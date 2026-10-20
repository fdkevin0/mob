package llm

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSendCutsOffOnlyAStalledResponse(t *testing.T) {
	defer func(d time.Duration) { StallTimeout = d }(StallTimeout)
	StallTimeout = 150 * time.Millisecond
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flush := func() { http.NewResponseController(w).Flush() }
		switch r.URL.Path {
		case "/silent":
			<-release
		case "/steady":
			// Arrives for well over StallTimeout, but never pauses that long.
			for range 8 {
				io.WriteString(w, "data\n")
				flush()
				time.Sleep(StallTimeout / 3)
			}
		case "/stops":
			io.WriteString(w, "data\n")
			flush()
			<-release
		}
	}))
	defer upstream.Close()
	// Handlers still waiting must return before the server can close.
	defer close(release)
	get := func(path string) (string, error) {
		req, _ := http.NewRequest("GET", upstream.URL+path, nil)
		resp, err := Send(nil, req)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		return string(raw), err
	}
	if _, err := get("/silent"); !errors.Is(err, ErrStalled) {
		t.Fatalf("silent response: %v", err)
	}
	if body, err := get("/steady"); err != nil || strings.Count(body, "data") != 8 {
		t.Fatalf("steady response cut off: %q %v", body, err)
	}
	if body, err := get("/stops"); !errors.Is(err, ErrStalled) || body != "data\n" {
		t.Fatalf("stopped response: %q %v", body, err)
	}
}

func TestSendRetriesWhatMayPass(t *testing.T) {
	defer func(d time.Duration) { RetryDelay = d }(RetryDelay)
	RetryDelay = time.Millisecond
	var calls []string
	failures := map[string]int{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		calls = append(calls, r.URL.Path+" "+string(body))
		switch r.URL.Path {
		case "/overloaded":
			if failures[r.URL.Path]++; failures[r.URL.Path] <= 2 {
				w.Header().Set("Retry-After", "0")
				w.WriteHeader(529)
				return
			}
		case "/quota":
			w.WriteHeader(http.StatusTooManyRequests)
			io.WriteString(w, `{"error":{"code":"insufficient_quota"}}`)
			return
		case "/down":
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		case "/bad":
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		io.WriteString(w, "ok")
	}))
	defer upstream.Close()
	post := func(path string) (int, string) {
		calls = nil
		req, _ := http.NewRequest("POST", upstream.URL+path, strings.NewReader("prompt"))
		resp, err := Send(nil, req)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(raw)
	}
	if status, body := post("/overloaded"); status != 200 || body != "ok" || len(calls) != 3 || calls[2] != "/overloaded prompt" {
		t.Fatalf("overloaded: %d %q %q", status, body, calls)
	}
	if status, body := post("/quota"); status != 429 || !strings.Contains(body, "insufficient_quota") || len(calls) != 1 {
		t.Fatalf("exhausted quota retried: %d %q %q", status, body, calls)
	}
	if status, _ := post("/down"); status != 503 || len(calls) != Retries+1 {
		t.Fatalf("failing server: %d %q", status, calls)
	}
	if status, _ := post("/bad"); status != 400 || len(calls) != 1 {
		t.Fatalf("bad request retried: %d %q", status, calls)
	}
}

func TestRetryAfter(t *testing.T) {
	if d := after("7", time.Second); d != 7*time.Second {
		t.Fatal(d)
	}
	if d := after("", time.Second); d != time.Second {
		t.Fatal(d)
	}
	if d := after(time.Now().Add(-time.Hour).UTC().Format(http.TimeFormat), time.Second); d != 0 {
		t.Fatal(d)
	}
}

func TestSendDoesNotRetryAStalledErrorBody(t *testing.T) {
	defer func(d, r time.Duration) { StallTimeout, RetryDelay = d, r }(StallTimeout, RetryDelay)
	StallTimeout, RetryDelay = 150*time.Millisecond, time.Millisecond
	release := make(chan struct{})
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		status := http.StatusServiceUnavailable
		if r.URL.Path == "/limited" {
			status = http.StatusTooManyRequests
		}
		w.WriteHeader(status)
		http.NewResponseController(w).Flush()
		<-release
	}))
	defer upstream.Close()
	defer close(release)
	for _, path := range []string{"/limited", "/down"} {
		calls.Store(0)
		req, _ := http.NewRequest("POST", upstream.URL+path, strings.NewReader("prompt"))
		if resp, err := Send(nil, req); !errors.Is(err, ErrStalled) || resp != nil || calls.Load() != 1 {
			t.Fatalf("%s: %v %v after %d requests", path, resp, err, calls.Load())
		}
	}
}
