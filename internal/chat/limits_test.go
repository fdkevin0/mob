package chat

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/llm"
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
