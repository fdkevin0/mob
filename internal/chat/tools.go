package chat

import (
	"context"
	"errors"
	"fmt"
	"slices"
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

// Tool is one function the model may call: its definition, what it adds to
// the system prompt when offered, and how it runs.
type Tool struct {
	llm.Tool
	Prompt string
	// Run's output goes back to the model; so does its error, unless it is
	// ErrAwaitingApproval or made by Abort.
	Run func(ctx context.Context, call ToolCall) (any, error)
}

// ToolCall is one invocation of a tool within a turn.
type ToolCall struct {
	llm.ToolCall
	ConversationID string
	Input          map[string]any
	// Part is the call as stored in Message; a tool may change what it records.
	Part    Part
	Message *Message
	Store   *Store
	Send    func(Event) error
}

// ErrAwaitingApproval ends the turn after a tool has requested approval; the
// call completes when the user decides.
var ErrAwaitingApproval = errors.New("awaiting approval")

type abort struct{ err error }

func (a abort) Error() string { return a.err.Error() }
func (a abort) Unwrap() error { return a.err }

// Abort makes a tool's error end the turn instead of going to the model.
func Abort(err error) error { return abort{err} }

// ToolRegistry holds the tools every turn offers. Register all tools before serving.
type ToolRegistry struct{ tools []Tool }

func (r *ToolRegistry) Register(tools ...Tool) {
	for _, t := range tools {
		if t.Name == "" || t.Run == nil {
			panic("tool needs a name and Run: " + t.Name)
		}
		if slices.ContainsFunc(r.tools, func(o Tool) bool { return o.Name == t.Name }) {
			panic("tool registered twice: " + t.Name)
		}
		r.tools = append(r.tools, t)
	}
}

// List is the registered tools in registration order.
func (r *ToolRegistry) List() []Tool { return slices.Clone(r.tools) }

// DefaultTools are the tools every conversation offers.
func DefaultTools() []Tool {
	return []Tool{
		{
			Tool: llm.Tool{Name: "datetime", Description: "Get current date and time in an optional IANA timezone.", Parameters: map[string]any{"type": "object", "properties": map[string]any{"timezone": map[string]any{"type": "string"}}, "additionalProperties": false}},
			Run:  datetime,
		},
		{
			Tool: llm.Tool{Name: "remember", Description: "Request permission to save one durable fact locally for this conversation. Stops the turn until the user approves.", Parameters: map[string]any{"type": "object", "properties": map[string]any{"fact": map[string]any{"type": "string"}}, "required": []string{"fact"}, "additionalProperties": false}},
			Run:  remember,
		},
	}
}

func datetime(_ context.Context, call ToolCall) (any, error) {
	zone, _ := call.Input["timezone"].(string)
	if zone == "" {
		zone = "Asia/Shanghai"
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		zone = "UTC"
		loc = time.UTC
	}
	now := time.Now()
	return map[string]string{"iso": now.UTC().Format(time.RFC3339), "readable": now.In(loc).Format(time.RFC3339), "timezone": zone}, nil
}

func remember(_ context.Context, call ToolCall) (any, error) {
	fact, ok := call.Input["fact"].(string)
	fact = strings.TrimSpace(fact)
	if !ok || fact == "" || len(fact) > 2000 {
		return nil, errors.New("fact must be 1–2000 bytes")
	}
	call.Part["input"] = map[string]string{"fact": fact}
	approvalID, err := call.Store.RequestApproval(call.ConversationID, *call.Message, call.ID, call.Part["input"])
	if err != nil {
		return nil, Abort(err)
	}
	if err := call.Send(Event{Kind: ApprovalRequested, ApprovalID: approvalID, ToolCallID: call.ID}); err != nil {
		return nil, Abort(err)
	}
	return nil, ErrAwaitingApproval
}

// offline is implemented by a sandbox whose commands have no network.
type offline interface{ Offline() bool }

// sandboxTool runs commands in box and describes it to the model, so it does
// not try the network where there is none.
func sandboxTool(box Sandbox) Tool {
	allowed := "Anything is allowed there: install packages, run code, use the network. "
	if o, ok := box.(offline); ok && o.Offline() {
		allowed = "Anything is allowed there, but it has no network: packages cannot be downloaded, so use what the image provides. "
	}
	return Tool{
		Tool: llm.Tool{
			Name: "sandbox",
			Description: "Run a shell command (sh -c) in an isolated Linux container. " + allowed +
				"Only /workspace, the working directory, persists between calls in this conversation; the user's own files and machine are not reachable.",
			Parameters: map[string]any{"type": "object", "properties": map[string]any{
				"command": map[string]any{"type": "string"},
				"timeout": map[string]any{"type": "integer", "minimum": 1, "maximum": int(sandbox.MaxTimeout / time.Second), "description": "Seconds; default " + fmt.Sprint(int(sandbox.DefaultTimeout/time.Second))},
			}, "required": []string{"command"}, "additionalProperties": false},
		},
		Prompt: "Use the sandbox tool for any command, code or file work; it is isolated, so it needs no permission.",
		Run: func(ctx context.Context, call ToolCall) (any, error) {
			command, _ := call.Input["command"].(string)
			seconds, _ := call.Input["timeout"].(float64)
			return box.Exec(ctx, call.ConversationID, command, time.Duration(seconds)*time.Second)
		},
	}
}
