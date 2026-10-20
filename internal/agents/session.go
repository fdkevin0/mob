package agents

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	acp "github.com/coder/acp-go-sdk"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/version"
)

// approvalWait is how long the agent waits for the owner to decide, as long
// as Mob keeps an approval.
const approvalWait = time.Hour

// cancelWait is how long a stopped prompt may take to end before the agent
// is ended with it.
const cancelWait = 10 * time.Second

// outputLimit bounds each text a tool call's output shows, in bytes.
const outputLimit = 16 << 10

// session is one running agent working on one task.
type session struct {
	svc    *Service
	preset Preset
	task   chat.Task
	conn   *acp.ClientSideConnection
	stop   func()
	stderr func() string
	id     acp.SessionId
	// items are what the agent sends, read by the turn that follows it.
	items chan item
	// closed closes when the session ends.
	closed  chan struct{}
	once    sync.Once
	loading atomic.Bool
	mu      sync.Mutex
	// prompting is set while a prompt runs; queue holds what the owner said
	// meanwhile, sent once it ends.
	prompting bool
	queue     []string
	// pending are the permission requests the owner was asked, by approval ID.
	pending map[string]*permission
	// calls are the tool calls the agent made, to show their results in a
	// later turn than the one that started them.
	calls map[acp.ToolCallId]call
	// model is the model the session's options select; cost is the cost the
	// agent last reported for its run, unpriced what of it no prompt's end
	// recorded yet.
	model          string
	cost, unpriced float64
}

type call struct {
	name  string
	input map[string]any
}

// item is one thing the agent sent: an update, a permission request, or the
// end of a prompt.
type item struct {
	update     *acp.SessionUpdate
	permission *permission
	end        *ending
}

type ending struct {
	reason acp.StopReason
	err    error
	// usage and meta are what the response said; began is when the prompt
	// was sent.
	usage *acp.Usage
	meta  map[string]any
	began time.Time
}

// permission is a request waiting for the owner's answer.
type permission struct {
	request acp.RequestPermissionRequest
	// tool and scope are what remembering an approval of it covers.
	tool, scope string
	answer      chan acp.RequestPermissionOutcome
	timer       *time.Timer
}

// open starts an ACP session with the agent on conn: the task's own, loaded
// again, or a new one in its worktree.
func open(ctx context.Context, svc *Service, p Preset, t chat.Task, conn Conn) (*session, error) {
	s := &session{svc: svc, preset: p, task: t, stop: conn.Stop, stderr: conn.Stderr, items: make(chan item, 256), closed: make(chan struct{}), pending: map[string]*permission{}, calls: map[acp.ToolCallId]call{}}
	if s.stderr == nil {
		s.stderr = func() string { return "" }
	}
	s.conn = acp.NewClientSideConnection(client{s}, conn.In, conn.Out)
	s.conn.SetLogger(slog.New(slog.DiscardHandler))
	go func() {
		select {
		case <-s.conn.Done():
			s.close()
		case <-s.closed:
		}
	}()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	init, err := s.conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: acp.ProtocolVersionNumber, ClientInfo: &acp.Implementation{Name: "mob", Version: version.Current}})
	if err != nil {
		return nil, s.failed("start", err)
	}
	var modes *acp.SessionModeState
	switch {
	case t.Session == "":
	case init.AgentCapabilities.LoadSession:
		// The agent replays the session while loading it; the
		// conversation already shows it.
		s.loading.Store(true)
		loaded, err := s.conn.LoadSession(ctx, acp.LoadSessionRequest{SessionId: acp.SessionId(t.Session), Cwd: t.Worktree, McpServers: []acp.McpServer{}})
		s.loading.Store(false)
		if err == nil {
			s.id, modes, s.model = acp.SessionId(t.Session), loaded.Modes, modelOption(loaded.ConfigOptions)
		}
	case init.AgentCapabilities.SessionCapabilities.Resume != nil:
		// Resuming restores the session without replaying it.
		resumed, err := s.conn.ResumeSession(ctx, acp.ResumeSessionRequest{SessionId: acp.SessionId(t.Session), Cwd: t.Worktree, McpServers: []acp.McpServer{}})
		if err == nil {
			s.id, modes, s.model = acp.SessionId(t.Session), resumed.Modes, modelOption(resumed.ConfigOptions)
		}
	}
	if s.id == "" {
		created, err := s.newSession(ctx, init.AuthMethods)
		if err != nil {
			return nil, err
		}
		s.id, modes, s.model = created.SessionId, created.Modes, modelOption(created.ConfigOptions)
		if err := svc.Store.SetTaskSession(t.ID, string(s.id)); err != nil {
			return nil, err
		}
	}
	if p.Mode != "" && modes != nil && modes.CurrentModeId != acp.SessionModeId(p.Mode) && slices.ContainsFunc(modes.AvailableModes, func(m acp.SessionMode) bool { return m.Id == acp.SessionModeId(p.Mode) }) {
		if _, err := s.conn.SetSessionMode(ctx, acp.SetSessionModeRequest{SessionId: s.id, ModeId: acp.SessionModeId(p.Mode)}); err != nil {
			return nil, s.failed("set its mode", err)
		}
	}
	return s, nil
}

// newSession creates a session in the task's worktree, signing in first
// with the environment variables an agent accepts, when it asks to and they
// are set.
func (s *session) newSession(ctx context.Context, methods []acp.AuthMethod) (acp.NewSessionResponse, error) {
	request := acp.NewSessionRequest{Cwd: s.task.Worktree, McpServers: []acp.McpServer{}}
	created, err := s.conn.NewSession(ctx, request)
	if !authRequired(err) {
		if err != nil {
			return created, s.failed("start a session", err)
		}
		return created, nil
	}
	for _, m := range methods {
		if m.EnvVar == nil || !slices.ContainsFunc(m.EnvVar.Vars, func(v acp.AuthEnvVar) bool { return os.Getenv(v.Name) != "" }) {
			continue
		}
		if _, err := s.conn.Authenticate(ctx, acp.AuthenticateRequest{MethodId: m.EnvVar.Id}); err != nil {
			continue
		}
		if created, err = s.conn.NewSession(ctx, request); err == nil {
			return created, nil
		}
	}
	return created, s.signIn()
}

// signIn says the agent is not signed in and how to sign it in.
func (s *session) signIn() error {
	return fmt.Errorf("%s is not signed in: %s", s.preset.Title, s.preset.SignIn)
}

// ansi matches terminal colour codes, which agents write to standard error.
var ansi = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)

func authRequired(err error) bool {
	var request *acp.RequestError
	return errors.As(err, &request) && request.Code == -32000
}

// failed explains why the agent failed to do what, with what it wrote to
// standard error.
func (s *session) failed(what string, err error) error {
	if out := ansi.ReplaceAllString(s.stderr(), ""); out != "" {
		if len(out) > 1000 {
			out = out[len(out)-1000:]
		}
		return fmt.Errorf("%s failed to %s: %w\n%s", s.preset.Title, what, err, out)
	}
	return fmt.Errorf("%s failed to %s: %w", s.preset.Title, what, err)
}

func (s *session) close() {
	s.once.Do(func() {
		close(s.closed)
		if s.stop != nil {
			s.stop()
		}
	})
}

// deliver hands x to the turn that follows the agent, unless the session
// ends first.
func (s *session) deliver(x item) bool {
	select {
	case s.items <- x:
		return true
	case <-s.closed:
		return false
	}
}

// prompt sends text to the agent, or queues it while a prompt runs.
func (s *session) prompt(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.prompting {
		s.queue = append(s.queue, text)
		return
	}
	s.send(text)
}

// send starts a prompt; s.mu is held.
func (s *session) send(text string) {
	s.prompting = true
	go func() {
		began := time.Now()
		response, err := s.conn.Prompt(context.Background(), acp.PromptRequest{SessionId: s.id, Prompt: []acp.ContentBlock{acp.TextBlock(text)}})
		s.deliver(item{end: &ending{response.StopReason, err, response.Usage, response.Meta, began}})
	}()
}

// next records that the prompt ended and sends the queued text, reporting
// whether it did.
func (s *session) next() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prompting = false
	if len(s.queue) == 0 {
		return false
	}
	text := s.queue[0]
	s.queue = s.queue[1:]
	s.send(text)
	return true
}

func (s *session) status(status string) {
	_ = s.svc.Store.SetTaskStatus(s.task.ID, status)
}

// reply follows the agent into turn until its prompt ends or it waits for
// the owner to decide.
func (s *session) reply(ctx context.Context, turn *chat.DelegateTurn) error {
	if turn.Text != "" {
		// What the owner says instead of deciding answers no to what waits.
		s.reject(turn.ConversationID)
		s.prompt(turn.Text)
	}
	if !s.busy() && len(s.items) == 0 {
		return nil
	}
	s.status(chat.TaskRunning)
	for {
		var x item
		if s.busy() {
			select {
			case x = <-s.items:
			case <-s.closed:
				s.svc.drop(s.task.ID, s)
				s.status(chat.TaskFailed)
				return s.failed("keep running", errors.New("it exited"))
			case <-ctx.Done():
				s.interrupt()
				s.status(chat.TaskStopped)
				return ctx.Err()
			}
		} else {
			// With no prompt running, show what the agent sent meanwhile,
			// such as the commands it offers, and stop following it.
			select {
			case x = <-s.items:
			default:
				s.status(chat.TaskReview)
				return nil
			}
		}
		switch {
		case x.update != nil:
			if err := s.show(turn, *x.update); err != nil {
				s.interrupt()
				return err
			}
		case x.permission != nil:
			asked, err := s.ask(turn, x.permission)
			if err != nil {
				x.permission.cancel()
				s.interrupt()
				return err
			}
			if asked {
				s.status(chat.TaskWaiting)
				return nil
			}
		default:
			// What the prompt used counts even when it failed.
			if err := s.used(turn, *x.end); err != nil {
				slog.Warn("record what a coding agent used", "task", s.task.ID, "error", err)
			}
			if s.next() {
				continue
			}
			return s.ended(*x.end)
		}
	}
}

// busy reports whether a prompt runs.
func (s *session) busy() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.prompting
}

// enqueue queues text for the agent while a prompt runs, reporting whether
// one did.
func (s *session) enqueue(text string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.prompting {
		s.queue = append(s.queue, text)
	}
	return s.prompting
}

// ended reports how a prompt ended.
func (s *session) ended(e ending) error {
	switch {
	case authRequired(e.err):
		// Claude Agent finds out it is not signed in only when it answers.
		s.status(chat.TaskFailed)
		return s.signIn()
	case e.err != nil:
		s.status(chat.TaskFailed)
		return s.failed("answer", e.err)
	case e.reason == acp.StopReasonCancelled:
		s.status(chat.TaskStopped)
		return context.Canceled
	case e.reason == acp.StopReasonRefusal:
		s.status(chat.TaskFailed)
		return fmt.Errorf("%s refused to go on", s.preset.Title)
	case e.reason == acp.StopReasonMaxTokens || e.reason == acp.StopReasonMaxTurnRequests:
		s.status(chat.TaskReview)
		return fmt.Errorf("%s stopped at its limit (%s); send a message to continue", s.preset.Title, e.reason)
	}
	s.status(chat.TaskReview)
	return nil
}

// interrupt cancels the running prompt and every request waiting for the
// owner, then waits for the prompt to end; an agent that does not end it
// is ended itself.
func (s *session) interrupt() {
	s.mu.Lock()
	s.queue = nil
	prompting := s.prompting
	for id, p := range s.pending {
		delete(s.pending, id)
		p.cancel()
	}
	s.mu.Unlock()
	if !prompting {
		return
	}
	_ = s.conn.Cancel(context.Background(), acp.CancelNotification{SessionId: s.id})
	deadline := time.After(cancelWait)
	for {
		select {
		case x := <-s.items:
			switch {
			case x.permission != nil:
				x.permission.cancel()
			case x.end != nil:
				s.mu.Lock()
				s.prompting = false
				s.mu.Unlock()
				return
			}
		case <-s.closed:
			return
		case <-deadline:
			s.svc.drop(s.task.ID, s)
			return
		}
	}
}

func (p *permission) cancel() {
	if p.timer != nil {
		p.timer.Stop()
	}
	p.give(acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}})
}

// reject answers no to every request waiting for the owner, recording the
// approvals as denied.
func (s *session) reject(conversationID string) {
	s.mu.Lock()
	pending := s.pending
	s.pending = map[string]*permission{}
	s.mu.Unlock()
	for id, p := range pending {
		_ = s.svc.Store.Withdraw(conversationID, id)
		p.choose(acp.PermissionOptionKindRejectOnce)
	}
}

// choose answers p with its first option of kind, or the nearest one.
func (p *permission) choose(kinds ...acp.PermissionOptionKind) {
	if p.timer != nil {
		p.timer.Stop()
	}
	for _, kind := range kinds {
		for _, o := range p.request.Options {
			if o.Kind == kind {
				p.give(acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: o.OptionId}})
				return
			}
		}
	}
	p.give(acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}})
}

// give answers p, unless it is answered already.
func (p *permission) give(outcome acp.RequestPermissionOutcome) {
	select {
	case p.answer <- outcome:
	default:
	}
}

// decide passes the owner's answer on to the request it decides, reporting
// whether one was waiting.
func (s *session) decide(d chat.Decision, a chat.Answer) bool {
	s.mu.Lock()
	p := s.pending[d.ApprovalID]
	delete(s.pending, d.ApprovalID)
	reason := strings.TrimSpace(a.Reason)
	if p != nil && !a.Approved && reason != "" {
		s.queue = append(s.queue, reason)
	}
	s.mu.Unlock()
	if p == nil {
		return false
	}
	switch {
	case !a.Approved:
		p.choose(acp.PermissionOptionKindRejectOnce, acp.PermissionOptionKindRejectAlways)
		if reason != "" {
			// The reason is the agent's next prompt: the one at work ends
			// rather than working around the denial without it.
			_ = s.conn.Cancel(context.Background(), acp.CancelNotification{SessionId: s.id})
		}
	case a.Remember != "":
		conversation := s.task.ConversationID
		if a.Remember == chat.RememberAlways {
			conversation = ""
		}
		_ = s.svc.Store.AddGrant(conversation, p.tool, p.scope)
		p.choose(acp.PermissionOptionKindAllowAlways, acp.PermissionOptionKindAllowOnce)
	default:
		p.choose(acp.PermissionOptionKindAllowOnce, acp.PermissionOptionKindAllowAlways)
	}
	if a.Approved {
		// The call goes on in the next turn, which shows how it ends.
		_ = s.svc.Store.Complete(d, map[string]any{"approved": true}, "", nil)
	}
	return true
}

// ask shows a permission request in turn and asks the owner, unless the
// worktree or a remembered approval already allows it; asked reports whether
// the owner was asked.
func (s *session) ask(turn *chat.DelegateTurn, p *permission) (asked bool, err error) {
	tc := p.request.ToolCall
	input := describe(tc.Title, tc.Kind, tc.Locations, tc.RawInput)
	if known, ok := s.calls[tc.ToolCallId]; ok {
		for k, v := range known.input {
			if _, set := input[k]; !set {
				input[k] = v
			}
		}
	}
	if !turn.HasTool(string(tc.ToolCallId)) {
		if err := turn.Tool(string(tc.ToolCallId), p.tool, input); err != nil {
			return false, err
		}
	}
	id, err := turn.RequestApproval(string(tc.ToolCallId), input)
	if err != nil {
		return false, err
	}
	p.timer = time.AfterFunc(approvalWait, func() {
		s.mu.Lock()
		waiting := s.pending[id] == p
		delete(s.pending, id)
		s.mu.Unlock()
		if waiting {
			p.cancel()
		}
	})
	s.mu.Lock()
	s.pending[id] = p
	s.mu.Unlock()
	return true, nil
}

// allowed reports whether the agent may go ahead without asking: an edit
// inside the task's worktree, or a call the owner chose to keep allowing.
func (s *session) allowed(p *permission) bool {
	tc := p.request.ToolCall
	if tc.Kind != nil && (*tc.Kind == acp.ToolKindEdit || *tc.Kind == acp.ToolKindDelete || *tc.Kind == acp.ToolKindMove) && len(tc.Locations) > 0 {
		if !slices.ContainsFunc(tc.Locations, func(l acp.ToolCallLocation) bool { return !inside(s.task.Worktree, l.Path) }) {
			return true
		}
	}
	ok, err := s.svc.Store.Granted(s.task.ConversationID, p.tool, p.scope)
	return ok && err == nil
}

// inside reports whether path is dir or within it once links are followed,
// so a link in the worktree cannot lead an edit outside it.
func inside(dir, path string) bool {
	if !filepath.IsAbs(path) {
		path = filepath.Join(dir, path)
	}
	dir, ok := resolve(filepath.Clean(dir))
	if !ok {
		return false
	}
	real, ok := resolve(filepath.Clean(path))
	if !ok {
		return false
	}
	rel, err := filepath.Rel(dir, real)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// resolve follows the links in path; a file that does not exist yet is
// resolved through its nearest existing parent. A link that leads nowhere
// cannot be resolved.
func resolve(path string) (string, bool) {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real, true
	}
	if _, err := os.Lstat(path); err == nil {
		return "", false
	}
	parent := filepath.Dir(path)
	if parent == path {
		return path, true
	}
	real, ok := resolve(parent)
	return filepath.Join(real, filepath.Base(path)), ok
}

// toolName is how the conversation names a call of kind by this agent.
func (s *session) toolName(kind *acp.ToolKind) string {
	k := "other"
	if kind != nil && *kind != "" {
		k = string(*kind)
	}
	return s.preset.Name + "_" + k
}

// describe is the input a call shows: its title, kind, files and the
// agent's own input.
func describe(title any, kind *acp.ToolKind, locations []acp.ToolCallLocation, raw any) map[string]any {
	input := map[string]any{}
	switch t := title.(type) {
	case string:
		if t != "" {
			input["title"] = t
		}
	case *string:
		if t != nil && *t != "" {
			input["title"] = *t
		}
	}
	if kind != nil && *kind != "" {
		input["kind"] = string(*kind)
	}
	if len(locations) > 0 {
		paths := make([]string, len(locations))
		for i, l := range locations {
			paths[i] = l.Path
		}
		input["files"] = paths
	}
	if raw != nil {
		input["input"] = raw
	}
	return input
}

// output is what a finished call shows: its text, diffs, or the agent's own
// output.
func output(content []acp.ToolCallContent, raw any) any {
	var parts []string
	for _, c := range content {
		switch {
		case c.Content != nil && c.Content.Content.Text != nil:
			parts = append(parts, c.Content.Content.Text.Text)
		case c.Diff != nil:
			parts = append(parts, "--- "+c.Diff.Path+"\n"+c.Diff.NewText)
		}
	}
	if len(parts) == 0 {
		if raw == nil {
			return map[string]any{}
		}
		return raw
	}
	text := strings.Join(parts, "\n\n")
	if len(text) > outputLimit {
		text = text[:outputLimit] + "\n… (cut)"
	}
	return map[string]any{"output": text}
}

// show writes one update into turn.
func (s *session) show(turn *chat.DelegateTurn, u acp.SessionUpdate) error {
	switch {
	case u.AgentMessageChunk != nil && u.AgentMessageChunk.Content.Text != nil:
		return turn.Stream("text", u.AgentMessageChunk.Content.Text.Text)
	case u.AgentThoughtChunk != nil && u.AgentThoughtChunk.Content.Text != nil:
		return turn.Stream("reasoning", u.AgentThoughtChunk.Content.Text.Text)
	case u.ToolCall != nil:
		tc := u.ToolCall
		kind := tc.Kind
		c := call{s.toolName(&kind), describe(tc.Title, &kind, tc.Locations, tc.RawInput)}
		s.calls[tc.ToolCallId] = c
		if err := turn.Tool(string(tc.ToolCallId), c.name, c.input); err != nil {
			return err
		}
		return s.finish(turn, tc.ToolCallId, &tc.Status, tc.Content, tc.RawOutput)
	case u.ToolCallUpdate != nil:
		tc := u.ToolCallUpdate
		c, known := s.calls[tc.ToolCallId]
		if !known {
			c = call{s.toolName(tc.Kind), describe(tc.Title, tc.Kind, tc.Locations, tc.RawInput)}
			s.calls[tc.ToolCallId] = c
		}
		if tc.Status != nil && (*tc.Status == acp.ToolCallStatusCompleted || *tc.Status == acp.ToolCallStatusFailed) && !turn.HasTool(string(tc.ToolCallId)) {
			// A call started in an earlier turn ends in this one.
			if err := turn.Tool(string(tc.ToolCallId), c.name, c.input); err != nil {
				return err
			}
		}
		return s.finish(turn, tc.ToolCallId, tc.Status, tc.Content, tc.RawOutput)
	case u.UsageUpdate != nil:
		s.costed(u.UsageUpdate)
	case u.ConfigOptionUpdate != nil:
		if model := modelOption(u.ConfigOptionUpdate.ConfigOptions); model != "" {
			s.mu.Lock()
			s.model = model
			s.mu.Unlock()
		}
	case u.Plan != nil:
		plan := make([]chat.PlanEntry, len(u.Plan.Entries))
		for i, e := range u.Plan.Entries {
			plan[i] = chat.PlanEntry{Content: e.Content, Status: string(e.Status)}
		}
		return s.svc.Store.SetTaskPlan(s.task.ID, plan)
	}
	return nil
}

// finish records a call's end once its status says it ended.
func (s *session) finish(turn *chat.DelegateTurn, id acp.ToolCallId, status *acp.ToolCallStatus, content []acp.ToolCallContent, raw any) error {
	if status == nil {
		return nil
	}
	switch *status {
	case acp.ToolCallStatusCompleted:
		delete(s.calls, id)
		return turn.ToolDone(string(id), output(content, raw), "")
	case acp.ToolCallStatusFailed:
		delete(s.calls, id)
		failure := "failed"
		if out, ok := output(content, raw).(map[string]any); ok && out["output"] != nil {
			failure = fmt.Sprint(out["output"])
		}
		return turn.ToolDone(string(id), nil, failure)
	}
	return nil
}

// client answers the agent's requests for the session.
type client struct{ s *session }

func (c client) SessionUpdate(_ context.Context, n acp.SessionNotification) error {
	if c.s.loading.Load() {
		return nil
	}
	c.s.deliver(item{update: &n.Update})
	return nil
}

func (c client) RequestPermission(ctx context.Context, request acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	s := c.s
	tc := request.ToolCall
	p := &permission{request: request, tool: s.toolName(tc.Kind), answer: make(chan acp.RequestPermissionOutcome, 1)}
	if tc.Title != nil {
		p.scope = *tc.Title
	}
	if s.allowed(p) {
		p.choose(acp.PermissionOptionKindAllowOnce, acp.PermissionOptionKindAllowAlways)
	} else if !s.deliver(item{permission: p}) {
		p.cancel()
	}
	select {
	case outcome := <-p.answer:
		return acp.RequestPermissionResponse{Outcome: outcome}, nil
	case <-ctx.Done():
		return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}}}, nil
	case <-s.closed:
		return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}}}, nil
	}
}

// Mob offers agents no file system or terminal of its own: they use their
// own in the worktree.

func (client) ReadTextFile(context.Context, acp.ReadTextFileRequest) (acp.ReadTextFileResponse, error) {
	return acp.ReadTextFileResponse{}, acp.NewMethodNotFound("fs/read_text_file")
}

func (client) WriteTextFile(context.Context, acp.WriteTextFileRequest) (acp.WriteTextFileResponse, error) {
	return acp.WriteTextFileResponse{}, acp.NewMethodNotFound("fs/write_text_file")
}

func (client) CreateTerminal(context.Context, acp.CreateTerminalRequest) (acp.CreateTerminalResponse, error) {
	return acp.CreateTerminalResponse{}, acp.NewMethodNotFound("terminal/create")
}

func (client) KillTerminal(context.Context, acp.KillTerminalRequest) (acp.KillTerminalResponse, error) {
	return acp.KillTerminalResponse{}, acp.NewMethodNotFound("terminal/kill")
}

func (client) ReleaseTerminal(context.Context, acp.ReleaseTerminalRequest) (acp.ReleaseTerminalResponse, error) {
	return acp.ReleaseTerminalResponse{}, acp.NewMethodNotFound("terminal/release")
}

func (client) TerminalOutput(context.Context, acp.TerminalOutputRequest) (acp.TerminalOutputResponse, error) {
	return acp.TerminalOutputResponse{}, acp.NewMethodNotFound("terminal/output")
}

func (client) WaitForTerminalExit(context.Context, acp.WaitForTerminalExitRequest) (acp.WaitForTerminalExitResponse, error) {
	return acp.WaitForTerminalExitResponse{}, acp.NewMethodNotFound("terminal/wait_for_exit")
}
