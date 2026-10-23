package agents

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/version"
)

const (
	// subtaskActive bounds the sub-tasks of one task that run or wait at once.
	subtaskActive = 3
	// subtaskTotal bounds the sub-tasks one task may start.
	subtaskTotal = 10
	// mcpName is what the agents call Mob's MCP server.
	mcpName = "mob"
)

// hub is the MCP server on loopback through which the agents of tasks that
// Mob's conversations started reach their sub-tasks. Each session has its
// own token, which names its task.
type hub struct {
	url    string
	server *http.Server
	// tokens are the tasks of the sessions that may use it, by token.
	tokens map[string]string
}

// mayDelegate reports whether task t may start sub-tasks: only a task Mob's
// conversation started may, so the tree is at most two agents deep.
func (s *Service) mayDelegate(t chat.Task) bool {
	return t.Parent != "" && !s.Owns(t.Parent)
}

// mcpServers are the MCP servers a session of task t gets: Mob's, when the
// task may start sub-tasks and the agent takes MCP servers over HTTP.
func (s *Service) mcpServers(t chat.Task, caps acp.AgentCapabilities) (servers []acp.McpServer, token string) {
	servers = []acp.McpServer{}
	if !caps.McpCapabilities.Http || !s.mayDelegate(t) {
		return servers, ""
	}
	url, err := s.listen()
	if err != nil {
		slog.Warn("start the MCP server for sub-tasks", "error", err)
		return servers, ""
	}
	token = chat.NewID() + chat.NewID()
	s.mu.Lock()
	if s.hub == nil {
		s.mu.Unlock()
		return servers, ""
	}
	s.hub.tokens[token] = t.ID
	s.mu.Unlock()
	servers = append(servers, acp.McpServer{Http: &acp.McpServerHttpInline{Name: mcpName, Type: "http", Url: url, Headers: []acp.HttpHeader{{Name: "Authorization", Value: "Bearer " + token}}}})
	return servers, token
}

// forget stops token from reaching the MCP server.
func (s *Service) forget(token string) {
	if token == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hub != nil {
		delete(s.hub.tokens, token)
	}
}

// listen starts the MCP server, unless it runs, and returns its URL.
func (s *Service) listen() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return "", errStopping
	}
	if s.hub != nil {
		return s.hub.url, nil
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	h := &hub{url: "http://" + l.Addr().String() + "/mcp", tokens: map[string]string{}}
	handler := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		s.mu.Lock()
		id, known := h.tokens[token]
		s.mu.Unlock()
		if !ok || !known {
			return nil
		}
		return s.subtaskServer(id)
	}, nil)
	mux := http.NewServeMux()
	mux.Handle("/mcp", handler)
	h.server = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = h.server.Serve(l) }()
	s.hub = h
	return h.url, nil
}

type startInput struct {
	Title  string `json:"title" jsonschema:"A short title for the sub-task"`
	Prompt string `json:"prompt" jsonschema:"What the sub-task's agent should do, with everything it needs to know"`
	Agent  string `json:"agent,omitempty" jsonschema:"The coding agent to use, such as codex or claude; yours when empty"`
}

type taskInput struct {
	Task string `json:"task" jsonschema:"The sub-task's ID"`
}

type messageInput struct {
	Task string `json:"task" jsonschema:"The sub-task's ID"`
	Text string `json:"text" jsonschema:"The instructions"`
}

// subtaskServer is the MCP server task id's agent sees.
func (s *Service) subtaskServer(id string) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: mcpName, Version: version.Current}, &mcp.ServerOptions{
		Instructions: "Mob runs this coding task. Its tools hand parts of your work to other coding agents, each in its own worktree and branch of the same project. The owner approves every sub-task first; Mob tells you when all your sub-tasks have ended.",
	})
	mcp.AddTool(server, &mcp.Tool{Name: "task_start", Description: fmt.Sprintf("Ask the owner to approve handing part of your work to another coding agent, in a new worktree and branch of this project. Returns at once; the sub-task starts once the owner approves, and Mob sends you a summary when all your sub-tasks have ended. At most %d run at once and %d in all.", subtaskActive, subtaskTotal)},
		func(ctx context.Context, _ *mcp.CallToolRequest, in startInput) (*mcp.CallToolResult, any, error) {
			text, err := s.askSubtask(id, in)
			return result(text, err), nil, nil
		})
	mcp.AddTool(server, &mcp.Tool{Name: "tasks", Description: "List the sub-tasks you started, with their status (running, waiting for the owner, review when done, stopped, failed), branch, latest reply and what they used."},
		func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, any, error) {
			text, err := s.listSubtasks(id)
			return result(text, err), nil, nil
		})
	mcp.AddTool(server, &mcp.Tool{Name: "task_message", Description: "Send one of your sub-tasks' agents more instructions; it works on them on its own."},
		func(_ context.Context, _ *mcp.CallToolRequest, in messageInput) (*mcp.CallToolResult, any, error) {
			child, err := s.subtask(id, in.Task)
			if err == nil && strings.TrimSpace(in.Text) == "" {
				err = errors.New("text is empty")
			}
			if err == nil {
				err = s.Message(child.ID, in.Text)
			}
			return result("Sent.", err), nil, nil
		})
	mcp.AddTool(server, &mcp.Tool{Name: "task_stop", Description: "Stop one of your sub-tasks' agents. Its branch and worktree stay."},
		func(_ context.Context, _ *mcp.CallToolRequest, in taskInput) (*mcp.CallToolResult, any, error) {
			child, err := s.subtask(id, in.Task)
			if err == nil {
				err = s.StopTask(child.ID)
			}
			if err == nil {
				s.settle(child.ID)
			}
			return result("Stopped.", err), nil, nil
		})
	return server
}

func result(text string, err error) *mcp.CallToolResult {
	if err != nil {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}}, IsError: true}
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}
}

// children are the tasks task t's conversation started.
func (s *Service) children(t chat.Task) ([]chat.Task, error) {
	list, err := s.Store.Tasks(t.Project)
	if err != nil {
		return nil, err
	}
	var kids []chat.Task
	for _, c := range list {
		if c.Parent == t.ConversationID {
			kids = append(kids, c)
		}
	}
	return kids, nil
}

// subtask is the task child, if task id started it.
func (s *Service) subtask(id, child string) (chat.Task, error) {
	parent, ok, err := s.Store.Task(id)
	if err != nil || !ok {
		return chat.Task{}, fmt.Errorf("no task %s", id)
	}
	c, ok, err := s.Store.Task(child)
	if err != nil || !ok || c.ID != child || c.Parent != parent.ConversationID {
		return chat.Task{}, fmt.Errorf("no sub-task %s of yours", child)
	}
	return c, nil
}

// askSubtask asks the owner, in task id's conversation, to approve starting
// a sub-task, and starts it once they do.
func (s *Service) askSubtask(id string, in startInput) (string, error) {
	t, ok, err := s.Store.Task(id)
	if err != nil || !ok {
		return "", fmt.Errorf("no task %s", id)
	}
	if !s.mayDelegate(t) {
		return "", errors.New("a sub-task cannot start sub-tasks of its own")
	}
	in.Title, in.Prompt, in.Agent = strings.TrimSpace(in.Title), strings.TrimSpace(in.Prompt), strings.TrimSpace(in.Agent)
	if in.Prompt == "" {
		return "", errors.New("prompt is empty")
	}
	if in.Agent == "" {
		in.Agent = t.Agent
	}
	a, err := preset(in.Agent)
	if err != nil {
		return "", err
	}
	if in.Title == "" {
		in.Title = firstLine(in.Prompt, 60)
	}
	kids, err := s.children(t)
	if err != nil {
		return "", err
	}
	active := 0
	for _, c := range kids {
		if c.Status == chat.TaskRunning || c.Status == chat.TaskWaiting {
			active++
		}
	}
	switch {
	case len(kids) >= subtaskTotal:
		return "", fmt.Errorf("you started %d sub-tasks, the most a task may", subtaskTotal)
	case active >= subtaskActive:
		return "", fmt.Errorf("%d of your sub-tasks are still at work, the most at once; wait for one to end", active)
	}
	session := s.running(t.ID)
	if session == nil {
		return "", errors.New("your session is not running")
	}
	call := acp.ToolCallId("mob-subtask-" + chat.NewID())
	input := map[string]any{"agent": a.Name, "project": t.Project, "title": in.Title, "prompt": in.Prompt}
	answer := session.askOwner(call, "Start a sub-task: "+in.Title, input)
	go func() {
		outcome := <-answer
		if outcome.Selected == nil || !strings.HasPrefix(string(outcome.Selected.OptionId), "allow") {
			session.deliver(item{update: &acp.SessionUpdate{ToolCallUpdate: &acp.SessionToolCallUpdate{ToolCallId: call, Status: acp.Ptr(acp.ToolCallStatusFailed), Content: []acp.ToolCallContent{acp.ToolContent(acp.TextBlock("The owner did not approve this sub-task."))}}}})
			return
		}
		child, err := s.StartTask(context.Background(), t.ConversationID, t.Project, a.Name, in.Title, in.Prompt)
		status, text := acp.ToolCallStatusCompleted, fmt.Sprintf("Started sub-task %s on branch %s.", child.ID, child.Branch)
		if err != nil {
			status, text = acp.ToolCallStatusFailed, "The sub-task did not start: "+err.Error()
		}
		session.deliver(item{update: &acp.SessionUpdate{ToolCallUpdate: &acp.SessionToolCallUpdate{ToolCallId: call, Status: &status, Content: []acp.ToolCallContent{acp.ToolContent(acp.TextBlock(text))}}}})
	}()
	return fmt.Sprintf("Asked the owner to approve sub-task %q (%s). It starts once they approve; Mob sends you a summary when all your sub-tasks have ended, and tasks lists them meanwhile.", in.Title, a.Title), nil
}

// listSubtasks is what tasks tells task id's agent.
func (s *Service) listSubtasks(id string) (string, error) {
	t, ok, err := s.Store.Task(id)
	if err != nil || !ok {
		return "", fmt.Errorf("no task %s", id)
	}
	kids, err := s.children(t)
	if err != nil {
		return "", err
	}
	if len(kids) == 0 {
		return "You started no sub-tasks.", nil
	}
	return s.report(kids)
}

// report lists tasks with their status, branch, what they used and their
// latest reply.
func (s *Service) report(list []chat.Task) (string, error) {
	ids := make([]string, len(list))
	for i, t := range list {
		ids[i] = t.ConversationID
	}
	used, err := s.Store.ConversationUsage(ids...)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for _, t := range list {
		fmt.Fprintf(&b, "- **%s** · %s · %s (task %s, branch `%s`)", statusLabels[t.Status], t.Agent, t.Title, t.ID, t.Branch)
		if u, ok := used[t.ConversationID]; ok {
			b.WriteString(" · " + u.Brief())
		}
		b.WriteString("\n")
		if said, _ := s.Store.LastReply(t.ConversationID); strings.TrimSpace(said) != "" {
			said = strings.TrimSpace(said)
			if r := []rune(said); len(r) > reportReply {
				said = "…" + string(r[len(r)-reportReply:])
			}
			b.WriteString("  " + strings.ReplaceAll(said, "\n", "\n  ") + "\n")
		}
	}
	return strings.TrimRight(b.String(), "\n"), nil
}

// reportReply bounds the agent's words a summary repeats per task, in runes.
const reportReply = 600

// summaryPrompt tells an agent its sub-tasks ended.
const summaryPrompt = "Automatic update from Mob, not written by the owner: all the sub-tasks you started have ended. Their branches are in this project; review and bring in what you need, then finish your own work.\n\n%s"

// settle tells the conversation that started task id when every task it
// started has ended: the agent of a task, which then goes on; or, for Mob's
// own conversation that started more than one, a summary in it and a notice.
func (s *Service) settle(id string) {
	t, ok, err := s.Store.Task(id)
	if err != nil || !ok || t.Parent == "" {
		return
	}
	list, err := s.Store.Tasks("")
	if err != nil {
		return
	}
	var siblings []chat.Task
	for _, c := range list {
		if c.Parent != t.Parent {
			continue
		}
		if c.Status == chat.TaskRunning || c.Status == chat.TaskWaiting {
			return
		}
		siblings = append(siblings, c)
	}
	// Each set of ended tasks is reported once, however many end together.
	sort.Slice(siblings, func(i, j int) bool { return siblings[i].CreatedAt < siblings[j].CreatedAt })
	var key strings.Builder
	for _, c := range siblings {
		key.WriteString(c.ID + ":" + c.Status + " ")
	}
	s.mu.Lock()
	if s.settled == nil {
		s.settled = map[string]string{}
	}
	if s.settled[t.Parent] == key.String() {
		s.mu.Unlock()
		return
	}
	s.settled[t.Parent] = key.String()
	s.mu.Unlock()
	text, err := s.report(siblings)
	if err != nil {
		return
	}
	if parent, ok := s.task(t.Parent); ok {
		prompt := fmt.Sprintf(summaryPrompt, text)
		if session := s.running(parent.ID); session != nil && session.enqueue(prompt) {
			// The agent at work reads it once its prompt ends.
			_ = s.Store.Say(parent.ConversationID, prompt)
			return
		}
		// An agent the owner stopped stays stopped, and one waiting for a
		// decision keeps waiting: a message would answer no to it.
		if parent.Status != chat.TaskReview {
			return
		}
		if err := s.Message(parent.ID, prompt); err != nil {
			slog.Warn("tell a task its sub-tasks ended", "task", parent.ID, "error", err)
		}
		return
	}
	if len(siblings) < 2 {
		// One task's end is news enough.
		return
	}
	summary := fmt.Sprintf("**All %d tasks started here have ended.**\n\n%s", len(siblings), text)
	if err := s.Store.Note(t.Parent, summary); err != nil {
		slog.Warn("summarize ended tasks", "conversation", t.Parent, "error", err)
		return
	}
	s.Conversations.Notify(chat.Notice{ConversationID: t.Parent, Text: summary})
}
