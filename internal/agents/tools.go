package agents

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
)

// managerPrompt makes Mob's own model the owner's project manager.
const managerPrompt = "You are also the owner's project manager. Hand coding work in a project (changes, fixes, investigations, reviews) to a coding agent with task_start instead of doing it yourself; each task works on its own branch. Use tasks to report progress and what waits for the owner's decision, task_message to pass on instructions, and task_stop to stop a task. Before telling the owner a task is done, check its work: task_diff shows what it changed, and task_check runs the tests or build in its worktree."

// replyLimit bounds the latest reply tasks shows for each task, in runes.
const replyLimit = 600

func object(properties map[string]any, required ...string) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func text(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

// Tools let Mob's model start, follow, instruct and stop tasks.
func (s *Service) Tools() []chat.Tool {
	agents := make([]string, len(Presets))
	for i, p := range Presets {
		agents[i] = p.Name
	}
	return append([]chat.Tool{{
		Tool: llm.Tool{Name: "task_start", Description: "Ask the owner to approve handing coding work to a coding agent. The agent works in a new git worktree and branch of the project; the turn stops until the owner approves.", Parameters: object(map[string]any{
			"project": text("A project's name, or the absolute path of a git repository on this computer"),
			"prompt":  text("What the agent should do, with everything it needs to know"),
			"title":   text("A short title for the task"),
			"agent":   map[string]any{"type": "string", "enum": agents, "description": "The coding agent; default " + agents[0]},
		}, "project", "prompt")},
		Prompt:    managerPrompt,
		OwnerOnly: true,
		Available: s.offered,
		Run:       s.askStart,
		Approved:  s.start,
		Scope: func(input json.RawMessage) string {
			var in struct{ Project, Agent string }
			_ = json.Unmarshal(input, &in)
			return in.Project + " " + in.Agent
		},
	}, {
		Tool:      llm.Tool{Name: "tasks", Description: "List coding agent tasks with their status (running, waiting for the owner's approval, review, stopped, failed), branch, plan, latest reply and the tokens, cache and cost their agent used by model, and the saved projects.", Parameters: object(map[string]any{"project": text("Only this project's tasks")})},
		OwnerOnly: true,
		Available: s.busy,
		Run: func(_ context.Context, call chat.ToolCall) (any, error) {
			project, _ := call.Input["project"].(string)
			return s.overview(project)
		},
	}, {
		Tool:      llm.Tool{Name: "task_message", Description: "Pass the owner's instructions on to a task's coding agent; it works on them on its own.", Parameters: object(map[string]any{"task": text("The task's ID"), "text": text("The instructions")}, "task", "text")},
		OwnerOnly: true,
		Available: s.busy,
		Run: func(_ context.Context, call chat.ToolCall) (any, error) {
			id, _ := call.Input["task"].(string)
			message, _ := call.Input["text"].(string)
			if strings.TrimSpace(message) == "" {
				return nil, errors.New("text is empty")
			}
			if err := s.Message(id, message); err != nil {
				return nil, err
			}
			return map[string]any{"sent": true}, nil
		},
	}, {
		Tool:      llm.Tool{Name: "task_stop", Description: "Stop a task's coding agent. Its branch and worktree stay.", Parameters: object(map[string]any{"task": text("The task's ID")}, "task")},
		OwnerOnly: true,
		Available: s.busy,
		Run: func(_ context.Context, call chat.ToolCall) (any, error) {
			id, _ := call.Input["task"].(string)
			if err := s.StopTask(id); err != nil {
				return nil, err
			}
			return map[string]any{"stopped": true}, nil
		},
	}}, s.reviewTools()...)
}

// offered reports whether task_start is offered: once there are projects or
// tasks, or while a coding agent can be started.
func (s *Service) offered() bool { return s.busy() || s.installed() }

// installed reports whether some agent's command is installed, looking again
// at most once a minute.
func (s *Service) installed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Since(s.checked) > time.Minute {
		s.checked, s.found = time.Now(), false
		for _, p := range Presets {
			if _, ok := command(p); ok {
				s.found = true
				break
			}
		}
	}
	return s.found
}

// busy reports whether there are projects or tasks to follow; until then
// only task_start is offered.
func (s *Service) busy() bool {
	projects, err := s.Projects()
	if err == nil && len(projects) > 0 {
		return true
	}
	tasks, err := s.Store.Tasks("")
	return err == nil && len(tasks) > 0
}

// askStart checks a task_start call and asks the owner to approve it.
func (s *Service) askStart(ctx context.Context, call chat.ToolCall) (any, error) {
	var in struct{ Project, Prompt, Title, Agent string }
	raw, _ := json.Marshal(call.Input)
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Prompt) == "" {
		return nil, errors.New("prompt is empty")
	}
	a, err := preset(in.Agent)
	if err != nil {
		return nil, err
	}
	p, ok, err := s.project(in.Project)
	if err != nil {
		return nil, err
	}
	if !ok {
		list, _ := s.Projects()
		names := make([]string, len(list))
		for i, p := range list {
			names[i] = p.Name
		}
		if !filepath.IsAbs(in.Project) {
			return nil, fmt.Errorf("no project is called %q; saved projects: %s. Give the absolute path of a git repository instead", in.Project, strings.Join(names, ", "))
		}
		if _, err := git(ctx, in.Project, "rev-parse", "--show-toplevel"); err != nil {
			return nil, fmt.Errorf("%s is not a git repository: %w", in.Project, err)
		}
		p = Project{Path: in.Project}
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = firstLine(in.Prompt, 60)
	}
	return nil, call.RequestApproval(map[string]string{"project": p.Path, "agent": a.Name, "title": title, "prompt": in.Prompt})
}

// start begins an approved task.
func (s *Service) start(ctx context.Context, call chat.ApprovedCall) (any, error) {
	var in struct{ Project, Agent, Title, Prompt string }
	if err := json.Unmarshal(call.Input, &in); err != nil {
		return nil, err
	}
	t, err := s.StartTask(ctx, call.ConversationID, in.Project, in.Agent, in.Title, in.Prompt)
	if err != nil {
		return nil, err
	}
	return map[string]any{"task": t.ID, "conversation": t.ConversationID, "branch": t.Branch, "worktree": t.Worktree, "status": "started; the agent works on its own and its conversation shows its progress"}, nil
}

// overview is what tasks returns.
func (s *Service) overview(project string) (any, error) {
	projects, err := s.Projects()
	if err != nil {
		return nil, err
	}
	list, err := s.Store.Tasks(project)
	if err != nil {
		return nil, err
	}
	used, err := s.used(list)
	if err != nil {
		return nil, err
	}
	tasks := make([]map[string]any, len(list))
	for i, t := range list {
		reply, _ := s.Store.LastReply(t.ConversationID)
		if r := []rune(reply); len(r) > replyLimit {
			reply = "…" + string(r[len(r)-replyLimit:])
		}
		entry := map[string]any{"id": t.ID, "project": t.Project, "agent": t.Agent, "title": t.Title, "status": t.Status, "branch": t.Branch, "worktree": t.Worktree, "conversation": t.ConversationID}
		if reply != "" {
			entry["latestReply"] = reply
		}
		if len(t.Plan) > 0 {
			entry["plan"] = t.Plan
		}
		if u, ok := used[t.ConversationID]; ok {
			entry["usage"] = u
		}
		tasks[i] = entry
	}
	return map[string]any{"projects": projects, "tasks": tasks}, nil
}

// Commands list and save projects and list tasks.
func (s *Service) Commands() []chat.Command {
	return []chat.Command{{
		CommandSpec: chat.CommandSpec{Name: "projects", Usage: "/projects [add PATH [NAME] | remove NAME]", Summary: "Show the projects coding agents work on, or add or remove one", Clients: chat.Interactive},
		OwnerOnly:   true,
		Run: func(ctx context.Context, call chat.CommandCall) (chat.CommandResult, error) {
			switch {
			case len(call.Fields) == 0:
				return s.describeProjects()
			case call.Fields[0] == "add" && (len(call.Fields) == 2 || len(call.Fields) == 3):
				name := ""
				if len(call.Fields) == 3 {
					name = call.Fields[2]
				}
				p, err := s.AddProject(ctx, call.Fields[1], name)
				if err != nil {
					return chat.CommandResult{}, &chat.CommandError{Status: 400, Message: err.Error()}
				}
				return chat.Reply(fmt.Sprintf("Project %s is %s.", p.Name, p.Path))
			case call.Fields[0] == "remove" && len(call.Fields) == 2:
				if err := s.RemoveProject(call.Fields[1]); err != nil {
					return chat.CommandResult{}, &chat.CommandError{Status: 400, Message: err.Error()}
				}
				return chat.Reply("Removed project " + call.Fields[1] + "; its tasks and branches stay.")
			}
			return chat.CommandResult{}, &chat.CommandError{Status: 400, Message: "usage: /projects [add PATH [NAME] | remove NAME]"}
		},
	}, {
		CommandSpec: chat.CommandSpec{Name: "tasks", Usage: "/tasks [PROJECT]", Summary: "Show coding agent tasks and what they are doing", Clients: chat.Interactive},
		OwnerOnly:   true,
		Run: func(_ context.Context, call chat.CommandCall) (chat.CommandResult, error) {
			project := ""
			if len(call.Fields) > 0 {
				project = call.Fields[0]
			}
			nodes, err := s.Tree(project)
			if err != nil {
				return chat.CommandResult{}, err
			}
			if len(nodes) == 0 {
				return chat.Reply("No tasks yet. Ask Mob to hand coding work in a project to a coding agent.")
			}
			return chat.Reply(outline(nodes))
		},
	}}
}

func (s *Service) describeProjects() (chat.CommandResult, error) {
	list, err := s.Projects()
	if err != nil {
		return chat.CommandResult{}, err
	}
	if len(list) == 0 {
		return chat.Reply("No projects yet. Add a git repository with `/projects add PATH`.")
	}
	var b strings.Builder
	b.WriteString("| Project | Path |\n| --- | --- |\n")
	for _, p := range list {
		fmt.Fprintf(&b, "| %s | `%s` |\n", cell(p.Name), p.Path)
	}
	return chat.Reply(b.String())
}

// used is what the tasks' agents used, by conversation.
func (s *Service) used(list []chat.Task) (map[string]chat.UsageSummary, error) {
	ids := make([]string, len(list))
	for i, t := range list {
		ids[i] = t.ConversationID
	}
	return s.Store.ConversationUsage(ids...)
}

// cell keeps text from breaking a Markdown table row.
func cell(text string) string {
	return strings.NewReplacer("|", "\\|", "\n", " ").Replace(text)
}
