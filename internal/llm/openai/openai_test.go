package openai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/llm"
)

func TestStreamingAndTruncation(t *testing.T) {
	for _, truncated := range []bool{false, true} {
		t.Run(fmt.Sprint(truncated), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer test" || body["reasoning_effort"] != "high" || body["max_tokens"] != float64(100) {
					t.Errorf("bad provider request: %v", body)
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"思考\"}}]}\r\n\r\n")
				fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"你好\",\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"datetime\",\"arguments\":\"{\"}}]}}]}\n\n")
				if !truncated {
					fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\n")
					fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"prompt_tokens_details\":{\"cached_tokens\":1}}}\n\ndata: [DONE]\n\n")
				}
			}))
			defer upstream.Close()
			var got string
			m := New(llm.Ref{Provider: "p", Model: "test", Effort: "high"}, llm.Info{}, Config{BaseURL: upstream.URL, Key: "test"})
			result, err := m.Stream(context.Background(), llm.Request{Messages: []llm.Message{{Role: "user", Text: "hi"}}, MaxTokens: 100}, func(kind, delta string) error { got += kind + ":" + delta + ";"; return nil })
			if truncated {
				if err == nil {
					t.Fatal("truncated stream marked successful")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != "reasoning:思考;text:你好;" || len(result.Calls) != 1 || result.Calls[0].ID != "c1" || result.Calls[0].Arguments != "{}" || *result.Usage != (llm.Usage{Input: 3, Output: 2, CacheRead: 1}) {
				t.Fatalf("bad result: %+v %s", result, got)
			}
		})
	}
}

func TestVendorErrorMessage(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		fmt.Fprint(w, `{"error":{"message":"The model `+"`nope`"+` does not exist\u0007"}}`)
	}))
	defer upstream.Close()
	_, err := New(llm.Ref{Model: "nope"}, llm.Info{}, Config{BaseURL: upstream.URL}).Stream(context.Background(), llm.Request{}, func(string, string) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "HTTP 404: The model `nope` does not exist") || strings.ContainsRune(err.Error(), 7) {
		t.Fatalf("%v", err)
	}
}

// A refusal for a prompt longer than the window is told apart from others,
// however the vendor words it.
func TestContextOverflowIsRecognized(t *testing.T) {
	defer func(d time.Duration) { llm.RetryDelay = d }(llm.RetryDelay)
	llm.RetryDelay = time.Millisecond
	for _, c := range []struct {
		status   int
		body     string
		overflow bool
	}{
		{400, `{"error":{"message":"This model's maximum context length is 128000 tokens.","code":"context_length_exceeded"}}`, true},
		{400, `{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}`, true},
		{413, `{"error":{"message":"request too large"}}`, true},
		{400, `{"error":{"message":"invalid tool schema"}}`, false},
		{429, `{"error":{"message":"too many tokens per minute"}}`, false},
	} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(c.status)
			fmt.Fprint(w, c.body)
		}))
		_, err := New(llm.Ref{Model: "m"}, llm.Info{}, Config{BaseURL: upstream.URL}).Stream(context.Background(), llm.Request{}, func(string, string) error { return nil })
		upstream.Close()
		if errors.Is(err, llm.ErrContextOverflow) != c.overflow || !strings.Contains(err.Error(), fmt.Sprint("HTTP ", c.status)) {
			t.Errorf("%d %s: %v", c.status, c.body, err)
		}
	}
}
