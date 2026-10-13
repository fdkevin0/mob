package app

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
)

// pairingLifetime bounds how long a one-time browser pairing code stays valid.
const pairingLifetime = 5 * time.Minute

// access holds the local access token and the one-time codes that hand it to a browser.
type access struct {
	mu    sync.RWMutex
	token string
	// revoked closes when token is replaced, ending every request it authorized.
	revoked chan struct{}
	codes   map[string]time.Time
	now     func() time.Time
}

// Token is the current local access token.
func (s *Server) Token() string {
	s.access.mu.RLock()
	defer s.access.mu.RUnlock()
	return s.access.token
}

// authorize checks the request's token and returns the channel that closes when it is revoked.
func (s *Server) authorize(header string) (<-chan struct{}, bool) {
	s.access.mu.RLock()
	defer s.access.mu.RUnlock()
	return s.access.revoked, bearer(header, s.access.token)
}

// errRevoked ends requests whose token was rotated while they ran.
var errRevoked = errors.New("access token was replaced")

// revocable ties a request to its token: rotation cancels its context, so
// streams and turns stop, and fails body reads, so a request still waiting
// for its body never starts work. The caller runs done when the handler
// returns, since requests built outside net/http.Server are never cancelled.
func revocable(r *http.Request, revoked <-chan struct{}) (_ *http.Request, done func()) {
	ctx, cancel := context.WithCancelCause(r.Context())
	go func() {
		select {
		case <-revoked:
			cancel(errRevoked)
		case <-ctx.Done():
		}
	}()
	r = r.WithContext(context.WithValue(ctx, revocationKey{}, revoked))
	if r.Body != nil {
		r.Body = revocableBody{r.Body, revoked}
	}
	return r, func() { cancel(nil) }
}

type revocationKey struct{}

// revocation closes when the token that authorized the request is replaced;
// work that outlives the request uses it to stop with the request's authority.
func revocation(ctx context.Context) <-chan struct{} {
	revoked, _ := ctx.Value(revocationKey{}).(<-chan struct{})
	return revoked
}

type revocableBody struct {
	io.ReadCloser
	revoked <-chan struct{}
}

func (b revocableBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	select {
	case <-b.revoked:
		return 0, errRevoked
	default:
		return n, err
	}
}

func bearer(header, token string) bool {
	return token != "" && subtle.ConstantTimeCompare([]byte(header), []byte("Bearer "+token)) == 1
}

func (a *access) clock() time.Time {
	if a.now != nil {
		return a.now()
	}
	return time.Now()
}

// pair issues a single-use code that a browser exchanges for the token.
func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	a := &s.access
	code := chat.NewID() + chat.NewID()
	now := a.clock()
	a.mu.Lock()
	// Check again under the lock: a request authorized just before a rotation
	// must not mint a code that claims the replacement token.
	if !bearer(r.Header.Get("Authorization"), a.token) {
		a.mu.Unlock()
		http.Error(w, "unauthorized", 401)
		return
	}
	if a.codes == nil {
		a.codes = map[string]time.Time{}
	}
	for c, expires := range a.codes {
		if !now.Before(expires) {
			delete(a.codes, c)
		}
	}
	a.codes[code] = now.Add(pairingLifetime)
	a.mu.Unlock()
	writeJSON(w, 200, map[string]any{"code": code, "expiresAt": now.Add(pairingLifetime).UnixMilli()})
}

// claim exchanges a pairing code for the token. It is the only unauthenticated API route.
func (s *Server) claim(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Code string `json:"code"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.Code == "" {
		http.Error(w, "invalid pairing request", 400)
		return
	}
	a := &s.access
	a.mu.Lock()
	expires, ok := a.codes[input.Code]
	delete(a.codes, input.Code)
	token := a.token
	a.mu.Unlock()
	if !ok || !a.clock().Before(expires) {
		http.Error(w, "pairing code is invalid or expired; run mob open again", 403)
		return
	}
	writeJSON(w, 200, map[string]string{"token": token})
}

// ErrTokenFromEnvironment means the token is supplied through configuration and cannot be rotated here.
var ErrTokenFromEnvironment = errors.New("the access token is supplied through configuration; change it there and restart Mob")

// errStaleToken means the caller's token was replaced while its request waited.
var errStaleToken = errors.New("unauthorized")

// rotateToken replaces the token when allowed accepts the current one, persisting
// it first, and invalidates pending pairing codes. Every client signed in with
// the old token must sign in again.
func (s *Server) rotateToken(allowed func(current string) bool) error {
	if s.PersistToken == nil {
		return ErrTokenFromEnvironment
	}
	next := chat.NewID() + chat.NewID()
	s.access.mu.Lock()
	defer s.access.mu.Unlock()
	if !allowed(s.access.token) {
		return errStaleToken
	}
	if err := s.PersistToken(next); err != nil {
		return err
	}
	s.access.token = next
	s.access.codes = nil
	close(s.access.revoked)
	s.access.revoked = make(chan struct{})
	return nil
}

func (s *Server) rotate(w http.ResponseWriter, r *http.Request) {
	header := r.Header.Get("Authorization")
	if err := s.rotateToken(func(current string) bool { return bearer(header, current) }); errors.Is(err, ErrTokenFromEnvironment) {
		http.Error(w, err.Error(), 409)
	} else if errors.Is(err, errStaleToken) {
		http.Error(w, "unauthorized", 401)
	} else if err != nil {
		log.Printf("token rotation failed: %v", err)
		http.Error(w, "token rotation failed", 500)
	} else {
		w.WriteHeader(204)
	}
}
