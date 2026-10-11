package chat

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/llm"
)

func TestDescribeApproval(t *testing.T) {
	type mail struct {
		To      string `json:"to"`
		Subject string `json:"subject"`
		Text    string `json:"text"`
		Sender  string `json:"sender,omitempty"`
		Count   int    `json:"count"`
	}
	got := DescribeApproval("email_send", mail{To: "a@example.com", Subject: "Hi", Text: strings.Repeat("x", approvalField+5), Count: 2})
	want := "email_send\nto: a@example.com\nsubject: Hi\ntext: " + strings.Repeat("x", approvalField) + "…\ncount: 2"
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	if got := DescribeApproval("t", nil); got != "t" {
		t.Fatalf("nil input: %q", got)
	}
	if got := DescribeApproval("t", []int{1}); got != "t\n[1]" {
		t.Fatalf("array input: %q", got)
	}
}

func TestExpiredApprovalsStopWaiting(t *testing.T) {
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
	if err != nil || len(service.Pending(id)) != 1 {
		t.Fatalf("request: %v %+v", err, service.Pending(id))
	}
	if _, err = s.db.Exec("UPDATE approvals SET expires_at=0 WHERE id=?", approval); err != nil {
		t.Fatal(err)
	}
	if p := service.Pending(id); len(p) != 0 {
		t.Fatalf("an expired approval is still pending: %+v", p)
	}
	history, _ := s.History(id)
	part := history[len(history)-1].Parts[0]
	if part["state"] != "output-error" || part["errorText"] != expiredApproval || outcome(part) != `{"error":"`+expiredApproval+`"}` {
		t.Fatalf("expired call: %v", part)
	}
	if _, err = s.Decide(id, approval, true, ""); !errors.Is(err, ErrStaleApproval) {
		t.Fatalf("decided an expired approval: %v", err)
	}
}
