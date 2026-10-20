package chat

import (
	"context"
	"errors"
	"time"
)

// reply records the parts and events shared by model and delegated turns.
// Each caller owns its step grouping and execution policy.
type reply struct {
	ctx      context.Context
	store    *Store
	message  *Message
	emit     func(Event) error
	lastSave time.Time
	segments map[string]segment
}

type segment struct {
	index int
	id    string
}

func newReply(ctx context.Context, store *Store, message *Message, emit func(Event) error) *reply {
	return &reply{ctx: ctx, store: store, message: message, emit: emit, lastSave: time.Now(), segments: map[string]segment{}}
}

func (r *reply) send(e Event) error {
	if err := r.ctx.Err(); err != nil {
		return err
	}
	if time.Since(r.lastSave) > time.Second {
		if err := r.store.Save(*r.message, "streaming", ""); err != nil {
			return err
		}
		r.lastSave = time.Now()
	}
	return r.emit(e)
}

func (r *reply) finish(runErr error) error {
	status, failure := "complete", ""
	if runErr != nil {
		status, failure = "error", runErr.Error()
		switch {
		case errors.Is(runErr, context.Canceled):
			status = "cancelled"
		case errors.Is(runErr, ErrStepLimit):
			status = "step-limit"
		}
	}
	if err := r.store.Save(*r.message, status, failure); err != nil {
		return errors.Join(runErr, err)
	}
	return runErr
}

func (r *reply) stream(kind, delta string) error {
	s, ok := r.segments[kind]
	if !ok {
		s = segment{len(r.message.Parts), NewID()}
		r.segments[kind] = s
		r.message.Parts = append(r.message.Parts, Part{"type": kind, "text": ""})
		if err := r.send(Event{Kind: SegmentStarted, Segment: kind, ID: s.id}); err != nil {
			return err
		}
	}
	r.message.Parts[s.index]["text"] = r.message.Parts[s.index]["text"].(string) + delta
	return r.send(Event{Kind: SegmentDelta, Segment: kind, ID: s.id, Text: delta})
}

func (r *reply) endSegments() (err error) {
	for _, kind := range []string{"reasoning", "text"} {
		if s, ok := r.segments[kind]; ok {
			if e := r.send(Event{Kind: SegmentFinished, Segment: kind, ID: s.id}); e != nil && err == nil {
				err = e
			}
		}
	}
	return err
}

func (r *reply) tool(id, name string, input any) (Part, error) {
	part := Part{"type": "tool-" + name, "toolCallId": id, "state": "input-available", "input": input}
	r.message.Parts = append(r.message.Parts, part)
	return part, r.send(Event{Kind: ToolInput, ToolCallID: id, ToolName: name, Input: input})
}

func (r *reply) toolDone(id string, part Part, output any, failure string) error {
	if failure != "" {
		part["state"] = "output-error"
		part["errorText"] = failure
		return r.send(Event{Kind: ToolFailed, ToolCallID: id, Error: failure})
	}
	part["state"] = "output-available"
	part["output"] = output
	return r.send(Event{Kind: ToolOutput, ToolCallID: id, Output: output})
}
