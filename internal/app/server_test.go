package app

import (
	"bytes"
	"encoding/json"
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/provider"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHTTPAuthCancellationAndBusy(t *testing.T) {
	s, err := chat.OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, _ := s.Create()
	server := NewServer(s, provider.Offline(), strings.Repeat("t", 32))
	defer server.Close()
	httpServer := httptest.NewServer(server.Handler(nil))
	defer httpServer.Close()
	request := func(method, path, origin, token string, body any) *http.Response {
		t.Helper()
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, httpServer.URL+path, bytes.NewReader(raw))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	for _, test := range []struct {
		origin, token string
		status        int
	}{{"", "", 401}, {"https://evil.example", server.Token, 403}, {"", server.Token, 200}} {
		r := request("GET", "/api/conversations", test.origin, test.token, nil)
		r.Body.Close()
		if r.StatusCode != test.status {
			t.Fatalf("auth status %d want %d", r.StatusCode, test.status)
		}
	}
	body := chat.ChatRequest{ID: c.ID, Text: strings.Repeat("hello ", 100), RequestID: "once"}
	r := request("POST", "/api/chat", "", server.Token, body)
	defer r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatal(r.Status)
	}
	busy := request("POST", "/api/chat", "", server.Token, chat.ChatRequest{ID: c.ID, Text: "other", RequestID: "twice"})
	busy.Body.Close()
	if busy.StatusCode != 409 {
		t.Fatalf("concurrent turn accepted: %d", busy.StatusCode)
	}
	stop := request("POST", "/api/conversations/"+c.ID+"/stop", "", server.Token, map[string]any{})
	stop.Body.Close()
	stream, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(stream, []byte("[DONE]")) {
		t.Fatal("missing stream terminator")
	}
	deadline := time.Now().Add(time.Second)
	for {
		h, e := s.History(c.ID)
		if e != nil {
			t.Fatal(e)
		}
		if h[len(h)-1].Metadata["status"] == "cancelled" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("cancellation not saved: %+v", h)
		}
		time.Sleep(time.Millisecond)
	}
	duplicate := request("POST", "/api/chat", "", server.Token, body)
	duplicate.Body.Close()
	if duplicate.StatusCode != 409 {
		t.Fatalf("retry accepted: %d", duplicate.StatusCode)
	}
}
