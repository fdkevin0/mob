package chat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// PendingApproval is a tool call waiting for the user's decision.
type PendingApproval struct {
	ID   string
	Tool string
	// Input is what the user is asked to approve.
	Input any
}

// Pending lists the conversation's tool calls awaiting a decision, oldest first.
func (s *ConversationService) Pending(id string) []PendingApproval {
	if id == "" {
		return nil
	}
	history, err := s.Store.History(id)
	if err != nil {
		return nil
	}
	var list []PendingApproval
	for _, m := range history {
		for _, p := range m.Parts {
			if p["state"] != "approval-requested" {
				continue
			}
			var approval string
			switch a := p["approval"].(type) {
			case map[string]any:
				approval = fmt.Sprint(a["id"])
			case map[string]string:
				approval = a["id"]
			}
			if approval != "" {
				list = append(list, PendingApproval{ID: approval, Tool: strings.TrimPrefix(fmt.Sprint(p["type"]), "tool-"), Input: p["input"]})
			}
		}
	}
	return list
}

// approvalField bounds each input field a summary shows, in runes.
const approvalField = 600

// DescribeApproval is a plain-text summary of what a call asks the user to
// approve, for channels that cannot show the web UI's card: the tool, then
// one "field: value" line per input field in the order the tool gave them.
func DescribeApproval(tool string, input any) string {
	var b strings.Builder
	b.WriteString(tool)
	raw, err := json.Marshal(input)
	if err != nil || bytes.Equal(raw, []byte("null")) {
		return b.String()
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		b.WriteString("\n" + clip(string(raw)))
		return b.String()
	}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			break
		}
		var value json.RawMessage
		if dec.Decode(&value) != nil {
			break
		}
		var text string
		if json.Unmarshal(value, &text) != nil {
			text = string(value)
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		fmt.Fprintf(&b, "\n%s: %s", key, clip(text))
	}
	return b.String()
}

func clip(text string) string {
	if runes := []rune(text); len(runes) > approvalField {
		return string(runes[:approvalField]) + "…"
	}
	return text
}
