package chat

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/llm"
)

// summarizing answers turns with "ok" and summaries with what they fold in.
type summarizing struct {
	info llm.Info
	fail bool
	// long, when set, is every summary written.
	long      string
	requests  []llm.Request
	summaries []llm.Request
}

func (m *summarizing) Ref() llm.Ref   { return llm.Ref{Provider: "test", Model: "summarizing"} }
func (m *summarizing) Info() llm.Info { return m.info }
func (m *summarizing) Stream(_ context.Context, req llm.Request, _ func(string, string) error) (llm.Result, error) {
	if !strings.HasPrefix(req.System, compactPrompt) {
		m.requests = append(m.requests, req)
		return llm.Result{Text: "ok"}, nil
	}
	m.summaries = append(m.summaries, req)
	if m.fail {
		return llm.Result{}, errors.New("summary failed")
	}
	if m.long != "" {
		return llm.Result{Text: m.long}, nil
	}
	return llm.Result{Text: fmt.Sprintf("SUMMARY %d", len(m.summaries)), Usage: &llm.Usage{Input: 100, Output: 10}}, nil
}

// longHistory adds n user messages of about 1000 tokens each, numbered, and
// begins a turn after them.
func longHistory(t *testing.T, n int) (*Store, string, Message) {
	s, id, m := turnFixture(t)
	for i := range n {
		m, _ = s.Begin(id, NewID(), fmt.Sprintf("msg-%d ", i)+strings.Repeat("x", 3000), "test/summarizing")
	}
	return s, id, m
}

func TestHistoryIsSummarizedNotOmitted(t *testing.T) {
	s, id, m := longHistory(t, 30)
	first := m.ID
	model := &summarizing{info: llm.Info{ID: "summarizing", Context: 20000, Output: 1000}}
	if err := Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(model.summaries) == 0 || !strings.Contains(model.summaries[0].Messages[0].Text, "msg-0 ") {
		t.Fatalf("older messages were not summarized: %d summaries", len(model.summaries))
	}
	req := model.requests[0]
	if !strings.Contains(req.System, summaryNotice+"SUMMARY") || strings.Contains(req.System, "omitted") || strings.Contains(req.Messages[0].Text, "msg-0 ") {
		t.Fatalf("the turn did not read the summary in place of older messages: %.300s", req.System)
	}
	if size := tokens(req.System) + promptTokens(req.Messages); size > 20000-req.MaxTokens {
		t.Fatalf("prompt of about %d tokens exceeds the window", size)
	}
	// Recent messages fill at most half the room, so the next turn reads the
	// stored summary without summarizing again.
	if size := promptTokens(req.Messages); size > 20000/2 {
		t.Fatalf("recent messages take %d tokens after summarizing", size)
	}
	summary, _ := s.Summary(id)
	if !strings.HasPrefix(summary.Text, "SUMMARY") || summary.Through == "" {
		t.Fatalf("summary not stored: %+v", summary)
	}
	m, _ = s.Begin(id, NewID(), "and then?", "test/summarizing")
	before := len(model.summaries)
	if err := Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(model.summaries) != before || !strings.Contains(model.requests[1].System, summary.Text) {
		t.Fatalf("the next turn summarized again or lost the summary")
	}
	// What summarizing cost is charged to the turn that did it.
	history, _ := s.History(id)
	for _, h := range history {
		if h.ID == first && (h.Usage == nil || h.Usage.Input < 100) {
			t.Fatalf("summarizing was not charged to its turn: %+v", h.Usage)
		}
	}
}

// A window too small for everything to summarize at once gets it in parts,
// each request within the window, each folding into the summary so far.
func TestSummaryIsWrittenInPartsThatFit(t *testing.T) {
	s, id, m := longHistory(t, 60)
	model := &summarizing{info: llm.Info{ID: "summarizing", Context: 12000, Output: 4000}}
	if err := Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(model.summaries) < 2 || !strings.Contains(model.summaries[1].Messages[0].Text, "Summary so far:\nSUMMARY 1") {
		t.Fatalf("summary was not written in parts: %d requests", len(model.summaries))
	}
	for i, req := range model.summaries {
		if size := tokens(req.System) + promptTokens(req.Messages); size+req.MaxTokens > 12000 {
			t.Fatalf("summary request %d of about %d tokens and %d to write exceeds the window", i+1, size, req.MaxTokens)
		}
	}
	if !strings.Contains(model.requests[0].System, "SUMMARY "+fmt.Sprint(len(model.summaries))) {
		t.Fatal("the turn did not read the last summary")
	}
}

func TestFailedSummaryOmitsInstead(t *testing.T) {
	s, id, m := longHistory(t, 30)
	model := &summarizing{info: llm.Info{ID: "summarizing", Context: 20000, Output: 1000}, fail: true}
	if err := Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(model.requests[0].System, "omitted") || strings.Contains(model.requests[0].System, summaryNotice) {
		t.Fatalf("a failed summary was used: %.200s", model.requests[0].System)
	}
	if summary, _ := s.Summary(id); summary.Text != "" || summary.Through != "" {
		t.Fatalf("a failed summary was stored: %+v", summary)
	}
}

// Each message is fitted against the summary it is read with, which can
// grow as parts are folded in.
func TestSummaryPartsFitAsTheSummaryGrows(t *testing.T) {
	model := &summarizing{info: llm.Info{ID: "summarizing", Context: 10000, Output: 4000}, long: strings.Repeat("s", 11970)}
	var messages []Message
	for i := range 3 {
		messages = append(messages, Message{ID: NewID(), Role: "user", Parts: []Part{{"type": "text", "text": fmt.Sprint(i) + strings.Repeat("x", 30000)}}})
	}
	if _, _, err := summarize(context.Background(), model, "", messages, summaryTokens); err != nil {
		t.Fatal(err)
	}
	if len(model.summaries) < 2 {
		t.Fatalf("summarized in %d parts", len(model.summaries))
	}
	for i, req := range model.summaries {
		if size := tokens(req.System) + promptTokens(req.Messages); size+req.MaxTokens > 10000 {
			t.Fatalf("summary request %d of about %d tokens and %d to write exceeds the window", i+1, size, req.MaxTokens)
		}
	}
}

// A summary too large for the model the conversation switched to is set
// aside for the turn rather than leaving no room for it.
func TestOversizedSummaryIsSetAside(t *testing.T) {
	s, id, m := turnFixture(t)
	if err := s.Summarize(id, Summary{Text: strings.Repeat("s", 9000), Through: m.ID}); err != nil {
		t.Fatal(err)
	}
	m, _ = s.Begin(id, NewID(), "hi", "test/summarizing")
	model := &summarizing{info: llm.Info{ID: "summarizing", Context: 3000, Output: 500}}
	if err := Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	req := model.requests[0]
	if strings.Contains(req.System, summaryNotice) || req.Messages[len(req.Messages)-1].Text != "hi" {
		t.Fatalf("the oversized summary was read: %d messages", len(req.Messages))
	}
	if summary, _ := s.Summary(id); len(summary.Text) != 9000 {
		t.Fatal("the stored summary was lost")
	}
}

// A summary is no longer than leaves room for the latest message, and one
// that turns out longer is not used for the turn, which omits instead.
func TestSummaryLeavesRoomForTheLatestMessage(t *testing.T) {
	for _, long := range []string{"", strings.Repeat("s", 11970)} {
		s, id, m := longHistory(t, 10)
		m, _ = s.Begin(id, NewID(), strings.Repeat("y", 18000), "test/summarizing")
		model := &summarizing{info: llm.Info{ID: "summarizing", Context: 10000, Output: 4000}, long: long}
		if err := Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil }); err != nil {
			t.Fatalf("summary of %d bytes: %v", len(long), err)
		}
		if len(model.summaries) == 0 || model.summaries[0].MaxTokens >= summaryTokens {
			t.Fatalf("summaries were not bounded by the latest message: %d", len(model.summaries))
		}
		req := model.requests[0]
		if req.Messages[len(req.Messages)-1].Text != strings.Repeat("y", 18000) {
			t.Fatal("the turn did not read the latest message")
		}
		if used := strings.Contains(req.System, summaryNotice); used == (long != "") {
			t.Fatalf("summary of %d bytes used: %v", len(long), used)
		}
	}
}

// A stored summary that fits the window but not beside the latest message is
// set aside for the turn.
func TestStoredSummaryLeavesRoomForTheLatestMessage(t *testing.T) {
	s, id, m := turnFixture(t)
	if err := s.Summarize(id, Summary{Text: strings.Repeat("s", 9000), Through: m.ID}); err != nil {
		t.Fatal(err)
	}
	m, _ = s.Begin(id, NewID(), strings.Repeat("y", 18000), "test/summarizing")
	model := &summarizing{info: llm.Info{ID: "summarizing", Context: 10000, Output: 4000}}
	if err := Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(model.requests[0].System, summaryNotice) {
		t.Fatal("the stored summary crowded out the latest message")
	}
}

// A summary written to fit a turn is read again on the next one rather than
// written anew.
func TestSummaryThatFitsIsReused(t *testing.T) {
	s, id, m := longHistory(t, 10)
	m, _ = s.Begin(id, NewID(), strings.Repeat("y", 9000), "test/summarizing")
	model := &summarizing{info: llm.Info{ID: "summarizing", Context: 10000, Output: 4000}, long: strings.Repeat("s", 11400)}
	if err := Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if summary, _ := s.Summary(id); len(summary.Text) != 11400 {
		t.Fatalf("the summary was not stored: %d bytes", len(summary.Text))
	}
	before := len(model.summaries)
	m, _ = s.Begin(id, NewID(), "continue", "test/summarizing")
	if err := Run(context.Background(), s, model, Agent{}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(model.summaries) != before || !strings.Contains(model.requests[1].System, summaryNotice) {
		t.Fatalf("the stored summary was written again in %d requests", len(model.summaries)-before)
	}
}

// A call that changes after it was summarized, here an approval that expired,
// drops the summary, so the model reads the call as it is now.
func TestSummaryOfAChangedCallIsDropped(t *testing.T) {
	s, id, m := turnFixture(t)
	service := NewConversation(s, nil)
	service.Tools.Register(echoTool("deploy", func(_ context.Context, call ToolCall) (any, error) {
		return nil, call.RequestApproval(map[string]string{"target": "prod"})
	}))
	var approval string
	err := Run(context.Background(), s, &scripted{call: llm.ToolCall{ID: "c1", Name: "deploy", Arguments: `{}`}}, service.agent(true), id, m, "", func(e Event) error {
		if e.Kind == ApprovalRequested {
			approval = e.ApprovalID
		}
		return nil
	})
	if err != nil || approval == "" {
		t.Fatalf("request: %v", err)
	}
	if err = s.Summarize(id, Summary{Text: "deploy is waiting for approval", Through: m.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("UPDATE approvals SET expires_at=0 WHERE id=?", approval); err != nil {
		t.Fatal(err)
	}
	if err = s.ExpireApprovals(id); err != nil {
		t.Fatal(err)
	}
	if summary, _ := s.Summary(id); summary.Text != "" || summary.Through != "" {
		t.Fatalf("the summary still tells of the waiting call: %+v", summary)
	}
}
