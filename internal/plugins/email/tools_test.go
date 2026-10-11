package email

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
)

func TestTools(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	conversation, _ := store.Create()
	// Nothing listens on the endpoint, so a send fails after it is accepted.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().(*net.TCPAddr)
	listener.Close()
	endpoint := Endpoint{Host: "127.0.0.1", Port: address.Port, Security: "tls", Username: "user", Password: "secret"}
	config := Config{From: "me@example.org", IMAP: endpoint, SMTP: endpoint}
	tools := map[string]chat.Tool{}
	for _, tool := range Tools(func() (Config, error) { return config, nil }) {
		tools[tool.Name] = tool
	}
	for name, tool := range tools {
		if tool.Available() {
			t.Fatalf("%s offered while email is disabled", name)
		}
	}
	config.Enabled = true
	if !tools["email_inbox"].Available() {
		t.Fatal("not offered while email is enabled")
	}
	call := func(name string, input map[string]any) (any, error) {
		m, err := store.Begin(conversation.ID, chat.NewID(), "go", "")
		if err != nil {
			t.Fatal(err)
		}
		part := chat.Part{"type": "tool-" + name, "toolCallId": "call"}
		m.Parts = []chat.Part{part}
		return tools[name].Run(context.Background(), chat.ToolCall{ToolCall: llm.ToolCall{ID: "call", Name: name}, ConversationID: conversation.ID, Input: input, Part: part, Message: &m, Store: store, Send: func(chat.Event) error { return nil }})
	}
	for _, input := range []map[string]any{{}, {"uid": 1.5, "validity": 1.0}, {"uid": 0.0, "validity": 1.0}, {"uid": 1.0, "validity": 1e10}} {
		if _, err := call("email_read", input); err == nil || !strings.Contains(err.Error(), "uid and validity") {
			t.Fatalf("read %v: %v", input, err)
		}
	}
	if _, err := call("email_send", map[string]any{"to": "not an address", "subject": "Hi", "text": "Hello"}); err == nil || errors.Is(err, chat.ErrAwaitingApproval) {
		t.Fatalf("invalid draft: %v", err)
	}
	if _, err := call("email_send", map[string]any{"to": "you@example.org", "subject": "Hi", "text": "Hello"}); !errors.Is(err, chat.ErrAwaitingApproval) {
		t.Fatalf("send did not ask first: %v", err)
	}
	if schema := tools["email_inbox"].Parameters; schema["required"] != nil {
		t.Fatalf("a tool without arguments lists required ones: %v", schema)
	}
	approved := chat.ApprovedCall{ConversationID: conversation.ID, ApprovalID: chat.NewID(), Store: store}
	approved.Input, _ = json.Marshal(outgoing{Draft{To: "you@example.org", Subject: "Hi", Text: "Hello"}, sender(config)})
	changed := config
	changed.SMTP.Username = "someone-else"
	config, changed = changed, config
	if _, err := tools["email_send"].Approved(context.Background(), approved); err == nil || !strings.Contains(err.Error(), "configuration changed") {
		t.Fatalf("sent from another account than the user approved: %v", err)
	}
	config = changed
	config.Enabled = false
	if _, err := tools["email_send"].Approved(context.Background(), approved); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("sent while disabled: %v", err)
	}
	config.Enabled = true
	if _, err := tools["email_send"].Approved(context.Background(), approved); err == nil {
		t.Fatal("send to a closed port succeeded")
	}
	if _, err := tools["email_send"].Approved(context.Background(), approved); err == nil || !strings.Contains(err.Error(), "already attempted") {
		t.Fatalf("an approval sent twice: %v", err)
	}
}

func TestSendScope(t *testing.T) {
	var send chat.Tool
	for _, tool := range Tools(func() (Config, error) { return Config{}, nil }) {
		if tool.Name == "email_send" {
			send = tool
		}
	}
	scope := func(to string) string {
		raw, _ := json.Marshal(outgoing{Draft{To: to, Subject: "s", Text: "t"}, "me@x via me@smtp:587"})
		return send.Scope(raw)
	}
	if got := scope(" Bob@X.com, alice@x.com,bob@x.com "); got != "to alice@x.com, bob@x.com from me@x via me@smtp:587" {
		t.Fatalf("scope: %q", got)
	}
	if scope("alice@x.com") == scope("alice@x.com, eve@y.com") {
		t.Fatal("another recipient shares the scope")
	}
}
