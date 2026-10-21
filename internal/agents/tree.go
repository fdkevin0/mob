package agents

import (
	"fmt"
	"strings"

	"github.com/fdkevin0/mob/internal/chat"
)

// Mob is the agent of Mob's own conversations in the tree.
const Mob = "mob"

// Idle is the status of a Mob conversation that is not answering and waits
// for no decision.
const Idle = "idle"

// AgentNode is one conversation in the tree of who started whom: a task, or
// a conversation of Mob's that started tasks.
type AgentNode struct {
	ConversationID string `json:"conversationId"`
	// Parent is the conversation that started this one; empty for a root.
	Parent string `json:"parent,omitempty"`
	// Agent is the task's agent, or mob; Label is its display name.
	Agent string `json:"agent"`
	Label string `json:"label"`
	// Model is the model the agent runs: the one its running session's
	// options select, else the one that used the most tokens.
	Model string `json:"model,omitempty"`
	Title string `json:"title"`
	// Status is a task status, or running, waiting or idle for Mob.
	Status string `json:"status"`
	// Approvals are the decisions that wait for the owner, oldest first.
	Approvals []AgentApproval `json:"approvals"`
	// Tools are the kinds of tool the agent used, such as execute or edit.
	Tools []string   `json:"tools"`
	Task  *chat.Task `json:"task,omitempty"`
	// Usage is what the conversation used, when it recorded any.
	Usage *chat.UsageSummary `json:"usage,omitempty"`
}

// AgentApproval is a decision waiting in an agent's conversation.
type AgentApproval struct {
	ID   string `json:"id"`
	Tool string `json:"tool"`
	// Text says what is asked, in a few lines.
	Text string `json:"text"`
}

// approvalText bounds how much of a request a card shows, in runes.
const approvalText = 400

// waiting lists the decisions that wait in conversationID.
func (s *Service) waiting(conversationID string) []AgentApproval {
	pending := s.Conversations.Pending(conversationID)
	list := make([]AgentApproval, len(pending))
	for i, p := range pending {
		text := chat.DescribeApproval(p.Tool, p.Input)
		// An agent's request names itself in a title.
		if in, ok := p.Input.(map[string]any); ok {
			if title, ok := in["title"].(string); ok && title != "" {
				text = title
			}
		}
		if r := []rune(text); len(r) > approvalText {
			text = string(r[:approvalText]) + "…"
		}
		list[i] = AgentApproval{ID: p.ID, Tool: p.Tool, Text: text}
	}
	return list
}

// Tree lists the tasks, most recently updated first, then the conversations
// that started them and are no task.
func (s *Service) Tree(project string) ([]AgentNode, error) {
	tasks, err := s.Store.Tasks(project)
	if err != nil {
		return nil, err
	}
	nodes := make([]AgentNode, 0, len(tasks))
	isTask := map[string]bool{}
	for _, t := range tasks {
		isTask[t.ConversationID] = true
	}
	parents := map[string]bool{}
	for _, t := range tasks {
		label := t.Agent
		if p, err := preset(t.Agent); err == nil {
			label = p.Title
		}
		used, err := s.Store.ToolsUsed(t.ConversationID)
		if err != nil {
			return nil, err
		}
		kinds := []string{}
		for _, name := range used {
			if kind, ok := strings.CutPrefix(name, t.Agent+"_"); ok {
				kinds = append(kinds, kind)
			}
		}
		task := t
		nodes = append(nodes, AgentNode{ConversationID: t.ConversationID, Parent: t.Parent, Agent: t.Agent, Label: label, Model: s.sessionModel(t.ID), Title: t.Title,
			Status: t.Status, Approvals: s.waiting(t.ConversationID), Tools: kinds, Task: &task})
		if t.Parent != "" && !isTask[t.Parent] {
			parents[t.Parent] = true
		}
	}
	conversations := []chat.Conversation{}
	if len(parents) > 0 {
		if conversations, err = s.Store.List(); err != nil {
			return nil, err
		}
	}
	for _, c := range conversations {
		if !parents[c.ID] {
			continue
		}
		n := AgentNode{ConversationID: c.ID, Agent: Mob, Label: "Mob", Title: c.Title, Status: Idle, Approvals: s.waiting(c.ID), Tools: []string{}}
		switch {
		case len(n.Approvals) > 0:
			n.Status = chat.TaskWaiting
		case s.Conversations.Active(c.ID):
			n.Status = chat.TaskRunning
		}
		nodes = append(nodes, n)
	}
	ids := make([]string, len(nodes))
	for i, n := range nodes {
		ids[i] = n.ConversationID
	}
	used, err := s.Store.ConversationUsage(ids...)
	if err != nil {
		return nil, err
	}
	for i := range nodes {
		n := &nodes[i]
		u, ok := used[n.ConversationID]
		if !ok {
			continue
		}
		n.Usage = &u
		// An agent that names no model is recorded under its own name.
		if n.Model == "" && len(u.Models) > 0 && u.Models[0].Model != n.Agent {
			n.Model = u.Models[0].Model
		}
	}
	return nodes, nil
}

// sessionModel is the model task id's running session selects, if any.
func (s *Service) sessionModel(id string) string {
	session := s.running(id)
	if session == nil {
		return ""
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.model
}

// statusLabels are how /tasks names statuses.
var statusLabels = map[string]string{
	chat.TaskRunning: "Running",
	chat.TaskWaiting: "Needs you",
	chat.TaskReview:  "Done",
	chat.TaskStopped: "Stopped",
	chat.TaskFailed:  "Failed",
	Idle:             "Idle",
}

// outline writes nodes as a Markdown list nested by who started whom.
func outline(nodes []AgentNode) string {
	known := map[string]bool{}
	for _, n := range nodes {
		known[n.ConversationID] = true
	}
	children := map[string][]AgentNode{}
	for _, n := range nodes {
		parent := n.Parent
		if !known[parent] {
			parent = ""
		}
		children[parent] = append(children[parent], n)
	}
	var b strings.Builder
	var write func(parent string, depth int)
	write = func(parent string, depth int) {
		for _, n := range children[parent] {
			fmt.Fprintf(&b, "%s- **%s** · %s · %s", strings.Repeat("  ", depth), statusLabels[n.Status], n.Label, n.Title)
			if n.Task != nil {
				fmt.Fprintf(&b, " · %s `%s`", n.Task.Project, n.Task.Branch)
			}
			if n.Usage != nil {
				b.WriteString(" · " + n.Usage.Brief())
			}
			b.WriteString("\n")
			write(n.ConversationID, depth+1)
		}
	}
	write("", 0)
	return b.String()
}
