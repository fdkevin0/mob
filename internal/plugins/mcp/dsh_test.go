package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
)

func TestDSHBridge(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("DSH bridge integration needs Bun")
	}
	dir, err := filepath.Abs("../../../apps/dsh")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "node_modules/@deepseek-ai/cordis")); err != nil {
		t.Skip("run bun install to test the DSH bridge")
	}
	fixture := t.TempDir()
	called, disposed := filepath.Join(fixture, "called"), filepath.Join(fixture, "disposed")
	configFile := filepath.Join(fixture, "plugins.json")
	config, err := json.Marshal([]any{map[string]any{"module": filepath.Join(dir, "tests/fixtures/noisy.ts"), "config": map[string]string{"called": called, "disposed": disposed}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configFile, config, 0600); err != nil {
		t.Fatal(err)
	}
	server := Server{Command: bun, Args: []string{filepath.Join(dir, "src/main.ts"), configFile}}
	h := &Hub{}
	h.Configure(Servers{"dsh": server})
	running(t, h, "dsh")
	tools := h.Tools()
	if len(tools) != 1 || tools[0].Name != "mcp__dsh__noisy" || !tools[0].OwnerOnly || tools[0].Approved == nil {
		t.Fatalf("DSH tools: %+v", tools)
	}
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	conversation, err := store.Create()
	if err != nil {
		t.Fatal(err)
	}
	message, err := store.Begin(conversation.ID, chat.NewID(), "call the DSH tool", "")
	if err != nil {
		t.Fatal(err)
	}
	message.Parts = []chat.Part{{"type": "tool-mcp__dsh__noisy", "toolCallId": "dsh-call", "state": "input-available"}}
	var approvalID string
	_, err = tools[0].Run(context.Background(), chat.ToolCall{
		ToolCall:       llm.ToolCall{ID: "dsh-call", Name: tools[0].Name},
		ConversationID: conversation.ID, Store: store, Message: &message, Part: message.Parts[0],
		Send: func(event chat.Event) error { approvalID = event.ApprovalID; return nil },
	})
	if !errors.Is(err, chat.ErrAwaitingApproval) {
		t.Fatalf("DSH call did not ask for approval: %v", err)
	}
	if _, err := os.Stat(called); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("DSH tool ran before approval: %v", err)
	}
	decision, err := store.Decide(conversation.ID, approvalID, true, "")
	if err != nil {
		t.Fatal(err)
	}
	result, err := tools[0].Approved(context.Background(), chat.ApprovedCall{ConversationID: conversation.ID, ApprovalID: approvalID, Input: decision.Input, Store: store})
	if err != nil || result != "ok" {
		t.Fatalf("DSH result: %v, %v", result, err)
	}
	if data, err := os.ReadFile(called); err != nil || string(data) != "called" {
		t.Fatalf("approved DSH tool did not run: %s, %v", data, err)
	}
	r := request{Server: "dsh", Tool: "missing", Config: server.fingerprint()}
	if _, err := h.call(context.Background(), r); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("unknown DSH tool: %v", err)
	}
	h.mu.Lock()
	session := h.states["dsh"].session
	h.mu.Unlock()
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(disposed); err != nil || string(data) != "disposed" {
		t.Fatalf("DSH plugin cleanup did not finish on EOF: %s, %v", data, err)
	}
}
