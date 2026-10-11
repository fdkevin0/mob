package anthropic

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fdkevin0/mob/internal/llm"
)

func TestMessagesStream(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			System    string           `json:"system"`
			MaxTokens int              `json:"max_tokens"`
			Thinking  map[string]any   `json:"thinking"`
			Messages  []map[string]any `json:"messages"`
			Tools     []map[string]any `json:"tools"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.URL.Path != "/v1/messages" || r.Header.Get("x-api-key") != "key" || r.Header.Get("anthropic-version") == "" {
			t.Errorf("bad request %s", r.URL.Path)
		}
		// Results answering one assistant turn arrive in one user message; foreign IDs are adapted.
		if body.System != "sys" || len(body.Messages) != 3 || body.Messages[2]["role"] != "user" || len(body.Messages[2]["content"].([]any)) != 2 ||
			body.Thinking["budget_tokens"] != float64(2048) || body.MaxTokens != 100+2048 || body.Tools[0]["input_schema"] == nil {
			t.Errorf("bad body %+v", body)
		}
		if id := body.Messages[1]["content"].([]any)[1].(map[string]any)["id"]; id != "call_1_x" {
			t.Errorf("tool id %v", id)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, e := range []string{
			`{"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}`,
			`{"type":"content_block_start","index":1,"content_block":{"type":"text"}}`,
			`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}`,
			`{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"datetime"}}`,
			`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"timezone\":"}}`,
			`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"UTC\"}"}}`,
			`{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}`,
			`{"type":"message_stop"}`,
		} {
			fmt.Fprintf(w, "event: x\ndata: %s\n\n", e)
		}
	}))
	defer upstream.Close()
	m := New(llm.Ref{Provider: "a", Model: "claude", Effort: "low"}, llm.Info{}, Config{BaseURL: upstream.URL, Key: "key"})
	var got string
	result, err := m.Stream(context.Background(), llm.Request{System: "sys", MaxTokens: 100, Tools: []llm.Tool{{Name: "datetime", Parameters: map[string]any{"type": "object"}}},
		Messages: []llm.Message{
			{Role: "user", Text: "hi"},
			{Role: "assistant", Text: "a", ToolCalls: []llm.ToolCall{{ID: "call:1.x", Name: "t", Arguments: "{}"}, {ID: "b", Name: "t", Arguments: "oops"}}},
			{Role: "tool", ToolCallID: "call:1.x", Text: "1"}, {Role: "tool", ToolCallID: "b", Text: "2"},
		}}, func(kind, delta string) error { got += kind + ":" + delta + ";"; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if got != "reasoning:hmm;text:Hi;" || result.Signature != "sig" || len(result.Calls) != 1 || result.Calls[0].Arguments != `{"timezone":"UTC"}` ||
		*result.Usage != (llm.Usage{Input: 15, Output: 7, CacheRead: 5}) {
		t.Fatalf("%+v %s", result, got)
	}
}
