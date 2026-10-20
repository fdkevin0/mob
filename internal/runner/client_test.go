package runner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

const testKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
const testID = "11111111-1111-4111-8111-111111111111"

func TestEncryptionAuthenticatesRoutingAndContent(t *testing.T) {
	key, _ := aead(testKey)
	e, err := seal(key, testID, "request", Envelope{Version: 1, Session: strings.Repeat("a", 64), ID: testID, Final: true}, map[string]string{"private": "secret prompt"})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(e)
	if strings.Contains(string(raw), "secret prompt") {
		t.Fatal("plaintext in envelope")
	}
	var got map[string]string
	if err := open(key, testID, "request", e, &got); err != nil || got["private"] != "secret prompt" {
		t.Fatalf("round trip: %v %v", got, err)
	}
	mutations := []func(*Envelope){func(e *Envelope) { e.ID = "other" }, func(e *Envelope) { e.Session = "other" }, func(e *Envelope) { e.Seq++ }, func(e *Envelope) { e.Final = false }, func(e *Envelope) { e.Data = "AAAA" }, func(e *Envelope) { e.Nonce = "AAAA" }}
	for _, mutate := range mutations {
		bad := e
		mutate(&bad)
		if open(key, testID, "request", bad, &got) == nil {
			t.Fatal("tampered envelope accepted")
		}
	}
	if open(key, testID, "response", e, &got) == nil || open(key, "other", "request", e, &got) == nil {
		t.Fatal("wrong direction or runner accepted")
	}
}

func TestRunnerEncryptedStreamAndReplay(t *testing.T) {
	key, _ := aead(testKey)
	var calls atomic.Int32
	finished := make(chan error, 1)
	server := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		ws.SetDeadline(time.Now().Add(5 * time.Second))
		var hello struct {
			Session string `json:"session"`
		}
		if err := websocket.JSON.Receive(ws, &hello); err != nil {
			finished <- err
			return
		}
		e, _ := seal(key, testID, "request", Envelope{Version: 1, Session: hello.Session, ID: testID, Final: true}, request{Method: "POST", Path: "/api/chat", Body: "private prompt", Expires: time.Now().Add(30 * time.Second).UnixMilli()})
		if err := websocket.JSON.Send(ws, e); err != nil {
			finished <- err
			return
		}
		var body strings.Builder
		for seq := uint64(0); ; seq++ {
			var reply Envelope
			if err := websocket.JSON.Receive(ws, &reply); err != nil {
				finished <- err
				return
			}
			if reply.Seq != seq {
				t.Errorf("sequence: %d", reply.Seq)
			}
			var out response
			if err := open(key, testID, "response", reply, &out); err != nil {
				finished <- err
				return
			}
			if seq == 0 && out.Status != 201 {
				t.Errorf("status: %d", out.Status)
			}
			bytes, err := base64.StdEncoding.DecodeString(out.Body)
			if err != nil {
				finished <- err
				return
			}
			body.Write(bytes)
			if reply.Final {
				break
			}
		}
		if body.String() != "data: 你好\n\ndata: [DONE]\n\n" {
			t.Errorf("body: %q", body.String())
		}
		// The same authenticated request must never execute twice.
		_ = websocket.JSON.Send(ws, e)
		var reply Envelope
		if err := websocket.JSON.Receive(ws, &reply); err == nil {
			t.Error("replay received a response")
		}
		finished <- nil
	}))
	defer server.Close()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		raw, _ := io.ReadAll(r.Body)
		if string(raw) != "private prompt" {
			t.Errorf("request body: %q", raw)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(201)
		// Deliberately split UTF-8 bytes across writes.
		data := []byte("data: 你好\n\ndata: [DONE]\n\n")
		w.Write(data[:7])
		w.Write(data[7:])
	})
	err := connect(context.Background(), server.URL, Credentials{ID: testID, Token: "fake"}, key, handler, func(string) {})
	if err == nil || !strings.Contains(err.Error(), "replayed") {
		t.Fatalf("expected replay rejection: %v", err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("executed %d times", calls.Load())
	}
}

func TestRunnerRejectsLocalAuthorityAndExternalPaths(t *testing.T) {
	for _, path := range []string{"https://evil.example/api/chat", "//evil.example/api/chat", "/api/../api/config", "/api/%2e%2e/api/config", "/api/pairing", "/api/pairing/claim", "/api/token/rotate", "/api/runtime/stop", "/not-api"} {
		t.Run(path, func(t *testing.T) {
			w := httptest.NewRecorder()
			serve(context.Background(), http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("forbidden request forwarded") }), w, request{Method: "POST", Path: path})
			if w.Code < 400 {
				t.Fatalf("status: %d", w.Code)
			}
		})
	}
}

func TestLocalTokenNeverLeavesRunner(t *testing.T) {
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer local-only" || r.Header.Get("Cookie") != "" || r.Header.Get("Origin") != "" {
			t.Errorf("unsafe forwarded headers: %v", r.Header)
		}
		w.Header().Set("Set-Cookie", "secret")
		w.Write([]byte("ok"))
	}))
	defer local.Close()
	w := httptest.NewRecorder()
	serve(context.Background(), LocalHandler(local.URL, "local-only"), w, request{Method: "GET", Path: "/api/config", Headers: http.Header{"Authorization": {"attacker"}, "Cookie": {"cloud-session"}, "Origin": {"https://cloud.example"}}})
	if w.Code != 200 || w.Body.String() != "ok" || w.Header().Get("Set-Cookie") != "" {
		t.Fatalf("unsafe response: %v", w)
	}
}

func TestDisconnectCancelsLocalRequests(t *testing.T) {
	key, _ := aead(testKey)
	entered := make(chan struct{})
	cancelled := make(chan struct{})
	server := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		var hello struct {
			Session string `json:"session"`
		}
		websocket.JSON.Receive(ws, &hello)
		e, _ := seal(key, testID, "request", Envelope{Version: 1, Session: hello.Session, ID: testID, Final: true}, request{Method: "GET", Path: "/api/config", Expires: time.Now().Add(30 * time.Second).UnixMilli()})
		websocket.JSON.Send(ws, e)
		<-entered
		ws.Close()
	}))
	defer server.Close()
	_ = connect(context.Background(), server.URL, Credentials{ID: testID}, key, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done(); close(cancelled) }), func(string) {})
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("request survived disconnect")
	}
}
