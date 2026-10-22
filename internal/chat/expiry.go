package chat

import (
	"database/sql"
	"errors"
	"sync"
	"time"
)

// expiryTimers expire each conversation's pending approvals when their time
// passes, so clients following changes see it without asking for a snapshot.
type expiryTimers struct {
	mu     sync.Mutex
	timers map[string]*time.Timer
	closed bool
}

// scheduleExpiry arms the conversation's timer for its earliest pending
// approval, or disarms it when none is pending.
func (s *Store) scheduleExpiry(conversationID string) {
	var next sql.NullInt64
	if err := s.db.QueryRow("SELECT MIN(expires_at) FROM approvals WHERE conversation_id=? AND status='pending'", conversationID).Scan(&next); err != nil {
		return
	}
	e := &s.expiry
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	if t := e.timers[conversationID]; t != nil {
		t.Stop()
		delete(e.timers, conversationID)
	}
	if !next.Valid {
		return
	}
	if e.timers == nil {
		e.timers = map[string]*time.Timer{}
	}
	// ExpireApprovals expires what is strictly past its time.
	wait := time.Until(time.UnixMilli(next.Int64)) + time.Millisecond
	e.timers[conversationID] = time.AfterFunc(wait, func() {
		if s.ExpireApprovals(conversationID) == nil {
			s.scheduleExpiry(conversationID)
		}
	})
}

// scheduleAllExpiries arms timers for the approvals left pending when Mob last stopped.
func (s *Store) scheduleAllExpiries() error {
	rows, err := s.db.Query("SELECT DISTINCT conversation_id FROM approvals WHERE status='pending'")
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	for _, id := range ids {
		s.scheduleExpiry(id)
	}
	return nil
}

func (s *Store) stopExpiries() {
	e := &s.expiry
	e.mu.Lock()
	defer e.mu.Unlock()
	e.closed = true
	for _, t := range e.timers {
		t.Stop()
	}
	e.timers = nil
}
