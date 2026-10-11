package chat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

type openCodeTestTransport func(*http.Request) (*http.Response, error)

func (f openCodeTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestOpenCodeZenEndpointDetection(t *testing.T) {
	for _, tc := range []struct {
		url  string
		want bool
	}{
		{"https://opencode.ai/zen/v1", true},
		{"https://OPENCODE.AI/zen/v1/", true},
		{"https://opencode.ai:443/zen/v1", true},
		{"https://opencode.ai:1234/zen/v1", false},
		{"https://opencode.ai/zen", true},
		{"https://other.example/v1", false},
		{"https://opencode.ai.evil.example/zen/v1", false},
		{"https://other.example/opencode.ai/zen/v1", false},
		{"https://opencode.ai/other/v1", false},
		{"https://opencode.ai/zenith/v1", false},
		{"http://opencode.ai/zen/v1", false},
		{"https://%", false},
	} {
		p := Provider{BaseURL: tc.url, Model: DefaultOpenCodeZenModel, APIKey: "public"}
		if p.IsOpenCodeZen() != tc.want || p.IsOpenCodeFreeTier() != tc.want {
			t.Errorf("incorrect Zen detection for %s", tc.url)
		}
		if !tc.want {
			h := http.Header{}
			p.ApplyOpenCodeHeaders(h, "conversation")
			if len(h) != 0 {
				t.Errorf("Zen headers applied to %s", tc.url)
			}
		}
	}
	if (Provider{BaseURL: DefaultOpenCodeZenBaseURL, Model: "paid-model", APIKey: "public"}).IsOpenCodeFreeTier() {
		t.Fatal("public key made a paid model free")
	}
}

func TestOpenCodeZenIdentificationAndHeaders(t *testing.T) {
	zen := Provider{BaseURL: "https://opencode.ai/zen/v1", Model: "mimo-v2.6-flash-free", APIKey: "public"}
	if !zen.IsOpenCodeZen() {
		t.Fatal("expected IsOpenCodeZen to be true")
	}
	if !zen.IsOpenCodeFreeTier() {
		t.Fatal("expected IsOpenCodeFreeTier to be true")
	}

	req, _ := http.NewRequest("POST", "https://opencode.ai/zen/v1/chat/completions", nil)
	zen.ApplyOpenCodeHeaders(req.Header, "conv_123")
	if req.Header.Get("User-Agent") != "opencode/"+OpenCodeVersion {
		t.Fatalf("unexpected User-Agent: %s", req.Header.Get("User-Agent"))
	}
	if req.Header.Get("x-opencode-client") != "cli" {
		t.Fatalf("unexpected x-opencode-client: %s", req.Header.Get("x-opencode-client"))
	}
	if req.Header.Get("x-opencode-project") != "global" {
		t.Fatalf("unexpected x-opencode-project: %s", req.Header.Get("x-opencode-project"))
	}
	if !strings.HasPrefix(req.Header.Get("x-opencode-session"), "ses_") {
		t.Fatalf("unexpected x-opencode-session: %s", req.Header.Get("x-opencode-session"))
	}
	if !strings.HasPrefix(req.Header.Get("x-opencode-request"), "msg_") {
		t.Fatalf("unexpected x-opencode-request: %s", req.Header.Get("x-opencode-request"))
	}
}

func TestEnsureOpenCodeFreeTools(t *testing.T) {
	initial := []any{
		map[string]any{"type": "function", "function": map[string]any{"name": "datetime"}},
	}
	enhanced := EnsureOpenCodeFreeTools(initial)
	if len(enhanced) != 3 {
		t.Fatalf("expected 3 tools, got %d", len(enhanced))
	}
	names := map[string]bool{}
	for _, item := range enhanced {
		m := item.(map[string]any)
		fn := m["function"].(map[string]any)
		names[fn["name"].(string)] = true
	}
	if !names["datetime"] || !names["bash"] || !names["read"] {
		t.Fatalf("missing required tools in %v", names)
	}

	// Idempotent: should not add duplicates if already present
	again := EnsureOpenCodeFreeTools(enhanced)
	if len(again) != 3 {
		t.Fatalf("expected 3 tools after second pass, got %d", len(again))
	}
}

func TestOpenCodeZenStreamAndReasoning(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != "opencode/"+OpenCodeVersion {
			t.Errorf("missing OpenCode User-Agent header: %s", r.Header.Get("User-Agent"))
		}
		if r.Header.Get("x-opencode-client") != "cli" {
			t.Errorf("missing x-opencode-client header: %s", r.Header.Get("x-opencode-client"))
		}
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("invalid json: %v", err)
		}
		toolList, _ := payload["tools"].([]any)
		if len(toolList) < 2 {
			t.Errorf("expected free tools injected, got %d", len(toolList))
		}

		w.Header().Set("Content-Type", "text/event-stream")
		// Simulate OpenCode Zen reasoning and content delta
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning\":\"thinking about answer\"}}]}\n\n"))
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"Hello from Zen!\"}}]}\n\n"))
		w.Write([]byte("data: {\"choices\":[{\"finish_reason\":\"stop\",\"delta\":{}}]}\n\n"))
		w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	p := Provider{
		BaseURL: DefaultOpenCodeZenBaseURL,
		Model:   "mimo-v2.6-flash-free",
		Transport: openCodeTestTransport(func(r *http.Request) (*http.Response, error) {
			if r.Header.Get("Authorization") != "Bearer public" {
				t.Error("missing public fallback")
			}
			local := r.Clone(r.Context())
			local.URL, _ = url.Parse(server.URL + r.URL.Path)
			return server.Client().Transport.RoundTrip(local)
		}),
	}

	var emittedReasoning, emittedText string
	res, err := p.Stream(context.Background(), []ModelMessage{{Role: "user", Content: "Hi"}}, func(kind, delta string) error {
		if kind == "reasoning" {
			emittedReasoning += delta
		} else if kind == "text" {
			emittedText += delta
		}
		return nil
	})
	if err != nil {
		t.Fatalf("stream error: %v", err)
	}
	if emittedReasoning != "thinking about answer" {
		t.Fatalf("unexpected emitted reasoning: %q", emittedReasoning)
	}
	if emittedText != "Hello from Zen!" {
		t.Fatalf("unexpected emitted text: %q", emittedText)
	}
	if res.Text != "Hello from Zen!" || res.Reasoning != "thinking about answer" {
		t.Fatalf("unexpected result: %+v", res)
	}
}

func TestCustomFreeModelDoesNotReceiveZenTools(t *testing.T) {
	for _, analyze := range []bool{false, true} {
		p := Provider{BaseURL: "https://other.example/v1", Model: "custom-free", APIKey: "public"}
		p.Transport = openCodeTestTransport(func(r *http.Request) (*http.Response, error) {
			if r.Header.Get("x-opencode-client") != "" || strings.HasPrefix(r.Header.Get("User-Agent"), "opencode/") {
				t.Error("custom provider received Zen headers")
			}
			var payload struct {
				Tools []struct{ Function struct{ Name string } }
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			for _, tool := range payload.Tools {
				if tool.Function.Name == "bash" || tool.Function.Name == "read" {
					t.Error("custom provider received Zen stub tools")
				}
			}
			if analyze && len(payload.Tools) != 0 {
				t.Error("analysis received tools")
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("data: {\"choices\":[{\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))}, nil
		})
		messages := []ModelMessage{{Role: "user", Content: "Hi"}}
		var err error
		if analyze {
			_, err = p.Analyze(context.Background(), messages)
		} else {
			_, err = p.Stream(context.Background(), messages, func(string, string) error { return nil })
		}
		if err != nil {
			t.Fatal(err)
		}
		p.APIKey = ""
		if _, err := p.Analyze(context.Background(), messages); err == nil {
			t.Fatal("custom provider received an anonymous Zen fallback")
		}
	}
}
