package app

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
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
	codes map[string]time.Time
	now   func() time.Time
}

// Token is the current local access token.
func (s *Server) Token() string {
	s.access.mu.RLock()
	defer s.access.mu.RUnlock()
	return s.access.token
}

func (s *Server) authorized(header string) bool {
	token := s.Token()
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

// ErrTokenFromEnvironment means the token is supplied through MOB_TOKEN and cannot be rotated here.
var ErrTokenFromEnvironment = errors.New("the access token is supplied through MOB_TOKEN; change it there and restart Mob")

// RotateToken replaces the token, persisting it first, and invalidates pending pairing codes.
// Every client signed in with the old token must sign in again.
func (s *Server) RotateToken() error {
	if s.PersistToken == nil {
		return ErrTokenFromEnvironment
	}
	next := chat.NewID() + chat.NewID()
	s.access.mu.Lock()
	defer s.access.mu.Unlock()
	if err := s.PersistToken(next); err != nil {
		return err
	}
	s.access.token = next
	s.access.codes = nil
	return nil
}

func (s *Server) rotate(w http.ResponseWriter, r *http.Request) {
	if err := s.RotateToken(); errors.Is(err, ErrTokenFromEnvironment) {
		http.Error(w, err.Error(), 409)
	} else if err != nil {
		log.Printf("token rotation failed: %v", err)
		http.Error(w, "token rotation failed", 500)
	} else {
		w.WriteHeader(204)
	}
}
