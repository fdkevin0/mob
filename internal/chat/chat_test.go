package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/llm/demo"
	"github.com/fdkevin0/mob/internal/llm/openai"
	"github.com/fdkevin0/mob/internal/sandbox"
)

func TestPersistenceApprovalAndRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.sqlite")
	s, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if s != nil {
			s.Close()
		}
	})
	if other, err := OpenStore(path); err == nil {
		other.Close()
		t.Fatal("second process acquired live database")
	}
	c, err := s.Create()
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.Begin(c.ID, "request-1", "/remember 喜欢中文", "demo/echo")
	if err != nil {
		t.Fatal(err)
	}
	var events []Event
	err = Run(context.Background(), s, demo.Model{}, Agent{Tools: DefaultTools()}, c.ID, m, "", func(e Event) error { events = append(events, e); return nil })
	if err != nil {
		t.Fatal(err)
	}
	var approval string
	for _, e := range events {
		if e.Kind == ApprovalRequested {
			approval = e.ApprovalID
		}
	}
	if approval == "" {
		t.Fatal("missing approval event")
	}
	if facts, _ := s.Memories(c.ID, false); len(facts) != 0 {
		t.Fatal("executed without approval")
	}
	if _, err = s.Decide(NewID(), approval, true, ""); !errors.Is(err, ErrStaleApproval) {
		t.Fatalf("cross-conversation approval: %v", err)
	}
	decision, err := s.Decide(c.ID, approval, true, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Decide(c.ID, approval, true, ""); !errors.Is(err, ErrStaleApproval) {
		t.Fatalf("repeated approval: %v", err)
	}
	if facts, _ := s.Memories(c.ID, false); len(facts) != 0 {
		t.Fatal("deciding carried out the call")
	}
	if note, err := NewConversation(s, nil).carryOut(context.Background(), c.ID, decision, true); err != nil || !strings.Contains(note, `approved remember and it ran. Result: {"saved":true}`) {
		t.Fatalf("carry out: %q %v", note, err)
	}
	facts, err := s.Memories(c.ID, false)
	if err != nil || len(facts) != 1 || facts[0] != "喜欢中文" {
		t.Fatalf("facts %v, %v", facts, err)
	}
	if _, err = s.Begin(c.ID, "request-1", "duplicate", ""); err == nil {
		t.Fatal("duplicate request accepted")
	}
	history, err := s.History(c.ID)
	if err != nil || len(history) != 2 {
		t.Fatalf("history: %v %v", history, err)
	}
	if history[1].Parts[0]["state"] != "output-available" {
		t.Fatal("approval UI state not persisted")
	}
	m, err = s.Begin(c.ID, "interrupted", "hello", "")
	if err != nil {
		t.Fatal(err)
	}
	m.Parts = []Part{{"type": "text", "text": "partial"}}
	if err = s.Save(m, "streaming", ""); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s = nil
	s, err = OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	history, err = s.History(c.ID)
	if err != nil {
		t.Fatal(err)
	}
	last := history[len(history)-1]
	if Text(last) != "partial" || last.Metadata["status"] != "interrupted" {
		t.Fatalf("recovery lost state: %+v", last)
	}
}

func TestDenialAndExpiry(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, _ := s.Create()
	for _, action := range []string{"deny", "expire"} {
		m, err := s.Begin(c.ID, NewID(), "remember", "")
		if err != nil {
			t.Fatal(err)
		}
		m.Parts = []Part{{"type": "tool-remember", "toolCallId": "call", "input": map[string]string{"fact": "test"}}}
		id, err := s.RequestApproval(c.ID, m, "call", map[string]string{"fact": "test"})
		if err != nil {
			t.Fatal(err)
		}
		if action == "expire" {
			if _, err = s.db.Exec("UPDATE approvals SET expires_at=0 WHERE id=?", id); err != nil {
				t.Fatal(err)
			}
			if _, err = s.Decide(c.ID, id, true, ""); !errors.Is(err, ErrStaleApproval) {
				t.Fatal(err)
			}
		} else {
			if _, err = s.Decide(c.ID, id, false, ""); err != nil {
				t.Fatal(err)
			}
		}
	}
	facts, err := s.Memories(c.ID, false)
	if err != nil || len(facts) != 0 {
		t.Fatalf("denied/expired wrote facts: %v %v", facts, err)
	}
}

func TestEngineContinuesAfterTool(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Role       string `json:"role"`
				Content    string `json:"content"`
				ToolCallID string `json:"tool_call_id"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if calls.Add(1) == 1 {
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"clock","function":{"name":"datetime","arguments":"{\"timezone\":\"Asia/Shanghai\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\n")
		} else {
			last := body.Messages[len(body.Messages)-1]
			if last.Role != "tool" || last.ToolCallID != "clock" || !strings.Contains(last.Content, "Asia/Shanghai") {
				t.Errorf("missing tool result: %+v", last)
			}
			fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"Time checked."},"finish_reason":"stop"}]}`+"\n\n")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, _ := s.Create()
	m, err := s.Begin(c.ID, NewID(), "What time is it?", "test/test")
	if err != nil {
		t.Fatal(err)
	}
	model := openai.New(llm.Ref{Provider: "test", Model: "test"}, llm.Info{ID: "test", Tools: true}, openai.Config{BaseURL: upstream.URL, Key: "test"})
	err = Run(context.Background(), s, model, Agent{Tools: DefaultTools()}, c.ID, m, "", func(Event) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	history, err := s.History(c.ID)
	if err != nil {
		t.Fatal(err)
	}
	last := history[len(history)-1]
	if calls.Load() != 2 || last.Parts[0]["state"] != "output-available" || Text(last) != "Time checked." {
		t.Fatalf("bad tool continuation: %+v", last)
	}
}

type fakeSandbox struct{ conversation, command string }

func (f *fakeSandbox) Exec(_ context.Context, conversationID, command string, _ time.Duration) (sandbox.Result, error) {
	f.conversation, f.command = conversationID, command
	return sandbox.Result{ExitCode: 0, Stdout: "Linux\n"}, nil
}

type offlineSandbox struct{ fakeSandbox }

func (offlineSandbox) Offline() bool { return true }

func TestSandboxToolSaysWhenOffline(t *testing.T) {
	if d := sandboxTool(&fakeSandbox{}).Description; !strings.Contains(d, "use the network") {
		t.Fatalf("online description: %q", d)
	}
	if d := sandboxTool(&offlineSandbox{}).Description; !strings.Contains(d, "no network") || strings.Contains(d, "use the network") {
		t.Fatalf("offline description: %q", d)
	}
}

func TestSandboxRunsWithoutApproval(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, _ := s.Create()
	m, _ := s.Begin(c.ID, NewID(), "/sandbox uname", "demo/echo")
	// Without a sandbox the tool is not offered, so the demo model just echoes.
	if err = Run(context.Background(), s, demo.Model{}, Agent{Tools: DefaultTools()}, c.ID, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	m, _ = s.Begin(c.ID, NewID(), "/sandbox uname", "demo/echo")
	box := &fakeSandbox{}
	var kinds []EventKind
	if err = Run(context.Background(), s, demo.Model{}, Agent{Tools: append(DefaultTools(), sandboxTool(box))}, c.ID, m, "", func(e Event) error { kinds = append(kinds, e.Kind); return nil }); err != nil {
		t.Fatal(err)
	}
	history, _ := s.History(c.ID)
	last := history[len(history)-1]
	if box.conversation != c.ID || box.command != "uname" || last.Parts[0]["state"] != "output-available" || !strings.Contains(Text(last), "Linux") {
		t.Fatalf("sandbox call: %+v %+v", box, last)
	}
	for _, k := range kinds {
		if k == ApprovalRequested {
			t.Fatal("sandbox asked for approval")
		}
	}
}

func TestOwnerFactsAreReadInEveryOwnerConversation(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var ids []string
	for range 3 {
		c, err := s.Create()
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, c.ID)
	}
	owned, other, elsewhere := ids[0], ids[1], ids[2]
	if err := s.SaveFact("a", owned, "prefers Go", true); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveFact("b", other, "a guest's fact", false); err != nil {
		t.Fatal(err)
	}
	service := NewConversation(s, nil)
	read := func(id string, owner bool) string {
		turn := &Turn{ConversationID: id, Owner: owner, Request: &llm.Request{}}
		if err := service.recall(context.Background(), turn); err != nil {
			t.Fatal(err)
		}
		return turn.Request.System
	}
	if got := read(elsewhere, true); !strings.Contains(got, "prefers Go") || strings.Contains(got, "guest") {
		t.Fatalf("owner turn elsewhere read %q", got)
	}
	if got := read(elsewhere, false); got != "" {
		t.Fatalf("another caller's turn read %q", got)
	}
	if got := read(other, false); !strings.Contains(got, "guest") || strings.Contains(got, "prefers Go") {
		t.Fatalf("guest conversation read %q", got)
	}
	listed, err := service.listFacts(context.Background(), CommandCall{})
	if err != nil || !strings.Contains(listed.Markdown, "all your conversations") || !strings.Contains(listed.Markdown, "`/forget b`") {
		t.Fatalf("listed %q %v", listed.Markdown, err)
	}
	if n, err := s.Forget("a"); n != 1 || err != nil {
		t.Fatalf("forget: %d %v", n, err)
	}
	if got := read(elsewhere, true); got != "" {
		t.Fatalf("forgotten fact read: %q", got)
	}
}
