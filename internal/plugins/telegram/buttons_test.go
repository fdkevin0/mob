package telegram

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/fdkevin0/mob/internal/channel"
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/provider"
)

// labels are the rows' button labels, one string per row.
func labels(rows [][]button) []string {
	var list []string
	for _, row := range rows {
		var names []string
		for _, b := range row {
			names = append(names, b.Text+"="+b.Data)
		}
		list = append(list, strings.Join(names, " | "))
	}
	return list
}

func TestRepliesOfferButtonsInPlaceOfCommands(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service := &Service{Store: store, Conversation: chat.NewConversation(store, provider.Offline())}
	config := Config{UserID: 7}
	ctx := context.Background()
	present := func(text string) (string, [][]button) {
		t.Helper()
		r, err := service.reply(ctx, config, "bot", chat.NewID(), text)
		if err != nil {
			t.Fatalf("%s: %v", text, err)
		}
		r, rows := service.present(ctx, config, "bot", text, r)
		return r.Text, rows
	}

	if text, rows := present("/help"); text != texts.Help || len(rows) != len(menuButtons) {
		t.Fatalf("/help: %s %v", text, labels(rows))
	}
	if _, rows := present("/new"); rows != nil {
		t.Fatalf("/new offers buttons: %v", labels(rows))
	}
	var first, second string
	store.Setting("telegram-conversation:bot:7", &first)
	present("/new")
	store.Setting("telegram-conversation:bot:7", &second)
	text, rows := present("/list")
	got := labels(rows)
	// Both conversations may share a timestamp, so their order is not checked.
	if text != pickConversation || len(got) != 3 || !slices.Contains(got, "✓ New conversation=/open "+second) || !slices.Contains(got, "New conversation=/open "+first) || got[2] != "New conversation=/new" {
		t.Fatalf("/list: %s %v", text, got)
	}
	if text, _ := present("/open " + first); text != "Switched to “New conversation”." {
		t.Fatalf("/open: %s", text)
	}
	if _, rows := present("/model"); len(rows) == 0 || rows[0][0].Text != "Follow the default model" || rows[0][0].Data != "/model default" {
		t.Fatalf("/model: %v", labels(rows))
	}
	if _, rows := present("/model offline/demo"); rows != nil {
		t.Fatalf("a model switch offers buttons: %v", labels(rows))
	}

	present("/remember 喝茶")
	present("/approve always")
	if _, rows := present("/grants"); len(rows) != 2 || rows[0][0].Text != "Forget all" || !strings.HasPrefix(rows[1][0].Text, "Forget remember") || !strings.HasPrefix(rows[1][0].Data, "/revoke ") {
		t.Fatalf("/grants: %v", labels(rows))
	}
	// Every remembered approval gets a button, past completion's 20.
	for i := range 25 {
		if err := store.AddGrant("", fmt.Sprint("tool", i), ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, rows := present("/grants"); len(rows) != 27 {
		t.Fatalf("/grants with 26 remembered: %d rows", len(rows))
	}

	if r, rows := service.present(ctx, config, "bot", "hi", channel.Reply{Text: texts.Busy}); r.Text != texts.Busy || len(rows) != 1 || rows[0][0].Data != "/stop" {
		t.Fatalf("busy: %v", labels(rows))
	}
}

func TestLongCommandsRideOnTokens(t *testing.T) {
	var s Service
	short := "/open " + chat.NewID()
	if s.callback(short) != short || s.command(short) != short {
		t.Fatal("a short command needs no token")
	}
	long := "/model provider/" + strings.Repeat("m", 80)
	token := s.callback(long)
	if len(token) > callbackLimit || !strings.HasPrefix(token, "#") || s.command(token) != long {
		t.Fatalf("token %q", token)
	}
	if s.callback(long) == token {
		t.Fatal("tokens repeat")
	}
	if s.command("#unknown") != "" {
		t.Fatal("an unknown token sends a command")
	}
}

func TestATapOnAChoiceRemovesTheList(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	conversation, err := store.Create()
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var calls []string
	c := Config{Token: "1:x", UserID: 7, Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		if method != "sendMessageDraft" && method != "sendChatAction" && method != "answerCallbackQuery" {
			raw, _ := json.Marshal(body)
			mu.Lock()
			calls = append(calls, method+" "+string(raw))
			mu.Unlock()
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true,"result":true}`))}, nil
	})}
	service := &Service{Store: store, Conversation: chat.NewConversation(store, provider.Offline())}
	tap := func(id int64, data string) Update {
		var u Update
		if err := json.Unmarshal([]byte(`{"update_id":`+fmt.Sprint(id)+`,"callback_query":{"id":"q","data":"`+data+`","from":{"id":7},"message":{"message_id":42,"chat":{"id":7},"reply_markup":{"inline_keyboard":[[{"text":"x","callback_data":"`+data+`"}]]}}}}`), &u); err != nil {
			t.Fatal(err)
		}
		u, _ = c.tapped(u)
		return u
	}
	if err := service.Message(context.Background(), c, "1", tap(1, "/list")); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || !strings.HasPrefix(calls[0], "sendMessage ") || !strings.Contains(calls[0], `"callback_data":"/open `+conversation.ID+`"`) {
		t.Fatalf("a menu tap: %v", calls)
	}
	calls = nil
	if err := service.Message(context.Background(), c, "1", tap(2, "/open "+conversation.ID)); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || !strings.Contains(calls[0], "Switched to") || calls[1] != `editMessageReplyMarkup {"chat_id":7,"message_id":42,"reply_markup":{"inline_keyboard":[]}}` {
		t.Fatalf("a pick: %v", calls)
	}
}

func TestPickedTellsAListsChoicesFromTheMenu(t *testing.T) {
	list := keyboard{Rows: [][]button{{{Text: "a", Data: "/open " + chat.NewID()}}, menuButtons[0][:1]}}
	menu := keyboard{Rows: menuButtons}
	for _, tc := range []struct {
		text string
		k    keyboard
		want bool
	}{
		{"/open x", list, true},
		{"/new", list, true},
		{"/new", menu, false},
		{"/list", menu, false},
		{"/model default", keyboard{}, true},
		{"/approve x", keyboard{}, false},
	} {
		if got := picked(tc.text, tc.k); got != tc.want {
			t.Errorf("picked(%q) = %v", tc.text, got)
		}
	}
}
