package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/sandbox"
)

// folder saves outputs in a directory, as the sandbox saves them in a workspace.
type folder struct{ dir string }

func (f folder) Save(conversationID, name, text string) (string, error) {
	return "/workspace/.mob/outputs/" + name, os.WriteFile(filepath.Join(f.dir, name), []byte(text), 0600)
}

func TestSmallOutputIsReadWhole(t *testing.T) {
	output := map[string]any{"rows": []int{1, 2, 3}}
	raw, _ := json.Marshal(output)
	if got := modelOutput(output, ""); got != string(raw) {
		t.Fatalf("small output changed: %s", got)
	}
}

func TestLargeOutputKeepsItsEnds(t *testing.T) {
	text := "开始" + strings.Repeat("日志行\n", 20000) + "结束"
	var view struct {
		Truncated  bool
		Bytes      int
		Head, Tail string
	}
	got := modelOutput(text, "")
	if err := json.Unmarshal([]byte(got), &view); err != nil {
		t.Fatal(err)
	}
	if !view.Truncated || view.Bytes != len(text) || !strings.HasPrefix(view.Head, "开始") || !strings.HasSuffix(view.Tail, "结束") ||
		!utf8.ValidString(view.Head) || !utf8.ValidString(view.Tail) || len(view.Head)+len(view.Tail) > inlineOutput {
		t.Fatalf("bad view of %d bytes: head %d, tail %d", len(text), len(view.Head), len(view.Tail))
	}
}

func TestLargeOutputIsSavedForTheModel(t *testing.T) {
	s, id, m := turnFixture(t)
	dir := t.TempDir()
	stdout := "first line\n" + strings.Repeat("x\n", 50000) + "last line\n"
	tool := echoTool("exec", func(context.Context, ToolCall) (any, error) {
		return sandbox.Result{ExitCode: 3, Stdout: stdout, Stderr: "warning"}, nil
	})
	model := &scripted{call: llm.ToolCall{ID: "call-1", Name: "exec", Arguments: `{}`}}
	if err := Run(context.Background(), s, model, Agent{Tools: []Tool{tool}, Saver: folder{dir}}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	read := model.requests[1].Messages[len(model.requests[1].Messages)-1]
	var view struct{ Head, Tail, Note string }
	if err := json.Unmarshal([]byte(read.Text), &view); err != nil || read.Role != "tool" || len(view.Head)+len(view.Tail) > savedPreview ||
		!strings.Contains(view.Note, "/workspace/.mob/outputs/") || !strings.Contains(view.Head, "first line") || !strings.Contains(view.Tail, "last line") {
		t.Fatalf("model read %d bytes: %.300s", len(read.Text), read.Text)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.txt"))
	if len(files) != 1 {
		t.Fatalf("saved %d files", len(files))
	}
	saved, _ := os.ReadFile(files[0])
	if !strings.Contains(string(saved), "exitCode: 3\n") || !strings.Contains(string(saved), "--- stdout ---\n"+stdout) {
		t.Fatalf("saved output is not readable: %.200s", saved)
	}
	// Later turns read the same view, and the stored part keeps it all.
	history, _ := s.History(id)
	part := history[len(history)-1].Parts[0]
	replayed, _ := Prompt(history, "", 0)
	if part["outputFile"] != "/workspace/.mob/outputs/"+filepath.Base(files[0]) || replayed[len(replayed)-2].Text != read.Text {
		t.Fatalf("replay differs: %v", part["outputFile"])
	}
	if raw, _ := json.Marshal(part["output"]); !strings.Contains(string(raw), "last line") {
		t.Fatal("stored output was cut")
	}
}

func TestLargeOutputWithoutASandbox(t *testing.T) {
	s, id, m := turnFixture(t)
	tool := echoTool("big", func(context.Context, ToolCall) (any, error) { return strings.Repeat("y", 100000) + "END", nil })
	model := &scripted{call: llm.ToolCall{ID: "call-1", Name: "big", Arguments: `{}`}}
	if err := Run(context.Background(), s, model, Agent{Tools: []Tool{tool}}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	read := model.requests[1].Messages[len(model.requests[1].Messages)-1].Text
	var view struct{ Head, Tail, Note string }
	if err := json.Unmarshal([]byte(read), &view); err != nil || len(view.Head)+len(view.Tail) > inlineOutput || !strings.HasSuffix(view.Tail, "END") || strings.Contains(view.Note, "saved at") {
		t.Fatalf("model read %d bytes: %.200s", len(read), read)
	}
}
