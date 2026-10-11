package telegram

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

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
