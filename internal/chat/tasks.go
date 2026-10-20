package chat

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// Task is work handed to a coding agent: one conversation the agent answers,
// in its own worktree and branch of a project.
type Task struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	// Project is the project's name, Agent the agent's.
	Project  string `json:"project"`
	Agent    string `json:"agent"`
	Title    string `json:"title"`
	Worktree string `json:"worktree"`
	Branch   string `json:"branch"`
	// Session is the agent's own session ID, for loading it again.
	Session string `json:"session,omitempty"`
	Status  string `json:"status"`
	// Plan is the agent's latest plan, as it reported it.
	Plan      []PlanEntry `json:"plan,omitempty"`
	CreatedAt int64       `json:"createdAt"`
	UpdatedAt int64       `json:"updatedAt"`
}

// PlanEntry is one step of an agent's plan: pending, in_progress or completed.
type PlanEntry struct {
	Content string `json:"content"`
	Status  string `json:"status"`
}

// What a task is doing.
const (
	TaskRunning = "running"
	// TaskWaiting tasks wait for the owner to decide an approval.
	TaskWaiting = "waiting"
	// TaskReview tasks have finished what they were asked; the owner reviews
	// the branch or asks for more.
	TaskReview  = "review"
	TaskStopped = "stopped"
	TaskFailed  = "failed"
)

const taskColumns = "id,conversation_id,project,agent,title,worktree,branch,session,status,plan,created_at,updated_at"

// CreateTask saves t with a new conversation titled after it, which the
// agent's replies go into.
func (s *Store) CreateTask(t *Task) error {
	now := time.Now().UnixMilli()
	t.ID, t.ConversationID, t.CreatedAt, t.UpdatedAt = NewID(), NewID(), now, now
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	title := []rune(t.Agent + ": " + t.Title)
	if len(title) > 60 {
		title = title[:60]
	}
	if _, err = tx.Exec("INSERT INTO conversations(id,title,updated_at) VALUES(?,?,?)", t.ConversationID, string(title), now); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO tasks("+taskColumns+") VALUES(?,?,?,?,?,?,?,?,?,'',?,?)", t.ID, t.ConversationID, t.Project, t.Agent, t.Title, t.Worktree, t.Branch, t.Session, t.Status, now, now); err != nil {
		return err
	}
	return tx.Commit()
}

func scanTask(row interface{ Scan(...any) error }) (Task, error) {
	var t Task
	var plan string
	err := row.Scan(&t.ID, &t.ConversationID, &t.Project, &t.Agent, &t.Title, &t.Worktree, &t.Branch, &t.Session, &t.Status, &plan, &t.CreatedAt, &t.UpdatedAt)
	if err == nil && plan != "" {
		err = json.Unmarshal([]byte(plan), &t.Plan)
	}
	return t, err
}

// Task finds a task by its ID or its conversation's; ok is false when
// neither names one.
func (s *Store) Task(id string) (t Task, ok bool, err error) {
	t, err = scanTask(s.db.QueryRow("SELECT "+taskColumns+" FROM tasks WHERE id=? OR conversation_id=?", id, id))
	if errors.Is(err, sql.ErrNoRows) {
		return t, false, nil
	}
	return t, err == nil, err
}

// Tasks lists the tasks of project, or of every project when it is empty,
// most recently updated first.
func (s *Store) Tasks(project string) ([]Task, error) {
	rows, err := s.db.Query("SELECT "+taskColumns+" FROM tasks WHERE ?='' OR project=? ORDER BY updated_at DESC,id", project, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, t)
	}
	return list, rows.Err()
}

// SetTaskStatus records what task id is doing.
func (s *Store) SetTaskStatus(id, status string) error {
	_, err := s.db.Exec("UPDATE tasks SET status=?,updated_at=? WHERE id=?", status, time.Now().UnixMilli(), id)
	return err
}

// SetTaskSession records the agent's session for task id.
func (s *Store) SetTaskSession(id, session string) error {
	_, err := s.db.Exec("UPDATE tasks SET session=?,updated_at=? WHERE id=?", session, time.Now().UnixMilli(), id)
	return err
}

// SetTaskPlan records the agent's latest plan for task id.
func (s *Store) SetTaskPlan(id string, plan []PlanEntry) error {
	raw, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	_, err = s.db.Exec("UPDATE tasks SET plan=?,updated_at=? WHERE id=?", string(raw), time.Now().UnixMilli(), id)
	return err
}

// LastReply is the last text of the conversation's latest reply: what the
// agent said after its last tool call.
func (s *Store) LastReply(conversationID string) (string, error) {
	var raw string
	err := s.db.QueryRow("SELECT parts FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1", conversationID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var parts []Part
	if err := json.Unmarshal([]byte(raw), &parts); err != nil {
		return "", err
	}
	text := ""
	for _, p := range parts {
		if p["type"] == "text" {
			text, _ = p["text"].(string)
		}
	}
	return text, nil
}
