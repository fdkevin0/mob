package chat

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/sandbox"
)

// Sandbox runs commands where they cannot reach the host; package sandbox
// implements it. With one configured, the model may run anything there
// without asking.
type Sandbox interface {
	Exec(ctx context.Context, conversationID, command string, timeout time.Duration) (sandbox.Result, error)
}

var tools = []llm.Tool{
	{Name: "datetime", Description: "Get current date and time in an optional IANA timezone.", Parameters: map[string]any{"type": "object", "properties": map[string]any{"timezone": map[string]any{"type": "string"}}, "additionalProperties": false}},
	{Name: "remember", Description: "Request permission to save one durable fact locally for this conversation. Stops the turn until the user approves.", Parameters: map[string]any{"type": "object", "properties": map[string]any{"fact": map[string]any{"type": "string"}}, "required": []string{"fact"}, "additionalProperties": false}},
}

var sandboxTool = llm.Tool{
	Name: "sandbox",
	Description: "Run a shell command (sh -c) in an isolated Linux container. Anything is allowed there: install packages, run code, use the network. " +
		"Only /workspace, the working directory, persists between calls in this conversation; the user's own files and machine are not reachable.",
	Parameters: map[string]any{"type": "object", "properties": map[string]any{
		"command": map[string]any{"type": "string"},
		"timeout": map[string]any{"type": "integer", "minimum": 1, "maximum": int(sandbox.MaxTimeout / time.Second), "description": "Seconds; default " + fmt.Sprint(int(sandbox.DefaultTimeout/time.Second))},
	}, "required": []string{"command"}, "additionalProperties": false},
}

func executeTool(ctx context.Context, store *Store, box Sandbox, conversationID string, message *Message, call llm.ToolCall, part Part, input map[string]any, send func(Event) error) (any, bool, error, error) {
	var output any
	var toolErr error
	switch call.Name {
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
	case "sandbox":
		if box == nil {
			return nil, false, errors.New("the sandbox is disabled"), nil
		}
		command, _ := input["command"].(string)
		seconds, _ := input["timeout"].(float64)
		result, e := box.Exec(ctx, conversationID, command, time.Duration(seconds)*time.Second)
		if e != nil {
			if ctx.Err() != nil {
				return nil, false, nil, ctx.Err()
			}
			return nil, false, e, nil
		}
		output = result
	default:
		toolErr = fmt.Errorf("unsupported tool: %s", call.Name)
	}
	return output, false, toolErr, nil
}
