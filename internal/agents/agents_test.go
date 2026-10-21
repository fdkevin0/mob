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
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
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
	// resumes makes it resume sessions instead of loading them; resumed is
	// the session it resumed.
	resumes bool
	resumed string
	// signedOut makes it ask to sign in, with a login no variable answers.
	signedOut bool
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
	if f.resumes {
		// Like DeepSeek Harness: sessions are resumed, not loaded.
		return acp.InitializeResponse{ProtocolVersion: acp.ProtocolVersionNumber, AgentCapabilities: acp.AgentCapabilities{SessionCapabilities: acp.SessionCapabilities{Resume: &acp.SessionResumeCapabilities{}}}}, nil
	}
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
func (f *fake) ResumeSession(_ context.Context, r acp.ResumeSessionRequest) (acp.ResumeSessionResponse, error) {
	f.mu.Lock()
	f.dir, f.resumed = r.Cwd, string(r.SessionId)
	f.mu.Unlock()
	return acp.ResumeSessionResponse{}, nil
}
func (f *fake) SetSessionConfigOption(context.Context, acp.SetSessionConfigOptionRequest) (acp.SetSessionConfigOptionResponse, error) {
	return acp.SetSessionConfigOptionResponse{}, nil
}

var modelCategory = acp.SessionConfigOptionCategoryModel

var models = []acp.SessionConfigOption{{Select: &acp.SessionConfigOptionSelect{Id: "model", Type: "select", Category: &modelCategory, CurrentValue: "gpt-5.5-codex/high",
	Options: acp.SessionConfigSelectOptions{Ungrouped: &acp.SessionConfigSelectOptionsUngrouped{{Value: "gpt-5.5-codex/high", Name: "gpt-5.5-codex (high)"}}}}}}

var modes = &acp.SessionModeState{CurrentModeId: "read-only", AvailableModes: []acp.SessionMode{{Id: "read-only", Name: "Read only"}, {Id: "auto", Name: "Auto"}, {Id: "acceptEdits", Name: "Accept edits"}}}

func (f *fake) NewSession(_ context.Context, r acp.NewSessionRequest) (acp.NewSessionResponse, error) {
	if f.signedOut {
		return acp.NewSessionResponse{}, acp.NewAuthRequired(nil)
	}
	f.mu.Lock()
	f.dir = r.Cwd
	id := f.session
	f.mu.Unlock()
	if id == "" {
		id = "s1"
	}
	return acp.NewSessionResponse{SessionId: id, Modes: modes, ConfigOptions: models}, nil
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
	case strings.HasPrefix(text, "cmd "), text == "bare":
		// Like DeepSeek Harness and CodeBuddy Code: the call is shown
		// first, and the permission request names only its ID.
		call := acp.ToolCallId("call-" + text)
		if text == "bare" {
			f.say(ctx, id, acp.StartToolCall(call, "", acp.WithStartKind(acp.ToolKindOther), acp.WithStartStatus(acp.ToolCallStatusPending)))
		} else {
			f.say(ctx, id, acp.StartToolCall(call, "bash", acp.WithStartKind(acp.ToolKindOther), acp.WithStartStatus(acp.ToolCallStatusPending), acp.WithStartRawInput(map[string]any{"command": strings.TrimPrefix(text, "cmd ")})))
		}
		answer, err := f.conn.RequestPermission(ctx, acp.RequestPermissionRequest{SessionId: id, ToolCall: acp.ToolCallUpdate{ToolCallId: call}, Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, Name: "Allow once", OptionId: "allow-once"},
			{Kind: acp.PermissionOptionKindRejectOnce, Name: "Reject", OptionId: "reject-once"},
		}})
		if err != nil || answer.Outcome.Selected == nil {
			return acp.PromptResponse{StopReason: acp.StopReasonCancelled}, nil
		}
		f.say(ctx, id, acp.UpdateAgentMessageText(string(answer.Outcome.Selected.OptionId)))
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
	// resumes, when set, makes the agents resume sessions; signedOut makes
	// them ask to sign in.
	resumes, signedOut bool
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
	f := &fake{release: make(chan struct{}), session: fs.session, failLoad: fs.failLoad, resumes: fs.resumes, signedOut: fs.signedOut}
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
	task, err := h.svc.StartTask(context.Background(), "", h.repo, "", "", prompt)
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
	task, err := h.svc.StartTask(context.Background(), "", h.repo, "claude", "", "login")
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

func TestCodeBuddyAsksToLogIn(t *testing.T) {
	h := newHarness(t)
	h.fakes.signedOut = true
	task, err := h.svc.StartTask(context.Background(), "", h.repo, "codebuddy", "", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if task = h.wait(task); task.Agent != "codebuddy" || task.Status != chat.TaskFailed {
		t.Fatalf("task = %+v", task)
	}
	history, _ := h.svc.Store.History(task.ConversationID)
	if failure := fmtJSON(history[len(history)-1].Metadata["error"]); !strings.Contains(failure, "CodeBuddy Code is not signed in: run `codebuddy`") {
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
	task, err := h.svc.StartTask(context.Background(), "", h.repo, "", "wait", "wait")
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
	task, err := h.svc.StartTask(context.Background(), "", h.repo, "", "", "hold")
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

	failed, err := h.svc.StartTask(context.Background(), "", h.repo, "claude", "", "login")
	if err != nil {
		t.Fatal(err)
	}
	h.wait(failed)
	if got = took(); len(got) != 1 || !strings.Contains(got[0].Text, "**Task failed:** claude · login\n\nClaude Agent is not signed in") {
		t.Fatalf("failure notices = %+v", got)
	}

	limited, err := h.svc.StartTask(context.Background(), "", h.repo, "", "", "limit")
	if err != nil {
		t.Fatal(err)
	}
	if limited = h.wait(limited); limited.Status != chat.TaskReview {
		t.Fatalf("status = %q", limited.Status)
	}
	if got = took(); len(got) != 1 || !strings.Contains(got[0].Text, "**Task stopped early:** codex · limit\n\nCodex stopped at its limit (max_tokens); send a message to continue\n\nhalfway") {
		t.Fatalf("limit notices = %+v", got)
	}

	stopped, err := h.svc.StartTask(context.Background(), "", h.repo, "", "", "wait")
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
	starting, err := h.svc.StartTask(context.Background(), "", h.repo, "", "", "hello")
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

func TestTreeShowsWhoStartedWhom(t *testing.T) {
	h := newHarness(t)
	mob, err := h.svc.Store.Create()
	if err != nil {
		t.Fatal(err)
	}
	started, err := h.svc.StartTask(context.Background(), mob.ID, h.repo, "", "Greet", "hello")
	if err != nil {
		t.Fatal(err)
	}
	task := h.wait(started)
	alone := h.start("hello")
	nodes, err := h.svc.Tree("")
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 3 {
		t.Fatalf("nodes = %+v", nodes)
	}
	byID := map[string]AgentNode{}
	for _, n := range nodes {
		byID[n.ConversationID] = n
	}
	child, root := byID[task.ConversationID], byID[mob.ID]
	if child.Parent != mob.ID || child.Label != "Codex" || child.Model != "gpt-5.5-codex/high" || child.Status != chat.TaskReview || child.Task == nil || fmtJSON(child.Tools) != `["read"]` {
		t.Fatalf("task node = %+v", child)
	}
	if root.Agent != Mob || root.Status != Idle || root.Parent != "" || root.Task != nil {
		t.Fatalf("mob node = %+v", root)
	}
	if byID[alone.ConversationID].Parent != "" {
		t.Fatalf("unstarted task = %+v", byID[alone.ConversationID])
	}
	text := outline(nodes)
	if !strings.Contains(text, "- **Idle** · Mob · New conversation\n  - **Done** · Codex · Greet · ") {
		t.Fatalf("outline =\n%s", text)
	}
}

func TestReviewingATask(t *testing.T) {
	h := newHarness(t)
	task := h.start("hello")
	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@example.com"}, args...)...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	write := func(path, text string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// The agent commits one file and leaves another changed and one new;
	// meanwhile the project moves on.
	write(filepath.Join(task.Worktree, "a.go"), "package a\n")
	write(filepath.Join(task.Worktree, "b.go"), "package b\n")
	git(task.Worktree, "add", ".")
	git(task.Worktree, "commit", "-q", "-m", "add a and b")
	write(filepath.Join(task.Worktree, "b.go"), "package b\n\nvar B = 1\n")
	write(filepath.Join(task.Worktree, "new.txt"), "new\n")
	write(filepath.Join(h.repo, "main.go"), "package main\n")
	git(h.repo, "add", ".")
	git(h.repo, "commit", "-q", "-m", "main moves on")

	out, err := h.svc.diff(context.Background(), task.ID, false, "b.go")
	if err != nil {
		t.Fatal(err)
	}
	got := out.(map[string]any)
	commits, changed := got["commits"].([]string), strings.Join(got["changed"].([]string), ";")
	if len(commits) != 1 || !strings.HasSuffix(commits[0], "add a and b") || !strings.Contains(changed, "a.go") || !strings.Contains(changed, "3\t0\tb.go") || strings.Contains(changed, "main.go") {
		t.Fatalf("diff = %s", fmtJSON(got))
	}
	if untracked := got["untracked"].([]string); len(untracked) != 1 || untracked[0] != "new.txt" {
		t.Fatalf("untracked = %v", untracked)
	}
	if patch := got["patch"].(string); !strings.Contains(patch, "+var B = 1") || strings.Contains(patch, "a.go") || strings.Contains(patch, "new.txt") {
		t.Fatalf("patch = %q", patch)
	}
	// A new file the agent has not added shows in full, alone or with the rest.
	for _, file := range []string{"new.txt", ""} {
		out, err := h.svc.diff(context.Background(), task.ID, true, file)
		if err != nil {
			t.Fatal(err)
		}
		patch := out.(map[string]any)["patch"].(string)
		if !strings.Contains(patch, "+++ b/new.txt") || !strings.Contains(patch, "+new") || strings.Contains(patch, "var B") == (file != "") {
			t.Fatalf("patch of %q = %q", file, patch)
		}
	}
	if _, err := h.svc.diff(context.Background(), "nope", false, ""); err == nil {
		t.Fatal("diff of an unknown task")
	}

	// task_check asks first, then runs in the worktree it was approved for.
	var check chat.Tool
	for _, tool := range h.svc.Tools() {
		if tool.Name == "task_check" {
			check = tool
		}
	}
	if _, err := check.Run(context.Background(), chat.ToolCall{Input: map[string]any{"task": task.ID, "command": " "}}); err == nil {
		t.Fatal("empty command accepted")
	}
	if runtime.GOOS != "windows" {
		input, _ := json.Marshal(map[string]string{"task": task.ID, "project": task.Project, "worktree": task.Worktree, "command": "ls new.txt; echo failing >&2; exit 3"})
		out, err := check.Approved(context.Background(), chat.ApprovedCall{Input: input})
		result := out.(map[string]any)
		if err != nil || result["exitCode"] != 3 || !strings.Contains(result["output"].(string), "new.txt") || !strings.Contains(result["output"].(string), "failing") {
			t.Fatalf("check = %v, %v", result, err)
		}
		if check.Scope(input) != task.Project+" ls new.txt; echo failing >&2; exit 3" {
			t.Fatalf("scope = %q", check.Scope(input))
		}
	}

	// The owner's turns see the task; other callers' do not.
	for _, owner := range []bool{true, false} {
		turn := &chat.Turn{Owner: owner, Request: &llm.Request{}}
		if err := h.svc.snapshot(context.Background(), turn); err != nil {
			t.Fatal(err)
		}
		if seen := strings.Contains(turn.Request.System, "review: hello (task "+task.ID); seen != owner {
			t.Fatalf("owner %v: system = %q", owner, turn.Request.System)
		}
	}
}

func TestLimitedKeepsTheEnd(t *testing.T) {
	l := &limited{max: 4}
	l.Write([]byte("abc"))
	l.Write([]byte("defg"))
	if got := l.String(); got != "… 3 bytes cut\ndefg" {
		t.Fatalf("%q", got)
	}
}

// reviewer is Mob's model reviewing a finished task: it reads the task's diff,
// then concludes.
type reviewer struct{}

func (reviewer) Ref() llm.Ref   { return llm.Ref{Provider: "test", Model: "reviewer"} }
func (reviewer) Info() llm.Info { return llm.Info{ID: "reviewer", Tools: true} }
func (reviewer) Stream(_ context.Context, req llm.Request, emit func(string, string) error) (llm.Result, error) {
	last := req.Messages[len(req.Messages)-1]
	if last.Role == "tool" {
		text := "Looks ready to merge; the diff names its branch: " + fmt.Sprint(strings.Contains(last.Text, "mob/say-hello")) + "."
		return llm.Result{Text: text}, emit("text", text)
	}
	id := regexp.MustCompile(`coding task (\w+)`).FindStringSubmatch(last.Text)
	if id == nil {
		return llm.Result{Text: "no task"}, nil
	}
	return llm.Result{Calls: []llm.ToolCall{{ID: "diff1", Name: "task_diff", Arguments: `{"task":"` + id[1] + `"}`}}}, nil
}

type reviewers struct{}

func (reviewers) Default() string                          { return "test/reviewer" }
func (reviewers) Resolve(string) (llm.Model, error)        { return reviewer{}, nil }
func (reviewers) SetDefault(string) (llm.Ref, error)       { return reviewer{}.Ref(), nil }
func (reviewers) List(context.Context, string) []llm.Group { return nil }

func TestMobReviewsAFinishedTask(t *testing.T) {
	h := newHarness(t)
	h.conv.Models = reviewers{}
	var mu sync.Mutex
	var notices []chat.Notice
	defer h.conv.Notices(func(n chat.Notice) { mu.Lock(); notices = append(notices, n); mu.Unlock() })()
	origin, err := h.svc.Store.Create()
	if err != nil {
		t.Fatal(err)
	}
	var start chat.Tool
	for _, tool := range h.svc.Tools() {
		if tool.Name == "task_start" {
			start = tool
		}
	}
	input, _ := json.Marshal(map[string]string{"project": h.repo, "agent": "codex", "title": "Say hello", "prompt": "hello"})
	out, err := start.Approved(context.Background(), chat.ApprovedCall{ConversationID: origin.ID, Input: input})
	if err != nil {
		t.Fatal(err)
	}
	task, _, _ := h.svc.Store.Task(out.(map[string]any)["task"].(string))
	if task = h.wait(task); task.Parent != origin.ID || task.Status != chat.TaskReview {
		t.Fatalf("task = %+v", task)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		mu.Lock()
		n := len(notices)
		mu.Unlock()
		if n > 0 && !h.conv.Active(origin.ID) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no review notice")
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	got := notices
	mu.Unlock()
	// One notice, Mob's conclusion instead of the agent's words.
	if len(got) != 1 || got[0].ConversationID != origin.ID || !strings.HasPrefix(got[0].Text, "**Task reviewed:** codex · Say hello\nBranch `"+task.Branch+"`\n\nLooks ready to merge") {
		t.Fatalf("notices = %+v", got)
	}
	history, err := h.svc.Store.History(origin.ID)
	if err != nil || len(history) != 2 || !strings.HasPrefix(chat.Text(history[0]), "Automatic task update from Mob") || history[1].Parts[0]["type"] != "tool-task_diff" {
		t.Fatalf("review history = %s, %v", fmtJSON(history), err)
	}
	// Reviews on their own stop after reviewLimit.
	h.svc.mu.Lock()
	h.svc.reviews[task.ID] = reviewLimit
	h.svc.mu.Unlock()
	if h.svc.review(task) {
		t.Fatal("reviewed past the limit")
	}
}

func TestResumingASession(t *testing.T) {
	h := newHarness(t)
	h.fakes.resumes = true
	task, err := h.svc.StartTask(context.Background(), "", h.repo, "dsh", "", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if task = h.wait(task); task.Agent != "dsh" || task.Session != "s1" {
		t.Fatalf("task = %+v", task)
	}
	if err := h.svc.StopTask(task.ID); err != nil {
		t.Fatal(err)
	}
	task = h.say(task, "again")
	f := h.fakes.last()
	if len(h.fakes.agents) != 2 || f.resumed != "s1" || f.dir != task.Worktree || h.reply(task) != "got again" {
		t.Fatalf("agents %d, resumed %q in %q, reply %q", len(h.fakes.agents), f.resumed, f.dir, h.reply(task))
	}
}

func TestStartPassesPatchAndEnvironment(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	// The patch file is the command's last argument.
	p := Preset{Title: "Echo", Commands: [][]string{{"sh", "-c", `eval "cat \"\${$#}\""; echo "$MOB_AGENT_TEST"`, "sh"}}, Env: []string{"MOB_AGENT_TEST=on"}, Patch: "- id: x\n  disabled: true\n"}
	conn, err := start(context.Background(), p, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	out, _ := io.ReadAll(conn.Out)
	conn.Stop()
	if string(out) != "- id: x\n  disabled: true\non\n" {
		t.Fatalf("out = %q", out)
	}
	left, _ := filepath.Glob(filepath.Join(os.TempDir(), "mob-agent-*.patch.yml"))
	if len(left) != 0 {
		t.Fatalf("patch files left: %v", left)
	}
}

func TestRememberingANamelessRequest(t *testing.T) {
	h := newHarness(t)
	task := h.start("cmd curl https://trusted.example")
	if task.Status != chat.TaskWaiting {
		t.Fatalf("status = %q", task.Status)
	}
	pending := h.conv.Pending(task.ConversationID)
	if len(pending) != 1 || pending[0].Tool != "codex_other" || !strings.Contains(fmtJSON(pending[0].Input), "trusted.example") {
		t.Fatalf("pending = %+v", pending)
	}
	task = h.decide(task, chat.Answer{Approved: true, Remember: chat.RememberAlways})
	if task.Status != chat.TaskReview || h.reply(task) != "allow-once" {
		t.Fatalf("status %q, reply %q", task.Status, h.reply(task))
	}
	// The same command is allowed from then on; another one is not.
	if task = h.say(task, "cmd curl https://trusted.example"); task.Status != chat.TaskReview || h.reply(task) != "allow-once" {
		t.Fatalf("same command: status %q, reply %q", task.Status, h.reply(task))
	}
	if task = h.say(task, "cmd curl https://unrelated.example"); task.Status != chat.TaskWaiting {
		t.Fatalf("another command was allowed: status %q, reply %q", task.Status, h.reply(task))
	}
	task = h.decide(task, chat.Answer{Approved: false})

	// A request with nothing to tell it apart is never remembered.
	task = h.say(task, "bare")
	task = h.decide(task, chat.Answer{Approved: true, Remember: chat.RememberAlways})
	if task = h.say(task, "bare"); task.Status != chat.TaskWaiting {
		t.Fatalf("a nameless request was remembered: status %q", task.Status)
	}
	grants, err := h.svc.Store.Grants()
	if err != nil || len(grants) != 1 || grants[0].Scope != `bash {"command":"curl https://trusted.example"}` {
		t.Fatalf("grants = %+v, %v", grants, err)
	}
}
