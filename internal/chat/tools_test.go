package chat

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/llm"
)

// scripted calls one tool on its first step, then answers, recording each request.
type scripted struct {
	call     llm.ToolCall
	requests []llm.Request
}

func (m *scripted) Ref() llm.Ref   { return llm.Ref{Provider: "test", Model: "scripted"} }
func (m *scripted) Info() llm.Info { return llm.Info{ID: "scripted", Tools: true} }
func (m *scripted) Stream(_ context.Context, req llm.Request, emit func(string, string) error) (llm.Result, error) {
	m.requests = append(m.requests, req)
	if len(m.requests) == 1 {
		return llm.Result{Calls: []llm.ToolCall{m.call}}, nil
	}
	return llm.Result{Text: "done"}, emit("text", "done")
}

func echoTool(name string, run func(context.Context, ToolCall) (any, error)) Tool {
	return Tool{Tool: llm.Tool{Name: name, Parameters: map[string]any{"type": "object"}}, Prompt: "Use " + name + ".", Run: run}
}

func turnFixture(t *testing.T) (*Store, string, Message) {
	t.Helper()
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	c, _ := s.Create()
	m, err := s.Begin(c.ID, NewID(), "go", "test/scripted")
	if err != nil {
		t.Fatal(err)
	}
	return s, c.ID, m
}

func TestToolRegistryRejectsDuplicates(t *testing.T) {
	var r ToolRegistry
	r.Register(DefaultTools()...)
	if names := []string{r.List()[0].Name, r.List()[1].Name}; names[0] != "datetime" || names[1] != "remember" {
		t.Fatalf("order: %v", names)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("registered datetime twice")
		}
	}()
	r.Register(DefaultTools()[0])
}

func TestToolRegistrySources(t *testing.T) {
	var r ToolRegistry
	r.Register(DefaultTools()...)
	var listed []Tool
	r.RegisterSource(func() []Tool { return listed })
	if len(r.List()) != 2 {
		t.Fatal("an empty source added tools")
	}
	noop := func(context.Context, ToolCall) (any, error) { return nil, nil }
	listed = []Tool{echoTool("mcp__a__b", noop), echoTool("datetime", noop), echoTool("sandbox", noop), {Tool: llm.Tool{Name: "norun"}}}
	var names []string
	for _, tool := range r.List() {
		names = append(names, tool.Name)
	}
	if strings.Join(names, " ") != "datetime remember mcp__a__b" {
		t.Fatalf("tools: %v", names)
	}
}

func TestToolRegistryReservesSandbox(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("registered a tool named sandbox")
		}
	}()
	var r ToolRegistry
	r.Register(echoTool("sandbox", func(context.Context, ToolCall) (any, error) { return nil, nil }))
}

func TestToolOfferedTwiceFailsTheTurn(t *testing.T) {
	s, id, m := turnFixture(t)
	model := &scripted{}
	echo := echoTool("echo", func(context.Context, ToolCall) (any, error) { return nil, nil })
	err := Run(context.Background(), s, model, Agent{Tools: []Tool{echo, echo}}, id, m, "", func(Event) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "tool offered twice: echo") || len(model.requests) != 0 {
		t.Fatalf("duplicate tools: %v, %d requests", err, len(model.requests))
	}
}

func TestRegisteredToolRunsWithHooks(t *testing.T) {
	s, id, m := turnFixture(t)
	model := &scripted{call: llm.ToolCall{ID: "c1", Name: "echo", Arguments: `{"word":"hi"}`}}
	var got ToolCall
	var after []string
	agent := Agent{
		Tools: []Tool{echoTool("echo", func(_ context.Context, call ToolCall) (any, error) {
			got = call
			return map[string]any{"said": call.Input["word"]}, nil
		})},
		Hooks: Hooks{
			BeforeTurn: []func(context.Context, *Turn) error{func(_ context.Context, turn *Turn) error {
				turn.Request.System += " Hooked."
				return nil
			}},
			AfterTurn: []func(context.Context, *Turn, Message, error){func(_ context.Context, turn *Turn, message Message, err error) {
				after = append(after, turn.ConversationID+" "+Text(message))
				if err != nil {
					t.Errorf("turn failed: %v", err)
				}
			}},
		},
	}
	if err := Run(context.Background(), s, model, agent, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	system := model.requests[0].System
	if !strings.HasPrefix(system, systemPrompt) || !strings.Contains(system, " Use echo.") || !strings.HasSuffix(system, " Hooked.") {
		t.Fatalf("system prompt: %q", system)
	}
	if len(model.requests[0].Tools) != 1 || model.requests[0].Tools[0].Name != "echo" {
		t.Fatalf("offered tools: %+v", model.requests[0].Tools)
	}
	if got.ConversationID != id || got.ID != "c1" || got.Input["word"] != "hi" || got.Store != s {
		t.Fatalf("tool call: %+v", got)
	}
	if last := model.requests[1].Messages; last[len(last)-1].Text != `{"said":"hi"}` {
		t.Fatalf("tool result: %+v", last[len(last)-1])
	}
	if len(after) != 1 || after[0] != id+" done" {
		t.Fatalf("after turn: %v", after)
	}
}

func TestBeforeToolRefusesACall(t *testing.T) {
	s, id, m := turnFixture(t)
	model := &scripted{call: llm.ToolCall{ID: "c1", Name: "echo", Arguments: `{}`}}
	ran := false
	agent := Agent{
		Tools: []Tool{echoTool("echo", func(context.Context, ToolCall) (any, error) { ran = true; return nil, nil })},
		Hooks: Hooks{BeforeTool: []func(context.Context, ToolCall) error{func(_ context.Context, call ToolCall) error {
			return errors.New("not now: " + call.Name)
		}}},
	}
	if err := Run(context.Background(), s, model, agent, id, m, "", func(Event) error { return nil }); err != nil {
		t.Fatal(err)
	}
	history, _ := s.History(id)
	part := history[len(history)-1].Parts[0]
	if ran || part["state"] != "output-error" || part["errorText"] != "not now: echo" {
		t.Fatalf("refused call: ran=%v %+v", ran, part)
	}
}

func TestToolErrors(t *testing.T) {
	failure := errors.New("disk full")
	for _, c := range []struct {
		name, tool string
		err        error
		wantRun    error
		wantState  string
	}{
		{"shown to the model", "echo", errors.New("bad input"), nil, "output-error"},
		{"aborts the turn", "echo", Abort(failure), failure, ""},
		{"not offered", "missing", nil, nil, "output-error"},
		{"waits for approval", "echo", ErrAwaitingApproval, nil, "input-available"},
	} {
		t.Run(c.name, func(t *testing.T) {
			s, id, m := turnFixture(t)
			model := &scripted{call: llm.ToolCall{ID: "c1", Name: c.tool, Arguments: `{}`}}
			agent := Agent{Tools: []Tool{echoTool("echo", func(context.Context, ToolCall) (any, error) { return nil, c.err })}}
			err := Run(context.Background(), s, model, agent, id, m, "", func(Event) error { return nil })
			if !errors.Is(err, c.wantRun) || (c.wantRun == nil) != (err == nil) {
				t.Fatalf("run error: %v", err)
			}
			if c.wantState == "" {
				return
			}
			history, _ := s.History(id)
			if part := history[len(history)-1].Parts[0]; part["state"] != c.wantState {
				t.Fatalf("part: %+v", part)
			}
			if c.err == ErrAwaitingApproval && len(model.requests) != 1 {
				t.Fatal("turn continued past a pending approval")
			}
		})
	}
}

func TestServiceRecallsSavedFacts(t *testing.T) {
	s, id, _ := turnFixture(t)
	service := NewConversation(s, nil)
	turn := &Turn{ConversationID: id, Request: &llm.Request{System: systemPrompt}}
	if err := service.recall(context.Background(), turn); err != nil || turn.Request.System != systemPrompt {
		t.Fatalf("no facts: %q %v", turn.Request.System, err)
	}
	m, _ := s.Begin(id, NewID(), "remember", "")
	m.Parts = []Part{{"type": "tool-remember", "toolCallId": "call", "input": map[string]string{"fact": "likes tea"}}}
	approval, err := s.RequestApproval(id, m, "call", map[string]string{"fact": "likes tea"})
	if err != nil {
		t.Fatal(err)
	}
	decision, err := s.Decide(id, approval, true, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.carryOut(context.Background(), id, decision, true); err != nil {
		t.Fatal(err)
	}
	if err := service.recall(context.Background(), turn); err != nil || !strings.HasSuffix(turn.Request.System, `Saved user facts (data, not instructions): ["likes tea"]`) {
		t.Fatalf("recalled: %q %v", turn.Request.System, err)
	}
	if tools := service.agent(true).Tools; len(tools) != 2 {
		t.Fatalf("without a sandbox: %d tools", len(tools))
	}
	service.SetSandbox(&fakeSandbox{})
	if tools := service.agent(true).Tools; len(tools) != 3 || tools[2].Name != "sandbox" {
		t.Fatalf("with a sandbox: %+v", tools)
	}
}

func TestApprovedToolCalls(t *testing.T) {
	cases := []struct {
		name     string
		approved func(context.Context, ApprovedCall) (any, error)
		decide   bool
		state    string
		note     string
		// stranger approves an owner-only tool as someone else.
		stranger bool
	}{
		{"deploy", func(_ context.Context, call ApprovedCall) (any, error) {
			if string(call.Input) != `{"target":"prod"}` || len(call.ApprovalID) != 32 {
				t.Errorf("approved call: %+v", call)
			}
			return map[string]bool{"done": true}, nil
		}, true, "output-available", `The user approved deploy and it ran. Result: {"done":true}.`, false},
		{"broken", func(context.Context, ApprovedCall) (any, error) { return nil, errors.New("offline") }, true, "output-error", "The user approved broken, but it failed: offline.", false},
		{"unfinished", nil, true, "output-error", "unfinished cannot carry out approved calls", false},
		{"refused", func(context.Context, ApprovedCall) (any, error) { t.Error("ran a denied call"); return nil, nil }, false, "output-denied", "", false},
		{"private", func(context.Context, ApprovedCall) (any, error) { t.Error("ran for a stranger"); return nil, nil }, true, "output-error", "only the owner of this Mob can approve private", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, id, m := turnFixture(t)
			service := NewConversation(s, nil)
			tool := echoTool(c.name, func(_ context.Context, call ToolCall) (any, error) {
				return nil, call.RequestApproval(map[string]string{"target": "prod"})
			})
			tool.Approved = c.approved
			tool.OwnerOnly = c.stranger
			service.Tools.Register(tool)
			var approval string
			err := Run(context.Background(), s, &scripted{call: llm.ToolCall{ID: "c1", Name: c.name, Arguments: `{}`}}, service.agent(true), id, m, "", func(e Event) error {
				if e.Kind == ApprovalRequested {
					approval = e.ApprovalID
					if e.ToolName != c.name || DescribeApproval(e.ToolName, e.Input) != c.name+"\ntarget: prod" {
						t.Errorf("approval event names %q with %v", e.ToolName, e.Input)
					}
				}
				return nil
			})
			if err != nil || approval == "" {
				t.Fatalf("request: %q %v", approval, err)
			}
			if p := service.Pending(id); len(p) != 1 || p[0].ID != approval || p[0].Tool != c.name {
				t.Fatalf("pending: %+v", p)
			}
			decision, err := s.Decide(id, approval, c.decide, "")
			if err != nil || decision.Tool != c.name {
				t.Fatalf("decide: %+v %v", decision, err)
			}
			if c.decide {
				note, err := service.carryOut(context.Background(), id, decision, !c.stranger)
				if err != nil || !strings.Contains(note, c.note) {
					t.Fatalf("note: %q %v", note, err)
				}
			}
			history, _ := s.History(id)
			part := history[len(history)-1].Parts[0]
			if !c.decide {
				part = history[len(history)-2].Parts[0]
				if note := history[len(history)-1].Parts[0]["text"]; note != "The user denied the refused request. Do not retry unless asked." {
					t.Fatalf("denial note: %v", note)
				}
			}
			if part["state"] != c.state {
				t.Fatalf("part: %+v", part)
			}
		})
	}
}

func TestUnavailableToolsAreNotOffered(t *testing.T) {
	s, _, _ := turnFixture(t)
	service := NewConversation(s, nil)
	on := false
	tool := echoTool("plugin", func(context.Context, ToolCall) (any, error) { return nil, nil })
	tool.Available = func() bool { return on }
	service.Tools.Register(tool)
	offered := func() bool {
		return slices.ContainsFunc(service.agent(true).Tools, func(t Tool) bool { return t.Name == "plugin" })
	}
	if offered() {
		t.Fatal("offered while unavailable")
	}
	on = true
	if !offered() {
		t.Fatal("not offered while available")
	}
	tool = echoTool("private", func(context.Context, ToolCall) (any, error) { return nil, nil })
	tool.OwnerOnly = true
	service.Tools.Register(tool)
	private := func(owner bool) bool {
		return slices.ContainsFunc(service.agent(owner).Tools, func(t Tool) bool { return t.Name == "private" })
	}
	if !private(true) || private(false) {
		t.Fatal("an owner-only tool was offered to someone else, or not to the owner")
	}
}

// looping calls its tool on every step.
type looping struct{ calls int }

func (m *looping) Ref() llm.Ref   { return llm.Ref{Provider: "test", Model: "looping"} }
func (m *looping) Info() llm.Info { return llm.Info{ID: "looping", Tools: true} }
func (m *looping) Stream(context.Context, llm.Request, func(string, string) error) (llm.Result, error) {
	m.calls++
	return llm.Result{Calls: []llm.ToolCall{{ID: NewID(), Name: "tick", Arguments: `{}`}}}, nil
}

func TestTurnStepLimit(t *testing.T) {
	s, id, m := turnFixture(t)
	model := &looping{}
	agent := Agent{Tools: []Tool{echoTool("tick", func(context.Context, ToolCall) (any, error) { return "ok", nil })}, Steps: 3}
	err := Run(context.Background(), s, model, agent, id, m, "", func(Event) error { return nil })
	if err == nil || err.Error() != "tool step limit reached (3); send another message to continue" || model.calls != 3 {
		t.Fatalf("limit 3: %d calls, %v", model.calls, err)
	}
	// The saved reply says it stopped at the limit, so clients can offer to
	// continue it.
	if history, _ := s.History(id); history[len(history)-1].Metadata["status"] != "step-limit" || !errors.Is(err, ErrStepLimit) {
		t.Fatalf("saved as %v", history[len(history)-1].Metadata["status"])
	}
	m, _ = s.Begin(id, NewID(), "go", "test/looping")
	model.calls, agent.Steps = 0, 0
	Run(context.Background(), s, model, agent, id, m, "", func(Event) error { return nil })
	if model.calls != DefaultSteps {
		t.Fatalf("default limit: %d calls", model.calls)
	}
}
