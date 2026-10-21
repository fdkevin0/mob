package schedule

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
)

func TestNext(t *testing.T) {
	shanghai, _ := time.LoadLocation("Asia/Shanghai")
	newYork, _ := time.LoadLocation("America/New_York")
	friday := time.Date(2026, 10, 23, 9, 0, 0, 0, shanghai)
	for _, c := range []struct {
		repeat string
		last   time.Time
		loc    *time.Location
		clock  string
		now    time.Time
		want   time.Time
	}{
		{"daily", friday, shanghai, "09:00", friday, friday.AddDate(0, 0, 1)},
		{"weekdays", friday, shanghai, "09:00", friday, time.Date(2026, 10, 26, 9, 0, 0, 0, shanghai)},
		{"weekly", friday, shanghai, "09:00", friday, friday.AddDate(0, 0, 7)},
		{"hourly", friday, shanghai, "09:00", friday.Add(150 * time.Minute), friday.Add(3 * time.Hour)},
		// Missed runs are skipped, not caught up one by one.
		{"daily", friday, shanghai, "09:00", friday.AddDate(0, 0, 3).Add(time.Hour), friday.AddDate(0, 0, 4)},
		// A daily run keeps its time of day across daylight saving's end.
		{"daily", time.Date(2026, 10, 31, 9, 0, 0, 0, newYork), newYork, "09:00", time.Date(2026, 10, 31, 9, 0, 0, 0, newYork), time.Date(2026, 11, 1, 9, 0, 0, 0, newYork)},
		// And across its start: 02:30 does not exist on March 8, which
		// moves that run but not the next.
		{"daily", time.Date(2026, 3, 7, 2, 30, 0, 0, newYork), newYork, "02:30", time.Date(2026, 3, 8, 12, 0, 0, 0, newYork), time.Date(2026, 3, 9, 2, 30, 0, 0, newYork)},
		{"daily", time.Date(2026, 3, 8, 2, 30, 0, 0, newYork), newYork, "02:30", time.Date(2026, 3, 8, 12, 0, 0, 0, newYork), time.Date(2026, 3, 9, 2, 30, 0, 0, newYork)},
	} {
		if got := next(c.last, c.repeat, c.loc, c.clock, c.now); !got.Equal(c.want) {
			t.Errorf("%s after %s: %s, want %s", c.repeat, c.now, got, c.want)
		}
	}
}

// echo answers every prompt with what it was asked.
type echo struct{}

func (echo) Ref() llm.Ref   { return llm.Ref{Provider: "test", Model: "echo"} }
func (echo) Info() llm.Info { return llm.Info{ID: "echo", Tools: true} }
func (echo) Stream(_ context.Context, req llm.Request, emit func(string, string) error) (llm.Result, error) {
	text := "did: " + req.Messages[len(req.Messages)-1].Text
	return llm.Result{Text: text}, emit("text", text)
}

type models struct{}

func (models) Default() string                          { return "test/echo" }
func (models) Resolve(string) (llm.Model, error)        { return echo{}, nil }
func (models) SetDefault(string) (llm.Ref, error)       { return echo{}.Ref(), nil }
func (models) List(context.Context, string) []llm.Group { return nil }

func TestSchedulesRunAndRepeat(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	conversations := chat.NewConversation(store, models{})
	defer func() { conversations.Close(); store.Close() }()
	now := time.Date(2026, 10, 21, 8, 0, 0, 0, time.UTC)
	s := &Service{Store: store, Conversations: conversations, Now: func() time.Time { return now }}
	var mu sync.Mutex
	var notices []chat.Notice
	defer conversations.Notices(func(n chat.Notice) { mu.Lock(); notices = append(notices, n); mu.Unlock() })()
	c, err := store.Create()
	if err != nil {
		t.Fatal(err)
	}
	tools := map[string]chat.Tool{}
	for _, tool := range s.Tools() {
		tools[tool.Name] = tool
	}
	if tools["schedules"].Available() {
		t.Fatal("schedules offered with nothing scheduled")
	}
	for _, input := range []map[string]any{
		{"prompt": "x", "at": "tomorrow"},
		{"prompt": "x", "at": "2026-10-20T09:00:00Z"},
		{"prompt": "x", "at": "2026-10-22T09:00:00Z", "repeat": "monthly"},
		{"prompt": " ", "at": "2026-10-22T09:00:00Z"},
		{"prompt": "x", "at": "2026-10-22T09:00:00Z", "timezone": "Mars/Base"},
	} {
		if _, err := tools["schedule"].Run(context.Background(), chat.ToolCall{Input: input}); err == nil || err == chat.ErrAwaitingApproval {
			t.Errorf("%v accepted: %v", input, err)
		}
	}
	add := func(input map[string]string) string {
		t.Helper()
		raw, _ := json.Marshal(input)
		out, err := tools["schedule"].Approved(context.Background(), chat.ApprovedCall{ConversationID: c.ID, Input: raw})
		if err != nil {
			t.Fatal(err)
		}
		return out.(map[string]any)["schedule"].(string)
	}
	add(map[string]string{"prompt": "remind me to stretch", "at": "2026-10-21T09:00:00Z"})
	daily := add(map[string]string{"prompt": "summarize my tasks", "at": "2026-10-21T09:30:00+00:00", "repeat": "daily", "timezone": "UTC"})
	// A repeat whose first time passed starts at its next one.
	past := add(map[string]string{"prompt": "late", "at": "2026-10-20T07:00:00Z", "repeat": "daily", "timezone": "UTC"})
	all, _ := store.Schedules(0)
	if len(all) != 3 || all[2].ID != past || all[2].Next != time.Date(2026, 10, 21, 7, 0, 0, 0, time.UTC).AddDate(0, 0, 1).UnixMilli() {
		t.Fatalf("schedules = %+v", all)
	}

	wait := func(n int) []chat.Notice {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			mu.Lock()
			got := append([]chat.Notice(nil), notices...)
			mu.Unlock()
			if len(got) >= n && !conversations.Active(c.ID) {
				return got
			}
			if time.Now().After(deadline) {
				t.Fatalf("notices = %+v", got)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	s.RunDue()
	if got := wait(0); len(got) != 0 {
		t.Fatalf("ran early: %+v", got)
	}
	now = time.Date(2026, 10, 21, 9, 5, 0, 0, time.UTC)
	s.RunDue()
	got := wait(1)
	if len(got) != 1 || !strings.HasPrefix(got[0].Text, "**Scheduled:** remind me to stretch\n\ndid: Scheduled by the owner") || got[0].ConversationID != c.ID {
		t.Fatalf("notices = %+v", got)
	}
	if all, _ = store.Schedules(0); len(all) != 2 || all[0].ID != daily {
		t.Fatalf("one-off kept: %+v", all)
	}
	now = time.Date(2026, 10, 21, 9, 31, 0, 0, time.UTC)
	s.RunDue()
	wait(2)
	if all, _ = store.Schedules(0); all[0].ID != past || all[1].ID != daily || all[1].Next != time.Date(2026, 10, 22, 9, 30, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("daily not moved on: %+v", all)
	}
	if out, err := tools["schedule_cancel"].Run(context.Background(), chat.ToolCall{Input: map[string]any{"id": daily}}); err != nil || out.(map[string]any)["cancelled"] != true {
		t.Fatalf("cancel: %v %v", out, err)
	}
	if _, err := tools["schedule_cancel"].Run(context.Background(), chat.ToolCall{Input: map[string]any{"id": "all"}}); err == nil {
		t.Fatal("the model cancelled every schedule at once")
	}
	if all, _ = store.Schedules(0); len(all) != 1 || all[0].ID != past || !tools["schedules"].Available() {
		t.Fatalf("after cancel: %+v", all)
	}
}

func TestReportQuotesItsOwnTurn(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	conversations := chat.NewConversation(store, models{})
	defer func() { conversations.Close(); store.Close() }()
	s := &Service{Store: store, Conversations: conversations}
	var notices []chat.Notice
	defer conversations.Notices(func(n chat.Notice) { notices = append(notices, n) })()
	c, _ := store.Create()
	run := func(text string) *chat.Running {
		t.Helper()
		r, err := conversations.Start(chat.ChatRequest{ID: c.ID, Text: text, RequestID: chat.NewID(), Owner: true}, nil)
		if err != nil {
			t.Fatal(err)
		}
		<-r.Done()
		return r
	}
	scheduled := run("scheduled work")
	run("a later message")
	// The report comes after a newer reply, and still quotes its own turn.
	s.report(chat.Schedule{ConversationID: c.ID, Prompt: "scheduled work"}, scheduled)
	if len(notices) != 1 || !strings.Contains(notices[0].Text, "did: scheduled work") || strings.Contains(notices[0].Text, "later") {
		t.Fatalf("notices = %+v", notices)
	}
}
