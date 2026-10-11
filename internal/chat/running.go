package chat

import (
	"context"
	"errors"
	"sync"
)

// Running is an admitted turn and the log of its events. Any number of clients
// replay it from a point and follow it live; a turn admitted by Start outlives
// the request that started it, and only Stop, Close or its timeout end it early.
type Running struct {
	cancel  context.CancelFunc
	mu      sync.Mutex
	events  []Event
	changed chan struct{}
	done    chan struct{}
	err     error
}

func newRunning(cancel context.CancelFunc) *Running {
	return &Running{cancel: cancel, changed: make(chan struct{}), done: make(chan struct{})}
}

func (r *Running) record(e Event) {
	r.mu.Lock()
	r.events = append(r.events, e)
	close(r.changed)
	r.changed = make(chan struct{})
	r.mu.Unlock()
}

// finish ends the log. A turn that failed after it began ends with the events
// a client needs to show why, as the turn itself only returns its error.
func (r *Running) finish(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil && len(r.events) > 0 {
		end := Event{Kind: TurnFailed, Error: err.Error()}
		if errors.Is(err, context.Canceled) {
			end = Event{Kind: TurnAborted}
		}
		r.events = append(r.events, end, Event{Kind: TurnFinished, Reason: "error"})
	}
	r.err = err
	close(r.changed)
	close(r.done)
}

// Stop cancels the turn.
func (r *Running) Stop() { r.cancel() }

// Done closes when the turn has ended and every event is logged.
func (r *Running) Done() <-chan struct{} { return r.done }

// Follow calls fn with each event after the first `after`, numbered from 1,
// and waits for more until the turn ends or ctx is done. Once every event is
// delivered it returns the turn's error.
func (r *Running) Follow(ctx context.Context, after int, fn func(seq int, e Event) error) error {
	for {
		r.mu.Lock()
		events, changed := r.events[min(after, len(r.events)):], r.changed
		ended := r.isDone()
		r.mu.Unlock()
		for i, e := range events {
			if err := fn(after+i+1, e); err != nil {
				return err
			}
		}
		after += len(events)
		if ended {
			return r.err
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (r *Running) isDone() bool {
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}

// begun waits for the turn's first event, or for it to end without one.
func (r *Running) begun() (bool, error) {
	for {
		r.mu.Lock()
		n, changed, ended := len(r.events), r.changed, r.isDone()
		r.mu.Unlock()
		if n > 0 {
			return true, nil
		}
		if ended {
			return false, r.err
		}
		<-changed
	}
}
