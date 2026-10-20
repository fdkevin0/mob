package chat

import (
	"context"
	"errors"
	"time"
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
	Text     string
	store    *Store
	message  *Message
	send     func(Event) error
	segments map[string]segment
	stepped  bool
}

type segment struct {
	index int
	id    string
}

// MessageID is the reply being written.
func (t *DelegateTurn) MessageID() string { return t.message.ID }

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
	s, ok := t.segments[kind]
	if !ok {
		s = segment{len(t.message.Parts), NewID()}
		t.segments[kind] = s
		t.message.Parts = append(t.message.Parts, Part{"type": kind, "text": ""})
		if err := t.send(Event{Kind: SegmentStarted, Segment: kind, ID: s.id}); err != nil {
			return err
		}
	}
	t.message.Parts[s.index]["text"] = t.message.Parts[s.index]["text"].(string) + delta
	return t.send(Event{Kind: SegmentDelta, Segment: kind, ID: s.id, Text: delta})
}

// endStep finishes the open text and reasoning, so what follows starts new
// parts after them.
func (t *DelegateTurn) endStep() error {
	if !t.stepped {
		return nil
	}
	for _, kind := range []string{"reasoning", "text"} {
		if s, ok := t.segments[kind]; ok {
			if err := t.send(Event{Kind: SegmentFinished, Segment: kind, ID: s.id}); err != nil {
				return err
			}
		}
	}
	t.segments = map[string]segment{}
	t.stepped = false
	return t.send(Event{Kind: StepFinished})
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
	t.message.Parts = append(t.message.Parts, Part{"type": "tool-" + name, "toolCallId": id, "state": "input-available", "input": input})
	return t.send(Event{Kind: ToolInput, ToolCallID: id, ToolName: name, Input: input})
}

// ToolDone records how a call shown with Tool ended; a call the reply does
// not show is ignored.
func (t *DelegateTurn) ToolDone(id string, output any, failure string) error {
	part := t.part(id)
	if part == nil || part["state"] == "output-available" || part["state"] == "output-error" {
		return nil
	}
	if failure != "" {
		part["state"] = "output-error"
		part["errorText"] = failure
		return t.send(Event{Kind: ToolFailed, ToolCallID: id, Error: failure})
	}
	part["state"] = "output-available"
	part["output"] = output
	return t.send(Event{Kind: ToolOutput, ToolCallID: id, Output: output})
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
func runDelegate(ctx context.Context, store *Store, delegate Delegate, conversationID string, message Message, text string, emit func(Event) error) (runErr error) {
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
	turn := &DelegateTurn{ConversationID: conversationID, Text: text, store: store, message: &message, send: send, segments: map[string]segment{}}
	defer func() {
		status, failure := "complete", ""
		if runErr != nil {
			status, failure = "error", runErr.Error()
			if errors.Is(runErr, context.Canceled) {
				status = "cancelled"
			}
		}
		if err := store.Save(message, status, failure); err != nil {
			runErr = errors.Join(runErr, err)
		}
	}()
	if err := send(Event{Kind: TurnStarted, MessageID: message.ID}); err != nil {
		return err
	}
	if err := delegate.Reply(ctx, turn); err != nil {
		return err
	}
	return turn.endStep()
}
