package channel

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/provider"
)

// thinker reasons before it answers.
type thinker struct{}

func (thinker) Ref() llm.Ref   { return llm.Ref{Provider: "test", Model: "thinker"} }
func (thinker) Info() llm.Info { return llm.Info{ID: "thinker", Context: 100000} }
func (thinker) Stream(_ context.Context, _ llm.Request, emit func(string, string) error) (llm.Result, error) {
	if err := emit("reasoning", "secret plan"); err != nil {
		return llm.Result{}, err
	}
	return llm.Result{Text: "hello"}, emit("text", "hello")
}

type oneModel struct{ model llm.Model }

func (o oneModel) Default() string                          { return "test/thinker" }
func (o oneModel) Resolve(string) (llm.Model, error)        { return o.model, nil }
func (o oneModel) SetDefault(string) (llm.Ref, error)       { return o.model.Ref(), nil }
func (o oneModel) List(context.Context, string) []llm.Group { return nil }

func bridge(t *testing.T) *Bridge {
	t.Helper()
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	conversation := chat.NewConversation(store, oneModel{thinker{}})
	t.Cleanup(conversation.Close)
	return &Bridge{Name: "Test", Client: chat.ClientWeChat, Store: store, Conversation: conversation, Texts: Texts{
		Help:      "Connected.",
		Approvals: func([]chat.PendingApproval, int) string { return "\n\napprove?" },
		Stale:     func(id string) string { return "stale " + id },
		Failed:    func(err error) string { return "\nfailed: " + err.Error() },
		Empty:     "empty",
	}}
}

func TestAnswerShowsOnlyTheTurnsText(t *testing.T) {
	b := bridge(t)
	reply, err := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "hi"})
	if err != nil || reply.Text != "hello" {
		t.Fatalf("reply %q (err: %v)", reply.Text, err)
	}
}

func TestAnswerRunsCommands(t *testing.T) {
	b := bridge(t)
	if reply, err := b.Answer(context.Background(), Message{Key: "k", Text: "/help"}); err != nil || !strings.HasPrefix(reply.Text, "Connected.\n\n") || !strings.Contains(reply.Text, "/approve") {
		t.Fatalf("/help: %q (err: %v)", reply.Text, err)
	}
	if list, _ := b.Store.List(); len(list) != 0 {
		t.Fatal("/help created a conversation")
	}
	if reply, err := b.Answer(context.Background(), Message{Key: "k", Text: "/new"}); err != nil || reply.Text != "New conversation started." {
		t.Fatalf("/new: %q (err: %v)", reply.Text, err)
	}
	var id string
	if err := b.Store.Setting("k", &id); err != nil || id == "" {
		t.Fatalf("/new did not become the sender's conversation: %v", err)
	}
	if reply, _ := b.Answer(context.Background(), Message{Key: "k", Text: "/grants"}); !strings.Contains(reply.Text, "Only the owner") {
		t.Fatalf("a guest listed grants: %q", reply.Text)
	}
	stale := chat.NewID()
	if reply, err := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "/approve " + stale}); err != nil || reply.Text != "stale "+stale || reply.Settled != stale {
		t.Fatalf("stale approval: %q (err: %v)", reply.Text, err)
	}
}

func TestDeliverAnswersAndSendsOnce(t *testing.T) {
	b := bridge(t)
	answers, sends := 0, 0
	answer := func(context.Context) (Reply, error) { answers++; return Reply{Text: "hi"}, nil }
	send := func(_ context.Context, r Reply) error {
		sends++
		if r.Text != "hi" {
			t.Fatalf("sent %q", r.Text)
		}
		return nil
	}
	for range 2 {
		if err := b.Deliver(context.Background(), "m1", answer, send); err != nil {
			t.Fatal(err)
		}
	}
	if answers != 1 || sends != 1 {
		t.Fatalf("answered %d and sent %d times", answers, sends)
	}
	if d, _ := b.Store.Delivery("m1"); d.State != "sent" || d.Reply != "hi" {
		t.Fatalf("delivery: %+v", d)
	}

	failed := func(context.Context, Reply) error { return errors.New("network down") }
	if err := b.Deliver(context.Background(), "m2", answer, failed); err == nil || !strings.Contains(err.Error(), "Test reply delivery failed or is uncertain") {
		t.Fatalf("failed send: %v", err)
	}
	if d, _ := b.Store.Delivery("m2"); d.State != "failed-or-unknown" {
		t.Fatalf("failed delivery: %+v", d)
	}

	// A send the service was interrupted in is reported, never repeated.
	if _, err := b.Store.AcceptDelivery("m3", "sending"); err != nil {
		t.Fatal(err)
	}
	sends = 0
	if err := b.Deliver(context.Background(), "m3", answer, send); err == nil || sends != 0 {
		t.Fatalf("interrupted send: %v, sent %d", err, sends)
	}
	if d, _ := b.Store.Delivery("m3"); d.State != "failed-or-unknown" {
		t.Fatalf("interrupted delivery: %+v", d)
	}

	// A failed answer is still sent, then reported.
	broken := func(context.Context) (Reply, error) { return Reply{Text: "hi"}, errors.New("model down") }
	sends = 0
	if err := b.Deliver(context.Background(), "m4", broken, send); err == nil || sends != 1 {
		t.Fatalf("failed answer: %v, sent %d", err, sends)
	}
	if d, _ := b.Store.Delivery("m4"); d.State != "processing-failed" {
		t.Fatalf("failed answer's delivery: %+v", d)
	}
}

func TestApprovalPromptCountsTowardTheLimit(t *testing.T) {
	b := bridge(t)
	b.Conversation = chat.NewConversation(b.Store, provider.Offline())
	t.Cleanup(b.Conversation.Close)
	b.Texts.Approvals = func([]chat.PendingApproval, int) string { return strings.Repeat("a", 1000) }
	b.Limit = 900
	reply, err := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "/remember tea"})
	if err == nil || !strings.Contains(err.Error(), "Test bridge limit") || len(reply.Approvals) != 1 {
		t.Fatalf("reply %q %+v (err: %v)", reply.Text, reply.Approvals, err)
	}
}

// worker looks the time up twice, commenting as it goes, then concludes. It
// keeps the system prompt it was given.
type worker struct{ system *string }

func (worker) Ref() llm.Ref   { return llm.Ref{Provider: "test", Model: "worker"} }
func (worker) Info() llm.Info { return llm.Info{ID: "worker", Context: 100000, Tools: true} }
func (w worker) Stream(_ context.Context, req llm.Request, emit func(string, string) error) (llm.Result, error) {
	*w.system = req.System
	calls := 0
	for _, m := range req.Messages {
		calls += len(m.ToolCalls)
	}
	if calls < 2 {
		call := llm.ToolCall{ID: chat.NewID(), Name: "datetime", Arguments: "{}"}
		return llm.Result{Text: "Let me check.", Calls: []llm.ToolCall{call}}, emit("text", "Let me check.")
	}
	return llm.Result{Text: "It is noon."}, emit("text", "It is noon.")
}

func TestAnswerConcludesWithTheLastStepAndTheToolsUsed(t *testing.T) {
	b := bridge(t)
	var system string
	b.Conversation = chat.NewConversation(b.Store, oneModel{worker{&system}})
	t.Cleanup(b.Conversation.Close)
	b.Texts.Used = func(used []Use) string { return "\n(used " + used[0].String() + ")" }
	reply, err := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "time?"})
	if err != nil || reply.Text != "It is noon.\n(used datetime ×2)" {
		t.Fatalf("reply %q (err: %v)", reply.Text, err)
	}
	if !strings.Contains(system, "reading in Test") {
		t.Fatalf("the model was not told how the reply is read: %q", system)
	}
}

// waiter writes a little, then waits until it is stopped. started closes
// when it first waits.
type waiter struct {
	started chan struct{}
	once    *sync.Once
}

func (waiter) Ref() llm.Ref   { return llm.Ref{Provider: "test", Model: "waiter"} }
func (waiter) Info() llm.Info { return llm.Info{ID: "waiter", Context: 100000} }
func (w waiter) Stream(ctx context.Context, _ llm.Request, emit func(string, string) error) (llm.Result, error) {
	if err := emit("text", "partial"); err != nil {
		return llm.Result{}, err
	}
	w.once.Do(func() { close(w.started) })
	<-ctx.Done()
	return llm.Result{}, ctx.Err()
}

func TestAnswerWhileBusyAndStopped(t *testing.T) {
	b := bridge(t)
	w := waiter{started: make(chan struct{}), once: new(sync.Once)}
	b.Conversation = chat.NewConversation(b.Store, oneModel{w})
	t.Cleanup(b.Conversation.Close)
	b.Client = chat.ClientTelegram
	b.Texts.Busy, b.Texts.Stopped = "busy", "stopped"
	type result struct {
		reply Reply
		err   error
	}
	first := make(chan result, 1)
	go func() {
		reply, err := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "long job"})
		first <- result{reply, err}
	}()
	<-w.started
	if reply, err := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "and this"}); err != nil || reply.Text != "busy" {
		t.Fatalf("while busy: %q (err: %v)", reply.Text, err)
	}
	if reply, err := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "/deny " + chat.NewID()}); err != nil || reply.Text != "busy" || reply.Settled != "" {
		t.Fatalf("a decision while busy: %q %q (err: %v)", reply.Text, reply.Settled, err)
	}
	if reply, err := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "/stop"}); err != nil || reply.Text != "Stopping." {
		t.Fatalf("/stop: %q (err: %v)", reply.Text, err)
	}
	if r := <-first; r.err != nil || r.reply.Text != "partial\n\nstopped" {
		t.Fatalf("stopped turn: %q (err: %v)", r.reply.Text, r.err)
	}
	if reply, err := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "/stop"}); err != nil || reply.Text != "Nothing is running." {
		t.Fatalf("/stop with nothing running: %q (err: %v)", reply.Text, err)
	}
}

// deployer calls deploy, then says it is done.
type deployer struct{}

func (deployer) Ref() llm.Ref   { return llm.Ref{Provider: "test", Model: "deployer"} }
func (deployer) Info() llm.Info { return llm.Info{ID: "deployer", Context: 100000, Tools: true} }
func (deployer) Stream(_ context.Context, req llm.Request, emit func(string, string) error) (llm.Result, error) {
	for _, m := range req.Messages {
		if len(m.ToolCalls) > 0 {
			return llm.Result{Text: "deployed"}, emit("text", "deployed")
		}
	}
	return llm.Result{Calls: []llm.ToolCall{{ID: chat.NewID(), Name: "deploy", Arguments: "{}"}}}, nil
}

func TestApprovedWorkStartsTheMessageAndStops(t *testing.T) {
	b := bridge(t)
	b.Conversation = chat.NewConversation(b.Store, oneModel{deployer{}})
	t.Cleanup(b.Conversation.Close)
	b.Client = chat.ClientTelegram
	b.Texts.Busy, b.Texts.Stopped = "busy", "stopped"
	running := make(chan struct{})
	b.Conversation.Tools.Register(chat.Tool{
		Tool: llm.Tool{Name: "deploy", Parameters: map[string]any{"type": "object"}},
		Run: func(_ context.Context, call chat.ToolCall) (any, error) {
			return nil, call.RequestApproval(map[string]string{})
		},
		Approved: func(ctx context.Context, _ chat.ApprovedCall) (any, error) {
			close(running)
			<-ctx.Done()
			return nil, ctx.Err()
		},
	})
	request, err := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "deploy"})
	if err != nil || len(request.Approvals) != 1 {
		t.Fatalf("request: %q %+v (err: %v)", request.Text, request.Approvals, err)
	}
	started := make(chan bool, 2)
	approved := make(chan Reply, 1)
	go func() {
		reply, _ := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "/approve", Started: func(stop func()) { started <- stop != nil }})
		approved <- reply
	}()
	<-running
	select {
	case withStop := <-started:
		if !withStop {
			t.Fatal("the message started without a way to stop its turn")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the approved call ran before the message started")
	}
	if reply, _ := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "more"}); reply.Text != "busy" {
		t.Fatalf("while the approved call runs: %q", reply.Text)
	}
	if reply, _ := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "/stop"}); reply.Text != "Stopping." {
		t.Fatalf("/stop: %q", reply.Text)
	}
	if reply := <-approved; !strings.HasSuffix(reply.Text, "stopped") || reply.Settled != request.Approvals[0].ID {
		t.Fatalf("stopped approval: %q %q", reply.Text, reply.Settled)
	}
}
