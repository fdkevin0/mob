package cloudflare

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
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
	var paths []string
	result := `{"success":true,"result":[]}`
	transport := transportFunc(func(r *http.Request) (*http.Response, error) {
		paths = append(paths, r.URL.Path)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(result)), Header: make(http.Header)}, nil
	})
	config := Config{Transport: transport, AccountID: strings.Repeat("a", 32), Token: "secret-token", DatabaseID: "db", NamespaceID: "ns"}
	tool := Tools(func() (Config, error) { return config, nil })[0]
	if tool.Available() {
		t.Fatal("offered while Cloudflare is disabled")
	}
	config.Enabled = true
	if !tool.Available() {
		t.Fatal("not offered while Cloudflare is enabled")
	}
	run := func(input map[string]any) (any, error) {
		m, err := store.Begin(conversation.ID, chat.NewID(), "go", "")
		if err != nil {
			t.Fatal(err)
		}
		part := chat.Part{"type": "tool-cloudflare", "toolCallId": "call"}
		m.Parts = []chat.Part{part}
		return tool.Run(context.Background(), chat.ToolCall{ToolCall: llm.ToolCall{ID: "call", Name: "cloudflare"}, ConversationID: conversation.ID, Input: input, Part: part, Message: &m, Store: store, Send: func(chat.Event) error { return nil }})
	}
	if _, err := run(map[string]any{"operation": "test"}); err == nil {
		t.Fatal("ran an operation the tool does not offer")
	}
	if _, err := run(map[string]any{"operation": "d1.databases"}); err != nil || len(paths) != 1 {
		t.Fatalf("read: %v %v", paths, err)
	}
	for _, operation := range []string{"ai.run", "vectorize.query", "d1.query"} {
		if _, err := run(map[string]any{"operation": operation, "argument": "DELETE FROM t"}); !errors.Is(err, chat.ErrAwaitingApproval) || len(paths) != 1 {
			t.Fatalf("%s ran without approval: %v", operation, err)
		}
	}
	approved := chat.ApprovedCall{ConversationID: conversation.ID, ApprovalID: chat.NewID(), Store: store}
	approved.Input, _ = json.Marshal(request{Operation: "d1.query", Argument: "SELECT ?", Params: []any{1}, Target: target(config, "d1.query")})
	config.DatabaseID = "production"
	if _, err := tool.Approved(context.Background(), approved); err == nil || len(paths) != 1 {
		t.Fatalf("ran against another database than the user approved: %v %v", paths, err)
	}
	config.DatabaseID = "db"
	if _, err := tool.Approved(context.Background(), approved); err != nil || paths[1] != "/client/v4/accounts/"+config.AccountID+"/d1/database/db/query" {
		t.Fatalf("approved query: %v %v", paths, err)
	}
	result = `{"success":true,"result":"` + strings.Repeat("x", toolOutput) + `"}`
	output, err := run(map[string]any{"operation": "kv.get", "argument": "big"})
	if out, ok := output.(map[string]any); err != nil || !ok || out["truncated"] != true || len(out["result"].(string)) != toolOutput {
		t.Fatalf("large result: %v", err)
	}
}
