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
	if err := os.Chmod(path, 0600); err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return errors.Join(s.db.Close(), s.lock.Unlock()) }

func (s *Store) Create() (Conversation, error) {
	c := Conversation{NewID(), "New conversation", time.Now().UnixMilli()}
	_, err := s.db.Exec("INSERT INTO conversations(id,title,updated_at) VALUES(?,?,?)", c.ID, c.Title, c.UpdatedAt)
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
	return m, tx.Commit()
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
	return m, tx.Commit()
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
	return err
}

// ConversationModel is the model reference /model chose, or "" for the default.
func (s *Store) ConversationModel(id string) (string, error) {
	var model string
	err := s.db.QueryRow("SELECT model FROM conversations WHERE id=?", id).Scan(&model)
	return model, err
}

func (s *Store) SetConversationModel(id, model string) error {
	result, err := s.db.Exec("UPDATE conversations SET model=? WHERE id=?", model, id)
	if err == nil {
		if n, _ := result.RowsAffected(); n == 0 {
			err = sql.ErrNoRows
		}
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
	return id, tx.Commit()
}

var ErrStaleApproval = errors.New("approval is unknown, expired, or already decided")

// Decision is an approval the user has just decided.
type Decision struct {
	ApprovalID, MessageID, ToolCallID string
	// Tool is the name of the tool that asked.
	Tool  string
	Input json.RawMessage
}

// Decide records the user's decision, at most once. A denial completes the
// call and tells the model; an approved call is left for Complete, so a retry
// never carries it out twice.
func (s *Store) Decide(conversationID, approvalID string, approved bool) (Decision, error) {
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
	if !approved {
		note := "The user denied the " + d.Tool + " request. Do not retry unless asked."
		body, _ := json.Marshal([]Part{{"type": "text", "text": note}})
		if _, err = tx.Exec("INSERT INTO messages(id,conversation_id,role,parts,status) VALUES(?,?,'user',?,'complete')", NewID(), conversationID, string(body)); err != nil {
			return d, err
		}
	}
	return d, tx.Commit()
}

// Complete records what an approved call returned.
func (s *Store) Complete(d Decision, output any, failure error) error {
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
		}
	})
	if err != nil {
		return err
	}
	return tx.Commit()
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
	_, err = tx.Exec("UPDATE messages SET parts=? WHERE id=?", string(encoded), d.MessageID)
	return err
}

// SaveFact keeps a fact for the conversation; id makes saving it again a no-op.
func (s *Store) SaveFact(id, conversationID, fact string) error {
	_, err := s.db.Exec("INSERT OR IGNORE INTO memories VALUES(?,?,?)", id, conversationID, fact)
	return err
}

func (s *Store) Memories(id string) ([]string, error) {
	rows, err := s.db.Query("SELECT fact FROM memories WHERE conversation_id=? ORDER BY rowid", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var fact string
		if err = rows.Scan(&fact); err != nil {
			return nil, err
		}
		result = append(result, fact)
	}
	return result, rows.Err()
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
