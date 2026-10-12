package chat

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/llm"
)

// filling calls a tool at every step, reporting usage when it is given.
type filling struct {
	info     llm.Info
	usage    func(step int) *llm.Usage
	requests []llm.Request
}

func (m *filling) Ref() llm.Ref   { return llm.Ref{Provider: "test", Model: "filling"} }
func (m *filling) Info() llm.Info { return m.info }
func (m *filling) Stream(_ context.Context, req llm.Request, _ func(string, string) error) (llm.Result, error) {
	m.requests = append(m.requests, req)
	step := len(m.requests)
	result := llm.Result{Calls: []llm.ToolCall{{ID: fmt.Sprint("call-", step), Name: "read", Arguments: `{}`}}}
	if m.usage != nil {
		result.Usage = m.usage(step)
	}
	return result, nil
}

func TestToolDefinitionsCountAgainstTheWindow(t *testing.T) {
	s, id, m := turnFixture(t)
	for range 5 {
		m, _ = s.Begin(id, NewID(), strings.Repeat("x", 3000), "test/sized")
	}
	tool := echoTool("read", func(context.Context, ToolCall) (any, error) { return "ok", nil })
	tool.Description = strings.Repeat("d", 48000)
	info := llm.Info{ID: "sized", Context: 20000, Output: 1000, Tools: true}
	plain, withTool := &sized{info: info}, &sized{info: info}
	if err := Run(context.Background(), s, plain, Agent{}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err := Run(context.Background(), s, withTool, Agent{Tools: []Tool{tool}}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(plain.requests[0].Messages) != 6 {
		t.Fatalf("history without tools: %d messages", len(plain.requests[0].Messages))
	}
	req := withTool.requests[0]
	if len(req.Messages) >= 6 || !strings.Contains(req.System, "omitted") {
		t.Fatalf("a 16000-token tool definition left all %d messages in a 20000-token window", len(req.Messages))
	}
	if size := tokens(req.System) + toolTokens(req.Tools) + promptTokens(req.Messages); size > info.Context-req.MaxTokens {
		t.Fatalf("prompt of about %d tokens leaves no room for a %d-token reply", size, req.MaxTokens)
	}
}

// The provider's count of the last step decides, not the estimate, as
// tokenizers differ from it.
func TestTurnStopsWhenUsageFillsTheWindow(t *testing.T) {
	s, id, m := turnFixture(t)
	tool := echoTool("read", func(context.Context, ToolCall) (any, error) { return "ok", nil })
	model := &filling{
		info:  llm.Info{ID: "filling", Context: 100000, Output: 4000, Tools: true},
		usage: func(step int) *llm.Usage { return &llm.Usage{Input: 30000 * step, Output: 100} },
	}
	err := Run(context.Background(), s, model, Agent{Tools: []Tool{tool}}, id, m, "", func(Event) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "filled filling's context") {
		t.Fatalf("turn went on: %v", err)
	}
	// After the third step the prompt holds 90100 tokens, within the 96000 a
	// prompt may use; after the fourth, 120100, so no fifth request is made.
	if len(model.requests) != 4 {
		t.Fatalf("made %d requests, want 4", len(model.requests))
	}
}

// Without usage, each step's tool results are estimated as they are added;
// older ones the model has read are cleared so the turn can go on.
func TestOlderToolResultsAreClearedToContinue(t *testing.T) {
	s, id, m := turnFixture(t)
	tool := echoTool("read", func(context.Context, ToolCall) (any, error) { return strings.Repeat("y", 100000), nil })
	model := &filling{info: llm.Info{ID: "filling", Context: 40000, Output: 4000, Tools: true}}
	err := Run(context.Background(), s, model, Agent{Tools: []Tool{tool}, Steps: 8}, id, m, "", func(Event) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "tool step limit") {
		t.Fatalf("turn did not run to its step limit: %v", err)
	}
	for i, req := range model.requests {
		if size := tokens(req.System) + toolTokens(req.Tools) + promptTokens(req.Messages); size > 40000-req.MaxTokens {
			t.Fatalf("request %d had about %d tokens with %d reserved for the reply", i+1, size, req.MaxTokens)
		}
	}
	last := model.requests[len(model.requests)-1].Messages
	if first := last[2].Text; !strings.Contains(first, `"cleared":true`) || !strings.Contains(first, "Run the tool again") {
		t.Fatalf("the oldest output was not cleared: %.200s", first)
	}
	// The newest output, which the model has not read yet, is whole.
	if newest := last[len(last)-1].Text; strings.Contains(newest, "cleared") || !strings.Contains(newest, "yyyy") {
		t.Fatalf("the newest output was cleared: %.200s", newest)
	}
}

// Fitting history clears older tool outputs before omitting whole turns, and
// points the model at the saved output.
func TestHistoryClearsOldOutputsBeforeOmittingTurns(t *testing.T) {
	s, id, m := turnFixture(t)
	tool := echoTool("exec", func(context.Context, ToolCall) (any, error) { return strings.Repeat("z", 60000), nil })
	if err := Run(context.Background(), s, &scripted{call: llm.ToolCall{ID: "call-1", Name: "exec", Arguments: `{}`}}, Agent{Tools: []Tool{tool}, Saver: folder{t.TempDir()}}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	m, _ = s.Begin(id, NewID(), "and now?", "test/sized")
	model := &sized{info: llm.Info{ID: "sized", Context: 1800, Output: 500}}
	if err := Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	req := model.requests[0]
	if strings.Contains(req.System, "omitted") || req.Messages[0].Text != "go" {
		t.Fatalf("turns were omitted: %d messages", len(req.Messages))
	}
	var output string
	for _, msg := range req.Messages {
		if msg.Role == "tool" {
			output = msg.Text
		}
	}
	if !strings.Contains(output, `"cleared":true`) || !strings.Contains(output, "/workspace/.mob/outputs/") {
		t.Fatalf("old output was not cleared with its file: %.200s", output)
	}
}

// What is added after history is fitted, the omission notice and an approval
// note, is reserved when fitting it, so the first request fits too.
func TestFirstRequestFitsWithItsAdditions(t *testing.T) {
	s, id, m := turnFixture(t)
	for range 8 {
		m, _ = s.Begin(id, NewID(), strings.Repeat("x", 3000), "test/sized")
	}
	tool := echoTool("read", func(context.Context, ToolCall) (any, error) { return "ok", nil })
	tool.Description = strings.Repeat("d", 12000)
	info := llm.Info{ID: "sized", Context: 12000, Output: 1000, Tools: true}
	model := &sized{info: info}
	note := "The user approved read and it ran. Result: " + strings.Repeat("r", 6000)
	if err := Run(context.Background(), s, model, Agent{Tools: []Tool{tool}}, id, m, note, func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	req := model.requests[0]
	if !strings.Contains(req.System, "omitted") || req.Messages[len(req.Messages)-1].Text != note {
		t.Fatalf("history was not cut or the note is missing")
	}
	if size := tokens(req.System) + toolTokens(req.Tools) + promptTokens(req.Messages); size > info.Context-req.MaxTokens {
		t.Fatalf("first request of about %d tokens exceeds the %d a prompt may use", size, info.Context-req.MaxTokens)
	}
}
