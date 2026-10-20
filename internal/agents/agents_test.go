package agents

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"

	"github.com/fdkevin0/mob/internal/chat"
)

// fake is an ACP agent that acts on the words of each prompt.
type fake struct {
	conn *acp.AgentSideConnection
	dir  string
	mu   sync.Mutex
	// prompts are the texts it was sent; mode the mode it was set to.
	prompts []string
	mode    string
	loaded  string
	// release lets a "hold" prompt end.
	release chan struct{}
	// spent is the cost "tokens" prompts report.
	spent float64
	// session is the ID of the sessions it creates, "s1" when empty;
	// failLoad makes loading a session fail.
	session  acp.SessionId
	failLoad bool
}

func (f *fake) Initialize(context.Context, acp.InitializeRequest) (acp.InitializeResponse, error) {
	return acp.InitializeResponse{ProtocolVersion: acp.ProtocolVersionNumber, AgentCapabilities: acp.AgentCapabilities{LoadSession: true}}, nil
}
func (f *fake) Authenticate(context.Context, acp.AuthenticateRequest) (acp.AuthenticateResponse, error) {
	return acp.AuthenticateResponse{}, nil
}
func (f *fake) Logout(context.Context, acp.LogoutRequest) (acp.LogoutResponse, error) {
	return acp.LogoutResponse{}, nil
}
func (f *fake) Cancel(context.Context, acp.CancelNotification) error { return nil }
func (f *fake) CloseSession(context.Context, acp.CloseSessionRequest) (acp.CloseSessionResponse, error) {
	return acp.CloseSessionResponse{}, nil
}
func (f *fake) ListSessions(context.Context, acp.ListSessionsRequest) (acp.ListSessionsResponse, error) {
	return acp.ListSessionsResponse{}, nil
}
func (f *fake) ResumeSession(context.Context, acp.ResumeSessionRequest) (acp.ResumeSessionResponse, error) {
	return acp.ResumeSessionResponse{}, nil
}
func (f *fake) SetSessionConfigOption(context.Context, acp.SetSessionConfigOptionRequest) (acp.SetSessionConfigOptionResponse, error) {
	return acp.SetSessionConfigOptionResponse{}, nil
}

var modes = &acp.SessionModeState{CurrentModeId: "read-only", AvailableModes: []acp.SessionMode{{Id: "read-only", Name: "Read only"}, {Id: "auto", Name: "Auto"}, {Id: "acceptEdits", Name: "Accept edits"}}}

func (f *fake) NewSession(_ context.Context, r acp.NewSessionRequest) (acp.NewSessionResponse, error) {
	f.mu.Lock()
	f.dir = r.Cwd
	id := f.session
	f.mu.Unlock()
	if id == "" {
		id = "s1"
	}
	return acp.NewSessionResponse{SessionId: id, Modes: modes}, nil
}
func (f *fake) LoadSession(ctx context.Context, r acp.LoadSessionRequest) (acp.LoadSessionResponse, error) {
	if f.failLoad {
		return acp.LoadSessionResponse{}, acp.NewInternalError(nil)
	}
	f.mu.Lock()
	f.dir, f.loaded = r.Cwd, string(r.SessionId)
	f.mu.Unlock()
	// Loading replays the session, which Mob already shows.
	_ = f.conn.SessionUpdate(ctx, acp.SessionNotification{SessionId: r.SessionId, Update: acp.UpdateAgentMessageText("replayed")})
	return acp.LoadSessionResponse{Modes: modes}, nil
}
func (f *fake) SetSessionMode(_ context.Context, r acp.SetSessionModeRequest) (acp.SetSessionModeResponse, error) {
	f.mu.Lock()
	f.mode = string(r.ModeId)
	f.mu.Unlock()
	return acp.SetSessionModeResponse{}, nil
}

func (f *fake) say(ctx context.Context, id acp.SessionId, u acp.SessionUpdate) {
	_ = f.conn.SessionUpdate(ctx, acp.SessionNotification{SessionId: id, Update: u})
}

func (f *fake) Prompt(ctx context.Context, p acp.PromptRequest) (acp.PromptResponse, error) {
	text := p.Prompt[0].Text.Text
	f.mu.Lock()
	f.prompts = append(f.prompts, text)
	dir := f.dir
	f.mu.Unlock()
	id := p.SessionId
	end := acp.PromptResponse{StopReason: acp.StopReasonEndTurn}
	switch {
	case text == "hello":
		f.say(ctx, id, acp.UpdatePlan(acp.PlanEntry{Content: "greet", Status: acp.PlanEntryStatusCompleted}))
		f.say(ctx, id, acp.StartToolCall("read1", "Read README", acp.WithStartKind(acp.ToolKindRead), acp.WithStartStatus(acp.ToolCallStatusCompleted), acp.WithStartContent([]acp.ToolCallContent{acp.ToolContent(acp.TextBlock("# Readme"))})))
		f.say(ctx, id, acp.UpdateAgentMessageText("Hi"))
	case text == "run" || text == "edit":
		kind, title, files := acp.ToolKindExecute, "npm test", []acp.ToolCallLocation(nil)
		if text == "edit" {
			kind, title, files = acp.ToolKindEdit, "Edit main.go", []acp.ToolCallLocation{{Path: filepath.Join(dir, "main.go")}}
		}
		f.say(ctx, id, acp.StartToolCall("call1", title, acp.WithStartKind(kind), acp.WithStartStatus(acp.ToolCallStatusPending), acp.WithStartLocations(files)))
		answer, err := f.conn.RequestPermission(ctx, acp.RequestPermissionRequest{SessionId: id, ToolCall: acp.ToolCallUpdate{ToolCallId: "call1", Title: acp.Ptr(title), Kind: acp.Ptr(kind), Locations: files}, Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, Name: "Allow", OptionId: "allow"},
			{Kind: acp.PermissionOptionKindAllowAlways, Name: "Always", OptionId: "always"},
			{Kind: acp.PermissionOptionKindRejectOnce, Name: "Reject", OptionId: "reject"},
		}})
		if err != nil || answer.Outcome.Selected == nil || answer.Outcome.Selected.OptionId == "reject" {
			if ctx.Err() != nil || answer.Outcome.Cancelled != nil {
				return acp.PromptResponse{StopReason: acp.StopReasonCancelled}, nil
			}
			f.say(ctx, id, acp.UpdateToolCall("call1", acp.WithUpdateStatus(acp.ToolCallStatusFailed)))
			f.say(ctx, id, acp.UpdateAgentMessageText("skipped"))
			return end, nil
		}
		f.say(ctx, id, acp.UpdateToolCall("call1", acp.WithUpdateStatus(acp.ToolCallStatusCompleted), acp.WithUpdateContent([]acp.ToolCallContent{acp.ToolContent(acp.TextBlock("ok"))})))
		f.say(ctx, id, acp.UpdateAgentMessageText("done "+string(answer.Outcome.Selected.OptionId)))
	case text == "hold":
		f.say(ctx, id, acp.UpdateAgentMessageText("holding "))
		<-f.release
	case text == "limit":
		f.say(ctx, id, acp.UpdateAgentMessageText("halfway"))
		return acp.PromptResponse{StopReason: acp.StopReasonMaxTokens}, nil
	case text == "tokens":
		// As Claude Agent reports: input without the cache, the total with
		// it, a breakdown by model and the cost of the run so far.
		f.mu.Lock()
		f.spent += 0.25
		spent := f.spent
		f.mu.Unlock()
		f.say(ctx, id, acp.SessionUpdate{UsageUpdate: &acp.SessionUsageUpdate{SessionUpdate: "usage_update", Used: 1000, Size: 200000, Cost: &acp.Cost{Amount: spent, Currency: "USD"}}})
		f.say(ctx, id, acp.UpdateAgentMessageText("counted"))
		count := map[string]any{"inputTokens": 10, "cachedInputTokens": 900, "cachedWriteTokens": 90, "outputTokens": 40, "totalTokens": 1040}
		return acp.PromptResponse{StopReason: acp.StopReasonEndTurn, Usage: &acp.Usage{InputTokens: 10, CachedReadTokens: acp.Ptr(900), CachedWriteTokens: acp.Ptr(90), OutputTokens: 40, TotalTokens: 1040},
			Meta: map[string]any{"quota": map[string]any{"model_usage": []any{map[string]any{"model": "claude-test", "token_count": count}}}}}, nil
	case text == "login":
		return acp.PromptResponse{}, acp.NewAuthRequired(nil)
	case text == "wait":
		<-ctx.Done()
		return acp.PromptResponse{StopReason: acp.StopReasonCancelled}, nil
	default:
		f.say(ctx, id, acp.UpdateAgentMessageText("got "+text))
	}
	return end, nil
}

// fakes starts a fake agent for every session; agents lists them.
type fakes struct {
	mu     sync.Mutex
	agents []*fake
	// slow, when set, makes starting an agent wait until it is stopped.
	slow bool
	// session and failLoad are given to the agents started next.
	session  acp.SessionId
	failLoad bool
}

func (fs *fakes) connect(ctx context.Context, _ Preset, _ string) (Conn, error) {
	fs.mu.Lock()
	slow := fs.slow
	fs.mu.Unlock()
	if slow {
		<-ctx.Done()
		return Conn{}, ctx.Err()
	}
	toAgent, fromClient := io.Pipe()
	toClient, fromAgent := io.Pipe()
	fs.mu.Lock()
	f := &fake{release: make(chan struct{}), session: fs.session, failLoad: fs.failLoad}
	fs.mu.Unlock()
	f.conn = acp.NewAgentSideConnection(f, fromAgent, toAgent)
	f.conn.SetLogger(slog.New(slog.DiscardHandler))
	fs.mu.Lock()
	fs.agents = append(fs.agents, f)
	fs.mu.Unlock()
	stop := func() { fromClient.Close(); toClient.Close(); toAgent.Close(); fromAgent.Close() }
	return Conn{In: fromClient, Out: toClient, Stop: stop}, nil
}

func (fs *fakes) last() *fake {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.agents[len(fs.agents)-1]
}

func repository(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "start"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	return dir
}

type harness struct {
	t     *testing.T
	svc   *Service
	conv  *chat.ConversationService
	fakes *fakes
	repo  string
}

func newHarness(t *testing.T) *harness {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	conversations := chat.NewConversation(store, nil)
	fs := &fakes{}
	svc := &Service{Store: store, Conversations: conversations, Dir: t.TempDir(), Connect: fs.connect}
	conversations.SetDelegate(svc)
	conversations.Tools.Register(svc.Tools()...)
	t.Cleanup(func() { conversations.Close(); svc.Close(); store.Close() })
	return &harness{t: t, svc: svc, conv: conversations, fakes: fs, repo: repository(t)}
}

// wait waits for the task's turn to end.
func (h *harness) wait(task chat.Task) chat.Task {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for h.conv.Active(task.ConversationID) {
		if time.Now().After(deadline) {
			h.t.Fatal("task turn did not end")
		}
		time.Sleep(5 * time.Millisecond)
	}
	t, _, err := h.svc.Store.Task(task.ID)
	if err != nil {
		h.t.Fatal(err)
	}
	return t
}

func (h *harness) say(task chat.Task, text string) chat.Task {
	h.t.Helper()
	if err := h.svc.Message(task.ID, text); err != nil {
		h.t.Fatal(err)
	}
	return h.wait(task)
}

// decide answers the task's only pending approval.
func (h *harness) decide(task chat.Task, answer chat.Answer) chat.Task {
	h.t.Helper()
	pending := h.conv.Pending(task.ConversationID)
	if len(pending) != 1 {
		h.t.Fatalf("pending approvals = %+v", pending)
	}
	answer.ID = pending[0].ID
	if err := h.conv.Execute(context.Background(), chat.ChatRequest{ID: task.ConversationID, Approval: &answer, Owner: true}, func(chat.Event) error { return nil }); err != nil {
		h.t.Fatal(err)
	}
	return h.wait(task)
}

// reply is the text of the conversation's latest reply.
func (h *harness) reply(task chat.Task) string {
	h.t.Helper()
	history, err := h.svc.Store.History(task.ConversationID)
	if err != nil {
		h.t.Fatal(err)
	}
	last := history[len(history)-1]
	if failure, ok := last.Metadata["error"]; ok {
		h.t.Fatalf("reply failed: %v", failure)
	}
	return chat.Text(last)
}

func (h *harness) start(prompt string) chat.Task {
	h.t.Helper()
	task, err := h.svc.StartTask(context.Background(), h.repo, "", "", prompt)
	if err != nil {
		h.t.Fatal(err)
	}
	return h.wait(task)
}

func TestTaskRunsInItsOwnWorktree(t *testing.T) {
	h := newHarness(t)
	task := h.start("hello")
	if task.Status != chat.TaskReview || task.Agent != "codex" || task.Session != "s1" || !strings.HasPrefix(task.Branch, "mob/hello-") {
		t.Fatalf("task = %+v", task)
	}
	if branch, err := git(context.Background(), task.Worktree, "branch", "--show-current"); err != nil || branch != task.Branch {
		t.Fatalf("worktree branch = %q, %v", branch, err)
	}
	f := h.fakes.last()
	if f.dir != task.Worktree || f.mode != "auto" {
		t.Fatalf("agent ran in %q, mode %q", f.dir, f.mode)
	}
	if got := h.reply(task); got != "Hi" {
		t.Fatalf("reply = %q", got)
	}
	history, _ := h.svc.Store.History(task.ConversationID)
	last := history[len(history)-1]
	if last.Model != "codex" {
		t.Fatalf("model = %q", last.Model)
	}
	var tool chat.Part
	for _, p := range last.Parts {
		if p["type"] == "tool-codex_read" {
			tool = p
		}
	}
	if tool == nil || tool["state"] != "output-available" || !strings.Contains(fmtJSON(tool["output"]), "# Readme") {
		t.Fatalf("parts = %v", last.Parts)
	}
	if len(task.Plan) != 1 || task.Plan[0].Content != "greet" || task.Plan[0].Status != "completed" {
		t.Fatalf("plan = %+v", task.Plan)
	}
	projects, _ := h.svc.Projects()
	if len(projects) != 1 || projects[0].Name != filepath.Base(h.repo) {
		t.Fatalf("projects = %+v", projects)
	}
}

func fmtJSON(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

func TestClaudeAgent(t *testing.T) {
	h := newHarness(t)
	task, err := h.svc.StartTask(context.Background(), h.repo, "claude", "", "login")
	if err != nil {
		t.Fatal(err)
	}
	task = h.wait(task)
	if task.Agent != "claude" || task.Status != chat.TaskFailed || h.fakes.last().mode != "acceptEdits" {
		t.Fatalf("task = %+v, mode %q", task, h.fakes.last().mode)
	}
	history, _ := h.svc.Store.History(task.ConversationID)
	if failure := fmtJSON(history[len(history)-1].Metadata["error"]); !strings.Contains(failure, "Claude Agent is not signed in") || !strings.Contains(failure, "/login") {
		t.Fatalf("error = %s", failure)
	}
}

func TestApprovalsReachTheAgent(t *testing.T) {
	h := newHarness(t)
	task := h.start("run")
	if task.Status != chat.TaskWaiting {
		t.Fatalf("status = %q", task.Status)
	}
	pending := h.conv.Pending(task.ConversationID)
	if len(pending) != 1 || pending[0].Tool != "codex_execute" || !strings.Contains(fmtJSON(pending[0].Input), "npm test") {
		t.Fatalf("pending = %+v", pending)
	}
	task = h.decide(task, chat.Answer{Approved: true})
	if task.Status != chat.TaskReview || h.reply(task) != "done allow" {
		t.Fatalf("status %q, reply %q", task.Status, h.reply(task))
	}
	history, _ := h.svc.Store.History(task.ConversationID)
	last := history[len(history)-1]
	if len(last.Parts) == 0 || last.Parts[0]["type"] != "tool-codex_execute" || last.Parts[0]["state"] != "output-available" {
		t.Fatalf("continued reply = %v", last.Parts)
	}

	// A denial's reason goes to the agent once it has dealt with the denial.
	task = h.say(task, "run")
	task = h.decide(task, chat.Answer{Approved: false, Reason: "use make"})
	if got := h.reply(task); !strings.HasSuffix(got, "got use make") {
		t.Fatalf("reply = %q", got)
	}

	// Always allow covers the same command from then on.
	task = h.say(task, "run")
	task = h.decide(task, chat.Answer{Approved: true, Remember: chat.RememberAlways})
	if got := h.reply(task); got != "done always" {
		t.Fatalf("reply = %q", got)
	}
	task = h.say(task, "run")
	if task.Status != chat.TaskReview || h.reply(task) != "done allow" {
		t.Fatalf("remembered approval: status %q, reply %q", task.Status, h.reply(task))
	}
}

func TestEditsInTheWorktreeNeedNoApproval(t *testing.T) {
	h := newHarness(t)
	task := h.start("edit")
	if task.Status != chat.TaskReview || h.reply(task) != "done allow" {
		t.Fatalf("status %q, reply %q", task.Status, h.reply(task))
	}
}

func TestWritingInsteadOfDecidingDenies(t *testing.T) {
	h := newHarness(t)
	task := h.start("run")
	task = h.say(task, "never mind")
	if got := h.reply(task); got != "skippedgot never mind" {
		t.Fatalf("reply = %q", got)
	}
	if len(h.conv.Pending(task.ConversationID)) != 0 {
		t.Fatal("approval still pending")
	}
}

func TestStopAndReload(t *testing.T) {
	h := newHarness(t)
	task, err := h.svc.StartTask(context.Background(), h.repo, "", "wait", "wait")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if err := h.svc.StopTask(task.ID); err != nil {
		t.Fatal(err)
	}
	task = h.wait(task)
	if task.Status != chat.TaskStopped {
		t.Fatalf("status = %q", task.Status)
	}
	// A stopped agent is started again, loading its session, when the
	// owner writes; the replay is not shown again.
	task = h.say(task, "again")
	f := h.fakes.last()
	if len(h.fakes.agents) != 2 || f.loaded != "s1" || h.reply(task) != "got again" {
		t.Fatalf("agents %d, loaded %q, reply %q", len(h.fakes.agents), f.loaded, h.reply(task))
	}
}

func TestOnlyTheOwner(t *testing.T) {
	h := newHarness(t)
	task := h.start("hello")
	err := h.conv.Execute(context.Background(), chat.ChatRequest{ID: task.ConversationID, Text: "hi", RequestID: chat.NewID()}, func(chat.Event) error { return nil })
	var command *chat.CommandError
	if !errors.As(err, &command) || command.Status != 403 {
		t.Fatalf("err = %v", err)
	}
}

func TestStartTaskTool(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.AddProject(context.Background(), h.repo, "mob"); err != nil {
		t.Fatal(err)
	}
	var start chat.Tool
	for _, tool := range h.svc.Tools() {
		if tool.Name == "task_start" {
			start = tool
		}
	}
	if _, err := start.Run(context.Background(), chat.ToolCall{Input: map[string]any{"project": "other", "prompt": "x"}}); err == nil || !strings.Contains(err.Error(), "saved projects: mob") {
		t.Fatalf("unknown project: %v", err)
	}
	out, err := start.Approved(context.Background(), chat.ApprovedCall{Input: json.RawMessage(`{"project":"mob","agent":"codex","title":"Say hello","prompt":"hello"}`)})
	if err != nil {
		t.Fatal(err)
	}
	id := out.(map[string]any)["task"].(string)
	task, _, _ := h.svc.Store.Task(id)
	task = h.wait(task)
	if task.Project != "mob" || task.Title != "Say hello" || task.Status != chat.TaskReview {
		t.Fatalf("task = %+v", task)
	}
	overview, err := h.svc.overview("")
	if err != nil || !strings.Contains(fmtJSON(overview), `"latestReply":"Hi"`) {
		t.Fatalf("overview = %s, %v", fmtJSON(overview), err)
	}
}

func TestMessageWhileWorking(t *testing.T) {
	h := newHarness(t)
	task, err := h.svc.StartTask(context.Background(), h.repo, "", "", "hold")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.Message(task.ID, "also this"); err != nil {
		t.Fatal(err)
	}
	close(h.fakes.last().release)
	task = h.wait(task)
	history, _ := h.svc.Store.History(task.ConversationID)
	var said bool
	reply := ""
	for _, m := range history {
		said = said || m.Role == "user" && chat.Text(m) == "also this"
		if m.Role == "assistant" {
			reply = chat.Text(m)
		}
	}
	if !said || task.Status != chat.TaskReview || reply != "holding got also this" {
		t.Fatalf("said %v, status %q, reply %q", said, task.Status, reply)
	}
}

func TestDecidingAfterARestart(t *testing.T) {
	h := newHarness(t)
	task := h.start("run")
	// Mob stops: the agent ends with it, and starting again marks the task.
	h.svc.drop(task.ID, h.svc.running(task.ID))
	if err := h.svc.Recover(); err != nil {
		t.Fatal(err)
	}
	task = h.decide(task, chat.Answer{Approved: true})
	if task.Status != chat.TaskStopped || len(h.fakes.agents) != 1 || !strings.Contains(h.reply(task), "stopped before") {
		t.Fatalf("status %q, agents %d, reply %q", task.Status, len(h.fakes.agents), h.reply(task))
	}
	history, _ := h.svc.Store.History(task.ConversationID)
	for _, m := range history {
		for _, p := range m.Parts {
			if p["type"] == "tool-codex_execute" && p["state"] != "output-error" {
				t.Fatalf("approved call left %v", p["state"])
			}
		}
	}
}

func TestInside(t *testing.T) {
	dir := string(os.PathSeparator) + filepath.Join("w", "t")
	for path, want := range map[string]bool{filepath.Join(dir, "a.go"): true, dir: true, "b/c.go": true, filepath.Join(dir, "..", "x"): false, filepath.Join(dir+"x", "a"): false} {
		if inside(dir, path) != want {
			t.Errorf("inside(%q) = %v", path, !want)
		}
	}
	// Links are followed, even to files that do not exist yet.
	worktree, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(worktree, "link")); err != nil {
		t.Skip(err)
	}
	if err := os.Symlink(filepath.Join(outside, "missing"), filepath.Join(worktree, "dangling")); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]bool{filepath.Join(worktree, "new", "a.go"): true, filepath.Join(worktree, "link", "authorized_keys"): false, filepath.Join(worktree, "link"): false, filepath.Join(worktree, "dangling"): false} {
		if inside(worktree, path) != want {
			t.Errorf("inside(%q) = %v", path, !want)
		}
	}
}

func TestNoticesTellTheOwner(t *testing.T) {
	h := newHarness(t)
	var mu sync.Mutex
	var notices []chat.Notice
	defer h.conv.Notices(func(n chat.Notice) { mu.Lock(); notices = append(notices, n); mu.Unlock() })()
	took := func() []chat.Notice {
		mu.Lock()
		defer mu.Unlock()
		list := notices
		notices = nil
		return list
	}

	task := h.start("run")
	got := took()
	if len(got) != 1 || got[0].ConversationID != task.ConversationID || len(got[0].Approvals) != 1 || !strings.HasPrefix(got[0].Text, "**Task waits for your decision:** codex · run") {
		t.Fatalf("waiting notices = %+v", got)
	}
	// The app a decision came from already shows how the turn ended.
	answer := chat.Answer{ID: got[0].Approvals[0].ID, Approved: true}
	if err := h.conv.Execute(context.Background(), chat.ChatRequest{ID: task.ConversationID, Approval: &answer, Owner: true, Channel: "Telegram"}, func(chat.Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	h.wait(task)
	got = took()
	if len(got) != 1 || got[0].Channel != "Telegram" || !strings.Contains(got[0].Text, "**Task done:** codex · run\nBranch `"+task.Branch+"`\n\ndone allow") {
		t.Fatalf("done notices = %+v", got)
	}

	failed, err := h.svc.StartTask(context.Background(), h.repo, "claude", "", "login")
	if err != nil {
		t.Fatal(err)
	}
	h.wait(failed)
	if got = took(); len(got) != 1 || !strings.Contains(got[0].Text, "**Task failed:** claude · login\n\nClaude Agent is not signed in") {
		t.Fatalf("failure notices = %+v", got)
	}

	limited, err := h.svc.StartTask(context.Background(), h.repo, "", "", "limit")
	if err != nil {
		t.Fatal(err)
	}
	if limited = h.wait(limited); limited.Status != chat.TaskReview {
		t.Fatalf("status = %q", limited.Status)
	}
	if got = took(); len(got) != 1 || !strings.Contains(got[0].Text, "**Task stopped early:** codex · limit\n\nCodex stopped at its limit (max_tokens); send a message to continue\n\nhalfway") {
		t.Fatalf("limit notices = %+v", got)
	}

	stopped, err := h.svc.StartTask(context.Background(), h.repo, "", "", "wait")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if err := h.svc.StopTask(stopped.ID); err != nil {
		t.Fatal(err)
	}
	h.wait(stopped)
	if got = took(); len(got) != 0 {
		t.Fatalf("stopping a task told the owner: %+v", got)
	}

	// Nor does stopping one whose agent is still starting.
	h.fakes.mu.Lock()
	h.fakes.slow = true
	h.fakes.mu.Unlock()
	starting, err := h.svc.StartTask(context.Background(), h.repo, "", "", "hello")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if err := h.svc.StopTask(starting.ID); err != nil {
		t.Fatal(err)
	}
	if starting = h.wait(starting); starting.Status != chat.TaskStopped {
		t.Fatalf("status = %q", starting.Status)
	}
	if got = took(); len(got) != 0 {
		t.Fatalf("stopping a starting task told the owner: %+v", got)
	}
}

func TestUsageIsRecorded(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	h := newHarness(t)
	// Codex says what its session used only in its own records.
	rollout := filepath.Join(home, "sessions", "2026", "10", "20", "rollout-2026-10-20T10-00-00-s1.jsonl")
	write := func(session, lines string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(filepath.Dir(rollout), "rollout-2026-10-20T11-00-00-"+session+".jsonl"), []byte(lines), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(rollout), 0o755); err != nil {
		t.Fatal(err)
	}
	line := func(input, cached, output int) string {
		return fmt.Sprintf(`{"timestamp":"t","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":%d,"cached_input_tokens":%d,"output_tokens":%d,"reasoning_output_tokens":5,"total_tokens":%d},"last_token_usage":{}},"rate_limits":null}}`+"\n", input, cached, output, input+output)
	}
	if err := os.WriteFile(rollout, []byte(`{"timestamp":"t","type":"turn_context","payload":{"cwd":"/","model":"gpt-test"}}`+"\n"+line(1000, 800, 100)), 0o644); err != nil {
		t.Fatal(err)
	}
	task := h.start("hello")
	f, err := os.OpenFile(rollout, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString(line(1500, 1200, 150))
	f.Close()
	task = h.say(task, "again")
	used, err := h.svc.Store.ConversationUsage(task.ConversationID)
	if err != nil {
		t.Fatal(err)
	}
	if u := used[task.ConversationID]; u.Input != 1500 || u.CacheRead != 1200 || u.Output != 150 || u.Reasoning != 5 || u.Turns != 2 || u.Requests != 2 || len(u.Models) != 1 || u.Models[0].Model != "gpt-test" {
		t.Fatalf("Codex usage %+v", u)
	}
	// A session that cannot be loaded again is replaced by one counting
	// from zero; what the old one used stays.
	if err := h.svc.StopTask(task.ID); err != nil {
		t.Fatal(err)
	}
	h.wait(task)
	h.fakes.mu.Lock()
	h.fakes.session, h.fakes.failLoad = "s2", true
	h.fakes.mu.Unlock()
	write("s2", line(100, 0, 20))
	task = h.say(task, "more")
	used, _ = h.svc.Store.ConversationUsage(task.ConversationID)
	if u := used[task.ConversationID]; task.Session != "s2" || u.Input != 1600 || u.Output != 170 || u.Turns != 3 {
		t.Fatalf("usage after a new session %+v (session %s)", u, task.Session)
	}
	// Agents that report usage in their responses are taken at their word,
	// with input counted with the cache, and the cost they report.
	task = h.say(task, "tokens")
	task = h.say(task, "tokens")
	used, _ = h.svc.Store.ConversationUsage(task.ConversationID)
	u := used[task.ConversationID]
	if len(u.Models) != 3 || u.Models[0].Model != "claude-test" || u.Models[0].Input != 2000 || u.Models[0].CacheRead != 1800 || u.Models[0].CacheWrite != 180 || u.Models[0].Output != 80 || fmt.Sprintf("%.2f", u.Cost) != "0.50" {
		t.Fatalf("reported usage %+v", u)
	}
	overview, err := h.svc.overview("")
	if err != nil {
		t.Fatal(err)
	}
	if listed := overview.(map[string]any)["tasks"].([]map[string]any)[0]["usage"].(chat.UsageSummary); listed.Total != u.Total {
		t.Fatalf("tasks lists %+v", listed)
	}
}
