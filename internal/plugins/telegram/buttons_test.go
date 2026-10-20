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

func TestApprovalTapUsesOriginalConversationAfterNavigation(t *testing.T) {
	for _, approve := range []bool{true, false} {
		t.Run(fmt.Sprint(approve), func(t *testing.T) {
			store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			conversation := chat.NewConversation(store, provider.Offline())
			defer conversation.Close()
			service := &Service{Store: store, Conversation: conversation}
			var edited bool
			config := Config{UserID: 7, Token: "1:x", Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
				if strings.HasSuffix(r.URL.Path, "/editMessageReplyMarkup") {
					edited = true
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true,"result":true}`))}, nil
			})}
			ctx := context.Background()
			requested, err := service.reply(ctx, config, "1", chat.NewID(), "/remember tea")
			if err != nil || len(requested.Approvals) != 1 {
				t.Fatalf("approval request: %+v, %v", requested, err)
			}
			var original, current string
			if err := store.Setting(conversationKey("1", config), &original); err != nil {
				t.Fatal(err)
			}
			if _, err := service.reply(ctx, config, "1", chat.NewID(), "/new"); err != nil {
				t.Fatal(err)
			}
			if err := store.Setting(conversationKey("1", config), &current); err != nil {
				t.Fatal(err)
			}
			id := requested.Approvals[0].ID
			command := "/deny " + id
			if approve {
				command = "/approve " + id + " conversation"
			}
			var tap Update
			if err := json.Unmarshal([]byte(fmt.Sprintf(`{"update_id":1,"callback_query":{"id":"q","data":%q,"from":{"id":7},"message":{"message_id":42,"chat":{"id":7},"reply_markup":{"inline_keyboard":[]}}}}`, command)), &tap); err != nil {
				t.Fatal(err)
			}
			tap, _ = config.tapped(tap)
			// The approval's conversation must survive a plugin restart too.
			service = &Service{Store: store, Conversation: conversation}
			if err := service.Message(ctx, config, "1", tap); err != nil {
				t.Fatal(err)
			}
			if pending := conversation.Pending(original); len(pending) != 0 || !edited {
				t.Fatalf("pending=%v, buttons removed=%v", pending, edited)
			}
			var selected string
			if err := store.Setting(conversationKey("1", config), &selected); err != nil || selected != current {
				t.Fatalf("selected conversation changed: %q, %v", selected, err)
			}
			facts, err := store.Memories(original)
			if err != nil || approve && len(facts) != 1 || !approve && len(facts) != 0 {
				t.Fatalf("facts=%v, error=%v", facts, err)
			}
			grants, err := store.Grants()
			if err != nil || approve && (len(grants) != 1 || grants[0].ConversationID != original) {
				t.Fatalf("grant applied to wrong conversation: %+v, %v", grants, err)
			}
		})
	}
}

func TestTypedDenialWithIDUsesTheApprovalsConversation(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	conversation := chat.NewConversation(store, provider.Offline())
	defer conversation.Close()
	service := &Service{Store: store, Conversation: conversation}
	config := Config{UserID: 7, Token: "1:x", Transport: roundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true,"result":true}`))}, nil
	})}
	ctx := context.Background()
	requested, err := service.reply(ctx, config, "1", chat.NewID(), "/remember tea")
	if err != nil || len(requested.Approvals) != 1 {
		t.Fatalf("approval request: %+v, %v", requested, err)
	}
	var original string
	if err := store.Setting(conversationKey("1", config), &original); err != nil {
		t.Fatal(err)
	}
	if _, err := service.reply(ctx, config, "1", chat.NewID(), "/new"); err != nil {
		t.Fatal(err)
	}
	var typed Update
	if err := json.Unmarshal([]byte(fmt.Sprintf(`{"update_id":2,"message":{"message_id":5,"text":"/deny %s too long","from":{"id":7},"chat":{"id":7,"type":"private"}}}`, requested.Approvals[0].ID)), &typed); err != nil {
		t.Fatal(err)
	}
	if err := service.Message(ctx, config, "1", typed); err != nil {
		t.Fatal(err)
	}
	if pending := conversation.Pending(original); len(pending) != 0 {
		t.Fatalf("pending = %v", pending)
	}
}

func TestAnnounceSendsANoticeWithButtons(t *testing.T) {
	var sent []map[string]any
	c := Config{Token: "1:x", UserID: 7, Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		sent = append(sent, body)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true,"result":true}`))}, nil
	})}
	id := chat.NewID()
	s := &Service{}
	if err := s.announce(context.Background(), c, chat.Notice{Text: "**Task waits for your decision:** codex · tests", Approvals: []chat.PendingApproval{{ID: id, Tool: "codex_execute", Input: map[string]any{"title": "npm test"}}}}); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 || sent[0]["chat_id"] != float64(7) {
		t.Fatalf("sent = %v", sent)
	}
	text, _ := sent[0]["text"].(string)
	rows, _ := json.Marshal(sent[0]["reply_markup"])
	if !strings.Contains(text, "<b>Task waits for your decision:</b> codex · tests") || !strings.Contains(text, "/deny ID") || !strings.Contains(string(rows), `"/approve `+id+`"`) {
		t.Fatalf("text = %s, buttons = %s", text, rows)
	}
}
