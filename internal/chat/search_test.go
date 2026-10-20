package chat

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/llm"
)

// stepping returns its results in turn, one per model call, recording each
// request; after the last it answers.
type stepping struct {
	steps    [][]llm.ToolCall
	requests []llm.Request
}

func (m *stepping) Ref() llm.Ref   { return llm.Ref{Provider: "test", Model: "stepping"} }
func (m *stepping) Info() llm.Info { return llm.Info{ID: "stepping", Tools: true} }
func (m *stepping) Stream(_ context.Context, req llm.Request, emit func(string, string) error) (llm.Result, error) {
	m.requests = append(m.requests, req)
	if n := len(m.requests); n <= len(m.steps) {
		return llm.Result{Calls: m.steps[n-1]}, nil
	}
	return llm.Result{Text: "done"}, emit("text", "done")
}

func declared(req llm.Request) []string {
	var names []string
	for _, t := range req.Tools {
		names = append(names, t.Name)
	}
	return names
}

func deferredTool(name, description string, run func(context.Context, ToolCall) (any, error)) Tool {
	t := echoTool(name, run)
	t.Description, t.Exposure, t.Namespace, t.Prompt = description, Deferred, "MCP server github", ""
	return t
}

func TestToolSearchLoadsDeferredTools(t *testing.T) {
	s, id, m := turnFixture(t)
	ran := false
	issue := deferredTool("mcp__github__create_issue", "Create a new issue in a GitHub repository.", func(context.Context, ToolCall) (any, error) {
		ran = true
		return "created", nil
	})
	issue.Parameters = map[string]any{"type": "object", "properties": map[string]any{"title": map[string]any{"type": "string", "description": "Issue title"}}}
	pulls := deferredTool("mcp__github__list_pulls", "List pull requests.", nil)
	agent := Agent{Tools: []Tool{DefaultTools()[0], issue, pulls}}
	model := &stepping{steps: [][]llm.ToolCall{
		{{ID: "s1", Name: searchName, Arguments: `{"query":"open a GitHub issue"}`}},
		{{ID: "c1", Name: "mcp__github__create_issue", Arguments: `{"title":"x"}`}},
	}}
	if err := Run(context.Background(), s, model, agent, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if got := declared(model.requests[0]); !slices.Equal(got, []string{"datetime", searchName}) {
		t.Fatalf("first step declared %v", got)
	}
	if system := model.requests[0].System; !strings.Contains(system, "MCP server github (2)") || strings.Contains(system, "Use mcp__") {
		t.Fatalf("system prompt: %q", system)
	}
	var result searchResult
	if err := json.Unmarshal([]byte(model.requests[1].Messages[len(model.requests[1].Messages)-1].Text), &result); err != nil {
		t.Fatal(err)
	}
	// Both tools are of the GitHub server; the issue tool matches better.
	if !slices.Equal(result.Loaded, []string{"mcp__github__create_issue", "mcp__github__list_pulls"}) || result.Results[0].Namespace != "MCP server github" {
		t.Fatalf("search result: %+v", result)
	}
	if got := declared(model.requests[1]); !slices.Equal(got, []string{"datetime", searchName, "mcp__github__create_issue", "mcp__github__list_pulls"}) {
		t.Fatalf("second step declared %v", got)
	}
	if !ran {
		t.Fatal("the loaded tool did not run")
	}

	// A later turn keeps the tools the conversation loaded; with none left
	// to load, it offers no tool_search.
	next, err := s.Begin(id, NewID(), "again", "test/stepping")
	if err != nil {
		t.Fatal(err)
	}
	model = &stepping{}
	if err := Run(context.Background(), s, model, agent, id, next, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if got := declared(model.requests[0]); !slices.Equal(got, []string{"datetime", "mcp__github__create_issue", "mcp__github__list_pulls"}) {
		t.Fatalf("next turn declared %v", got)
	}
}

func TestHiddenToolsAreNotFound(t *testing.T) {
	s, id, m := turnFixture(t)
	secret := deferredTool("mcp__github__delete_repo", "Delete a GitHub repository.", nil)
	secret.Exposure = Hidden
	agent := Agent{Tools: []Tool{deferredTool("mcp__github__list_pulls", "List pull requests.", nil), secret}}
	model := &stepping{steps: [][]llm.ToolCall{{{ID: "s1", Name: searchName, Arguments: `{"query":"delete repository"}`}}}}
	if err := Run(context.Background(), s, model, agent, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(model.requests[0].System, "MCP server github (1)") {
		t.Fatalf("system prompt: %q", model.requests[0].System)
	}
	if out := model.requests[1].Messages[len(model.requests[1].Messages)-1].Text; strings.Contains(out, "delete_repo") || !strings.Contains(out, "Nothing matched") {
		t.Fatalf("search found: %s", out)
	}
}

func TestLoadedToolsWaitForTheNextStep(t *testing.T) {
	s, id, m := turnFixture(t)
	ran := 0
	issue := deferredTool("mcp__github__create_issue", "Create a new issue in a GitHub repository.", func(context.Context, ToolCall) (any, error) {
		ran++
		return "created", nil
	})
	issue.Prompt = "Name the repository when creating issues."
	agent := Agent{Tools: []Tool{issue}}
	model := &stepping{steps: [][]llm.ToolCall{
		// A call beside the search that loads its tool is not yet declared.
		{{ID: "s1", Name: searchName, Arguments: `{"query":"github issue"}`}, {ID: "c1", Name: "mcp__github__create_issue", Arguments: `{}`}},
		{{ID: "c2", Name: "mcp__github__create_issue", Arguments: `{}`}},
	}}
	if err := Run(context.Background(), s, model, agent, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	history, _ := s.History(id)
	parts := history[len(history)-1].Parts
	if parts[1]["state"] != "output-error" || parts[2]["state"] != "output-available" || ran != 1 {
		t.Fatalf("calls: ran %d, %+v", ran, parts)
	}
	if strings.Contains(model.requests[0].System, issue.Prompt) || !strings.Contains(model.requests[1].System, issue.Prompt) {
		t.Fatalf("the loaded tool's prompt: %q, then %q", model.requests[0].System, model.requests[1].System)
	}
}

func TestDeferredToolNotLoadedIsRefused(t *testing.T) {
	s, id, m := turnFixture(t)
	ran := false
	agent := Agent{Tools: []Tool{deferredTool("mcp__github__list_pulls", "List pull requests.", func(context.Context, ToolCall) (any, error) { ran = true; return nil, nil })}}
	model := &scripted{call: llm.ToolCall{ID: "c1", Name: "mcp__github__list_pulls", Arguments: `{}`}}
	if err := Run(context.Background(), s, model, agent, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	history, _ := s.History(id)
	if part := history[len(history)-1].Parts[0]; ran || part["state"] != "output-error" {
		t.Fatalf("an unloaded tool ran: %v %+v", ran, part)
	}
}

func TestRepeatedSearchDeclaresToolsAndPromptsOnce(t *testing.T) {
	s, id, m := turnFixture(t)
	issue := deferredTool("create_issue", "Create an issue.", func(context.Context, ToolCall) (any, error) { return "created", nil })
	issue.Prompt = "Name the repository when creating issues."
	model := &stepping{steps: [][]llm.ToolCall{
		{{ID: "s1", Name: searchName, Arguments: `{"query":"create_issue"}`}, {ID: "s2", Name: searchName, Arguments: `{"query":"create_issue"}`}},
		{{ID: "c1", Name: issue.Name, Arguments: `{}`}, {ID: "s3", Name: searchName, Arguments: `{"query":"create_issue"}`}},
	}}
	if err := Run(context.Background(), s, model, Agent{Tools: []Tool{issue}}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	for step, req := range model.requests {
		want := []string{searchName}
		count := 0
		if step > 0 {
			want, count = append(want, issue.Name), 1
		}
		if !slices.Equal(declared(req), want) || strings.Count(req.System, issue.Prompt) != count {
			t.Fatalf("step %d: declarations %v, prompt %q", step, declared(req), req.System)
		}
	}
}

func TestLoadedToolsCountTowardTheContextLimit(t *testing.T) {
	for _, large := range []string{"definition", "prompt"} {
		t.Run(large, func(t *testing.T) {
			s, id, m := turnFixture(t)
			issue := deferredTool("create_issue", "Create an issue.", nil)
			if large == "definition" {
				issue.Parameters = map[string]any{"type": "object", "description": strings.Repeat("x", 9000)}
			} else {
				issue.Prompt = strings.Repeat("x", 9000)
			}
			requests := 0
			model := recordingModel{info: llm.Info{ID: "narrow", Context: 2000, Output: 100, Tools: true}, stream: func(_ context.Context, _ llm.Request, _ func(string, string) error) (llm.Result, error) {
				requests++
				return llm.Result{Calls: []llm.ToolCall{{ID: "s1", Name: searchName, Arguments: `{"query":"create_issue"}`}}}, nil
			}}
			err := Run(context.Background(), s, model, Agent{Tools: []Tool{issue}}, id, m, "", func(Event) error { return nil })
			if err == nil || !strings.Contains(err.Error(), "has filled narrow's context") || requests != 1 {
				t.Fatalf("oversized tools reached the next model request: %d requests, %v", requests, err)
			}
		})
	}
}

func TestToolSearchFindsEntries(t *testing.T) {
	s, id, m := turnFixture(t)
	agent := Agent{Tools: DefaultTools(), Entries: []Entry{{Kind: "skill", Name: "pdf", Description: "Extract text and tables from PDF files.", Use: `Call skill with name "pdf".`}}}
	model := &stepping{steps: [][]llm.ToolCall{{{ID: "s1", Name: searchName, Arguments: `{"query":"read a pdf"}`}}}}
	if err := Run(context.Background(), s, model, agent, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(model.requests[0].System, "skills (1)") {
		t.Fatalf("system prompt: %q", model.requests[0].System)
	}
	var result searchResult
	json.Unmarshal([]byte(model.requests[1].Messages[len(model.requests[1].Messages)-1].Text), &result)
	if len(result.Results) != 1 || result.Results[0].Kind != "skill" || result.Results[0].Use != `Call skill with name "pdf".` || len(result.Loaded) != 0 {
		t.Fatalf("search result: %+v", result)
	}
}

func TestNoToolSearchWithoutDeferredTools(t *testing.T) {
	s, id, m := turnFixture(t)
	model := &stepping{}
	if err := Run(context.Background(), s, model, Agent{Tools: DefaultTools()}, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if got := declared(model.requests[0]); !slices.Equal(got, []string{"datetime", "remember"}) {
		t.Fatalf("declared %v", got)
	}
}

func TestRank(t *testing.T) {
	docs := []document{
		toolDocument(Tool{Tool: llm.Tool{Name: "mcp__github__create_issue", Description: "Create a new issue."}}),
		toolDocument(Tool{Tool: llm.Tool{Name: "sendEmail", Description: "Send an email message."}}),
		toolDocument(Tool{Tool: llm.Tool{Name: "weather", Description: "查询天气预报"}}),
		toolDocument(Tool{Tool: llm.Tool{Name: "issues", Description: "Count issues."}}),
	}
	for query, want := range map[string]int{
		"create issues":     0,
		"send email":        1,
		"SendEmail":         1,
		"github":            0,
		"email":             1,
		"天气":                2,
		"issues":            3, // the exact name comes first
		"the a of":          -1,
		"nothing like this": -1,
	} {
		got := rank(docs, query, 3)
		if want < 0 && len(got) != 0 || want >= 0 && (len(got) == 0 || got[0] != want) {
			t.Errorf("%q ranked %v, want %d first", query, got, want)
		}
	}
	if got := rank(docs, "issue", 1); len(got) != 1 {
		t.Fatalf("limit: %v", got)
	}
}

func TestParseExposure(t *testing.T) {
	for _, e := range []Exposure{Direct, Deferred, Hidden} {
		if got, err := ParseExposure(e.String()); err != nil || got != e {
			t.Fatalf("%v: %v %v", e, got, err)
		}
	}
	if _, err := ParseExposure("always"); err == nil {
		t.Fatal("parsed always")
	}
}

func TestToolRegistryReservesToolSearch(t *testing.T) {
	var r ToolRegistry
	r.RegisterSource(func() []Tool {
		return []Tool{echoTool(searchName, func(context.Context, ToolCall) (any, error) { return nil, nil })}
	})
	if len(r.List()) != 0 {
		t.Fatal("a source added tool_search")
	}
	r.RegisterEntries(func() []Entry { return []Entry{{Kind: "skill", Name: "a"}} })
	r.RegisterEntries(func() []Entry { return []Entry{{Kind: "skill", Name: "b"}} })
	if entries := r.Entries(); len(entries) != 2 || entries[1].Name != "b" {
		t.Fatalf("entries: %+v", entries)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("registered a tool named tool_search")
		}
	}()
	r.Register(echoTool(searchName, func(context.Context, ToolCall) (any, error) { return nil, nil }))
}
