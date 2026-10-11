package chat

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// Grant is a remembered approval: the owner's calls of Tool whose scope is
// Scope run without asking, in ConversationID or, when it is empty, in every
// conversation.
type Grant struct {
	ID             string
	ConversationID string
	Tool           string
	// Scope is what Tool.Scope returned for the approved input.
	Scope   string
	Created time.Time
}

// How long an approval is remembered, as Answer.Remember says.
const (
	RememberConversation = "conversation"
	RememberAlways       = "always"
)

// scope is what remembering an approval of input covers for t.
func (t Tool) scope(input json.RawMessage) string {
	if t.Scope == nil {
		return ""
	}
	return t.Scope(input)
}

// granted is RequestApproval's answer when a grant covers the call; the
// engine then carries the call out as approved.
type granted struct{ input json.RawMessage }

func (granted) Error() string { return "approved by a remembered decision" }

// AddGrant remembers an approval; remembering the same one again changes nothing.
func (s *Store) AddGrant(conversationID, tool, scope string) error {
	_, err := s.db.Exec("INSERT OR IGNORE INTO grants(id,conversation_id,tool,scope,created_at) VALUES(?,?,?,?,?)", NewID(), conversationID, tool, scope, time.Now().UnixMilli())
	return err
}

// Granted reports whether a grant covers tool's calls with scope in the conversation.
func (s *Store) Granted(conversationID, tool, scope string) (bool, error) {
	var one int
	err := s.db.QueryRow("SELECT 1 FROM grants WHERE tool=? AND scope=? AND conversation_id IN ('',?) LIMIT 1", tool, scope, conversationID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// Grants lists every remembered approval, oldest first.
func (s *Store) Grants() ([]Grant, error) {
	rows, err := s.db.Query("SELECT id,conversation_id,tool,scope,created_at FROM grants ORDER BY created_at, id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []Grant
	for rows.Next() {
		var g Grant
		var created int64
		if err = rows.Scan(&g.ID, &g.ConversationID, &g.Tool, &g.Scope, &created); err != nil {
			return nil, err
		}
		g.Created = time.UnixMilli(created)
		list = append(list, g)
	}
	return list, rows.Err()
}

// Revoke forgets the grant with id, or every grant when id is "all", and
// reports how many it forgot.
func (s *Store) Revoke(id string) (int64, error) {
	query, args := "DELETE FROM grants WHERE id=?", []any{id}
	if id == "all" {
		query, args = "DELETE FROM grants", nil
	}
	result, err := s.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
