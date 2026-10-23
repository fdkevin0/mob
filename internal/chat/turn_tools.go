package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/fdkevin0/mob/internal/llm"
)

// turnTools owns discovery and declarations for one turn. Search stages tools;
// only nextStep makes them callable and adds their definitions and prompts.
type turnTools struct {
	request                 *llm.Request
	offered                 map[string]Tool
	waiting, loaded, staged []Tool
	entries                 []Entry
}

func newTurnTools(request *llm.Request, tools []Tool, entries []Entry, history []Message) (*turnTools, error) {
	t := &turnTools{request: request, offered: map[string]Tool{}, entries: entries}
	used := usedTools(history)
	names := map[string]bool{}
	for _, tool := range tools {
		if names[tool.Name] {
			return nil, fmt.Errorf("tool offered twice: %s", tool.Name)
		}
		names[tool.Name] = true
		switch {
		case tool.Exposure == Hidden:
			continue
		case tool.Exposure == Deferred && !used[tool.Name]:
			t.waiting = append(t.waiting, tool)
			continue
		case tool.Exposure == Deferred:
			t.loaded = append(t.loaded, tool)
		}
		t.declare(tool)
	}
	if len(t.waiting) > 0 || len(entries) > 0 {
		t.declare(t.searchTool())
		request.System += " " + searchPrompt(t.waiting, entries)
	}
	return t, nil
}

func (t *turnTools) declare(tool Tool) {
	t.offered[tool.Name] = tool
	t.request.Tools = append(t.request.Tools, tool.Tool)
	if tool.Prompt != "" {
		t.request.System += " " + tool.Prompt
	}
}

func (t *turnTools) stage(tools []Tool) {
	for _, tool := range tools {
		t.waiting = slices.DeleteFunc(t.waiting, func(w Tool) bool { return w.Name == tool.Name })
		t.loaded = append(t.loaded, tool)
		t.staged = append(t.staged, tool)
	}
}

// nextStep returns the estimated prompt growth, including tool definitions.
// The turn loop still owns context fitting and the provider's measured usage.
func (t *turnTools) nextStep() int {
	if len(t.staged) == 0 {
		return 0
	}
	before := toolTokens(t.request.Tools)
	growth := 0
	for _, tool := range t.staged {
		t.declare(tool)
		if tool.Prompt != "" {
			growth += tokens(" " + tool.Prompt)
		}
	}
	t.staged = nil
	return growth + toolTokens(t.request.Tools) - before
}

// run runs an offered tool after the BeforeTool hooks allow it, and
// carries out a call a remembered approval covers.
func (t *turnTools) run(ctx context.Context, agent Agent, call ToolCall) (any, error) {
	tool, ok := t.offered[call.Name]
	if !ok {
		return nil, fmt.Errorf("unsupported tool: %s", call.Name)
	}
	for _, before := range agent.Hooks.BeforeTool {
		if err := before(ctx, call); err != nil {
			return nil, err
		}
	}
	if agent.Owner {
		call.tool = &tool
	}
	output, err := tool.Run(ctx, call)
	var g granted
	if errors.As(err, &g) {
		return tool.Approved(ctx, ApprovedCall{ConversationID: call.ConversationID, ApprovalID: NewID(), Input: g.input, Store: call.Store, Owner: agent.Owner})
	}
	return output, err
}

// usedTools are the tools the conversation has called, and those tool_search
// loaded in it, which stay declared in its later turns.
func usedTools(history []Message) map[string]bool {
	used := map[string]bool{}
	for _, m := range history {
		for _, part := range m.Parts {
			kind := fmt.Sprint(part["type"])
			if !strings.HasPrefix(kind, "tool-") {
				continue
			}
			used[kind[5:]] = true
			if kind != "tool-"+searchName || part["state"] != "output-available" {
				continue
			}
			var output searchResult
			raw, _ := json.Marshal(part["output"])
			if json.Unmarshal(raw, &output) == nil {
				for _, name := range output.Loaded {
					used[name] = true
				}
			}
		}
	}
	return used
}
