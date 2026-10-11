package protocol

import (
	"encoding/json"
	"testing"

	"github.com/fdkevin0/mob/internal/chat"
)

func TestApprovalChunkNamesOnlyTheApproval(t *testing.T) {
	raw, _ := json.Marshal(Encode(chat.Event{Kind: chat.ApprovalRequested, ApprovalID: "a", ToolCallID: "c", ToolName: "email_send", Input: map[string]string{"to": "x"}}))
	if want := `{"type":"tool-approval-request","toolCallId":"c","approvalId":"a"}`; string(raw) != want {
		t.Fatalf("got %s", raw)
	}
}
