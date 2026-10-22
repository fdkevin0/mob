package chat

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/llm"
	"github.com/gofrs/flock"
	_ "modernc.org/sqlite"
)

type Part map[string]any

type Message struct {
	ID       string         `json:"id"`
	Role     string         `json:"role"`
	Parts    []Part         `json:"parts"`
	Metadata map[string]any `json:"metadata,omitempty"`
	// Model answered an assistant message; Usage is what its steps cost.
	Model   string     `json:"-"`
	Usage   *llm.Usage `json:"-"`
	Command bool       `json:"-"`
}

type Conversation struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	UpdatedAt int64  `json:"updatedAt"`
}

type Store struct {
	db   *sql.DB
	lock *flock.Flock
	// Changes tells clients what each write changed.
	Changes Changes
	expiry  expiryTimers
}

func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

func OpenStore(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	lock := flock.New(path + ".lock")
	ok, err := lock.TryLock()
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("database is already in use; connect the TUI to the existing service")
	}
	// Set permissions before SQLite creates journals containing saved credentials.
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err == nil {
		err = errors.Join(file.Chmod(0600), file.Close())
	}
	if err != nil {
		_ = lock.Unlock()
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		_ = lock.Unlock()
		return nil, err
	}
	s := &Store{db: db, lock: lock}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;`)
	if err == nil {
		err = s.migrate()
	}
	if err == nil {
		_, err = db.Exec(`UPDATE messages SET status='interrupted', error='The service stopped before this reply completed.' WHERE status='streaming'; UPDATE deliveries SET state='failed-or-unknown',error='Service stopped during send; recipient outcome is unknown.' WHERE state='sending'; UPDATE deliveries SET state='processing-failed',error='Service stopped during processing; send a new message to continue.' WHERE state='processing';`)
	}
	if err != nil {
		_ = s.Close()
		return nil, err
	}
	if err := s.recoverApprovals(); err != nil {
		_ = s.Close()
		return nil, err
	}
	if err := s.scheduleAllExpiries(); err != nil {
		_ = s.Close()
		return nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	s.stopExpiries()
	return errors.Join(s.db.Close(), s.lock.Unlock())
}

func (s *Store) Create() (Conversation, error) {
	c := Conversation{NewID(), "New conversation", time.Now().UnixMilli()}
	_, err := s.db.Exec("INSERT INTO conversations(id,title,updated_at) VALUES(?,?,?)", c.ID, c.Title, c.UpdatedAt)
	if err == nil {
		s.Changes.conversation(c.ID, true)
	}
	return c, err
}

func (s *Store) List() ([]Conversation, error) {
	rows, err := s.db.Query("SELECT id,title,updated_at FROM conversations ORDER BY updated_at DESC,id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Conversation{}
	for rows.Next() {
		var c Conversation
		if err := rows.Scan(&c.ID, &c.Title, &c.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

func (s *Store) History(id string) ([]Message, error) {
	var found string
	if err := s.db.QueryRow("SELECT id FROM conversations WHERE id=?", id).Scan(&found); err != nil {
		return nil, err
	}
	rows, err := s.db.Query("SELECT id,role,parts,status,error,model,usage,kind FROM messages WHERE conversation_id=? ORDER BY seq", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Message{}
	for rows.Next() {
		var m Message
		var raw, status, failure, usage, kind string
		if err := rows.Scan(&m.ID, &m.Role, &raw, &status, &failure, &m.Model, &usage, &kind); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &m.Parts); err != nil {
			return nil, err
		}
		m.Metadata = map[string]any{"status": status}
		if failure != "" {
			m.Metadata["error"] = failure
		}
		if m.Model != "" {
			m.Metadata["model"] = m.Model
		}
		if usage != "" && json.Unmarshal([]byte(usage), &m.Usage) == nil {
			m.Metadata["usage"] = m.Usage
		}
		if m.Command = kind == "command"; m.Command {
			m.Metadata["command"] = true
		}
		result = append(result, m)
	}
	return result, rows.Err()
}

// Begin records the user's text and an empty assistant reply by model.
func (s *Store) Begin(id, requestID, text, model string) (Message, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback()
	if text != "" {
		raw, _ := json.Marshal([]Part{{"type": "text", "text": text}})
		if _, err = tx.Exec("INSERT INTO messages(id,conversation_id,role,parts,status) VALUES(?,?,'user',?,'complete')", requestID, id, string(raw)); err != nil {
			return Message{}, err
		}
		title := []rune(text)
		if len(title) > 60 {
			title = title[:60]
		}
		if _, err = tx.Exec("UPDATE conversations SET title=CASE WHEN title='New conversation' THEN ? ELSE title END,updated_at=? WHERE id=?", string(title), time.Now().UnixMilli(), id); err != nil {
			return Message{}, err
		}
	}
	m := Message{ID: NewID(), Role: "assistant", Parts: []Part{}, Model: model}
	_, err = tx.Exec("INSERT INTO messages(id,conversation_id,role,parts,status,model) VALUES(?,?,'assistant','[]','streaming',?)", m.ID, id, model)
	if err != nil {
		return Message{}, err
	}
	if err = tx.Commit(); err == nil {
		s.Changes.conversation(id, text != "")
	}
	return m, err
}

// Command records a slash command and its reply. Commands stay in the
// transcript but are never sent to a model.
func (s *Store) Command(id, requestID, text, reply string) (Message, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback()
	question, _ := json.Marshal([]Part{{"type": "text", "text": text}})
	m := Message{ID: NewID(), Role: "assistant", Parts: []Part{{"type": "text", "text": reply}}, Command: true}
	answer, _ := json.Marshal(m.Parts)
	if _, err = tx.Exec("INSERT INTO messages(id,conversation_id,role,parts,status,kind) VALUES(?,?,'user',?,'complete','command'),(?,?,'assistant',?,'complete','command')", requestID, id, string(question), m.ID, id, string(answer)); err != nil {
		return Message{}, err
	}
	if _, err = tx.Exec("UPDATE conversations SET updated_at=? WHERE id=?", time.Now().UnixMilli(), id); err != nil {
		return Message{}, err
	}
	if err = tx.Commit(); err == nil {
		s.Changes.conversation(id, true)
	}
	return m, err
}

func (s *Store) Save(m Message, status, failure string) error {
	raw, err := json.Marshal(m.Parts)
	if err != nil {
		return err
	}
	usage := ""
	if m.Usage != nil {
		encoded, _ := json.Marshal(m.Usage)
		usage = string(encoded)
	}
	_, err = s.db.Exec("UPDATE messages SET parts=?,status=?,error=?,usage=? WHERE id=?", string(raw), status, failure, usage, m.ID)
	if err == nil {
		s.messageChanged(m.ID)
	}
	return err
}

// ConversationModel is the model reference /model chose, or "" for the default.
func (s *Store) ConversationModel(id string) (string, error) {
	var model string
	err := s.db.QueryRow("SELECT model FROM conversations WHERE id=?", id).Scan(&model)
	return model, err
}

// Summary is a conversation's earlier messages summarized, through the
// message with ID Through, for models to read in their place.
type Summary struct{ Text, Through string }

func (s *Store) Summary(id string) (Summary, error) {
	var sum Summary
	err := s.db.QueryRow("SELECT summary,summary_through FROM conversations WHERE id=?", id).Scan(&sum.Text, &sum.Through)
	return sum, err
}

func (s *Store) Summarize(id string, sum Summary) error {
	_, err := s.db.Exec("UPDATE conversations SET summary=?,summary_through=? WHERE id=?", sum.Text, sum.Through, id)
	return err
}

func (s *Store) SetConversationModel(id, model string) error {
	result, err := s.db.Exec("UPDATE conversations SET model=? WHERE id=?", model, id)
	if err == nil {
		if n, _ := result.RowsAffected(); n == 0 {
			err = sql.ErrNoRows
		}
	}
	if err == nil {
		s.Changes.conversation(id, false)
	}
	return err
}

func (s *Store) RequestApproval(conversationID string, m Message, callID string, input any) (string, error) {
	id := NewID()
	raw, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	for _, part := range m.Parts {
		if part["toolCallId"] == callID {
			part["state"] = "approval-requested"
			part["approval"] = map[string]string{"id": id}
		}
	}
	parts, err := json.Marshal(m.Parts)
	if err != nil {
		return "", err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("INSERT INTO approvals(id,conversation_id,message_id,tool_call_id,input,expires_at) VALUES(?,?,?,?,?,?)", id, conversationID, m.ID, callID, string(raw), time.Now().Add(time.Hour).UnixMilli()); err != nil {
		return "", err
	}
	if _, err = tx.Exec("UPDATE messages SET parts=? WHERE id=?", string(parts), m.ID); err != nil {
		return "", err
	}
	if err = tx.Commit(); err == nil {
		s.Changes.conversation(conversationID, false)
		s.scheduleExpiry(conversationID)
	}
	return id, err
}

var ErrStaleApproval = errors.New("approval is unknown, expired, or already decided")

// ApprovalConversation locates the conversation a saved approval belongs to.
func (s *Store) ApprovalConversation(id string) (string, error) {
	var conversation string
	err := s.db.QueryRow("SELECT conversation_id FROM approvals WHERE id=?", id).Scan(&conversation)
	return conversation, err
}

// Decision is an approval the user has just decided.
type Decision struct {
	ApprovalID, MessageID, ToolCallID string
	// Tool is the name of the tool that asked.
	Tool  string
	Input json.RawMessage
}

// Decide records the user's decision, at most once. A denial completes the
// call and tells the model, with the user's reason when they gave one; an
// approved call is left for Complete, so a retry never carries it out twice.
func (s *Store) Decide(conversationID, approvalID string, approved bool, reason string) (Decision, error) {
	return s.decide(conversationID, approvalID, approved, reason, true)
}

// Withdraw records a pending approval as denied without telling a model, as
// when the owner wrote to a coding agent instead of deciding.
func (s *Store) Withdraw(conversationID, approvalID string) error {
	_, err := s.decide(conversationID, approvalID, false, "", false)
	return err
}

func (s *Store) decide(conversationID, approvalID string, approved bool, reason string, tell bool) (Decision, error) {
	d := Decision{ApprovalID: approvalID}
	tx, err := s.db.Begin()
	if err != nil {
		return d, err
	}
	defer tx.Rollback()
	var input, status string
	var expires int64
	err = tx.QueryRow("SELECT message_id,tool_call_id,input,status,expires_at FROM approvals WHERE id=? AND conversation_id=?", approvalID, conversationID).Scan(&d.MessageID, &d.ToolCallID, &input, &status, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return d, ErrStaleApproval
	}
	if err != nil {
		return d, err
	}
	if status != "pending" || expires < time.Now().UnixMilli() {
		return d, ErrStaleApproval
	}
	d.Input = json.RawMessage(input)
	status = "denied"
	if approved {
		status = "approved"
	}
	err = updatePart(tx, d, func(p Part) {
		d.Tool = strings.TrimPrefix(fmt.Sprint(p["type"]), "tool-")
		p["approval"] = map[string]any{"id": approvalID, "approved": approved}
		p["state"] = "approval-responded"
		if !approved {
			p["state"] = "output-denied"
		}
	})
	if err != nil {
		return d, err
	}
	if _, err = tx.Exec("UPDATE approvals SET status=? WHERE id=?", status, approvalID); err != nil {
		return d, err
	}
	if !approved && tell {
		note := "The user denied the " + d.Tool + " request. Do not retry unless asked."
		if reason != "" {
			note = "The user denied the " + d.Tool + " request and said: " + reason
		}
		body, _ := json.Marshal([]Part{{"type": "text", "text": note}})
		if _, err = tx.Exec("INSERT INTO messages(id,conversation_id,role,parts,status) VALUES(?,?,'user',?,'complete')", NewID(), conversationID, string(body)); err != nil {
			return d, err
		}
	}
	if err = tx.Commit(); err == nil {
		s.Changes.conversation(conversationID, false)
	}
	return d, err
}

// Complete records what an approved call returned and where a large output
// was saved, if it was.
func (s *Store) Complete(d Decision, output any, file string, failure error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	err = updatePart(tx, d, func(p Part) {
		if failure != nil {
			p["state"] = "output-error"
			p["errorText"] = failure.Error()
		} else {
			p["state"] = "output-available"
			p["output"] = output
			if file != "" {
				p["outputFile"] = file
			}
		}
	})
	if err != nil {
		return err
	}
	if err = tx.Commit(); err == nil {
		s.messageChanged(d.MessageID)
	}
	return err
}

// updatePart changes the decided call's part in its stored message.
func updatePart(tx *sql.Tx, d Decision, change func(Part)) error {
	var raw string
	if err := tx.QueryRow("SELECT parts FROM messages WHERE id=?", d.MessageID).Scan(&raw); err != nil {
		return err
	}
	var parts []Part
	if err := json.Unmarshal([]byte(raw), &parts); err != nil {
		return err
	}
	for _, p := range parts {
		if p["toolCallId"] == d.ToolCallID {
			change(p)
		}
	}
	encoded, err := json.Marshal(parts)
	if err != nil {
		return err
	}
	if _, err = tx.Exec("UPDATE messages SET parts=? WHERE id=?", string(encoded), d.MessageID); err != nil {
		return err
	}
	// A summary that covers the message tells of the call as it was; it is
	// dropped, so the next turn reads the message as it is now.
	_, err = tx.Exec(`UPDATE conversations SET summary='',summary_through='' WHERE summary_through<>''
		AND id=(SELECT conversation_id FROM messages WHERE id=?)
		AND (SELECT seq FROM messages WHERE id=?)<=(SELECT seq FROM messages WHERE id=conversations.summary_through)`, d.MessageID, d.MessageID)
	return err
}

// recoverApprovals settles calls whose decision survived but whose result did not.
func (s *Store) recoverApprovals() error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT a.id,a.message_id,a.tool_call_id FROM approvals a
 JOIN messages m ON m.id=a.message_id, json_each(m.parts) p
 WHERE a.status='approved' AND json_extract(p.value,'$.toolCallId')=a.tool_call_id
 AND json_extract(p.value,'$.state')='approval-responded'`)
	if err != nil {
		return err
	}
	var unfinished []Decision
	for rows.Next() {
		var d Decision
		if err := rows.Scan(&d.ApprovalID, &d.MessageID, &d.ToolCallID); err != nil {
			rows.Close()
			return err
		}
		unfinished = append(unfinished, d)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	for _, d := range unfinished {
		if err := updatePart(tx, d, func(p Part) {
			p["state"] = "output-error"
			p["errorText"] = "The service stopped before this approved call's result was saved. Its outcome is unknown; check before requesting it again."
		}); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// expiredApproval is what the model and the user see for a call whose
// approval expired undecided.
const expiredApproval = "The approval expired before the user decided; ask again if it is still needed."

// ExpireApprovals marks the conversation's undecided approvals that are past
// their expiry as expired and their calls as failed, so nothing waits on them.
func (s *Store) ExpireApprovals(conversationID string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query("SELECT id,message_id,tool_call_id FROM approvals WHERE conversation_id=? AND status='pending' AND expires_at<?", conversationID, time.Now().UnixMilli())
	if err != nil {
		return err
	}
	var expired []Decision
	for rows.Next() {
		var d Decision
		if err = rows.Scan(&d.ApprovalID, &d.MessageID, &d.ToolCallID); err != nil {
			rows.Close()
			return err
		}
		expired = append(expired, d)
	}
	if err = errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	for _, d := range expired {
		err = updatePart(tx, d, func(p Part) {
			p["state"] = "output-error"
			p["errorText"] = expiredApproval
		})
		if err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE approvals SET status='expired' WHERE id=?", d.ApprovalID); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err == nil && len(expired) > 0 {
		s.Changes.conversation(conversationID, false)
	}
	return err
}

// SaveFact keeps a fact for the conversation, and for every conversation of
// the owner's when the owner approved it; id makes saving it again a no-op.
func (s *Store) SaveFact(id, conversationID, fact string, owner bool) error {
	_, err := s.db.Exec("INSERT OR IGNORE INTO memories(id,conversation_id,fact,owner) VALUES(?,?,?,?)", id, conversationID, fact, owner)
	return err
}

// Memories are the facts a turn in conversation id reads: its own, and in
// the owner's turns every fact the owner approved.
func (s *Store) Memories(id string, owner bool) ([]string, error) {
	facts, err := s.facts("WHERE conversation_id=? OR (? AND owner)", id, owner)
	result := []string{}
	for _, f := range facts {
		result = append(result, f.Text)
	}
	return result, err
}

// Fact is one saved fact. Owner facts are read in all the owner's turns.
type Fact struct {
	ID, ConversationID, Text string
	Owner                    bool
}

// Facts are every saved fact, oldest first.
func (s *Store) Facts() ([]Fact, error) { return s.facts("") }

func (s *Store) facts(where string, args ...any) ([]Fact, error) {
	rows, err := s.db.Query("SELECT id,conversation_id,fact,owner FROM memories "+where+" ORDER BY rowid", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []Fact
	for rows.Next() {
		var f Fact
		if err = rows.Scan(&f.ID, &f.ConversationID, &f.Text, &f.Owner); err != nil {
			return nil, err
		}
		list = append(list, f)
	}
	return list, rows.Err()
}

// Forget deletes the fact with id, or every fact when id is "all", and
// reports how many it deleted.
func (s *Store) Forget(id string) (int64, error) {
	query, args := "DELETE FROM memories WHERE id=?", []any{id}
	if id == "all" {
		query, args = "DELETE FROM memories", nil
	}
	result, err := s.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func Text(m Message) string {
	var result string
	for _, p := range m.Parts {
		if p["type"] == "text" {
			result += fmt.Sprint(p["text"])
		}
	}
	return result
}

func (s *Store) HasRequest(id string) bool {
	var n int
	return s.db.QueryRow("SELECT count(*) FROM messages WHERE id=?", id).Scan(&n) == nil && n > 0
}

func (s *Store) Setting(key string, dest any) error {
	var raw string
	err := s.db.QueryRow("SELECT value FROM settings WHERE key=?", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(raw), dest)
}
func (s *Store) SaveSetting(key string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.db.Exec("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, string(raw))
	return err
}
