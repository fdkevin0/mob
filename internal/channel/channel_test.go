package channel

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
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
	if reply, err := b.Answer(context.Background(), Message{Key: "k", Owner: true, Text: "/approve " + stale}); err != nil || reply.Text != "stale "+stale {
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
