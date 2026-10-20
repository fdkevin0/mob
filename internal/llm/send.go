package llm

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"
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

// Retries is how many times Send repeats a request that failed before its
// response began, for reasons that may pass: a dropped connection, a rate
// limit or an overloaded or failing server. RetryDelay is the first wait,
// doubled each time unless the server says how long to wait, up to MaxRetryDelay.
var (
	Retries       = 3
	RetryDelay    = time.Second
	MaxRetryDelay = time.Minute
)

// retryable are the statuses a later attempt may not see; 529 is
// Anthropic's overloaded.
var retryable = []int{http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout, 529}

// Send sends a model request on transport without following redirects. The
// request fails with ErrStalled if its response does not start, or stops
// arriving, within StallTimeout. A request that failed before its response
// began is sent again up to Retries times, never once a response is streaming,
// so a retry cannot repeat text the caller has already shown.
func Send(transport http.RoundTripper, req *http.Request) (*http.Response, error) {
	if req.Body != nil && req.GetBody == nil {
		raw, err := io.ReadAll(req.Body)
		req.Body.Close()
		if err != nil {
			return nil, err
		}
		req.Body = io.NopCloser(bytes.NewReader(raw))
		req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(raw)), nil }
	}
	delay := RetryDelay
	for attempt := 0; ; attempt++ {
		resp, err := send(transport, req)
		var wait time.Duration
		var again bool
		resp, wait, again, err = retry(resp, err, delay)
		if !again || attempt >= Retries || req.Context().Err() != nil {
			return resp, err
		}
		if resp != nil {
			resp.Body.Close()
		}
		timer := time.NewTimer(wait)
		select {
		case <-req.Context().Done():
			timer.Stop()
			return nil, req.Context().Err()
		case <-timer.C:
		}
		delay = min(delay*2, MaxRetryDelay)
		if req.GetBody != nil {
			body, err := req.GetBody()
			if err != nil {
				return nil, err
			}
			req.Body = body
		}
	}
}

// retry reports whether a request that ended with resp or err may succeed if
// sent again, and how long to wait first. It reads the start of a retryable
// error's body, which the returned response still carries; a body that stalls
// ends the request with ErrStalled instead, as it already waited StallTimeout.
func retry(resp *http.Response, err error, delay time.Duration) (*http.Response, time.Duration, bool, error) {
	if err != nil {
		// A stalled request already waited StallTimeout; a cancelled one was meant.
		return resp, delay, !errors.Is(err, ErrStalled) && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded), err
	}
	if !slices.Contains(retryable, resp.StatusCode) {
		return resp, 0, false, nil
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		resp.Body.Close()
		return nil, 0, false, err
	}
	resp.Body = struct {
		io.Reader
		io.Closer
	}{io.MultiReader(bytes.NewReader(raw), resp.Body), resp.Body}
	// An exhausted quota stays exhausted.
	if resp.StatusCode == http.StatusTooManyRequests && bytes.Contains(raw, []byte("insufficient_quota")) {
		return resp, 0, false, nil
	}
	return resp, min(after(resp.Header.Get("Retry-After"), delay), MaxRetryDelay), true, nil
}

// after is how long a Retry-After header asks to wait, in seconds or until a
// date, or delay without one.
func after(header string, delay time.Duration) time.Duration {
	if seconds, err := strconv.Atoi(strings.TrimSpace(header)); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(header); err == nil {
		return max(time.Until(at), 0)
	}
	return delay
}

func send(transport http.RoundTripper, req *http.Request) (*http.Response, error) {
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
