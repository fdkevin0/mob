package runner

import (
	"bytes"
	"context"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/websocket"
)

type Credentials struct {
	URL   string `json:"url"`
	ID    string `json:"id"`
	Token string `json:"token"`
	Key   string `json:"key"`
}

// Origin permits TLS in production and loopback HTTP for local development.
func Origin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("runner URL must be an HTTPS origin")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1")) {
		return "", errors.New("runner URL requires HTTPS except on loopback")
	}
	return u.Scheme + "://" + u.Host, nil
}

// Run reconnects until cancelled. The handler remains local; only encrypted envelopes leave it.
func Run(ctx context.Context, credentials Credentials, handler http.Handler, status func(string)) error {
	origin, err := Origin(credentials.URL)
	if err != nil {
		return err
	}
	key, err := aead(credentials.Key)
	if err != nil {
		return err
	}
	for {
		err := connect(ctx, origin, credentials, key, handler, status)
		if ctx.Err() != nil {
			return nil
		}
		status(fmt.Sprintf("Runner disconnected (%v); reconnecting", err))
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(2 * time.Second):
		}
	}
}

type request struct {
	Method  string      `json:"method"`
	Path    string      `json:"path"`
	Headers http.Header `json:"headers"`
	Body    string      `json:"body"`
	Expires int64       `json:"expires"`
}
type response struct {
	Status  int         `json:"status"`
	Headers http.Header `json:"headers,omitempty"`
	Body    string      `json:"body"`
	// Error is set only on a final frame whose body is incomplete.
	Error string `json:"error,omitempty"`
}

func connect(ctx context.Context, origin string, credentials Credentials, key cipher.AEAD, handler http.Handler, status func(string)) error {
	config, err := websocket.NewConfig("ws"+strings.TrimPrefix(origin, "http")+"/api/runners/"+url.PathEscape(credentials.ID)+"/connect", origin)
	if err != nil {
		return err
	}
	config.Header.Set("Authorization", "Bearer "+credentials.Token)
	dialCtx, cancelDial := context.WithTimeout(ctx, 15*time.Second)
	ws, err := config.DialContext(dialCtx)
	cancelDial()
	if err != nil {
		return errors.New("relay connection failed; check network and pairing")
	}
	defer ws.Close()
	ws.MaxPayloadBytes = 2 * 1024 * 1024
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var mu sync.Mutex
	send := func(value any) error {
		mu.Lock()
		defer mu.Unlock()
		_ = ws.SetWriteDeadline(time.Now().Add(15 * time.Second))
		return websocket.JSON.Send(ws, value)
	}
	sessionBytes := make([]byte, 32)
	if _, err := rand.Read(sessionBytes); err != nil {
		return err
	}
	session := hex.EncodeToString(sessionBytes)
	if err := send(map[string]string{"type": "hello", "session": session}); err != nil {
		return err
	}
	status("Runner connected; end-to-end encryption enabled")
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				_ = ws.Close()
				return
			case <-ticker.C:
				if send(map[string]string{"type": "ping"}) != nil {
					_ = ws.Close()
					return
				}
			}
		}
	}()
	seen := make(map[string]int64)
	// More slots than the relay's 32 pending requests absorb the moment between
	// the relay forgetting a request and its handler here returning.
	slots := make(chan struct{}, 64)
	var activeMu sync.Mutex
	active := make(map[string]context.CancelFunc)
	// A request that is authenticated but not run gets its own encrypted error,
	// so one bad request never takes down the others sharing this connection.
	reject := func(envelope Envelope, status int, message string) error {
		rw := &encryptedWriter{key: key, runnerID: credentials.ID, envelope: envelope, send: send, headers: make(http.Header)}
		http.Error(rw, message, status)
		return rw.finish()
	}
	for {
		_ = ws.SetReadDeadline(time.Now().Add(90 * time.Second))
		var raw json.RawMessage
		if err := websocket.JSON.Receive(ws, &raw); err != nil {
			return err
		}
		var envelope Envelope
		if err := json.Unmarshal(raw, &envelope); err != nil {
			return err
		}
		if envelope.Version == 0 {
			// Heartbeat replies, and cancellations for requests whose browser left.
			var control struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			}
			if json.Unmarshal(raw, &control) == nil && control.Type == "cancel" {
				activeMu.Lock()
				if cancel, ok := active[control.ID]; ok {
					cancel()
				}
				activeMu.Unlock()
			}
			continue
		}
		// Frames that do not authenticate cannot be answered; drop them.
		if envelope.Session != session || envelope.Seq != 0 || !envelope.Final || len(envelope.ID) != 36 {
			continue
		}
		var req request
		if open(key, credentials.ID, "request", envelope, &req) != nil {
			continue
		}
		now := time.Now().UnixMilli()
		for id, expires := range seen {
			if expires < now {
				delete(seen, id)
			}
		}
		if _, ok := seen[envelope.ID]; ok {
			// Never answer a replay: the original's response is the only one.
			continue
		}
		if req.Expires < now || req.Expires > now+60_000 {
			if err := reject(envelope, http.StatusRequestTimeout, "request expired before it ran; check the browser clock"); err != nil {
				return err
			}
			continue
		}
		if len(seen) >= 10_000 {
			return errors.New("request rate limit")
		}
		// Recorded before any answer, so a request refused as busy cannot run later.
		seen[envelope.ID] = req.Expires
		select {
		case slots <- struct{}{}:
		default:
			if err := reject(envelope, http.StatusServiceUnavailable, "runner busy; the request did not run"); err != nil {
				return err
			}
			continue
		}
		requestCtx, cancel := context.WithCancel(ctx)
		activeMu.Lock()
		active[envelope.ID] = cancel
		activeMu.Unlock()
		go func() {
			defer func() { <-slots }()
			defer func() {
				activeMu.Lock()
				delete(active, envelope.ID)
				activeMu.Unlock()
				cancel()
			}()
			rw := &encryptedWriter{key: key, runnerID: credentials.ID, envelope: envelope, send: send, headers: make(http.Header)}
			// A request that produces nothing for six minutes ends, like the relay's idle limit,
			// even if a browser disappears without a cancellation reaching the runner.
			idle := time.AfterFunc(requestIdle, cancel)
			defer idle.Stop()
			rw.idle = idle
			serve(requestCtx, handler, rw, req)
			if rw.finish() != nil {
				// Only a failed send lands here: the socket itself is broken.
				_ = ws.Close()
			}
		}()
	}
}

const requestIdle = 6 * time.Minute

func serve(ctx context.Context, handler http.Handler, w http.ResponseWriter, req request) {
	u, err := url.ParseRequestURI(req.Path)
	if err != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(u.Path, "/api/") || strings.Contains(u.Path, "..") || strings.Contains(u.Path, "\\") || len(req.Body) > 1024*1024 || (req.Method != "GET" && req.Method != "POST") {
		http.Error(w, "invalid runner request", 400)
		return
	}
	// Remote peers cannot mint local access tokens or shut down the service.
	for _, path := range []string{"/api/pairing", "/api/token"} {
		if u.Path == path || strings.HasPrefix(u.Path, path+"/") {
			http.Error(w, "local-only endpoint", 403)
			return
		}
	}
	if strings.HasPrefix(u.Path, "/api/runtime") && req.Method != "GET" {
		http.Error(w, "local-only endpoint", 403)
		return
	}
	r, err := http.NewRequestWithContext(ctx, req.Method, req.Path, bytes.NewBufferString(req.Body))
	if err != nil {
		http.Error(w, "invalid request", 400)
		return
	}
	for _, name := range []string{"Content-Type", "Accept", "Last-Event-ID"} {
		for _, value := range req.Headers.Values(name) {
			r.Header.Add(name, value)
		}
	}
	handler.ServeHTTP(w, r)
}

type encryptedWriter struct {
	key      cipher.AEAD
	runnerID string
	envelope Envelope
	send     func(any) error
	headers  http.Header
	idle     *time.Timer
	status   int
	sent     bool
	failure  string
	err      error
}

func (w *encryptedWriter) Header() http.Header { return w.headers }
func (w *encryptedWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *encryptedWriter) emit(body string, final bool) error {
	if w.err != nil {
		return w.err
	}
	if w.status == 0 {
		w.status = 200
	}
	out := response{Body: body}
	if !w.sent {
		out.Status, out.Headers = w.status, w.headers
	}
	if final {
		out.Error = w.failure
	}
	w.envelope.Final = final
	sealed, err := seal(w.key, w.runnerID, "response", w.envelope, out)
	if err == nil {
		err = w.send(sealed)
	}
	w.err = err
	w.envelope.Seq++
	w.sent = true
	if w.idle != nil {
		w.idle.Reset(requestIdle)
	}
	return err
}
func (w *encryptedWriter) Write(p []byte) (int, error) {
	n := 0
	for len(p) > 0 {
		size := min(len(p), 16*1024)
		// Bodies are bytes, not necessarily UTF-8; base64 preserves split multibyte characters.
		if err := w.emit(base64.StdEncoding.EncodeToString(p[:size]), false); err != nil {
			return n, err
		}
		n += size
		p = p[size:]
	}
	return n, nil
}
func (w *encryptedWriter) Flush() {
	if !w.sent {
		_ = w.emit("", false)
	}
}

// fail marks the response incomplete: the final frame still authenticates, but
// carries the failure so the browser never takes a truncated body as complete.
func (w *encryptedWriter) fail(err error) {
	if w.failure == "" {
		w.failure = err.Error()
	}
}
func (w *encryptedWriter) finish() error { return w.emit("", true) }

// LocalHandler forwards only to the configured loopback service and injects its token locally.
func LocalHandler(origin, token string) http.Handler {
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target, err := http.NewRequestWithContext(r.Context(), r.Method, origin+r.URL.RequestURI(), r.Body)
		if err != nil {
			http.Error(w, "invalid local request", 400)
			return
		}
		target.Header = r.Header.Clone()
		target.Header.Set("Authorization", "Bearer "+token)
		resp, err := client.Do(target)
		if err != nil {
			http.Error(w, "local Mob unavailable", 502)
			return
		}
		defer resp.Body.Close()
		for _, name := range []string{"Content-Type", "X-Vercel-Ai-Ui-Message-Stream"} {
			for _, v := range resp.Header.Values(name) {
				w.Header().Add(name, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		if _, err := io.Copy(w, resp.Body); err != nil {
			// Never authenticate a truncated local response as a successful completion.
			if ew, ok := w.(*encryptedWriter); ok {
				ew.fail(err)
			}
		}
	})
}
