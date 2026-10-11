package llm

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"
)

// StallTimeout is how long a model request may wait for its response to
// start, and then for each further piece of it. A reply that keeps arriving
// is never cut off, however long it takes.
var StallTimeout = 2 * time.Minute

// ErrStalled ends a model request that stopped responding.
var ErrStalled = errors.New("model stopped responding")

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
