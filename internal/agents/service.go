package agents

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

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
	// found is whether an agent's command was installed when last checked.
	checked time.Time
	found   bool
}

var _ chat.Delegate = (*Service)(nil)

var errStopping = errors.New("Mob is stopping")

// startWait is how long a message waits for an agent that is starting.
const startWait = 30 * time.Second

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
	if turn.Text == "" && s.running(t.ID) == nil {
		// A decision reached no agent: it stopped, or Mob restarted, while
		// the approval waited. Only the owner's next message starts one.
		return turn.Stream("text", "The agent stopped before this was decided; send the task a message to continue.")
	}
	session, err := s.session(ctx, t)
	switch {
	case err == nil:
		err = session.reply(ctx, turn)
	case ctx.Err() != nil:
		// Stopped while the agent was starting.
		_ = s.Store.SetTaskStatus(t.ID, chat.TaskStopped)
	default:
		_ = s.Store.SetTaskStatus(t.ID, chat.TaskFailed)
	}
	if ctx.Err() == nil && !errors.Is(err, context.Canceled) {
		// Stopping a task is the owner's doing; it raises no notice.
		s.notify(t.ID, turn, err)
	}
	return err
}

// noticeLimit bounds the agent's words a notice repeats, in runes.
const noticeLimit = 1200

// notify tells the owner, in the messaging apps they use, that task id's turn
// ended waiting for a decision, done or failed.
func (s *Service) notify(id string, turn *chat.DelegateTurn, failure error) {
	t, ok, err := s.Store.Task(id)
	if err != nil || !ok {
		return
	}
	n := chat.Notice{ConversationID: t.ConversationID, Channel: turn.Channel}
	title := fmt.Sprintf("%s · %s", t.Agent, t.Title)
	said := strings.TrimSpace(turn.Conclusion())
	if r := []rune(said); len(r) > noticeLimit {
		said = "…" + string(r[len(r)-noticeLimit:])
	}
	switch {
	case t.Status == chat.TaskFailed && failure != nil:
		n.Text = "**Task failed:** " + title + "\n\n" + failure.Error()
	case failure != nil:
		// The agent ended early but can go on, such as at its limit.
		n.Text = "**Task stopped early:** " + title + "\n\n" + failure.Error()
	case t.Status == chat.TaskWaiting:
		if n.Approvals = s.Conversations.Pending(t.ConversationID); len(n.Approvals) == 0 {
			return
		}
		n.Text = "**Task waits for your decision:** " + title
	case t.Status == chat.TaskReview && turn.Wrote():
		n.Text = "**Task done:** " + title + "\nBranch `" + t.Branch + "`"
		if used, err := s.Store.ConversationUsage(t.ConversationID); err == nil {
			if u, ok := used[t.ConversationID]; ok {
				n.Text += " · " + u.Brief()
			}
		}
	default:
		return
	}
	if said != "" && t.Status != chat.TaskFailed {
		n.Text += "\n\n" + said
	}
	s.Conversations.Notify(n)
}

func (s *Service) Decide(conversationID string, d chat.Decision, a chat.Answer) error {
	t, ok := s.task(conversationID)
	if !ok {
		return errors.New("no task answers this conversation")
	}
	if session := s.running(t.ID); session != nil && session.decide(d, a) {
		return nil
	}
	if a.Approved {
		// The agent stopped waiting, such as when Mob restarted, so the
		// approved call never ran.
		return s.Store.Complete(d, nil, "", errors.New("the agent stopped before this was decided"))
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
// the agent in a turn that runs on its own. parent is the conversation that
// started it, if any.
func (s *Service) StartTask(ctx context.Context, parent, project, agent, title, prompt string) (chat.Task, error) {
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
	t := chat.Task{Project: p.Name, Agent: a.Name, Title: title, Worktree: dir, Branch: branch, Status: chat.TaskRunning, Parent: parent}
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
	// An agent at work takes the text once its current prompt ends, in the
	// turn already following it.
	// A turn that has just begun may still be starting the agent.
	for wait := time.Now().Add(startWait); s.Conversations.Active(t.ConversationID); time.Sleep(20 * time.Millisecond) {
		if session := s.running(t.ID); session != nil && session.enqueue(text) {
			return s.Store.Say(t.ConversationID, text)
		}
		if time.Now().After(wait) {
			return errors.New("the agent is still starting; try again shortly")
		}
	}
	_, err = s.Conversations.Start(chat.ChatRequest{ID: t.ConversationID, Text: text, RequestID: chat.NewID(), Owner: true}, nil)
	return err
}

// running is the agent working on task id, or nil.
func (s *Service) running(id string) *session {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[id]
}

// Recover records the tasks that were running or waiting when Mob last
// stopped as stopped: their agents ended with it.
func (s *Service) Recover() error { return s.Store.StopTasks() }

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
	if running := s.running(t.ID); running != nil {
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
