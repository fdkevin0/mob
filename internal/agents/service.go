package agents

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/fdkevin0/mob/internal/chat"
)

// Service runs coding agent tasks. It is the conversation service's
// delegate for the tasks' conversations.
type Service struct {
	Store *chat.Store
	// Conversations starts the turns that hand the owner's words to a task.
	Conversations *chat.ConversationService
	// Dir holds the tasks' worktrees, under worktrees/.
	Dir string
	// Connect starts an agent in dir; nil runs its preset's command.
	Connect func(ctx context.Context, p Preset, dir string) (Conn, error)
	mu      sync.Mutex
	// sessions are the agents running, by task ID.
	sessions map[string]*session
	closed   bool
}

var _ chat.Delegate = (*Service)(nil)

var errStopping = errors.New("Mob is stopping")

// task is the task whose conversation is conversationID.
func (s *Service) task(conversationID string) (chat.Task, bool) {
	t, ok, err := s.Store.Task(conversationID)
	return t, ok && err == nil && t.ConversationID == conversationID
}

func (s *Service) Owns(conversationID string) bool {
	_, ok := s.task(conversationID)
	return ok
}

func (s *Service) Label(conversationID string) string {
	t, _ := s.task(conversationID)
	return t.Agent
}

func (s *Service) Reply(ctx context.Context, turn *chat.DelegateTurn) error {
	t, ok := s.task(turn.ConversationID)
	if !ok {
		return errors.New("no task answers this conversation")
	}
	if t.Status == chat.TaskStopped && turn.Text == "" {
		return nil
	}
	session, err := s.session(ctx, t)
	if err != nil {
		_ = s.Store.SetTaskStatus(t.ID, chat.TaskFailed)
		return err
	}
	return session.reply(ctx, turn)
}

func (s *Service) Decide(conversationID string, d chat.Decision, a chat.Answer) error {
	t, ok := s.task(conversationID)
	if !ok {
		return errors.New("no task answers this conversation")
	}
	s.mu.Lock()
	session := s.sessions[t.ID]
	s.mu.Unlock()
	// An agent that stopped waiting, such as when Mob restarted, is
	// started again by the next message.
	if session != nil {
		session.decide(d, a)
	}
	return nil
}

// session is the running agent of task t, started and its session loaded or
// created when there is none.
func (s *Service) session(ctx context.Context, t chat.Task) (*session, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errStopping
	}
	if running := s.sessions[t.ID]; running != nil {
		s.mu.Unlock()
		return running, nil
	}
	s.mu.Unlock()
	p, err := preset(t.Agent)
	if err != nil {
		return nil, err
	}
	connect := s.Connect
	if connect == nil {
		connect = start
	}
	conn, err := connect(ctx, p, t.Worktree)
	if err != nil {
		return nil, err
	}
	running, err := open(ctx, s, p, t, conn)
	if err != nil {
		conn.Stop()
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		running.close()
		return nil, errStopping
	}
	if s.sessions == nil {
		s.sessions = map[string]*session{}
	}
	s.sessions[t.ID] = running
	return running, nil
}

// drop ends the agent of task id, if it runs.
func (s *Service) drop(id string, running *session) {
	s.mu.Lock()
	if s.sessions[id] == running {
		delete(s.sessions, id)
	}
	s.mu.Unlock()
	running.close()
}

// Close ends every agent.
func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	sessions := s.sessions
	s.sessions = nil
	s.mu.Unlock()
	for _, running := range sessions {
		running.close()
	}
}

// StartTask makes a worktree of project for a new task and hands prompt to
// the agent in a turn that runs on its own.
func (s *Service) StartTask(ctx context.Context, project, agent, title, prompt string) (chat.Task, error) {
	p, ok, err := s.project(project)
	if err != nil {
		return chat.Task{}, err
	}
	if !ok {
		if p, err = s.AddProject(ctx, project, ""); err != nil {
			return chat.Task{}, err
		}
	}
	a, err := preset(agent)
	if err != nil {
		return chat.Task{}, err
	}
	title = strings.TrimSpace(title)
	if title == "" {
		title = firstLine(prompt, 60)
	}
	dir, branch, err := s.worktree(ctx, p, title)
	if err != nil {
		return chat.Task{}, err
	}
	t := chat.Task{Project: p.Name, Agent: a.Name, Title: title, Worktree: dir, Branch: branch, Status: chat.TaskRunning}
	if err := s.Store.CreateTask(&t); err != nil {
		return chat.Task{}, err
	}
	if err := s.Message(t.ID, prompt); err != nil {
		_ = s.Store.SetTaskStatus(t.ID, chat.TaskFailed)
		return t, err
	}
	return t, nil
}

// Message hands text to task id's agent in a turn that runs on its own.
func (s *Service) Message(id, text string) error {
	t, ok, err := s.Store.Task(id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("no task %s", id)
	}
	_, err = s.Conversations.Start(chat.ChatRequest{ID: t.ConversationID, Text: text, RequestID: chat.NewID(), Owner: true}, nil)
	return err
}

// StopTask stops task id's turn and its agent.
func (s *Service) StopTask(id string) error {
	t, ok, err := s.Store.Task(id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("no task %s", id)
	}
	s.Conversations.Stop(t.ConversationID)
	s.mu.Lock()
	running := s.sessions[t.ID]
	s.mu.Unlock()
	if running != nil {
		s.drop(t.ID, running)
	}
	return s.Store.SetTaskStatus(t.ID, chat.TaskStopped)
}

// firstLine is the first line of text, cut to n runes.
func firstLine(text string, n int) string {
	line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	if r := []rune(line); len(r) > n {
		return string(r[:n])
	}
	return line
}
