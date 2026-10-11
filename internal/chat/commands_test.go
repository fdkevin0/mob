package chat

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/llm/demo"
)

// models offers demo/echo and two named models answered by the demo.
type models struct{ def string }

type named struct {
	demo.Model
	ref llm.Ref
}

func (n named) Ref() llm.Ref { return n.ref }
func (n named) Info() llm.Info {
	return llm.Info{ID: n.ref.Model, Tools: true, Reasoning: true, Context: 128000}
}

func (m *models) Default() string { return m.def }
func (m *models) Resolve(q string) (llm.Model, error) {
	switch q {
	case "demo/echo":
		return demo.Model{}, nil
	case "alpha/one", "one":
		return named{ref: llm.Ref{Provider: "alpha", Model: "one"}}, nil
	case "beta/two", "two":
		return named{ref: llm.Ref{Provider: "beta", Model: "two"}}, nil
	}
	return nil, errors.New("no model matches " + q)
}
func (m *models) SetDefault(q string) (llm.Ref, error) {
	model, err := m.Resolve(q)
	if err == nil {
		m.def = model.Ref().String()
	}
	return model.Ref(), err
}
func (m *models) List(ctx context.Context, q string) []llm.Group {
	return []llm.Group{{Provider: "alpha", Name: "Alpha", Models: []llm.Info{{ID: "one", Tools: true}}}, {Provider: "beta", Name: "Beta", Models: []llm.Info{{ID: "two"}}}}
}

func TestModelCommands(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	service := NewConversation(s, &models{def: "alpha/one"})
	c, _ := s.Create()
	say := func(text string, owner bool) string {
		var reply strings.Builder
		err := service.Execute(context.Background(), ChatRequest{ID: c.ID, Text: text, RequestID: NewID(), Owner: owner}, func(e Event) error {
			if e.Kind == SegmentDelta && e.Segment == "text" {
				reply.WriteString(e.Text)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("%s: %v", text, err)
		}
		return reply.String()
	}
	if got := say("/model", false); !strings.Contains(got, "alpha/one") || !strings.Contains(got, "(the default)") {
		t.Fatalf("current model: %q", got)
	}
	wantList := "**Current model:** `alpha/one`\n\n### alpha (Alpha)\n\n- **`alpha/one`** (current) — tools\n\n### beta (Beta)\n\n- `beta/two`\n\nSwitch with `/model NAME`, e.g. `/model alpha/one`."
	if got := say("/models", false); got != wantList {
		t.Fatalf("listing: %q", got)
	}
	history, err := s.History(c.ID)
	if err != nil || Text(history[len(history)-1]) != wantList {
		t.Fatalf("Markdown listing not saved: %v", err)
	}
	if got := say("/model two", false); !strings.Contains(got, "Only the owner") {
		t.Fatalf("non-owner switched: %q", got)
	}
	if got := say("/model two", true); !strings.Contains(got, "Switched this conversation to beta/two") {
		t.Fatalf("switch: %q", got)
	}
	if got := say("/model nothing", true); !strings.Contains(got, "no model matches") {
		t.Fatalf("unknown: %q", got)
	}
	if ref, _ := s.ConversationModel(c.ID); ref != "beta/two" {
		t.Fatalf("conversation model %q", ref)
	}
	// Retrying an accepted command must not undo a later switch.
	first := NewID()
	service.Execute(context.Background(), ChatRequest{ID: c.ID, Text: "/model one", RequestID: first, Owner: true}, func(Event) error { return nil })
	say("/model two", true)
	var command *CommandError
	if err := service.Execute(context.Background(), ChatRequest{ID: c.ID, Text: "/model one", RequestID: first, Owner: true}, func(Event) error { return nil }); !errors.As(err, &command) || command.Status != 409 {
		t.Fatalf("retry accepted: %v", err)
	}
	if ref, _ := s.ConversationModel(c.ID); ref != "beta/two" {
		t.Fatalf("retry switched the model back: %q", ref)
	}
	say("hello", true)
	history, _ = s.History(c.ID)
	last := history[len(history)-1]
	if last.Model != "beta/two" || last.Command || Text(last) == "" {
		t.Fatalf("turn did not use the conversation's model: %+v", last)
	}
	// Commands stay in the transcript but never reach a model.
	prompt, _ := Prompt(history, last.ID, 0)
	for _, m := range prompt {
		if strings.HasPrefix(m.Text, "/model") || strings.Contains(m.Text, "Switched") {
			t.Fatalf("command sent to the model: %+v", m)
		}
	}
	if got := say("/model default one", true); !strings.Contains(got, "default model is now alpha/one") {
		t.Fatalf("set default: %q", got)
	}
	if got := say("/model default", true); !strings.Contains(got, "follows the default model, alpha/one") {
		t.Fatalf("follow default: %q", got)
	}
	if ref, _ := s.ConversationModel(c.ID); ref != "" {
		t.Fatalf("conversation kept %q", ref)
	}
}

func TestPromptReplaysToolSteps(t *testing.T) {
	history := []Message{
		{ID: "u", Role: "user", Parts: []Part{{"type": "text", "text": "save it"}}},
		{ID: "a", Role: "assistant", Parts: []Part{
			{"type": "reasoning", "text": "private to its model"},
			{"type": "text", "text": "Checking."},
			{"type": "tool-datetime", "toolCallId": "c1", "state": "output-available", "input": map[string]any{}, "output": map[string]any{"iso": "now"}},
			{"type": "text", "text": "Saving."},
			{"type": "tool-remember", "toolCallId": "c2", "state": "output-denied", "input": map[string]any{"fact": "x"}},
		}},
	}
	got, omitted := Prompt(history, "", 0)
	roles := []string{}
	for _, m := range got {
		roles = append(roles, m.Role)
		if m.Reasoning != "" {
			t.Fatal("earlier reasoning replayed")
		}
	}
	if omitted || strings.Join(roles, ",") != "user,assistant,tool,assistant,tool" {
		t.Fatalf("roles %v", roles)
	}
	if got[1].Text != "Checking." || got[1].ToolCalls[0].ID != "c1" || !strings.Contains(got[2].Text, "now") || !strings.Contains(got[4].Text, "denied") {
		t.Fatalf("steps %+v", got)
	}
	// A small budget keeps the newest turns and starts with the user.
	long := append([]Message{{ID: "old", Role: "user", Parts: []Part{{"type": "text", "text": strings.Repeat("x", 3000)}}}}, history...)
	got, omitted = Prompt(long, "", 100)
	if !omitted || got[0].Text != "save it" {
		t.Fatalf("budget: %v %+v", omitted, got)
	}
}
