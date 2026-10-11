package chat

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Clients that type commands into a conversation.
const (
	ClientWeb      = "web"
	ClientTUI      = "tui"
	ClientTelegram = "telegram"
	ClientWeChat   = "wechat"
)

var allClients = []string{ClientWeb, ClientTUI, ClientTelegram, ClientWeChat}

// CommandSpec describes a slash command once for help text and completion in
// every client.
type CommandSpec struct {
	Name    string   `json:"name"`
	Usage   string   `json:"usage"`
	Summary string   `json:"summary"`
	Clients []string `json:"clients"`
}

// Suggestion replaces the last whitespace-separated token of the completed text.
type Suggestion struct {
	Value  string `json:"value"`
	Label  string `json:"label"`
	Detail string `json:"detail,omitempty"`
}

// CompletionRequest asks for suggestions for text typed up to the cursor.
type CompletionRequest struct {
	Client         string `json:"client"`
	ConversationID string `json:"conversationId,omitempty"`
	Text           string `json:"text"`
}

// argument suggests values for one argument position; prior holds the
// arguments before it.
type argument func(ctx context.Context, s *ConversationService, conversation string, prior []string) []Suggestion

type command struct {
	CommandSpec
	args []argument
}

const maxSuggestions = 20

var plugins = choices("email", "telegram", "cloudflare")

var commands = []command{
	{CommandSpec{"model", "/model [NAME | default [NAME]]", "Show or switch this conversation's model", allClients}, []argument{modelOrDefault, defaultModel}},
	{CommandSpec{"models", "/models [FILTER]", "List available models", allClients}, nil},
	{CommandSpec{"new", "/new", "Start a new conversation", []string{ClientTUI, ClientTelegram}}, nil},
	{CommandSpec{"list", "/list", "List conversations", []string{ClientTUI}}, nil},
	{CommandSpec{"open", "/open ID", "Switch to a conversation", []string{ClientTUI}}, []argument{conversations}},
	{CommandSpec{"approve", "/approve ID", "Approve a pending tool request", []string{ClientTUI, ClientTelegram}}, []argument{approvals}},
	{CommandSpec{"deny", "/deny ID", "Deny a pending tool request", []string{ClientTUI, ClientTelegram}}, []argument{approvals}},
	{CommandSpec{"plugins", "/plugins", "Configure plugins and cloud services", []string{ClientTUI}}, nil},
	{CommandSpec{"email", "/email [UID VALIDITY | analyze UID VALIDITY]", "List, read or summarize INBOX mail", []string{ClientTUI}}, []argument{choices("analyze")}},
	{CommandSpec{"mail", "/mail", "Compose an email", []string{ClientTUI}}, nil},
	{CommandSpec{"cloud", "/cloud OPERATION [ARGUMENT]", "Run a Cloudflare operation", []string{ClientTUI}}, []argument{choices("ai.models", "ai.run", "vectorize.indexes", "vectorize.query", "d1.databases", "d1.query", "kv.namespaces", "kv.get", "r2.buckets", "r2.list", "r2.get")}},
	{CommandSpec{"test", "/test PLUGIN", "Test a plugin connection", []string{ClientTUI}}, []argument{plugins}},
	{CommandSpec{"deliveries", "/deliveries", "Show channel delivery status", []string{ClientTUI}}, nil},
	{CommandSpec{"clear-secret", "/clear-secret PLUGIN FIELD", "Clear a saved credential of a disabled plugin", []string{ClientTUI}}, []argument{plugins}},
	{CommandSpec{"help", "/help", "Show commands", []string{ClientTelegram}}, nil},
}

func lookup(name, client string) (command, bool) {
	for _, c := range commands {
		if c.Name == name && slices.Contains(c.Clients, client) {
			return c, true
		}
	}
	return command{}, false
}

// Commands lists the commands a client understands.
func Commands(client string) []CommandSpec {
	list := []CommandSpec{}
	for _, c := range commands {
		if slices.Contains(c.Clients, client) {
			list = append(list, c.CommandSpec)
		}
	}
	return list
}

// Help is one line per command a client understands.
func Help(client string) string {
	var b strings.Builder
	for _, c := range Commands(client) {
		fmt.Fprintf(&b, "%s — %s\n", c.Usage, c.Summary)
	}
	return strings.TrimSuffix(b.String(), "\n")
}

// Complete suggests replacements for the last token of input.Text. Free text
// and finished arguments get no suggestions.
func (s *ConversationService) Complete(ctx context.Context, input CompletionRequest) []Suggestion {
	text := input.Text
	if !strings.HasPrefix(text, "/") || strings.ContainsAny(text, "\r\n") {
		return []Suggestion{}
	}
	fields := strings.Fields(text)
	ended := strings.HasSuffix(text, " ") || strings.HasSuffix(text, "\t")
	prefix := ""
	if !ended {
		prefix, fields = fields[len(fields)-1], fields[:len(fields)-1]
	}
	if len(fields) == 0 {
		var list []Suggestion
		for _, c := range Commands(input.Client) {
			list = append(list, Suggestion{Value: "/" + c.Name, Label: c.Usage, Detail: c.Summary})
		}
		return filter(list, prefix, false)
	}
	c, ok := lookup(strings.TrimPrefix(fields[0], "/"), input.Client)
	if !ok || len(fields)-1 >= len(c.args) {
		return []Suggestion{}
	}
	// Model listings can refresh from vendors; typing must not wait on them.
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return filter(c.args[len(fields)-1](ctx, s, input.ConversationID, fields[1:]), prefix, true)
}

// filter keeps prefix matches of the value before substring matches (of three
// or more characters) of the value or, when labels is set, the label, ignoring
// case.
func filter(list []Suggestion, prefix string, labels bool) []Suggestion {
	prefix = strings.ToLower(prefix)
	var first, rest []Suggestion
	for _, s := range list {
		value, word := strings.ToLower(s.Value), strings.TrimPrefix(prefix, "/")
		if strings.HasPrefix(value, prefix) || strings.HasPrefix(strings.TrimPrefix(value, "/"), prefix) {
			first = append(first, s)
		} else if len(word) >= 3 && (strings.Contains(value, word) || labels && strings.Contains(strings.ToLower(s.Label), word)) {
			rest = append(rest, s)
		}
	}
	result := append(append([]Suggestion{}, first...), rest...)
	if len(result) > maxSuggestions {
		result = result[:maxSuggestions]
	}
	return result
}

func choices(values ...string) argument {
	return func(context.Context, *ConversationService, string, []string) []Suggestion {
		list := make([]Suggestion, len(values))
		for i, v := range values {
			list[i] = Suggestion{Value: v, Label: v}
		}
		return list
	}
}

func modelChoices(ctx context.Context, s *ConversationService) []Suggestion {
	var list []Suggestion
	for _, g := range s.Models.List(ctx, "") {
		for _, m := range g.Models {
			ref := g.Provider + "/" + m.ID
			list = append(list, Suggestion{Value: ref, Label: ref, Detail: describe(m)})
		}
	}
	return list
}

func modelOrDefault(ctx context.Context, s *ConversationService, _ string, _ []string) []Suggestion {
	return append([]Suggestion{{Value: "default", Label: "default", Detail: "Follow or set the default model"}}, modelChoices(ctx, s)...)
}

func defaultModel(ctx context.Context, s *ConversationService, _ string, prior []string) []Suggestion {
	if prior[0] != "default" {
		return nil
	}
	return modelChoices(ctx, s)
}

func conversations(_ context.Context, s *ConversationService, _ string, _ []string) []Suggestion {
	list, err := s.Store.List()
	if err != nil {
		return nil
	}
	suggestions := make([]Suggestion, len(list))
	for i, c := range list {
		suggestions[i] = Suggestion{Value: c.ID, Label: c.Title, Detail: c.ID}
	}
	return suggestions
}

// approvals are the conversation's tool requests still awaiting a decision.
func approvals(_ context.Context, s *ConversationService, id string, _ []string) []Suggestion {
	if id == "" {
		return nil
	}
	history, err := s.Store.History(id)
	if err != nil {
		return nil
	}
	var list []Suggestion
	for _, m := range history {
		for _, p := range m.Parts {
			if p["state"] != "approval-requested" {
				continue
			}
			var approval string
			switch a := p["approval"].(type) {
			case map[string]any:
				approval = fmt.Sprint(a["id"])
			case map[string]string:
				approval = a["id"]
			}
			if approval != "" {
				list = append(list, Suggestion{Value: approval, Label: approval, Detail: strings.TrimPrefix(fmt.Sprint(p["type"]), "tool-")})
			}
		}
	}
	return list
}
