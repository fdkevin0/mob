package chat

import (
	"strings"
	"testing"
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
