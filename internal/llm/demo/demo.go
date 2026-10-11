// Package demo is an offline model: it echoes the prompt, turns
// "/remember fact" into a remember tool call, exercising approvals, and
// "/sandbox command" into a sandbox call when that tool is offered.
package demo

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/llm"
)

// ID is the reserved provider of the offline model.
const ID = "demo"

var Ref = llm.Ref{Provider: ID, Model: "echo"}

var Info = llm.Info{ID: "echo", Name: "Demo (offline)", Tools: true, Known: true}

type Model struct{}

func (Model) Ref() llm.Ref   { return Ref }
func (Model) Info() llm.Info { return Info }

func (Model) Stream(ctx context.Context, req llm.Request, emit func(string, string) error) (llm.Result, error) {
	var result llm.Result
	if len(req.Messages) == 0 {
		return result, nil
	}
	last := req.Messages[len(req.Messages)-1]
	if last.Role == "user" && strings.HasPrefix(last.Text, "/remember ") {
		args, _ := json.Marshal(map[string]string{"fact": strings.TrimPrefix(last.Text, "/remember ")})
		result.Calls = []llm.ToolCall{{ID: "demo_" + time.Now().Format("150405.000000000"), Name: "remember", Arguments: string(args)}}
		return result, nil
	}
	if last.Role == "user" && strings.HasPrefix(last.Text, "/sandbox ") && offered(req, "sandbox") {
		args, _ := json.Marshal(map[string]string{"command": strings.TrimPrefix(last.Text, "/sandbox ")})
		result.Calls = []llm.ToolCall{{ID: "demo_" + time.Now().Format("150405.000000000"), Name: "sandbox", Arguments: string(args)}}
		return result, nil
	}
	if last.Role == "tool" {
		text := "Tool result: " + last.Text
		result.Text = text
		return result, emit("text", text)
	}
	text := "[Demo mode — no model request]\n\nReceived: " + last.Text + "\n\nUse /remember a fact to exercise persistent approval."
	for _, r := range text {
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case <-time.After(4 * time.Millisecond):
		}
		result.Text += string(r)
		if err := emit("text", string(r)); err != nil {
			return result, err
		}
	}
	return result, nil
}

func offered(req llm.Request, name string) bool {
	for _, t := range req.Tools {
		if t.Name == name {
			return true
		}
	}
	return false
}
