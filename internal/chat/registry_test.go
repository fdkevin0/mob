package chat

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func values(list []Suggestion) []string {
	out := []string{}
	for _, s := range list {
		out = append(out, s.Value)
	}
	return out
}

func testService(t *testing.T) (*ConversationService, Conversation) {
	t.Helper()
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	c, _ := s.Create()
	return NewConversation(s, &models{def: "alpha/one"}), c
}

// pendingApproval stores a tool request awaiting a decision and returns its ID.
func pendingApproval(t *testing.T, s *Store, conversation string) string {
	t.Helper()
	approval := NewID()
	raw := `[{"type":"tool-remember","state":"approval-requested","approval":{"id":"` + approval + `"}}]`
	if _, err := s.db.Exec("INSERT INTO messages(id,conversation_id,role,parts,status) VALUES(?,?,'assistant',?,'complete')", NewID(), conversation, raw); err != nil {
		t.Fatal(err)
	}
	return approval
}

func TestComplete(t *testing.T) {
	service, c := testService(t)
	complete := func(client, text string) []string {
		return values(service.Commands.Complete(context.Background(), CommandRequest{Client: client, ConversationID: c.ID, Text: text}, true))
	}
	for _, tc := range []struct {
		client, text string
		want         []string
	}{
		{ClientTelegram, "/", []string{"/model", "/models", "/compact", "/new", "/list", "/open", "/approve", "/deny", "/grants", "/revoke", "/stop", "/help"}},
		{ClientWeb, "/mo", []string{"/model", "/models"}},
		{ClientWeb, "/models", []string{"/models"}},
		{ClientWeb, "/de", []string{"/deny"}},
		{ClientWeChat, "/open ", []string{}},
		{ClientWeb, "/model ", []string{"default", "alpha/one", "beta/two"}},
		{ClientWeb, "/model TWO", []string{"beta/two"}},
		{ClientWeb, "/model default b", []string{"beta/two"}},
		{ClientWeb, "/model alpha/one ", []string{}},
		{ClientTUI, "/approve ", []string{}},
		{ClientWeb, "hello /mo", []string{}},
		{ClientWeb, "/model\nx", []string{}},
	} {
		if got := complete(tc.client, tc.text); !slices.Equal(got, tc.want) {
			t.Errorf("%s %q: got %v, want %v", tc.client, tc.text, got, tc.want)
		}
	}
	if got := complete(ClientTUI, "/open "); !slices.Equal(got, []string{c.ID}) {
		t.Fatalf("conversations: %v", got)
	}
	approval := pendingApproval(t, service.Store, c.ID)
	if got := service.Commands.Complete(context.Background(), CommandRequest{Client: ClientTUI, ConversationID: c.ID, Text: "/deny "}, true); len(got) != 1 || got[0].Value != approval || got[0].Detail != "remember" {
		t.Fatalf("approvals: %+v", got)
	}
}

func TestRun(t *testing.T) {
	service, c := testService(t)
	run := func(client, text string) CommandResult {
		t.Helper()
		result, err := service.Commands.Run(context.Background(), CommandRequest{Client: client, ConversationID: c.ID, Text: text}, true)
		if err != nil {
			t.Fatalf("%s: %v", text, err)
		}
		return result
	}
	for _, text := range []string{"hello", "/model", "/models x", "/unknown", "/new\nsecond line"} {
		if run(ClientWeb, text).Handled {
			t.Fatalf("%q must be sent as chat", text)
		}
	}
	if run(ClientWeChat, "/list").Handled {
		t.Fatal("/list ran in a client that does not support it")
	}
	created := run(ClientWeb, "/new")
	if !created.Handled || created.Action == nil || created.Action.Kind != OpenConversation {
		t.Fatalf("/new: %+v", created)
	}
	if list, _ := service.Store.List(); len(list) != 2 {
		t.Fatal("/new did not create a conversation")
	}
	if list := run(ClientTUI, "/list").Markdown; !strings.Contains(list, "(current)") || !strings.Contains(list, created.Action.ConversationID) {
		t.Fatalf("/list: %s", list)
	}
	if opened := run(ClientWeb, "/open "+created.Action.ConversationID); opened.Action == nil || opened.Action.ConversationID != created.Action.ConversationID {
		t.Fatalf("/open: %+v", opened)
	}
	if missing := run(ClientWeb, "/open nope"); missing.Action != nil || !strings.Contains(missing.Markdown, "No conversation") {
		t.Fatalf("/open missing: %+v", missing)
	}
	if none := run(ClientWeb, "/approve"); none.Action != nil || !strings.Contains(none.Markdown, "0 requests") {
		t.Fatalf("/approve without requests: %+v", none)
	}
	approval := pendingApproval(t, service.Store, c.ID)
	for text, approved := range map[string]bool{"/approve": true, "/deny " + approval: false} {
		got := run(ClientTelegram, text)
		if got.Action == nil || got.Action.Kind != Decide || got.Action.ApprovalID != approval || got.Action.Approved != approved {
			t.Fatalf("%s: %+v", text, got)
		}
	}
	if help := run(ClientTelegram, "/help").Markdown; !strings.Contains(help, "/approve [ID]") || !strings.Contains(help, "/open ID") {
		t.Fatalf("telegram help: %s", help)
	}
	service.Commands.Register(Command{CommandSpec: CommandSpec{Name: "secret", Clients: []string{ClientWeb}}, OwnerOnly: true,
		Run: func(context.Context, CommandCall) (CommandResult, error) { return CommandResult{Markdown: "ran"}, nil }})
	if got, _ := service.Commands.Run(context.Background(), CommandRequest{Client: ClientWeb, Text: "/secret"}, false); !got.Handled || got.Markdown == "ran" {
		t.Fatalf("owner-only command ran for a guest: %+v", got)
	}
}

func TestRegisterRejectsAmbiguousCommands(t *testing.T) {
	for _, c := range []Command{
		{CommandSpec: CommandSpec{Name: "model", Transcript: true}},
		{CommandSpec: CommandSpec{Name: "both", Transcript: true}, Run: func(context.Context, CommandCall) (CommandResult, error) { return CommandResult{}, nil }},
		{CommandSpec: CommandSpec{Name: "neither"}},
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("registered %s", c.Name)
				}
			}()
			service, _ := testService(t)
			service.Commands.Register(c)
		}()
	}
}

func TestFenceAndCell(t *testing.T) {
	if got := Fence("", "a ``` b"); got != "````\na ``` b\n````" {
		t.Fatalf("fence: %q", got)
	}
	if got := Cell("a|b\nc"); got != `a\|b c` {
		t.Fatalf("cell: %q", got)
	}
}
