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
	"time"

	"github.com/gofrs/flock"
	_ "modernc.org/sqlite"
)

type Part map[string]any

type Message struct {
	ID       string         `json:"id"`
	Role     string         `json:"role"`
	Parts    []Part         `json:"parts"`
	Metadata map[string]any `json:"metadata,omitempty"`
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
	_, err := s.db.Exec("INSERT INTO conversations VALUES(?,?,?)", c.ID, c.Title, c.UpdatedAt)
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
	rows, err := s.db.Query("SELECT id,role,parts,status,error FROM messages WHERE conversation_id=? ORDER BY seq", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Message{}
	for rows.Next() {
		var m Message
		var raw, status, failure string
		if err := rows.Scan(&m.ID, &m.Role, &raw, &status, &failure); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &m.Parts); err != nil {
			return nil, err
		}
		m.Metadata = map[string]any{"status": status}
		if failure != "" {
			m.Metadata["error"] = failure
		}
		result = append(result, m)
	}
	return result, rows.Err()
}

func (s *Store) Begin(id, requestID, text string) (Message, error) {
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
	m := Message{ID: NewID(), Role: "assistant", Parts: []Part{}}
	_, err = tx.Exec("INSERT INTO messages(id,conversation_id,role,parts,status) VALUES(?,?,'assistant','[]','streaming')", m.ID, id)
	if err != nil {
		return Message{}, err
	}
	return m, tx.Commit()
}

func (s *Store) Save(m Message, status, failure string) error {
	raw, err := json.Marshal(m.Parts)
	if err != nil {
		return err
	}
	_, err = s.db.Exec("UPDATE messages SET parts=?,status=?,error=? WHERE id=?", string(raw), status, failure, m.ID)
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

// Decision, side effect and displayed result commit together, so retries cannot write twice.
func (s *Store) Decide(conversationID, approvalID string, approved bool) (string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var messageID, callID, input, status, raw string
	var expires int64
	err = tx.QueryRow("SELECT message_id,tool_call_id,input,status,expires_at FROM approvals WHERE id=? AND conversation_id=?", approvalID, conversationID).Scan(&messageID, &callID, &input, &status, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrStaleApproval
	}
	if err != nil {
		return "", err
	}
	if status != "pending" || expires < time.Now().UnixMilli() {
		return "", ErrStaleApproval
	}
	var args struct {
		Fact string `json:"fact"`
	}
	if err = json.Unmarshal([]byte(input), &args); err != nil {
		return "", err
	}
	if err = tx.QueryRow("SELECT parts FROM messages WHERE id=?", messageID).Scan(&raw); err != nil {
		return "", err
	}
	var parts []Part
	if err = json.Unmarshal([]byte(raw), &parts); err != nil {
		return "", err
	}
	status = "denied"
	note := "The user denied saving this memory: " + args.Fact + ". Do not retry unless asked."
	if approved {
		status = "approved"
		if _, err = tx.Exec("INSERT INTO memories VALUES(?,?,?)", approvalID, conversationID, args.Fact); err != nil {
			return "", err
		}
		note = "The user approved remember. The following fact was saved locally: " + args.Fact + ". Confirm the result."
	}
	for _, p := range parts {
		if p["toolCallId"] == callID {
			p["approval"] = map[string]any{"id": approvalID, "approved": approved}
			if approved {
				p["state"] = "output-available"
				p["output"] = map[string]any{"saved": true}
			} else {
				p["state"] = "output-denied"
			}
		}
	}
	encoded, err := json.Marshal(parts)
	if err != nil {
		return "", err
	}
	if _, err = tx.Exec("UPDATE messages SET parts=? WHERE id=?", string(encoded), messageID); err != nil {
		return "", err
	}
	if _, err = tx.Exec("UPDATE approvals SET status=? WHERE id=?", status, approvalID); err != nil {
		return "", err
	}
	if !approved {
		body, _ := json.Marshal([]Part{{"type": "text", "text": note}})
		if _, err = tx.Exec("INSERT INTO messages(id,conversation_id,role,parts,status) VALUES(?,?,'user',?,'complete')", NewID(), conversationID, string(body)); err != nil {
			return "", err
		}
	}
	return note, tx.Commit()
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

func (s *Store) APIKey() (string, error) {
	var key string
	err := s.db.QueryRow("SELECT value FROM settings WHERE key='api_key'").Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return key, err
}
func (s *Store) SaveAPIKey(key string) error { return s.SaveAPIKeyFor(key, "https://api.deepseek.com") }
func (s *Store) SaveAPIKeyFor(key, baseURL string) error {
	origin, _ := json.Marshal(ProviderOrigin(baseURL))
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("INSERT INTO settings VALUES('api_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO settings VALUES('api_key_origin',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", string(origin)); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) APIKeyFor(baseURL string) (string, error) {
	var origin string
	if err := s.Setting("api_key_origin", &origin); err != nil {
		return "", err
	}
	// Unscoped legacy keys were entered for the original default provider.
	if origin == "" {
		origin = "https://api.deepseek.com"
	}
	if origin != ProviderOrigin(baseURL) {
		return "", nil
	}
	return s.APIKey()
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
