package chat

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

var tools = []any{
	map[string]any{"type": "function", "function": map[string]any{"name": "datetime", "description": "Get current date and time in an optional IANA timezone.", "parameters": map[string]any{"type": "object", "properties": map[string]any{"timezone": map[string]any{"type": "string"}}, "additionalProperties": false}}},
	map[string]any{"type": "function", "function": map[string]any{"name": "remember", "description": "Request permission to save one durable fact locally for this conversation. Stops the turn until the user approves.", "parameters": map[string]any{"type": "object", "properties": map[string]any{"fact": map[string]any{"type": "string"}}, "required": []string{"fact"}, "additionalProperties": false}}},
}

func executeTool(store *Store, conversationID string, message *Message, call ToolCall, part Part, input map[string]any, send func(Event) error) (any, bool, error, error) {
	var output any
	var toolErr error
	switch call.Function.Name {
	case "datetime":
		zone, _ := input["timezone"].(string)
		if zone == "" {
			zone = "Asia/Shanghai"
		}
		loc, e := time.LoadLocation(zone)
		if e != nil {
			zone = "UTC"
			loc = time.UTC
		}
		now := time.Now()
		output = map[string]string{"iso": now.UTC().Format(time.RFC3339), "readable": now.In(loc).Format(time.RFC3339), "timezone": zone}
	case "remember":
		fact, ok := input["fact"].(string)
		fact = strings.TrimSpace(fact)
		if !ok || fact == "" || len(fact) > 2000 {
			return nil, false, errors.New("fact must be 1–2000 bytes"), nil
		}
		part["input"] = map[string]string{"fact": fact}
		approvalID, e := store.RequestApproval(conversationID, *message, call.ID, part["input"])
		if e != nil {
			return nil, false, nil, e
		}
		if err := send(Event{Kind: ApprovalRequested, ApprovalID: approvalID, ToolCallID: call.ID}); err != nil {
			return nil, false, nil, err
		}
		return nil, true, nil, nil
	default:
		toolErr = fmt.Errorf("unsupported tool: %s", call.Function.Name)
	}
	return output, false, toolErr, nil
}
