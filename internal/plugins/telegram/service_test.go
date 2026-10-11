package telegram

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
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
	got, approvals, err := service.reply(context.Background(), config, "bot", chat.NewID(), "/remember 简洁")
	if err != nil || !strings.Contains(got, "Approval needed: remember\nfact: 简洁") || !strings.Contains(got, "reply /approve, or /deny") || len(approvals) != 1 || approvals[0].Tool != "remember" {
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
	if err := c.Send(context.Background(), 7, strings.Repeat("x", 2001), chat.PendingApproval{ID: a, Tool: "email_send"}, chat.PendingApproval{ID: b, Tool: "remember"}); err != nil {
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
	if path != "/bot123:secret/setMyCommands" || strings.Join(names, " ") != "model models new approve deny grants revoke help" || sent.Scope.Type != "chat" || sent.Scope.ChatID != 7 {
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
