package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/provider"
)

func TestPairingAndTokenRotation(t *testing.T) {
	s, err := chat.OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	server := NewServer(s, provider.Offline(), strings.Repeat("t", 32))
	defer server.Close()
	now := time.Unix(1_000_000, 0)
	server.access.now = func() time.Time { return now }
	var persisted string
	server.PersistToken = func(token string) error { persisted = token; return nil }
	httpServer := httptest.NewServer(server.Handler(nil))
	defer httpServer.Close()
	post := func(path, token string, body any) *http.Response {
		t.Helper()
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", httpServer.URL+path, bytes.NewReader(raw))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { resp.Body.Close() })
		return resp
	}
	pair := func(token string) string {
		t.Helper()
		resp := post("/api/pairing", token, nil)
		if resp.StatusCode != 200 {
			t.Fatalf("pairing HTTP %d", resp.StatusCode)
		}
		var out struct{ Code string }
		json.NewDecoder(resp.Body).Decode(&out)
		return out.Code
	}
	claim := func(code string) (int, string) {
		t.Helper()
		resp := post("/api/pairing/claim", "", map[string]string{"code": code})
		var out struct{ Token string }
		json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out.Token
	}

	if resp := post("/api/pairing", "", nil); resp.StatusCode != 401 {
		t.Fatalf("unauthenticated pairing HTTP %d", resp.StatusCode)
	}
	code := pair(server.Token())
	if status, token := claim(code); status != 200 || token != server.Token() {
		t.Fatalf("claim %d %q", status, token)
	}
	if status, _ := claim(code); status != 403 {
		t.Fatalf("code reused: HTTP %d", status)
	}
	if status, _ := claim("guess"); status != 403 {
		t.Fatalf("unknown code accepted: HTTP %d", status)
	}
	expired := pair(server.Token())
	now = now.Add(pairingLifetime)
	if status, _ := claim(expired); status != 403 {
		t.Fatalf("expired code accepted: HTTP %d", status)
	}

	old := server.Token()
	pending := pair(old)
	if resp := post("/api/token/rotate", old, nil); resp.StatusCode != 204 {
		t.Fatalf("rotate HTTP %d", resp.StatusCode)
	}
	if server.Token() == old || persisted != server.Token() || len(persisted) < 32 {
		t.Fatalf("token not replaced and saved: %q", persisted)
	}
	if resp := post("/api/pairing", old, nil); resp.StatusCode != 401 {
		t.Fatalf("old token still accepted: HTTP %d", resp.StatusCode)
	}
	if status, _ := claim(pending); status != 403 {
		t.Fatalf("code issued before rotation accepted: HTTP %d", status)
	}

	// A request authorized with a token that is rotated before it takes the lock
	// neither mints a code for the replacement nor rotates again.
	stale := httptest.NewRequest("POST", "/api/pairing", nil)
	stale.Header.Set("Authorization", "Bearer "+old)
	for _, handle := range []http.HandlerFunc{server.pair, server.rotate} {
		recorder := httptest.NewRecorder()
		handle(recorder, stale)
		if recorder.Code != 401 {
			t.Fatalf("stale token accepted after rotation: HTTP %d", recorder.Code)
		}
	}
	if len(server.access.codes) != 0 || persisted != server.Token() {
		t.Fatal("stale request changed pairing codes or the token")
	}

	current := server.Token()
	server.PersistToken = func(string) error { return errors.New("disk full") }
	if resp := post("/api/token/rotate", current, nil); resp.StatusCode != 500 || server.Token() != current {
		t.Fatalf("failed save changed the token: HTTP %d", resp.StatusCode)
	}
	server.PersistToken = nil
	if resp := post("/api/token/rotate", current, nil); resp.StatusCode != 409 {
		t.Fatalf("MOB_TOKEN rotation HTTP %d", resp.StatusCode)
	}
}

// gatedBody signals its first read, then waits for release before returning data.
type gatedBody struct {
	reading, release chan struct{}
	data             *bytes.Reader
}

func (b *gatedBody) Read(p []byte) (int, error) {
	if b.reading != nil {
		close(b.reading)
		b.reading = nil
		<-b.release
	}
	return b.data.Read(p)
}

func (b *gatedBody) Close() error { return nil }

func TestRotationEndsRequestsOfTheOldToken(t *testing.T) {
	s, err := chat.OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	server := NewServer(s, provider.Offline(), strings.Repeat("t", 32))
	defer server.Close()
	server.PersistToken = func(string) error { return nil }
	handler := server.Handler(nil)
	rotate := func() {
		t.Helper()
		if err := server.rotateToken(func(string) bool { return true }); err != nil {
			t.Fatal(err)
		}
	}

	// A request authorized before rotation but still waiting for its body never starts a turn.
	waiting, _ := s.Create()
	raw, _ := json.Marshal(chat.ChatRequest{ID: waiting.ID, Text: "late", RequestID: "late"})
	body := &gatedBody{reading: make(chan struct{}), release: make(chan struct{}), data: bytes.NewReader(raw)}
	reading := body.reading
	req := httptest.NewRequest("POST", "http://127.0.0.1/api/chat", body)
	req.Header.Set("Authorization", "Bearer "+server.Token())
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { handler.ServeHTTP(recorder, req); close(done) }()
	<-reading
	rotate()
	close(body.release)
	<-done
	if recorder.Code == 200 {
		t.Fatal("request with a revoked token started a turn")
	}
	if h, _ := s.History(waiting.ID); len(h) != 0 {
		t.Fatalf("revoked request saved messages: %+v", h)
	}

	// A turn streaming under the old token stops when the token is replaced.
	httpServer := httptest.NewServer(handler)
	defer httpServer.Close()
	streaming, _ := s.Create()
	raw, _ = json.Marshal(chat.ChatRequest{ID: streaming.ID, Text: strings.Repeat("hello ", 2000), RequestID: "stream"})
	req, _ = http.NewRequest("POST", httpServer.URL+"/api/chat", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+server.Token())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("stream HTTP %d", resp.StatusCode)
	}
	rotate()
	io.Copy(io.Discard, resp.Body)
	deadline := time.Now().Add(2 * time.Second)
	for {
		h, _ := s.History(streaming.ID)
		if len(h) > 0 && h[len(h)-1].Metadata["status"] == "cancelled" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("turn kept running after rotation: %+v", h)
		}
		time.Sleep(time.Millisecond)
	}
}

// Requests built outside net/http.Server, such as the runner relay's, are never
// cancelled by a server; finishing the handler must still release the revocation watch.
func TestFinishedRequestsReleaseTheirRevocationWatch(t *testing.T) {
	s, err := chat.OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	server := NewServer(s, provider.Offline(), strings.Repeat("t", 32))
	defer server.Close()
	handler := server.Handler(nil)
	serve := func() {
		req, _ := http.NewRequest("GET", "/api/config", nil)
		req.Host = "localhost"
		req.Header.Set("Authorization", "Bearer "+server.Token())
		handler.ServeHTTP(httptest.NewRecorder(), req)
	}
	serve()
	time.Sleep(50 * time.Millisecond)
	before := runtime.NumGoroutine()
	for range 80 {
		serve()
	}
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > before+5 {
		if time.Now().After(deadline) {
			t.Fatalf("goroutines grew from %d to %d after finished requests", before, runtime.NumGoroutine())
		}
		time.Sleep(10 * time.Millisecond)
	}
}
