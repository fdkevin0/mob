package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/llm"
)

const (
	// outputCap bounds a reply; unknownOutput is used when the catalog gives no limit.
	outputCap     = 8192
	unknownOutput = 4096
	// recentMessages bounds history for models whose context window is unknown.
	recentMessages = 40
)

// systemPrompt starts every turn's instructions; tools and hooks add to it.
const systemPrompt = "You are Mob, a concise personal assistant. Reply in the user's language. Only claim a tool succeeded if its result says so. A tool call that asks for the user's approval ends the current turn."

// Agent is what a turn uses besides its model: the tools it offers and the
// hooks around it.
type Agent struct {
	Tools []Tool
	Hooks Hooks
	// Owner is set for the owner's turns, which run calls their remembered
	// approvals cover without asking.
	Owner bool
	// Steps bounds the model calls of a turn; zero means DefaultSteps.
	Steps int
}

// DefaultSteps is how many model calls a turn makes at most unless its agent
// says otherwise.
const DefaultSteps = 20

// Turn is one run of the model loop as hooks see it.
type Turn struct {
	ConversationID string
	Model          llm.Info
	// Request is the model request being built; BeforeTurn hooks may add to
	// its System before history is fitted to the context window.
	Request *llm.Request
}

// Hooks run around every turn, in registration order. Register all hooks
// before serving.
type Hooks struct {
	// BeforeTurn runs before the first model call; an error ends the turn.
	BeforeTurn []func(ctx context.Context, turn *Turn) error
	// BeforeTool runs before each offered tool call; an error refuses the
	// call and is handled as the tool's own would be.
	BeforeTool []func(ctx context.Context, call ToolCall) error
	// AfterTurn runs once the reply is saved, with the turn's error if any.
	AfterTurn []func(ctx context.Context, turn *Turn, message Message, err error)
}

// Run owns the model loop and message persistence; transports serialize its events.
func Run(ctx context.Context, store *Store, model llm.Model, agent Agent, conversationID string, message Message, note string, emit func(Event) error) (runErr error) {
	info := model.Info()
	turn := &Turn{ConversationID: conversationID, Model: info, Request: &llm.Request{System: systemPrompt, MaxTokens: unknownOutput}}
	lastSave := time.Now()
	send := func(e Event) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if time.Since(lastSave) > time.Second {
			if err := store.Save(message, "streaming", ""); err != nil {
				return err
			}
			lastSave = time.Now()
		}
		return emit(e)
	}
	defer func() {
		status, failure := "complete", ""
		if runErr != nil {
			status = "error"
			failure = runErr.Error()
			if errors.Is(runErr, context.Canceled) {
				status = "cancelled"
			}
		}
		if err := store.Save(message, status, failure); err != nil {
			runErr = errors.Join(runErr, err)
		}
		for _, after := range agent.Hooks.AfterTurn {
			after(context.WithoutCancel(ctx), turn, message, runErr)
		}
	}()
	if err := send(Event{Kind: TurnStarted, MessageID: message.ID}); err != nil {
		return err
	}
	history, err := store.History(conversationID)
	if err != nil {
		return err
	}
	req := turn.Request
	if info.Output > 0 {
		req.MaxTokens = min(info.Output, outputCap)
	}
	offered := map[string]Tool{}
	if info.Tools {
		for _, t := range agent.Tools {
			if _, twice := offered[t.Name]; twice {
				return fmt.Errorf("tool offered twice: %s", t.Name)
			}
			offered[t.Name] = t
			req.Tools = append(req.Tools, t.Tool)
			if t.Prompt != "" {
				req.System += " " + t.Prompt
			}
		}
	}
	for _, before := range agent.Hooks.BeforeTurn {
		if err := before(ctx, turn); err != nil {
			return err
		}
	}
	var omitted bool
	req.Messages, omitted = Prompt(history, message.ID, info.Context-req.MaxTokens-tokens(req.System))
	if omitted {
		req.System += "\nOlder conversation messages were omitted."
	}
	if note != "" {
		req.Messages = append(req.Messages, llm.Message{Role: "user", Text: note})
	}
	seenCalls := map[string]bool{}
	steps := agent.Steps
	if steps <= 0 {
		steps = DefaultSteps
	}
	for step := 0; step < steps; step++ {
		if err := send(Event{Kind: StepStarted}); err != nil {
			return err
		}
		indices := map[string]int{}
		ids := map[string]string{}
		result, err := model.Stream(ctx, *req, func(kind, delta string) error {
			index, ok := indices[kind]
			if !ok {
				index = len(message.Parts)
				indices[kind] = index
				ids[kind] = NewID()
				message.Parts = append(message.Parts, Part{"type": kind, "text": ""})
				if err := send(Event{Kind: SegmentStarted, Segment: kind, ID: ids[kind]}); err != nil {
					return err
				}
			}
			message.Parts[index]["text"] = message.Parts[index]["text"].(string) + delta
			return send(Event{Kind: SegmentDelta, Segment: kind, ID: ids[kind], Text: delta})
		})
		for _, kind := range []string{"reasoning", "text"} {
			if id := ids[kind]; id != "" {
				if e := send(Event{Kind: SegmentFinished, Segment: kind, ID: id}); e != nil && err == nil {
					err = e
				}
			}
		}
		if result.Usage != nil {
			u := result.Usage.Priced(info.Cost)
			message.Usage = add(message.Usage, u)
			if e := send(Event{Kind: UsageReported, Usage: u}); e != nil && err == nil {
				err = e
			}
		}
		if err != nil {
			return err
		}
		if result.Text == "" && len(result.Calls) == 0 {
			return errors.New("model produced no answer")
		}
		// Reasoning goes back within the turn, to the model that produced it.
		req.Messages = append(req.Messages, llm.Message{Role: "assistant", Text: result.Text, Reasoning: result.Reasoning, Signature: result.Signature, ToolCalls: result.Calls})
		pending := false
		for _, call := range result.Calls {
			if call.ID == "" || call.Name == "" {
				return errors.New("model returned an incomplete tool call")
			}
			if seenCalls[call.ID] {
				return errors.New("model repeated a tool call ID")
			}
			seenCalls[call.ID] = true
			var input map[string]any
			parseErr := json.Unmarshal([]byte(call.Arguments), &input)
			if input == nil {
				input = map[string]any{}
			}
			part := Part{"type": "tool-" + call.Name, "toolCallId": call.ID, "state": "input-available", "input": input}
			message.Parts = append(message.Parts, part)
			if err := send(Event{Kind: ToolInput, ToolCallID: call.ID, ToolName: call.Name, Input: input}); err != nil {
				return err
			}
			var output any
			var toolErr error
			if parseErr != nil {
				toolErr = errors.New("tool arguments must be a JSON object")
			} else {
				output, toolErr = runTool(ctx, agent, offered, ToolCall{ToolCall: call, ConversationID: conversationID, Input: input, Part: part, Message: &message, Store: store, Send: send})
				var stop abort
				switch {
				case errors.Is(toolErr, ErrAwaitingApproval):
					pending = true
					continue
				case toolErr != nil && ctx.Err() != nil:
					return ctx.Err()
				case errors.As(toolErr, &stop):
					return stop.err
				}
			}
			if toolErr != nil {
				part["state"] = "output-error"
				part["errorText"] = toolErr.Error()
				output = map[string]string{"error": toolErr.Error()}
				if err := send(Event{Kind: ToolFailed, ToolCallID: call.ID, Error: toolErr.Error()}); err != nil {
					return err
				}
			} else {
				part["state"] = "output-available"
				part["output"] = output
				if err := send(Event{Kind: ToolOutput, ToolCallID: call.ID, Output: output}); err != nil {
					return err
				}
			}
			body, _ := json.Marshal(output)
			req.Messages = append(req.Messages, llm.Message{Role: "tool", Text: string(body), ToolCallID: call.ID, ToolName: call.Name})
		}
		if err := send(Event{Kind: StepFinished}); err != nil {
			return err
		}
		if pending || len(result.Calls) == 0 {
			return nil
		}
	}
	return fmt.Errorf("tool step limit reached (%d); send another message to continue", steps)
}

// runTool runs an offered tool after the BeforeTool hooks allow it, and
// carries out a call a remembered approval covers.
func runTool(ctx context.Context, agent Agent, offered map[string]Tool, call ToolCall) (any, error) {
	tool, ok := offered[call.Name]
	if !ok {
		return nil, fmt.Errorf("unsupported tool: %s", call.Name)
	}
	for _, before := range agent.Hooks.BeforeTool {
		if err := before(ctx, call); err != nil {
			return nil, err
		}
	}
	if agent.Owner {
		call.tool = &tool
	}
	output, err := tool.Run(ctx, call)
	var g granted
	if errors.As(err, &g) {
		return tool.Approved(ctx, ApprovedCall{ConversationID: call.ConversationID, ApprovalID: NewID(), Input: g.input, Store: call.Store})
	}
	return output, err
}

func add(total *llm.Usage, u llm.Usage) *llm.Usage {
	if total == nil {
		return &u
	}
	total.Input += u.Input
	total.Output += u.Output
	total.Reasoning += u.Reasoning
	total.CacheRead += u.CacheRead
	total.CacheWrite += u.CacheWrite
	total.Cost += u.Cost
	return total
}

// tokens estimates a text's prompt tokens; models.dev limits are only as
// exact as this needs to be.
func tokens(s string) int { return len(s)/3 + 1 }

// Prompt replays stored history as model messages. Tool calls go back as
// calls with their results, so any model can continue another's work;
// earlier turns' reasoning is never replayed, as it belongs to its model.
// With a positive budget (tokens), the oldest messages beyond it are
// omitted; without one, only the most recent messages are kept.
func Prompt(history []Message, current string, budget int) (messages []llm.Message, omitted bool) {
	var turns [][]llm.Message
	for _, m := range history {
		if m.ID == current || m.Command {
			continue
		}
		if turn := replay(m); len(turn) > 0 {
			turns = append(turns, turn)
		}
	}
	start := max(0, len(turns)-recentMessages)
	if budget > 0 {
		used := 0
		for start = len(turns); start > 0; start-- {
			size := 0
			for _, m := range turns[start-1] {
				size += tokens(m.Text) + tokens(m.Reasoning)
				for _, c := range m.ToolCalls {
					size += tokens(c.Arguments)
				}
			}
			if used+size > budget && start < len(turns) {
				break
			}
			used += size
		}
	}
	// A prompt starts with the user's turn.
	for start < len(turns) && turns[start][0].Role != "user" {
		start++
	}
	for _, turn := range turns[start:] {
		messages = append(messages, turn...)
	}
	return messages, start > 0
}

// replay turns one stored message into model messages: an assistant reply
// becomes one assistant message per step, each followed by its tool results.
func replay(m Message) []llm.Message {
	if m.Role != "assistant" {
		if text := Text(m); text != "" {
			return []llm.Message{{Role: m.Role, Text: text}}
		}
		return nil
	}
	var out []llm.Message
	step := llm.Message{Role: "assistant"}
	var results []llm.Message
	flush := func() {
		if step.Text != "" || len(step.ToolCalls) > 0 {
			out = append(append(out, step), results...)
		}
		step, results = llm.Message{Role: "assistant"}, nil
	}
	for _, part := range m.Parts {
		kind := fmt.Sprint(part["type"])
		switch {
		case kind == "text":
			if len(step.ToolCalls) > 0 {
				flush()
			}
			step.Text += fmt.Sprint(part["text"])
		case strings.HasPrefix(kind, "tool-"):
			id, _ := part["toolCallId"].(string)
			if id == "" {
				continue
			}
			args, _ := json.Marshal(part["input"])
			step.ToolCalls = append(step.ToolCalls, llm.ToolCall{ID: id, Name: kind[5:], Arguments: string(args)})
			results = append(results, llm.Message{Role: "tool", ToolCallID: id, ToolName: kind[5:], Text: outcome(part)})
		}
	}
	flush()
	return out
}

// outcome is what a stored tool call returned, as the model is told it.
func outcome(part Part) string {
	var v any
	switch part["state"] {
	case "output-available":
		v = part["output"]
	case "output-error":
		v = map[string]any{"error": part["errorText"]}
	case "output-denied":
		v = map[string]string{"error": "The user denied this request."}
	case "approval-requested":
		v = map[string]string{"status": "Waiting for the user's approval."}
	default:
		v = map[string]string{"error": "The tool did not complete."}
	}
	raw, _ := json.Marshal(v)
	return string(raw)
}
