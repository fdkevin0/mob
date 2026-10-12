package chat

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/llm"
)

// refusing counts tokens its own way: it refuses any prompt whose messages
// are over limit, calls read for its first calls steps, then answers.
type refusing struct {
	limit, calls int
	requests     []llm.Request
}

func (m *refusing) Ref() llm.Ref { return llm.Ref{Provider: "test", Model: "refusing"} }
func (m *refusing) Info() llm.Info {
	return llm.Info{ID: "refusing", Context: 100000, Output: 1000, Tools: true}
}
func (m *refusing) Stream(_ context.Context, req llm.Request, emit func(string, string) error) (llm.Result, error) {
	m.requests = append(m.requests, req)
	if promptTokens(req.Messages) > m.limit {
		return llm.Result{}, llm.OverflowError(errors.New("model returned HTTP 400: prompt is too long"))
	}
	if m.calls > 0 {
		m.calls--
		return llm.Result{Calls: []llm.ToolCall{{ID: fmt.Sprint("call-", len(m.requests)), Name: "read", Arguments: `{}`}}}, nil
	}
	return llm.Result{Text: "ok"}, emit("text", "ok")
}

// A first request refused as too long is sent again with less history.
func TestRefusedPromptIsRetriedWithLessHistory(t *testing.T) {
	s, id, m := longHistory(t, 10)
	model := &refusing{limit: 8000}
	if err := Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(model.requests) != 2 {
		t.Fatalf("%d requests", len(model.requests))
	}
	retry := model.requests[1]
	if len(retry.Messages) >= len(model.requests[0].Messages) || !strings.Contains(retry.System, omittedNotice) || !strings.HasPrefix(retry.Messages[len(retry.Messages)-1].Text, "msg-9 ") {
		t.Fatalf("the retry kept %d of %d messages", len(retry.Messages), len(model.requests[0].Messages))
	}
}

// A later step refused as too long is sent again with older tool outputs
// cleared.
func TestRefusedStepIsRetriedWithOutputsCleared(t *testing.T) {
	s, id, m := turnFixture(t)
	tool := echoTool("read", func(context.Context, ToolCall) (any, error) { return strings.Repeat("r", 3000), nil })
	model := &refusing{limit: 1500, calls: 2}
	if err := Run(context.Background(), s, model, Agent{Tools: []Tool{tool}}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(model.requests) != 4 {
		t.Fatalf("%d requests", len(model.requests))
	}
	retry := model.requests[3]
	if first := retry.Messages[2].Text; strings.Contains(first, strings.Repeat("r", 3000)) || !strings.Contains(retry.Messages[4].Text, strings.Repeat("r", 3000)) {
		t.Fatalf("the retry did not clear the older output: %.100s", first)
	}
}

// A prompt refused again, or with nothing to free, ends the turn with the
// provider's error and a way to make room.
func TestRefusedPromptEndsTheTurnWhenItCannotShrink(t *testing.T) {
	s, id, m := turnFixture(t)
	model := &refusing{limit: 0}
	err := Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil })
	if !errors.Is(err, llm.ErrContextOverflow) || !strings.Contains(err.Error(), "/compact") || len(model.requests) != 1 {
		t.Fatalf("%d requests: %v", len(model.requests), err)
	}
	s, id, m = longHistory(t, 10)
	model = &refusing{limit: 1500}
	err = Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil })
	if !errors.Is(err, llm.ErrContextOverflow) || len(model.requests) != 2 {
		t.Fatalf("%d requests: %v", len(model.requests), err)
	}
}
