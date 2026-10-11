package chat

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/fdkevin0/mob/internal/llm"
)

func TestRememberedApprovals(t *testing.T) {
	s, id, _ := turnFixture(t)
	other, _ := s.Create()
	service := NewConversation(s, nil)
	runs := 0
	tool := echoTool("deploy", func(_ context.Context, call ToolCall) (any, error) {
		return nil, call.RequestApproval(map[string]any{"target": call.Input["target"]})
	})
	tool.Approved = func(_ context.Context, call ApprovedCall) (any, error) {
		runs++
		return map[string]any{"deployed": string(call.Input)}, nil
	}
	tool.Scope = func(input json.RawMessage) string {
		var in struct{ Target string }
		json.Unmarshal(input, &in)
		return "to " + in.Target
	}
	service.Tools.Register(tool)
	// call runs one turn that calls deploy and returns the approval it
	// requested, or "" when the call ran without asking.
	call := func(conversation string, owner bool, target string) string {
		t.Helper()
		m, err := s.Begin(conversation, NewID(), "go", "test/scripted")
		if err != nil {
			t.Fatal(err)
		}
		approval := ""
		err = Run(context.Background(), s, &scripted{call: llm.ToolCall{ID: NewID(), Name: "deploy", Arguments: `{"target":"` + target + `"}`}}, service.agent(owner), conversation, m, "", func(e Event) error {
			if e.Kind == ApprovalRequested {
				approval = e.ApprovalID
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return approval
	}

	approval := call(id, true, "prod")
	if approval == "" {
		t.Fatal("ran before any approval")
	}
	d, err := s.Decide(id, approval, true, "")
	if err != nil {
		t.Fatal(err)
	}
	if err = service.remember(id, d, RememberConversation); err != nil {
		t.Fatal(err)
	}
	if _, err = service.carryOut(context.Background(), id, d, true); err != nil || runs != 1 {
		t.Fatalf("approved call: %d %v", runs, err)
	}
	if call(id, true, "prod") != "" || runs != 2 {
		t.Fatalf("a remembered approval still asked: %d runs", runs)
	}
	history, _ := s.History(id)
	last := history[len(history)-1].Parts
	if part := last[len(last)-2]; part["state"] != "output-available" {
		t.Fatalf("remembered call not recorded as run: %v", part)
	}
	for _, c := range []struct {
		name, conversation, target string
		owner                      bool
	}{
		{"another scope", id, "staging", true},
		{"another caller", id, "prod", false},
		{"another conversation", other.ID, "prod", true},
	} {
		if call(c.conversation, c.owner, c.target) == "" {
			t.Fatalf("%s ran without asking", c.name)
		}
	}
	if err = s.AddGrant("", "deploy", "to prod"); err != nil {
		t.Fatal(err)
	}
	if call(other.ID, true, "prod") != "" {
		t.Fatal("an approval remembered always still asked in another conversation")
	}
	grants, err := s.Grants()
	if err != nil || len(grants) != 2 || grants[0].ConversationID != id || grants[1].ConversationID != "" || grants[0].Scope != "to prod" {
		t.Fatalf("grants: %+v %v", grants, err)
	}
	if n, err := s.Revoke("all"); n != 2 || err != nil {
		t.Fatalf("revoke: %d %v", n, err)
	}
	if call(id, true, "prod") == "" {
		t.Fatal("a revoked approval still ran without asking")
	}
}

func TestRememberNeedsOwnerAndApproval(t *testing.T) {
	s, id, _ := turnFixture(t)
	service := NewConversation(s, nil)
	for _, c := range []struct {
		answer Answer
		owner  bool
		status int
	}{
		{Answer{ID: NewID(), Approved: false, Remember: RememberAlways}, true, 400},
		{Answer{ID: NewID(), Approved: true, Remember: "forever"}, true, 400},
		{Answer{ID: NewID(), Approved: true, Remember: RememberAlways}, false, 403},
	} {
		answer := c.answer
		err := service.Execute(context.Background(), ChatRequest{ID: id, Approval: &answer, Owner: c.owner}, func(Event) error { return nil })
		var command *CommandError
		if !errors.As(err, &command) || command.Status != c.status {
			t.Fatalf("%+v owner=%v: %v", c.answer, c.owner, err)
		}
	}
}
