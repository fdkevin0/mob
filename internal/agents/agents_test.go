package agents

import (
	"context"
	"encoding/json"
	"errors"
	"io"
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

var modes = &acp.SessionModeState{CurrentModeId: "read-only", AvailableModes: []acp.SessionMode{{Id: "read-only", Name: "Read only"}, {Id: "auto", Name: "Auto"}}}

func (f *fake) NewSession(_ context.Context, r acp.NewSessionRequest) (acp.NewSessionResponse, error) {
	f.mu.Lock()
	f.dir = r.Cwd
	f.mu.Unlock()
	return acp.NewSessionResponse{SessionId: "s1", Modes: modes}, nil
}
func (f *fake) LoadSession(ctx context.Context, r acp.LoadSessionRequest) (acp.LoadSessionResponse, error) {
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
}

func (fs *fakes) connect(_ context.Context, _ Preset, _ string) (Conn, error) {
	toAgent, fromClient := io.Pipe()
	toClient, fromAgent := io.Pipe()
	f := &fake{}
	f.conn = acp.NewAgentSideConnection(f, fromAgent, toAgent)
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
	if got := h.reply(task); got != "skippedgot use make" {
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

func TestInside(t *testing.T) {
	dir := string(os.PathSeparator) + filepath.Join("w", "t")
	for path, want := range map[string]bool{filepath.Join(dir, "a.go"): true, dir: true, "b/c.go": true, filepath.Join(dir, "..", "x"): false, filepath.Join(dir+"x", "a"): false} {
		if inside(dir, path) != want {
			t.Errorf("inside(%q) = %v", path, !want)
		}
	}
}
