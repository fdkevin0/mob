package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/llm/anthropic"
)

// sized answers at once with the limits it is given, recording each request.
type sized struct {
	info     llm.Info
	requests []llm.Request
}

func (m *sized) Ref() llm.Ref   { return llm.Ref{Provider: "test", Model: "sized"} }
func (m *sized) Info() llm.Info { return m.info }
func (m *sized) Stream(_ context.Context, req llm.Request, emit func(string, string) error) (llm.Result, error) {
	m.requests = append(m.requests, req)
	return llm.Result{Text: "ok"}, emit("text", "ok")
}

// only resolves every reference to one model.
type only struct {
	*models
	model llm.Model
}

func (o only) Resolve(string) (llm.Model, error) { return o.model, nil }

func TestReplySizeFollowsTheModel(t *testing.T) {
	for _, c := range []struct {
		name string
		info llm.Info
		want int
	}{
		{"large limit is capped", llm.Info{ID: "big", Output: 128000, Context: 1000000}, outputCap},
		{"small limit is the model's", llm.Info{ID: "small", Output: 8192, Context: 128000}, 8192},
		{"small window keeps room for history", llm.Info{ID: "narrow", Output: 64000, Context: 40000}, 10000},
		{"unknown limit is the driver's", llm.Info{ID: "unknown"}, 0},
	} {
		s, id, m := turnFixture(t)
		model := &sized{info: c.info}
		if err := Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil }); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got := model.requests[0].MaxTokens; got != c.want {
			t.Errorf("%s: max tokens %d, want %d", c.name, got, c.want)
		}
	}
}

func TestMessageTooLargeForTheModel(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, _ := s.Create()
	m, err := s.Begin(c.ID, NewID(), strings.Repeat("x", 120000), "test/sized")
	if err != nil {
		t.Fatal(err)
	}
	model := &sized{info: llm.Info{ID: "narrow", Output: 4096, Context: 32000}}
	err = Run(context.Background(), s, model, Agent{}, c.ID, m, "", func(Event) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "more than narrow has room for") || len(model.requests) != 0 {
		t.Fatalf("an oversized message reached the model: %v, %d requests", err, len(model.requests))
	}
	// The same message fits a model with a larger window.
	m, _ = s.Begin(c.ID, NewID(), strings.Repeat("x", 120000), "test/sized")
	model.info.Context = 200000
	if err := Run(context.Background(), s, model, Agent{}, c.ID, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestLongMessagesAreAccepted(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	model := &sized{info: llm.Info{ID: "sized", Context: 128000}}
	service := NewConversation(s, only{&models{def: "test/sized"}, model})
	c, _ := s.Create()
	// Once rejected at 16000 bytes; a pasted log or document now reaches the model.
	text := strings.Repeat("日志行 ", 10000)
	if err := service.Execute(context.Background(), ChatRequest{ID: c.ID, Text: text, RequestID: NewID(), Owner: true}, func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(model.requests) != 1 || model.requests[0].Messages[0].Text != strings.TrimSpace(text) {
		t.Fatalf("long message did not reach the model: %d requests", len(model.requests))
	}
}

// Thinking comes out of the reply's reserved tokens, so the prompt the turn
// accepted and the max_tokens the driver sends fit the window together.
func TestThinkingFitsTheReservedReply(t *testing.T) {
	var sent struct {
		MaxTokens int `json:"max_tokens"`
		Messages  []struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"messages"`
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&sent)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer upstream.Close()
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, _ := s.Create()
	m, err := s.Begin(c.ID, NewID(), strings.Repeat("长", 163000), "a/claude")
	if err != nil {
		t.Fatal(err)
	}
	info := llm.Info{ID: "claude", Context: 200000, Output: 64000}
	model := anthropic.New(llm.Ref{Provider: "a", Model: "claude", Effort: "max"}, info, anthropic.Config{BaseURL: upstream.URL})
	if err := Run(context.Background(), s, model, Agent{}, c.ID, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	prompt := tokens(systemPrompt)
	for _, message := range sent.Messages {
		for _, block := range message.Content {
			prompt += tokens(block.Text)
		}
	}
	if prompt+sent.MaxTokens > info.Context {
		t.Fatalf("prompt of about %d tokens plus max_tokens %d exceeds the %d window", prompt, sent.MaxTokens, info.Context)
	}
}
