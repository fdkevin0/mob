package llm

import (
	"context"
	"errors"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"
)

// StallTimeout is how long a model request may wait for its response to
// start, and then for each further piece of it. A reply that keeps arriving
// is never cut off, however long it takes.
var StallTimeout = 2 * time.Minute

// ErrStalled ends a model request that stopped responding.
var ErrStalled = errors.New("model stopped responding")

// ErrContextOverflow is a provider refusing a prompt longer than the model's
// context window. A driver's error matches it with errors.Is.
var ErrContextOverflow = errors.New("prompt exceeds the model's context window")

// overflow phrases are how providers word a prompt too long for the window.
var overflow = []string{"context_length_exceeded", "context length", "context window", "maximum context", "prompt is too long", "input is too long", "too many tokens", "too many input tokens", "reduce the length"}

// Overflow reports whether a refusal with status and body is for a prompt
// longer than the model's window.
func Overflow(status int, body []byte) bool {
	if status == http.StatusRequestEntityTooLarge {
		return true
	}
	if status != http.StatusBadRequest && status != http.StatusUnprocessableEntity {
		return false
	}
	text := strings.ToLower(string(body))
	return slices.ContainsFunc(overflow, func(phrase string) bool { return strings.Contains(text, phrase) })
}

// OverflowError is err, matching ErrContextOverflow too.
func OverflowError(err error) error { return overflowError{err} }

type overflowError struct{ error }

func (e overflowError) Unwrap() []error { return []error{e.error, ErrContextOverflow} }

// Send sends a model request on transport without following redirects. The
// request fails with ErrStalled if its response does not start, or stops
// arriving, within StallTimeout.
func Send(transport http.RoundTripper, req *http.Request) (*http.Response, error) {
	ctx, cancel := context.WithCancelCause(req.Context())
	stalled := time.AfterFunc(StallTimeout, func() { cancel(ErrStalled) })
	client := http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req.WithContext(ctx))
	if err != nil {
		stalled.Stop()
		cancel(nil)
		if errors.Is(context.Cause(ctx), ErrStalled) {
			return nil, ErrStalled
		}
		return nil, err
	}
	stalled.Reset(StallTimeout)
	resp.Body = &stallBody{ReadCloser: resp.Body, ctx: ctx, stalled: stalled, cancel: cancel}
	return resp, nil
}

// stallBody restarts the stall timer whenever data arrives.
type stallBody struct {
	io.ReadCloser
	ctx     context.Context
	stalled *time.Timer
	cancel  context.CancelCauseFunc
}

func (b *stallBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if n > 0 {
		b.stalled.Reset(StallTimeout)
	}
	if err != nil && errors.Is(context.Cause(b.ctx), ErrStalled) {
		err = ErrStalled
	}
	return n, err
}

func (b *stallBody) Close() error {
	b.stalled.Stop()
	b.cancel(nil)
	return b.ReadCloser.Close()
}
