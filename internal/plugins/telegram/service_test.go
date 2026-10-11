package telegram

import (
	"context"
	"encoding/json"
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
	if got := reply("/remember 简洁"); !strings.Contains(got, "/approve") {
		t.Fatalf("approval request: %s", got)
	}
	if got := reply("/approve"); !strings.Contains(got, "saved locally") {
		t.Fatalf("/approve: %s", got)
	}
	if got := reply("/approve"); !strings.Contains(got, "0 requests are pending") {
		t.Fatalf("second /approve: %s", got)
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
	if path != "/bot123:secret/setMyCommands" || strings.Join(names, " ") != "model models new approve deny help" || sent.Scope.Type != "chat" || sent.Scope.ChatID != 7 {
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
