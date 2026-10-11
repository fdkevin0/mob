package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
