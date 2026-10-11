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

func TestComplete(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	service := NewConversation(s, &models{def: "alpha/one"})
	c, _ := s.Create()
	complete := func(client, text string) []string {
		return values(service.Complete(context.Background(), CompletionRequest{Client: client, ConversationID: c.ID, Text: text}))
	}
	for _, tc := range []struct {
		client, text string
		want         []string
	}{
		{ClientWeb, "/", []string{"/model", "/models"}},
		{ClientWeb, "/mo", []string{"/model", "/models"}},
		{ClientWeb, "/models", []string{"/models"}},
		{ClientTUI, "/de", []string{"/deny", "/deliveries"}},
		{ClientTUI, "/secret", []string{"/clear-secret"}},
		{ClientWeb, "/open ", []string{}},
		{ClientWeb, "/model ", []string{"default", "alpha/one", "beta/two"}},
		{ClientWeb, "/model TWO", []string{"beta/two"}},
		{ClientWeb, "/model default b", []string{"beta/two"}},
		{ClientWeb, "/model alpha/one ", []string{}},
		{ClientTUI, "/test t", []string{"telegram"}},
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
	approval := NewID()
	raw := `[{"type":"tool-remember","state":"approval-requested","approval":{"id":"` + approval + `"}}]`
	if _, err := s.db.Exec("INSERT INTO messages(id,conversation_id,role,parts,status) VALUES(?,?,'assistant',?,'complete')", NewID(), c.ID, raw); err != nil {
		t.Fatal(err)
	}
	if got := service.Complete(context.Background(), CompletionRequest{Client: ClientTUI, ConversationID: c.ID, Text: "/deny "}); len(got) != 1 || got[0].Value != approval || got[0].Detail != "remember" {
		t.Fatalf("approvals: %+v", got)
	}
}

func TestHelpFollowsClient(t *testing.T) {
	help := Help(ClientTelegram)
	for _, want := range []string{"/new", "/approve ID", "/model [NAME", "/help"} {
		if !strings.Contains(help, want) {
			t.Fatalf("telegram help lacks %s:\n%s", want, help)
		}
	}
	if strings.Contains(help, "/cloud") {
		t.Fatal("telegram help lists a terminal-only command")
	}
	for _, c := range Commands(ClientWeb) {
		if !isCommand("/" + c.Name) {
			t.Fatalf("web lists /%s, which the service does not answer", c.Name)
		}
	}
}
