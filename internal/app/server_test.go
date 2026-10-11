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
	}{{"", "", 401}, {"https://evil.example", server.Token(), 403}, {"", server.Token(), 200}} {
		r := request("GET", "/api/conversations", test.origin, test.token, nil)
		r.Body.Close()
		if r.StatusCode != test.status {
			t.Fatalf("auth status %d want %d", r.StatusCode, test.status)
		}
	}
	body := chat.ChatRequest{ID: c.ID, Text: strings.Repeat("hello ", 100), RequestID: "once"}
	r := request("POST", "/api/chat", "", server.Token(), body)
	defer r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatal(r.Status)
	}
	busy := request("POST", "/api/chat", "", server.Token(), chat.ChatRequest{ID: c.ID, Text: "other", RequestID: "twice"})
	busy.Body.Close()
	if busy.StatusCode != 409 {
		t.Fatalf("concurrent turn accepted: %d", busy.StatusCode)
	}
	stop := request("POST", "/api/conversations/"+c.ID+"/stop", "", server.Token(), map[string]any{})
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
	duplicate := request("POST", "/api/chat", "", server.Token(), body)
	duplicate.Body.Close()
	if duplicate.StatusCode != 409 {
		t.Fatalf("retry accepted: %d", duplicate.StatusCode)
	}
}

func TestDesktopOrigin(t *testing.T) {
	s, err := chat.OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	server := NewServer(s, provider.Offline(), strings.Repeat("t", 32))
	defer server.Close()
	handler := server.Handler(nil)
	for _, origin := range []string{
		"wails://wails", "http://wails.localhost",
		"wails://wails.localhost:34115", "wails://wails.localhost:49152",
		"wails://wails.localhost.evil.example:34115", "https://wails.localhost:34115",
		"wails://evil@wails.localhost:34115", "wails://wails.localhost:34115/path",
		"wails://wails.localhost:34115?query", "wails://wails.localhost:34115#fragment",
		"wails://wails.localhost:invalid", "null",
	} {
		t.Run(origin, func(t *testing.T) {
			allowed := origin == "wails://wails" || origin == "http://wails.localhost" || origin == "wails://wails.localhost:34115" || origin == "wails://wails.localhost:49152"
			for _, method := range []string{"OPTIONS", "GET"} {
				for _, authenticated := range []bool{false, true} {
					req := httptest.NewRequest(method, "http://127.0.0.1:8787/api/conversations", nil)
					req.Header.Set("Origin", origin)
					if authenticated {
						req.Header.Set("Authorization", "Bearer "+server.Token())
					}
					r := httptest.NewRecorder()
					handler.ServeHTTP(r, req)
					want := http.StatusForbidden
					if allowed {
						want = http.StatusUnauthorized
						if method == "OPTIONS" {
							want = http.StatusNoContent
						} else if authenticated {
							want = http.StatusOK
						}
						if got := r.Header().Get("Access-Control-Allow-Origin"); got != origin {
							t.Errorf("allow origin = %q, want %q", got, origin)
						}
					}
					if r.Code != want {
						t.Errorf("%s authenticated=%v: status %d, want %d", method, authenticated, r.Code, want)
					}
				}
			}
		})
	}
}

func TestCommandRoutes(t *testing.T) {
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
	call := func(method, path string, body any, dest any) int {
		t.Helper()
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, httpServer.URL+path, bytes.NewReader(raw))
		req.Header.Set("Authorization", "Bearer "+server.Token())
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode == 200 {
			if err := json.NewDecoder(resp.Body).Decode(dest); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode
	}
	var specs []chat.CommandSpec
	call("GET", "/api/commands?client=web", nil, &specs)
	var names []string
	for _, spec := range specs {
		names = append(names, spec.Name)
	}
	if got := strings.Join(names, " "); got != "model models new list open approve deny grants revoke plugins test deliveries clear-secret mail email cloud" {
		t.Fatalf("web commands: %s", got)
	}
	var suggestions []chat.Suggestion
	call("POST", "/api/commands/complete", chat.CommandRequest{Client: "web", Text: "/models"}, &suggestions)
	if len(suggestions) != 1 || suggestions[0].Value != "/models" || suggestions[0].Detail == "" {
		t.Fatalf("suggestions: %+v", suggestions)
	}
	call("POST", "/api/commands/complete", chat.CommandRequest{Client: "web", Text: "/clear-secret email "}, &suggestions)
	if len(suggestions) != 2 || suggestions[0].Value != "imap.password" {
		t.Fatalf("secret fields: %+v", suggestions)
	}
	call("POST", "/api/commands/complete", chat.CommandRequest{Client: "web", Text: "hello"}, &suggestions)
	if suggestions == nil || len(suggestions) != 0 {
		t.Fatalf("free text must complete to an empty list: %+v", suggestions)
	}
	run := func(text string) (chat.CommandResult, int) {
		t.Helper()
		var result chat.CommandResult
		status := call("POST", "/api/commands/run", chat.CommandRequest{Client: "web", ConversationID: c.ID, Text: text}, &result)
		return result, status
	}
	for text, want := range map[string]string{
		"/deliveries":                  "No deliveries yet.",
		"/test email":                  "email plugin is disabled.",
		"/test nope":                   "unknown plugin nope.",
		"/cloud":                       "D1 executes your SQL",
		"/clear-secret telegram token": "Cleared the saved token of telegram.",
		"/clear-secret telegram nope":  "unknown secret field",
	} {
		if result, status := run(text); status != 200 || !result.Handled || !strings.Contains(result.Markdown, want) {
			t.Fatalf("%s: %d %+v", text, status, result)
		}
	}
	if _, status := run("/email"); status != 409 {
		t.Fatalf("/email with the plugin disabled: %d", status)
	}
	if result, _ := run("/plugins"); result.Action == nil || result.Action.Kind != chat.OpenPlugins {
		t.Fatalf("/plugins: %+v", result)
	}
	if result, status := run("/model"); status != 200 || result.Handled {
		t.Fatalf("/model must stay a chat command: %+v", result)
	}
}
