package llm

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
