package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/llm"
)

const (
	// outputCap bounds a reply below the model's own limit, as other agents
	// do, so that a model with a huge limit still leaves room for history.
	outputCap = 32000
	// recentMessages bounds history for models whose context window is unknown.
	recentMessages = 40
)

// omittedNotice tells the model that history was cut to fit its window.
const omittedNotice = "\nOlder conversation messages were omitted."

// systemPrompt starts every turn's instructions; tools and hooks add to it.
const systemPrompt = "You are Mob, a concise personal assistant. Reply in the user's language. Only claim a tool succeeded if its result says so. A tool call that asks for the user's approval ends the current turn."

// Agent is what a turn uses besides its model: the tools it offers and the
// hooks around it.
type Agent struct {
	Tools []Tool
	// Entries are what tool_search finds besides tools, such as skills.
	Entries []Entry
	Hooks   Hooks
	// Owner is set for the owner's turns, which run calls their remembered
	// approvals cover without asking.
	Owner bool
	// Steps bounds the model calls of a turn; zero means DefaultSteps.
	Steps int
	// Saver, when set, keeps tool outputs too large to read in place where
	// the model can read them; without one the model reads their ends.
	Saver Saver
	// Prompt, when set, follows the system prompt, such as how the reader
	// will see the reply.
	Prompt string
}

// ErrStepLimit ends a turn that made as many model calls as it may. The turn
// is saved with status "step-limit", so clients can offer to continue it.
var ErrStepLimit = errors.New("tool step limit reached")

// DefaultSteps is how many model calls a turn makes at most unless its agent
// says otherwise.
const DefaultSteps = 20

// Turn is one run of the model loop as hooks see it.
type Turn struct {
	ConversationID string
	// Owner is set for the owner's turns.
	Owner bool
	Model llm.Info
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
	turn := &Turn{ConversationID: conversationID, Owner: agent.Owner, Model: info, Request: &llm.Request{System: systemPrompt}}
	if agent.Prompt != "" {
		turn.Request.System += "\n" + agent.Prompt
	}
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
			switch {
			case errors.Is(runErr, context.Canceled):
				status = "cancelled"
			case errors.Is(runErr, ErrStepLimit):
				status = "step-limit"
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
	// Without a known limit the driver picks the reply size; history still
	// leaves room for one of outputCap.
	reserve := outputCap
	if info.Output > 0 {
		req.MaxTokens = min(info.Output, outputCap)
		reserve = req.MaxTokens
	}
	if info.Context > 0 && reserve > info.Context/4 {
		reserve = info.Context / 4
		req.MaxTokens = min(req.MaxTokens, reserve)
	}
	// offered are the tools declared to the model. Deferred tools wait until
	// tool_search loads them, unless the conversation has loaded or called
	// them before; loaded are those declared so far.
	offered := map[string]Tool{}
	// staged are the tools tool_search loaded in this step, declared once
	// the step's calls have run, so a call made beside the search is refused.
	var waiting, loaded, staged []Tool
	if info.Tools {
		used := usedTools(history)
		names := map[string]bool{}
		for _, t := range agent.Tools {
			if names[t.Name] {
				return fmt.Errorf("tool offered twice: %s", t.Name)
			}
			names[t.Name] = true
			switch {
			case t.Exposure == Hidden:
				continue
			case t.Exposure == Deferred && !used[t.Name]:
				waiting = append(waiting, t)
				continue
			case t.Exposure == Deferred:
				loaded = append(loaded, t)
			}
			offered[t.Name] = t
			req.Tools = append(req.Tools, t.Tool)
			if t.Prompt != "" {
				req.System += " " + t.Prompt
			}
		}
		if len(waiting) > 0 || len(agent.Entries) > 0 {
			load := func(tools []Tool) {
				for _, t := range tools {
					waiting = slices.DeleteFunc(waiting, func(w Tool) bool { return w.Name == t.Name })
					loaded = append(loaded, t)
					staged = append(staged, t)
				}
			}
			search := toolSearch(func() []Tool { return waiting }, func() []Tool { return loaded }, agent.Entries, load)
			offered[searchName] = search
			req.Tools = append(req.Tools, search.Tool)
			req.System += " " + searchPrompt(waiting, agent.Entries)
		}
	}
	for _, before := range agent.Hooks.BeforeTurn {
		if err := before(ctx, turn); err != nil {
			return err
		}
	}
	// limit is what a prompt may use of the window, leaving room for the reply.
	limit := info.Context - reserve
	budget := limit - tokens(req.System) - toolTokens(req.Tools) - tokens(omittedNotice)
	if note != "" {
		budget -= tokens(note)
	}
	summary, err := store.Summary(conversationID)
	if err != nil {
		return err
	}
	// room is what a summary may take beside the latest message, which every
	// prompt keeps.
	last, _, _ := prompt(history, message.ID, 1)
	room := budget - promptTokens(last)
	// A summary written for a larger model, or before a long message, can
	// crowd the turn out; the turn then reads the messages it covers instead,
	// as many as fit. Otherwise it is read, as it was written to fit beside
	// such a message, and always when the window is unknown.
	if info.Context > 0 && summaryCost(summary.Text) > room {
		summary = Summary{}
	}
	history = since(history, summary.Through)
	var saved []string
	var through string
	req.Messages, saved, through = prompt(history, message.ID, budget-summaryCost(summary.Text))
	// History that does not fit is summarized rather than omitted, in a
	// summary short enough to leave room for the latest message. The summary
	// covers enough that recent messages fill at most half the room left
	// beside it, so the next turns need not summarize again.
	length := min(summaryTokens, room-tokens(summaryNotice))
	half := (budget - length - tokens(summaryNotice)) / 2
	if through != "" && info.Context > 0 && length >= summaryTokens/4 && half > 0 {
		_, _, older := prompt(history, message.ID, half)
		text, usage, err := summarize(ctx, model, summary.Text, until(history, older), length)
		if usage != nil {
			message.Usage = add(message.Usage, *usage)
			if e := send(Event{Kind: UsageReported, Usage: *usage}); e != nil {
				return e
			}
		}
		switch {
		case ctx.Err() != nil:
			return ctx.Err()
		case err == nil && summaryCost(text) <= room:
			// Without a summary that fits, the older messages are omitted instead.
			summary = Summary{Text: text, Through: older}
			if err := store.Summarize(conversationID, summary); err != nil {
				return err
			}
			history = since(history, older)
			req.Messages, saved, through = prompt(history, message.ID, budget-summaryCost(summary.Text))
		}
	}
	if size := promptTokens(req.Messages); info.Context > 0 && size > budget-summaryCost(summary.Text) {
		return fmt.Errorf("the latest message is about %d tokens, more than %s has room for (%d); shorten it or pick a model with a larger context", size, info.ID, max(budget-summaryCost(summary.Text), 0))
	}
	if summary.Text != "" {
		req.System += summaryNotice + summary.Text
	}
	if through != "" {
		req.System += omittedNotice
	}
	if note != "" {
		req.Messages, saved = append(req.Messages, llm.Message{Role: "user", Text: note}), append(saved, "")
	}
	// size is the prompt's tokens: estimated at first, then as the provider
	// counted the last step, plus estimates for what was added since.
	size := tokens(req.System) + toolTokens(req.Tools) + promptTokens(req.Messages)
	// declared is what the tool definitions take of size; tool_search adds
	// to them.
	declared := toolTokens(req.Tools)
	// read is how many of the messages the model has seen. groups are the
	// tool outputs that can be cleared to make room, oldest first: history's
	// estimated, then each step's, measured by the next step's usage.
	read, groups := 0, each(req.Messages, saved)
	// measured is set once the provider counts the prompt; base is then its
	// count after the last reply, less what clearing freed since, and latest
	// the outputs added after that reply.
	measured, base := false, -1
	var latest *outputs
	// shrink makes room after a provider refused a prompt the estimate let
	// through, as it counts tokens its own way: before the model has replied,
	// history is fitted to less; after, outputs the model has read are
	// cleared, never those it is about to read. It frees about a quarter of
	// the prompt and reports whether it freed any.
	shrink := func(step, seen int) bool {
		need := max(size/4, 1)
		if step > 0 {
			freed := clearOutputs(req.Messages, groups, seen, need, false)
			size, base = size-freed, base-freed
			return freed > 0
		}
		n := len(req.Messages)
		if note != "" {
			n--
		}
		current := promptTokens(req.Messages[:n])
		messages, files, omitted := prompt(history, message.ID, max(current-need, 1))
		if promptTokens(messages) >= current {
			return false
		}
		if omitted != "" && through == "" {
			req.System += omittedNotice
		}
		through = omitted
		if note != "" {
			messages, files = append(messages, llm.Message{Role: "user", Text: note}), append(files, "")
		}
		req.Messages, saved = messages, files
		groups = each(req.Messages, saved)
		size = tokens(req.System) + toolTokens(req.Tools) + promptTokens(req.Messages)
		return true
	}
	retried := false
	seenCalls := map[string]bool{}
	steps := agent.Steps
	if steps <= 0 {
		steps = DefaultSteps
	}
	for step := 0; step < steps; step++ {
		// Tool results can fill the window within a turn: clear older ones
		// the model has read, and stop before the provider refuses the request.
		if info.Context > 0 && step > 0 && size > limit {
			freed := clearOutputs(req.Messages, groups, read, size-limit, measured)
			size, base = size-freed, base-freed
		}
		if info.Context > 0 && step > 0 && size > limit {
			return fmt.Errorf("this turn has filled %s's context (about %d of %d tokens); send another message to continue", info.ID, size, limit)
		}
		if err := send(Event{Kind: StepStarted}); err != nil {
			return err
		}
		indices := map[string]int{}
		ids := map[string]string{}
		seen := read
		read = len(req.Messages)
		stream := func(kind, delta string) error {
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
		}
		result, err := model.Stream(ctx, *req, stream)
		// A refused prompt is made smaller and sent once more in the turn.
		if errors.Is(err, llm.ErrContextOverflow) && !retried && len(ids) == 0 {
			retried = true
			if shrink(step, seen) {
				read = len(req.Messages)
				result, err = model.Stream(ctx, *req, stream)
			}
		}
		if errors.Is(err, llm.ErrContextOverflow) {
			err = fmt.Errorf("%w; /compact summarizes the conversation to make room", err)
		}
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
		reply := llm.Message{Role: "assistant", Text: result.Text, Reasoning: result.Reasoning, Signature: result.Signature, ToolCalls: result.Calls}
		req.Messages = append(req.Messages, reply)
		if result.Usage != nil && result.Usage.Input > 0 {
			// The outputs added since the last reply take at least what the
			// prompt grew by since, as clearing freed at least what it
			// claimed; they are credited with that or their estimate, the
			// smaller, so clearing them never claims more than it frees.
			if latest != nil && base >= 0 {
				latest.tokens, latest.measured = min(latest.tokens, max(0, result.Usage.Input-base)), true
			}
			size, measured = result.Usage.Input+result.Usage.Output, true
			base = size
		} else {
			size += promptTokens([]llm.Message{reply})
			base = -1
		}
		latest = nil
		added := &outputs{}
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
				if file := save(agent.Saver, conversationID, output); file != "" {
					part["outputFile"] = file
				}
				if err := send(Event{Kind: ToolOutput, ToolCallID: call.ID, Output: output}); err != nil {
					return err
				}
			}
			file, _ := part["outputFile"].(string)
			out := llm.Message{Role: "tool", Text: modelOutput(output, file), ToolCallID: call.ID, ToolName: call.Name}
			added.list = append(added.list, toolOutput{len(req.Messages), file})
			added.tokens += promptTokens([]llm.Message{out})
			req.Messages = append(req.Messages, out)
			size += promptTokens([]llm.Message{out})
		}
		if len(added.list) > 0 {
			groups, latest = append(groups, added), added
		}
		for _, t := range staged {
			offered[t.Name] = t
			req.Tools = append(req.Tools, t.Tool)
			if t.Prompt != "" {
				req.System += " " + t.Prompt
				size += tokens(" " + t.Prompt)
			}
		}
		staged = nil
		if n := toolTokens(req.Tools); n != declared {
			size, declared = size+n-declared, n
		}
		if err := send(Event{Kind: StepFinished}); err != nil {
			return err
		}
		if pending || len(result.Calls) == 0 {
			return nil
		}
	}
	return fmt.Errorf("%w (%d); send another message to continue", ErrStepLimit, steps)
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
		return tool.Approved(ctx, ApprovedCall{ConversationID: call.ConversationID, ApprovalID: NewID(), Input: g.input, Store: call.Store, Owner: agent.Owner})
	}
	return output, err
}

// usedTools are the tools the conversation has called, and those tool_search
// loaded in it, which stay declared in its later turns.
func usedTools(history []Message) map[string]bool {
	used := map[string]bool{}
	for _, m := range history {
		for _, part := range m.Parts {
			kind := fmt.Sprint(part["type"])
			if !strings.HasPrefix(kind, "tool-") {
				continue
			}
			used[kind[5:]] = true
			if kind != "tool-"+searchName || part["state"] != "output-available" {
				continue
			}
			var output searchResult
			raw, _ := json.Marshal(part["output"])
			if json.Unmarshal(raw, &output) == nil {
				for _, name := range output.Loaded {
					used[name] = true
				}
			}
		}
	}
	return used
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

// summaryCost estimates the prompt tokens a summary takes.
func summaryCost(summary string) int {
	if summary == "" {
		return 0
	}
	return tokens(summaryNotice + summary)
}

// since is history after the message with ID id, or all of it.
func since(history []Message, id string) []Message {
	for i, m := range history {
		if m.ID == id {
			return history[i+1:]
		}
	}
	return history
}

// until is history up to and including the message with ID id.
func until(history []Message, id string) []Message {
	for i, m := range history {
		if m.ID == id {
			return history[:i+1]
		}
	}
	return nil
}

// toolTokens estimates the prompt tokens of tool definitions, which every
// model call sends with the messages.
func toolTokens(tools []llm.Tool) int {
	if len(tools) == 0 {
		return 0
	}
	raw, _ := json.Marshal(tools)
	return tokens(string(raw))
}

// promptTokens estimates the prompt tokens of model messages.
func promptTokens(messages []llm.Message) int {
	size := 0
	for _, m := range messages {
		size += tokens(m.Text) + tokens(m.Reasoning)
		for _, c := range m.ToolCalls {
			size += tokens(c.Arguments)
		}
	}
	return size
}

// Prompt replays stored history as model messages. Tool calls go back as
// calls with their results, so any model can continue another's work;
// earlier turns' reasoning is never replayed, as it belongs to its model.
// With a positive budget (tokens), older tool outputs are cleared and then
// the oldest messages beyond it omitted; without one, only the most recent
// messages are kept.
func Prompt(history []Message, current string, budget int) (messages []llm.Message, omitted bool) {
	messages, _, through := prompt(history, current, budget)
	return messages, through != ""
}

// prompt is Prompt that also gives, for each message, where its tool output
// is saved, if it is, and the ID of the last stored message it omits.
func prompt(history []Message, current string, budget int) (messages []llm.Message, saved []string, through string) {
	var turns [][]llm.Message
	var files [][]string
	var ids []string
	for _, m := range history {
		if m.ID == current || m.Command {
			continue
		}
		if turn, saved := replay(m); len(turn) > 0 {
			turns, files, ids = append(turns, turn), append(files, saved), append(ids, m.ID)
		}
	}
	start := max(0, len(turns)-recentMessages)
	if budget > 0 {
		// Older tool outputs are cleared before whole turns are omitted; the
		// latest turn keeps its own.
		used := 0
		for _, turn := range turns {
			used += promptTokens(turn)
		}
		for i := 0; i < len(turns)-1 && used > budget; i++ {
			used -= clearOutputs(turns[i], each(turns[i], files[i]), len(turns[i]), used-budget, false)
		}
		used = 0
		for start = len(turns); start > 0; start-- {
			size := promptTokens(turns[start-1])
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
	for i := start; i < len(turns); i++ {
		messages, saved = append(messages, turns[i]...), append(saved, files[i]...)
	}
	if start > 0 {
		through = ids[start-1]
	}
	return messages, saved, through
}

// replay turns one stored message into model messages: an assistant reply
// becomes one assistant message per step, each followed by its tool results.
// saved gives, for each message, where its tool output is saved, if it is.
func replay(m Message) (out []llm.Message, saved []string) {
	if m.Role != "assistant" {
		if text := Text(m); text != "" {
			return []llm.Message{{Role: m.Role, Text: text}}, []string{""}
		}
		return nil, nil
	}
	step := llm.Message{Role: "assistant"}
	var results []llm.Message
	var files []string
	flush := func() {
		if step.Text != "" || len(step.ToolCalls) > 0 {
			out = append(append(out, step), results...)
			saved = append(append(saved, ""), files...)
		}
		step, results, files = llm.Message{Role: "assistant"}, nil, nil
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
			file, _ := part["outputFile"].(string)
			files = append(files, file)
		}
	}
	flush()
	return out, saved
}

// outcome is what a stored tool call returned, as the model is told it.
func outcome(part Part) string {
	var v any
	switch part["state"] {
	case "output-available":
		file, _ := part["outputFile"].(string)
		return modelOutput(part["output"], file)
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
