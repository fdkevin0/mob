package telegram

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/provider"
)

func TestReplyRunsRegistryCommands(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service := &Service{Store: store, Conversation: chat.NewConversation(store, provider.Offline())}
	config := Config{UserID: 7}
	reply := func(text string) string {
		t.Helper()
		got, err := service.Reply(context.Background(), config, "bot", chat.NewID(), text)
		if err != nil {
			t.Fatalf("%s: %v", text, err)
		}
		return got
	}
	if help := reply("/start"); !strings.Contains(help, "Mob is connected") || !strings.Contains(help, "/approve [ID]") {
		t.Fatalf("/start: %s", help)
	}
	if list, _ := store.List(); len(list) != 0 {
		t.Fatal("/help created a conversation")
	}
	if got := reply("/new"); got != "New conversation started." {
		t.Fatalf("/new: %s", got)
	}
	var current string
	if err := store.Setting("telegram-conversation:bot:7", &current); err != nil || current == "" {
		t.Fatalf("/new did not become the bot's conversation: %v", err)
	}
	answer, err := service.reply(context.Background(), config, "bot", chat.NewID(), "/remember 简洁")
	got, approvals := answer.Text, answer.Approvals
	if err != nil || !strings.Contains(got, "**Approval needed**\n```\nremember\nfact: 简洁\n```") || !strings.Contains(got, "reply /approve, or /deny") || len(approvals) != 1 || approvals[0].Tool != "remember" {
		t.Fatalf("approval request: %s %+v %v", got, approvals, err)
	}
	if got := reply("/approve"); !strings.Contains(got, "approved remember and it ran") {
		t.Fatalf("/approve: %s", got)
	}
	if got := reply("/approve"); !strings.Contains(got, "0 requests are pending") {
		t.Fatalf("second /approve: %s", got)
	}
	reply("/remember 冗长")
	if got := reply("/approve " + chat.NewID() + " please"); got != "Use `/approve [ID] [conversation|always]`." {
		t.Fatalf("/approve with a reason: %s", got)
	}
	// The demo model echoes what it last received: the denial and its reason.
	if got := reply("/deny 太长了"); !strings.Contains(got, "The user denied the remember request and said: 太长了") {
		t.Fatalf("/deny with a reason: %s", got)
	}
	if got := reply("/deny"); !strings.Contains(got, "0 requests are pending; use `/deny [ID] [reason]`") {
		t.Fatalf("/deny with nothing pending: %s", got)
	}
	reply("/remember 喝茶")
	if got := reply("/approve always"); !strings.Contains(got, "approved remember and it ran") {
		t.Fatalf("/approve always: %s", got)
	}
	if got := reply("/remember 喝咖啡"); strings.Contains(got, "Approval needed") {
		t.Fatalf("a remembered approval still asked: %s", got)
	}
	if got := reply("/grants"); !strings.Contains(got, "| remember | every call | every conversation |") {
		t.Fatalf("/grants: %s", got)
	}
	if got := reply("/revoke all"); !strings.Contains(got, "Forgot 1") {
		t.Fatalf("/revoke all: %s", got)
	}
	if got := reply("/remember 喝水"); !strings.Contains(got, "Approval needed") {
		t.Fatalf("a revoked approval did not ask: %s", got)
	}
}

func TestApprovalButtonsAndTaps(t *testing.T) {
	a, b := chat.NewID(), chat.NewID()
	var sent []map[string]any
	var answered []string
	c := Config{Token: "1:x", UserID: 7, Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		switch {
		case strings.HasSuffix(r.URL.Path, "/sendMessage"):
			sent = append(sent, body)
		case strings.HasSuffix(r.URL.Path, "/answerCallbackQuery"):
			answered = append(answered, body["callback_query_id"].(string))
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true,"result":true}`))}, nil
	})}
	if err := c.Send(context.Background(), 7, strings.Repeat("x", 3000)+"\n\n"+strings.Repeat("y", 3000), chat.PendingApproval{ID: a, Tool: "email_send"}, chat.PendingApproval{ID: b, Tool: "remember"}); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 2 || sent[0]["reply_markup"] != nil {
		t.Fatalf("buttons belong under the last chunk only: %v", sent)
	}
	rows, _ := json.Marshal(sent[1]["reply_markup"])
	if want := `{"inline_keyboard":[[{"callback_data":"/approve ` + a + `","text":"Approve email_send"},{"callback_data":"/approve ` + a + ` always","text":"Always allow email_send"},{"callback_data":"/deny ` + a + `","text":"Deny email_send"}],[{"callback_data":"/approve ` + b + `","text":"Approve remember"},{"callback_data":"/approve ` + b + ` always","text":"Always allow remember"},{"callback_data":"/deny ` + b + `","text":"Deny remember"}]]}`; string(rows) != want {
		t.Fatalf("buttons: %s", rows)
	}

	tap := func(from int64, data string) Update {
		var u Update
		json.Unmarshal([]byte(`{"update_id":9,"callback_query":{"id":"q","data":"`+data+`","from":{"id":`+fmt.Sprint(from)+`}}}`), &u)
		return c.tapped(context.Background(), u)
	}
	if m := tap(7, "/approve "+a).Message; m == nil || m.Text != "/approve "+a || m.From.ID != 7 || m.Chat.ID != 7 || m.Chat.Type != "private" {
		t.Fatalf("owner tap: %+v", m)
	}
	if m := tap(8, "/approve "+a).Message; m != nil {
		t.Fatalf("a stranger's tap became a message: %+v", m)
	}
	if m := tap(7, "/new").Message; m != nil {
		t.Fatalf("a tap became another command: %+v", m)
	}
	if len(answered) != 2 {
		t.Fatalf("owner taps answered: %v", answered)
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestPublishCommandsFromRegistry(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service := &Service{Store: store, Conversation: chat.NewConversation(store, provider.Offline())}
	var path string
	var sent struct {
		Commands []botCommand `json:"commands"`
		Scope    struct {
			Type   string `json:"type"`
			ChatID int64  `json:"chat_id"`
		} `json:"scope"`
	}
	config := Config{Token: "123:secret", UserID: 7, Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		path = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
			t.Error(err)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true,"result":true}`))}, nil
	})}
	if err := service.PublishCommands(context.Background(), config); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, c := range sent.Commands {
		names = append(names, c.Command)
		if c.Description == "" {
			t.Fatalf("%s has no description", c.Command)
		}
	}
	if path != "/bot123:secret/setMyCommands" || strings.Join(names, " ") != "model models compact new approve deny grants revoke stop help" || sent.Scope.Type != "chat" || sent.Scope.ChatID != 7 {
		t.Fatalf("published %s %v %+v", path, names, sent.Scope)
	}
}

func TestMenuSkipsNamesTelegramRejects(t *testing.T) {
	got := menu([]chat.CommandSpec{{Name: "clear-secret", Summary: "x"}, {Name: "Help", Summary: "x"}, {Name: "quiet"}, {Name: "ok_1", Summary: strings.Repeat("é", 300)}})
	if len(got) != 1 || got[0].Command != "ok_1" || len([]rune(got[0].Description)) != 256 {
		t.Fatalf("menu: %+v", got)
	}
}

func TestLoopPublishesMenuAfterConnecting(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service := &Service{Store: store, Conversation: chat.NewConversation(store, provider.Offline())}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var calls []string
	config := Config{Token: "123:secret", UserID: 7, Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		calls = append(calls, method)
		result := `true`
		switch method {
		case "getMe":
			result = `{"id":123,"username":"mob_bot"}`
		case "getWebhookInfo":
			result = `{"url":""}`
		case "getUpdates":
			cancel()
			result = `[]`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true,"result":` + result + `}`))}, nil
	})}
	service.Loop(ctx, config, func(string) {})
	if got := strings.Join(calls, " "); !strings.HasPrefix(got, "getMe getWebhookInfo setMyCommands getUpdates") {
		t.Fatalf("calls: %s", got)
	}
}

func TestSendFallsBackToPlainTextWhenTelegramRejectsHTML(t *testing.T) {
	var sent []map[string]any
	c := Config{Token: "1:x", Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		sent = append(sent, body)
		if body["parse_mode"] == "HTML" {
			return &http.Response{StatusCode: 400, Body: io.NopCloser(strings.NewReader(`{"ok":false,"error_code":400}`))}, nil
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true,"result":{}}`))}, nil
	})}
	if err := c.Send(context.Background(), 7, "**hi** <there>"); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 2 || sent[0]["text"] != "<b>hi</b> &lt;there&gt;" || sent[1]["text"] != "hi <there>" || sent[1]["parse_mode"] != nil {
		t.Fatalf("sent: %v", sent)
	}
}

func TestTapRemovesTheDecidedButtons(t *testing.T) {
	a, b := chat.NewID(), chat.NewID()
	var edited map[string]any
	c := Config{Token: "1:x", UserID: 7, Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/editMessageReplyMarkup") {
			json.NewDecoder(r.Body).Decode(&edited)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true,"result":true}`))}, nil
	})}
	markup, _ := json.Marshal(map[string]any{"inline_keyboard": buttons([]chat.PendingApproval{{ID: a, Tool: "x"}, {ID: b, Tool: "y"}})})
	var u Update
	if err := json.Unmarshal([]byte(`{"update_id":9,"callback_query":{"id":"q","data":"/deny `+a+`","from":{"id":7},"message":{"message_id":42,"chat":{"id":7},"reply_markup":`+string(markup)+`}}}`), &u); err != nil {
		t.Fatal(err)
	}
	if m := c.tapped(context.Background(), u).Message; m == nil || m.Text != "/deny "+a {
		t.Fatalf("tap: %+v", m)
	}
	rows, _ := json.Marshal(edited["reply_markup"])
	if edited["message_id"] != float64(42) || strings.Contains(string(rows), a) || !strings.Contains(string(rows), "/approve "+b) {
		t.Fatalf("edited: %v %s", edited, rows)
	}
}

func TestMessageNotesMedia(t *testing.T) {
	var m Message
	if err := json.Unmarshal([]byte(`{"message_id":3,"caption":"look","photo":[{"file_id":"f"}],"from":{"id":7},"chat":{"id":7,"type":"private"}}`), &m); err != nil {
		t.Fatal(err)
	}
	if !m.Media || m.Caption != "look" || m.ID != 3 || m.From.ID != 7 || m.Chat.Type != "private" {
		t.Fatalf("photo: %+v", m)
	}
	if err := json.Unmarshal([]byte(`{"text":"hi"}`), &m); err != nil || m.Media {
		t.Fatalf("text: %+v", m)
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

type oneModel struct{ model llm.Model }

func (o oneModel) Default() string                          { return "test/waiter" }
func (o oneModel) Resolve(string) (llm.Model, error)        { return o.model, nil }
func (o oneModel) SetDefault(string) (llm.Ref, error)       { return o.model.Ref(), nil }
func (o oneModel) List(context.Context, string) []llm.Group { return nil }

func TestLoopKeepsPollingWhileAReplyIsWritten(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	w := waiter{started: make(chan struct{}), once: new(sync.Once)}
	conversation := chat.NewConversation(store, oneModel{w})
	defer conversation.Close()
	service := &Service{Store: store, Conversation: conversation}
	defer func(d time.Duration) { placeholderDelay = d }(placeholderDelay)
	placeholderDelay = time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var mu sync.Mutex
	var texts []string
	polls := 0
	var draft float64
	drafted, busy := make(chan struct{}), make(chan struct{})
	stopped := func(draft float64) string {
		return fmt.Sprintf(`[{"update_id":%d,"stopped_message_generation":{"chat":{"id":7,"type":"private"},"draft_id":%d}}]`, polls, int64(draft))
	}
	update := func(id int, body string) string {
		return fmt.Sprintf(`[{"update_id":%d,"message":{"message_id":%d,%s,"from":{"id":7},"chat":{"id":7,"type":"private"}}}]`, id, id, body)
	}
	config := Config{Token: "123:secret", UserID: 7, Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		result := `true`
		mu.Lock()
		defer mu.Unlock()
		switch method {
		case "getMe":
			result = `{"id":123,"username":"mob_bot"}`
		case "getWebhookInfo":
			result = `{"url":""}`
		case "sendMessageDraft":
			if draft == 0 {
				draft = body["draft_id"].(float64)
				close(drafted)
			}
		case "sendMessage":
			texts = append(texts, body["text"].(string))
			if strings.HasPrefix(body["text"].(string), "Still working") {
				close(busy)
			}
			result = `{}`
		case "getUpdates":
			polls++
			switch polls {
			case 1:
				result = update(1, `"text":"long job"`)
			case 2:
				mu.Unlock()
				<-w.started
				mu.Lock()
				result = update(2, `"photo":[{"file_id":"f"}]`)
			case 3:
				result = update(3, `"text":"and this"`)
			case 4:
				// A tap on another reply's draft stops nothing.
				mu.Unlock()
				<-drafted
				<-busy
				mu.Lock()
				result = stopped(draft + 100)
			case 5:
				result = stopped(draft)
			default:
				if len(texts) >= 3 {
					cancel()
				}
				result = `[]`
			}
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true,"result":` + result + `}`))}, nil
	})}
	service.Loop(ctx, config, func(string) {})
	mu.Lock()
	defer mu.Unlock()
	got := strings.Join(texts, " | ")
	for _, want := range []string{"Mob reads only text", "Still working on your last message", "partial\n\nStopped."} {
		if !strings.Contains(got, want) {
			t.Fatalf("sent %q, want %q", got, want)
		}
	}

}

func TestStopButtonStopsOnlyItsOwnReply(t *testing.T) {
	var s Service
	stopped := 0
	s.showing(1, func() { stopped++ })
	s.stop(2)
	if stopped != 0 {
		t.Fatal("a tap on another draft stopped the reply")
	}
	s.stop(1)
	s.done(1)
	s.stop(1)
	if stopped != 1 {
		t.Fatalf("stopped %d times", stopped)
	}
}
