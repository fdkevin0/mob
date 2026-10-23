package chat

import (
	"context"
	"errors"
	"time"

	"github.com/fdkevin0/mob/internal/llm"
)

// Delegate runs the turns of conversations an outside agent answers, such as
// a coding agent working on a task: the conversation shows what the agent
// does, and its approvals are the permissions the agent asks for. The agent
// keeps waiting while an approval is pending; the turn that asked ends, and
// the owner's decision starts the turn that follows the agent on.
type Delegate interface {
	// Owns reports whether conversationID's turns are the delegate's.
	Owns(conversationID string) bool
	// Label names the agent; replies record it as their model.
	Label(conversationID string) string
	// Reply streams the agent's work into turn until the agent finishes or
	// waits for an approval.
	Reply(ctx context.Context, turn *DelegateTurn) error
	// Decide passes the owner's answer on d, already recorded, to the agent
	// waiting for it.
	Decide(conversationID string, d Decision, a Answer) error
}

// SetDelegate makes later turns of the conversations delegate owns its own.
func (s *ConversationService) SetDelegate(delegate Delegate) {
	s.mu.Lock()
	s.delegate = delegate
	s.mu.Unlock()
}

// delegated is the delegate that owns conversationID, or nil.
func (s *ConversationService) delegated(conversationID string) Delegate {
	s.mu.Lock()
	delegate := s.delegate
	s.mu.Unlock()
	if delegate == nil || !delegate.Owns(conversationID) {
		return nil
	}
	return delegate
}

// DelegateTurn is one reply of a delegated conversation as the delegate
// writes it: text, reasoning and tool calls, saved as the engine saves a
// model's reply.
type DelegateTurn struct {
	ConversationID string
	// Text is what the owner wrote; empty when the turn follows an approval.
	Text string
	// Channel is the messaging app the turn answers in, if any.
	Channel string
	*reply
	stepped bool
}

// MessageID is the reply being written.
func (t *DelegateTurn) MessageID() string { return t.message.ID }

// Wrote reports whether the reply shows anything yet.
func (t *DelegateTurn) Wrote() bool { return len(t.message.Parts) > 0 }

// Conclusion is the reply's last text, which usually sums up the turn.
func (t *DelegateTurn) Conclusion() string {
	for i := len(t.message.Parts) - 1; i >= 0; i-- {
		if p := t.message.Parts[i]; p["type"] == "text" {
			text, _ := p["text"].(string)
			return text
		}
	}
	return ""
}

func (t *DelegateTurn) step() error {
	if t.stepped {
		return nil
	}
	t.stepped = true
	return t.send(Event{Kind: StepStarted})
}

// Stream adds delta to the reply's current text or reasoning.
func (t *DelegateTurn) Stream(kind, delta string) error {
	if delta == "" {
		return nil
	}
	if err := t.step(); err != nil {
		return err
	}
	return t.stream(kind, delta)
}

// endStep finishes the open text and reasoning, so what follows starts new
// parts after them.
func (t *DelegateTurn) endStep() error {
	if !t.stepped {
		return nil
	}
	if err := t.endSegments(); err != nil {
		return err
	}
	t.segments = map[string]segment{}
	t.stepped = false
	return t.send(Event{Kind: StepFinished})
}

// Used records what the agent's session used for the reply; model names the
// model, or the agent when it did not say which.
func (t *DelegateTurn) Used(session, model string, u llm.Usage, took time.Duration) error {
	t.message.Usage = add(t.message.Usage, u)
	if err := t.store.RecordSessionUsage(t.ConversationID, t.message.ID, session, model, u, took); err != nil {
		return err
	}
	return t.send(Event{Kind: UsageReported, Usage: u})
}

// HasTool reports whether the reply already shows call id.
func (t *DelegateTurn) HasTool(id string) bool { return t.part(id) != nil }

func (t *DelegateTurn) part(id string) Part {
	for _, p := range t.message.Parts {
		if p["toolCallId"] == id {
			return p
		}
	}
	return nil
}

// Tool shows a call the agent makes.
func (t *DelegateTurn) Tool(id, name string, input any) error {
	if t.HasTool(id) {
		return nil
	}
	if err := t.endStep(); err != nil {
		return err
	}
	if err := t.step(); err != nil {
		return err
	}
	_, err := t.tool(id, name, input)
	return err
}

// ToolDone records how a call shown with Tool ended; a call the reply does
// not show is ignored.
func (t *DelegateTurn) ToolDone(id string, output any, failure string) error {
	part := t.part(id)
	if part == nil || part["state"] == "output-available" || part["state"] == "output-error" {
		return nil
	}
	return t.toolDone(id, part, output, failure)
}

// RequestApproval asks the owner to approve call id, shown with Tool, and
// returns the approval's ID. The delegate returns from Reply once it has
// asked: the turn ends waiting for the owner.
func (t *DelegateTurn) RequestApproval(id string, input any) (string, error) {
	part := t.part(id)
	if part == nil {
		return "", errors.New("approval requested for a call the reply does not show")
	}
	part["input"] = input
	approval, err := t.store.RequestApproval(t.ConversationID, *t.message, id, input)
	if err != nil {
		return "", err
	}
	name, _ := part["type"].(string)
	return approval, t.send(Event{Kind: ApprovalRequested, ApprovalID: approval, ToolCallID: id, ToolName: name[len("tool-"):], Input: input})
}

// runDelegate is Run for a delegated conversation: the delegate writes the
// reply, which is saved while it streams and once it ends.
func runDelegate(ctx context.Context, store *Store, delegate Delegate, input ChatRequest, message Message, emit func(Event) error) (runErr error) {
	reply := newReply(ctx, store, &message, emit)
	turn := &DelegateTurn{ConversationID: input.ID, Text: input.Text, Channel: input.Channel, reply: reply}
	defer func() { runErr = reply.finish(runErr) }()
	if err := reply.send(Event{Kind: TurnStarted, MessageID: message.ID}); err != nil {
		return err
	}
	if err := delegate.Reply(ctx, turn); err != nil {
		return err
	}
	return turn.endStep()
}
