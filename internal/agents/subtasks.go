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
// agent takes MCP servers over HTTP, through which it reports how its work
// ended and, if it may, starts sub-tasks.
func (s *Service) mcpServers(t chat.Task, caps acp.AgentCapabilities) (servers []acp.McpServer, token string) {
	servers = []acp.McpServer{}
	if !caps.McpCapabilities.Http {
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
	// Stateless: every request is checked against the tokens as they are
	// now, so a token forgotten when its session ends reaches nothing,
	// and no MCP session outlives it.
	handler := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		id, ok := s.bearer(r)
		if !ok {
			return nil
		}
		return s.subtaskServer(id)
	}, &mcp.StreamableHTTPOptions{Stateless: true})
	auth := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := s.bearer(r); !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		handler.ServeHTTP(w, r)
	})
	mux := http.NewServeMux()
	mux.Handle("/mcp", auth)
	h.server = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = h.server.Serve(l) }()
	s.hub = h
	return h.url, nil
}

// bearer is the task whose token r carries, if the token is known.
func (s *Service) bearer(r *http.Request) (string, bool) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	s.mu.Lock()
	defer s.mu.Unlock()
	if !ok || s.hub == nil {
		return "", false
	}
	id, known := s.hub.tokens[token]
	return id, known
}

type startInput struct {
	Title  string `json:"title" jsonschema:"A short title for the sub-task"`
	Prompt string `json:"prompt" jsonschema:"What the sub-task's agent should do, with everything it needs to know"`
	Agent  string `json:"agent,omitempty" jsonschema:"The coding agent to use, such as codex or claude; yours when empty"`
	// Workspace is new, or shared to read the asking task's worktree.
	Workspace string `json:"workspace,omitempty" jsonschema:"new (default): a new worktree and branch; shared: work read-only in your worktree and branch, seeing your uncommitted changes, such as to review your work. A shared sub-task's edits are refused."`
}

type resultInput struct {
	Outcome string `json:"outcome" jsonschema:"passed: your work is done and holds up, or what you reviewed needs no changes; rework: your work, or what you reviewed, needs the changes you list; blocked: you cannot go on without a decision or something you lack"`
	Summary string `json:"summary" jsonschema:"What you did or found, in a few lines: for rework the changes needed, most important first; for blocked what you need"`
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
	t, _, _ := s.Store.Task(id)
	delegate := s.mayDelegate(t)
	instructions := "Mob runs this coding task. When you finish what you were asked, report how it ended with task_result; whoever gave you the task reads it."
	if delegate {
		instructions += " The other tools hand parts of your work to other coding agents, each in its own worktree and branch of the same project. The owner approves every sub-task first; Mob tells you when all your sub-tasks have ended, with how each said it ended."
	}
	server := mcp.NewServer(&mcp.Implementation{Name: mcpName, Version: version.Current}, &mcp.ServerOptions{Instructions: instructions})
	mcp.AddTool(server, &mcp.Tool{Name: "task_result", Description: "Report how your task ended: passed, rework or blocked, with a short summary. Call it once you finish what you were asked, as your last step; calling it again replaces what you said."},
		func(_ context.Context, _ *mcp.CallToolRequest, in resultInput) (*mcp.CallToolResult, any, error) {
			return result("Recorded.", s.recordResult(id, in)), nil, nil
		})
	if !delegate {
		return server
	}
	mcp.AddTool(server, &mcp.Tool{Name: "task_start", Description: fmt.Sprintf("Ask the owner to approve handing part of your work to another coding agent, in a new worktree and branch of this project, or read-only in your own worktree (workspace shared), such as to review your work. Returns at once; the sub-task starts once the owner approves, and Mob sends you a summary when all your sub-tasks have ended. At most %d run at once and %d in all.", subtaskActive, subtaskTotal)},
		func(ctx context.Context, _ *mcp.CallToolRequest, in startInput) (*mcp.CallToolResult, any, error) {
			text, err := s.askSubtask(id, in)
			return result(text, err), nil, nil
		})
	mcp.AddTool(server, &mcp.Tool{Name: "tasks", Description: "List the sub-tasks you started, with their status (running, waiting for the owner, review when done, stopped, failed), how each said its work ended (passed, needs rework, blocked), branch, its result or latest reply and what they used."},
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

// recordResult saves how task id's agent said its work ended.
func (s *Service) recordResult(id string, in resultInput) error {
	in.Outcome, in.Summary = strings.ToLower(strings.TrimSpace(in.Outcome)), strings.TrimSpace(in.Summary)
	switch in.Outcome {
	case chat.OutcomePassed, chat.OutcomeRework, chat.OutcomeBlocked:
	default:
		return fmt.Errorf("outcome is passed, rework or blocked, not %q", in.Outcome)
	}
	if r := []rune(in.Summary); len(r) > resultLimit {
		in.Summary = string(r[:resultLimit]) + "…"
	}
	return s.Store.SetTaskResult(id, in.Outcome, in.Summary)
}

// resultLimit bounds the summary an agent reports with its outcome, in runes.
const resultLimit = 4000

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
	shared := false
	switch in.Workspace {
	case "", "new":
	case "shared":
		shared = true
	default:
		return "", fmt.Errorf("workspace is new or shared, not %q", in.Workspace)
	}
	if in.Agent == "" {
		in.Agent = t.Agent
		if p, _ := preset(in.Agent); shared && p.ReadOnly == "" {
			in.Agent = readers()[0]
		}
	}
	a, err := preset(in.Agent)
	if err != nil {
		return "", err
	}
	if shared && a.ReadOnly == "" {
		return "", fmt.Errorf("%s cannot work read-only; use %s", a.Title, strings.Join(readers(), " or "))
	}
	if in.Title == "" {
		in.Title = firstLine(in.Prompt, 60)
	}
	// Checked again when the owner approves, which may be much later.
	if err := s.room(t, 0); err != nil {
		return "", err
	}
	session := s.running(t.ID)
	if session == nil {
		return "", errors.New("your session is not running")
	}
	call := acp.ToolCallId("mob-subtask-" + chat.NewID())
	input := map[string]any{"agent": a.Name, "project": t.Project, "title": in.Title, "prompt": in.Prompt}
	ask := "Start a sub-task: " + in.Title
	if shared {
		input["workspace"] = "read-only in " + t.Worktree
		ask = "Start a read-only sub-task: " + in.Title
	}
	answer := session.askOwner(call, ask, input)
	go func() {
		outcome := <-answer
		if outcome.Selected == nil || !strings.HasPrefix(string(outcome.Selected.OptionId), "allow") {
			session.deliver(item{update: &acp.SessionUpdate{ToolCallUpdate: &acp.SessionToolCallUpdate{ToolCallId: call, Status: acp.Ptr(acp.ToolCallStatusFailed), Content: []acp.ToolCallContent{acp.ToolContent(acp.TextBlock("The owner did not approve this sub-task."))}}}})
			return
		}
		var child chat.Task
		err := s.reserve(t)
		if err == nil {
			if shared {
				child, err = s.StartReader(t.ConversationID, t, a.Name, in.Title, in.Prompt)
			} else {
				child, err = s.StartTask(context.Background(), t.ConversationID, t.Project, a.Name, in.Title, in.Prompt)
			}
			s.release(t)
		}
		status, text := acp.ToolCallStatusCompleted, fmt.Sprintf("Started sub-task %s on branch %s.", child.ID, child.Branch)
		if err != nil {
			status, text = acp.ToolCallStatusFailed, "The sub-task did not start: "+err.Error()
		}
		session.deliver(item{update: &acp.SessionUpdate{ToolCallUpdate: &acp.SessionToolCallUpdate{ToolCallId: call, Status: &status, Content: []acp.ToolCallContent{acp.ToolContent(acp.TextBlock(text))}}}})
	}()
	return fmt.Sprintf("Asked the owner to approve sub-task %q (%s). It starts once they approve; Mob sends you a summary when all your sub-tasks have ended, and tasks lists them meanwhile.", in.Title, a.Title), nil
}

// room reports why task t may not start another sub-task, counting the
// starting ones too, if it may not.
func (s *Service) room(t chat.Task, starting int) error {
	kids, err := s.children(t)
	if err != nil {
		return err
	}
	active := starting
	for _, c := range kids {
		if c.Status == chat.TaskRunning || c.Status == chat.TaskWaiting {
			active++
		}
	}
	switch {
	case len(kids)+starting >= subtaskTotal:
		return fmt.Errorf("you started %d sub-tasks, the most a task may", subtaskTotal)
	case active >= subtaskActive:
		return fmt.Errorf("%d of your sub-tasks are at work or starting, the most at once; wait for one to end", active)
	}
	return nil
}

// reserve holds a place for a sub-task of t that is about to start, so that
// approvals decided together cannot pass the limits; release gives it back
// once the sub-task has started or failed to.
func (s *Service) reserve(t chat.Task) error {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	if err := s.room(t, s.starting[t.ID]); err != nil {
		return err
	}
	if s.starting == nil {
		s.starting = map[string]int{}
	}
	s.starting[t.ID]++
	return nil
}

func (s *Service) release(t chat.Task) {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	if s.starting[t.ID]--; s.starting[t.ID] <= 0 {
		delete(s.starting, t.ID)
	}
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
		fmt.Fprintf(&b, "- **%s** · %s · %s (task %s, branch `%s`)", label(t), t.Agent, t.Title, t.ID, t.Branch)
		if u, ok := used[t.ConversationID]; ok {
			b.WriteString(" · " + u.Brief())
		}
		b.WriteString("\n")
		// What the agent reported is its account; otherwise the end of what
		// it last said.
		said := t.Result
		if said == "" {
			said, _ = s.Store.LastReply(t.ConversationID)
			said = strings.TrimSpace(said)
			if r := []rune(said); len(r) > reportReply {
				said = "…" + string(r[len(r)-reportReply:])
			}
		}
		if said != "" {
			b.WriteString("  " + strings.ReplaceAll(said, "\n", "\n  ") + "\n")
		}
	}
	return strings.TrimRight(b.String(), "\n"), nil
}

// label is how a report names what task t is doing and, once it said, how
// its work ended.
func label(t chat.Task) string {
	if t.Outcome == "" {
		return statusLabels[t.Status]
	}
	return statusLabels[t.Status] + ", " + outcomeLabels[t.Outcome]
}

// outcomeLabels are how reports name outcomes.
var outcomeLabels = map[string]string{
	chat.OutcomePassed:  "passed",
	chat.OutcomeRework:  "needs rework",
	chat.OutcomeBlocked: "blocked",
}

// reportReply bounds the agent's words a summary repeats per task, in runes.
const reportReply = 600

// summaryPrompt tells an agent its sub-tasks ended.
const summaryPrompt = "Automatic update from Mob, not written by the owner: all the sub-tasks you started have ended, each with how it said its work ended (passed, needs rework or blocked) when it did. Their branches are in this project; review and bring in what you need, act on what they found, then finish your own work.\n\n%s"

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
		// A task that ends again, after more work, is news again.
		fmt.Fprintf(&key, "%s:%s:%d ", c.ID, c.Status, c.UpdatedAt)
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
		go s.tell(parent.ID, fmt.Sprintf(summaryPrompt, text))
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

// tellTries bounds how often tell finds the parent's conversation busy.
const tellTries = 5

// tell hands task id's agent the summary of its ended sub-tasks, once the
// turn its conversation may still be finishing has ended.
func (s *Service) tell(id, prompt string) {
	for try := 0; try < tellTries; try++ {
		parent, ok, err := s.Store.Task(id)
		if err != nil || !ok {
			return
		}
		if run := s.Conversations.Watch(parent.ConversationID); run != nil {
			<-run.Done()
		}
		if session := s.running(parent.ID); session != nil && session.enqueue(prompt) {
			// The agent at work reads it once its prompt ends.
			_ = s.Store.Say(parent.ConversationID, prompt)
			return
		}
		// An agent the owner stopped stays stopped, and one waiting for a
		// decision keeps waiting: a message would answer no to it.
		if parent, _, _ = s.Store.Task(id); parent.Status != chat.TaskReview {
			return
		}
		var busy *chat.CommandError
		if err = s.Message(parent.ID, prompt); err == nil || !errors.As(err, &busy) || busy.Status != 409 {
			if err != nil {
				slog.Warn("tell a task its sub-tasks ended", "task", parent.ID, "error", err)
			}
			return
		}
	}
}
