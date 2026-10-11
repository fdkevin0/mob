package chat

import (
	"context"
	"encoding/json"
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

// CommandSpec describes a slash command once for help, completion and
// execution in every client. A transcript command is answered by the chat
// stream and recorded in the conversation; any other runs through
// Registry.Run and only shows its result.
type CommandSpec struct {
	Name       string   `json:"name"`
	Usage      string   `json:"usage"`
	Summary    string   `json:"summary"`
	Clients    []string `json:"clients"`
	Transcript bool     `json:"transcript,omitempty"`
}

// CommandRequest is text typed into a client: up to the cursor when
// completing, the whole input when running.
type CommandRequest struct {
	Client         string `json:"client"`
	ConversationID string `json:"conversationId,omitempty"`
	Text           string `json:"text"`
}

// Suggestion replaces the last whitespace-separated token of the completed text.
type Suggestion struct {
	Value  string `json:"value"`
	Label  string `json:"label"`
	Detail string `json:"detail,omitempty"`
}

// Action asks the client to do what only it can: change its view or decide an
// approval through its own stream.
type Action struct {
	Kind           string `json:"kind"`
	ConversationID string `json:"conversationId,omitempty"`
	ApprovalID     string `json:"approvalId,omitempty"`
	Approved       bool   `json:"approved,omitempty"`
	// Reason is why the user denied the request, if they said.
	Reason string `json:"reason,omitempty"`
}

const (
	OpenConversation = "open-conversation"
	Decide           = "decide"
	OpenPlugins      = "open-plugins"
	ComposeMail      = "compose-mail"
)

// CommandResult is what a client shows after running a command. Handled is
// false when the text is not a command to run, and the client sends it as chat.
type CommandResult struct {
	Handled  bool    `json:"handled"`
	Markdown string  `json:"markdown,omitempty"`
	Action   *Action `json:"action,omitempty"`
}

// CommandCall is one invocation; Fields are the arguments and Rest is the
// text after the command name.
type CommandCall struct {
	Client, ConversationID, Rest string
	Fields                       []string
	Owner                        bool
}

// Argument suggests values for one argument position; prior holds the
// arguments before it.
type Argument func(ctx context.Context, call CommandCall, prior []string) []Suggestion

type Command struct {
	CommandSpec
	Args []Argument
	// OwnerOnly commands refuse callers that do not own this Mob.
	OwnerOnly bool
	// Run answers a non-transcript command.
	Run func(ctx context.Context, call CommandCall) (CommandResult, error)
}

// Registry holds every command. Register all commands before serving.
type Registry struct{ commands []Command }

const maxSuggestions = 20

func (r *Registry) Register(commands ...Command) {
	for _, c := range commands {
		if slices.ContainsFunc(r.commands, func(o Command) bool { return o.Name == c.Name }) {
			panic("command registered twice: " + c.Name)
		}
		if c.Transcript == (c.Run != nil) {
			panic("command needs exactly one of Transcript or Run: " + c.Name)
		}
		r.commands = append(r.commands, c)
	}
}

func (r *Registry) lookup(name, client string) (Command, bool) {
	for _, c := range r.commands {
		if c.Name == name && slices.Contains(c.Clients, client) {
			return c, true
		}
	}
	return Command{}, false
}

// transcript reports whether text is a transcript command in any client.
func (r *Registry) transcript(text string) bool {
	name, _, _ := strings.Cut(text, " ")
	for _, c := range r.commands {
		if c.Transcript && "/"+c.Name == name {
			return true
		}
	}
	return false
}

// Specs lists the commands a client understands.
func (r *Registry) Specs(client string) []CommandSpec {
	list := []CommandSpec{}
	for _, c := range r.commands {
		if slices.Contains(c.Clients, client) {
			list = append(list, c.CommandSpec)
		}
	}
	return list
}

// Help is one line per command a client understands.
func (r *Registry) Help(client string) string {
	var b strings.Builder
	for _, c := range r.Specs(client) {
		fmt.Fprintf(&b, "%s — %s\n", c.Usage, c.Summary)
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func parse(input CommandRequest, owner bool) (string, CommandCall) {
	text := strings.TrimSpace(input.Text)
	name, rest, _ := strings.Cut(text, " ")
	rest = strings.TrimSpace(rest)
	return strings.TrimPrefix(name, "/"), CommandCall{Client: input.Client, ConversationID: input.ConversationID, Rest: rest, Fields: strings.Fields(rest), Owner: owner}
}

// Run executes a non-transcript command. Other text, transcript commands
// included, comes back unhandled for the client to send as chat.
func (r *Registry) Run(ctx context.Context, input CommandRequest, owner bool) (CommandResult, error) {
	if !strings.HasPrefix(input.Text, "/") || strings.ContainsAny(input.Text, "\r\n") {
		return CommandResult{}, nil
	}
	name, call := parse(input, owner)
	c, ok := r.lookup(name, input.Client)
	if !ok || c.Run == nil {
		return CommandResult{}, nil
	}
	if c.OwnerOnly && !owner {
		return CommandResult{Handled: true, Markdown: "Only the owner of this Mob can use /" + c.Name + "."}, nil
	}
	result, err := c.Run(ctx, call)
	result.Handled = true
	return result, err
}

// Complete suggests replacements for the last token of input.Text. Free text
// and finished arguments get no suggestions.
func (r *Registry) Complete(ctx context.Context, input CommandRequest, owner bool) []Suggestion {
	text := input.Text
	if !strings.HasPrefix(text, "/") || strings.ContainsAny(text, "\r\n") {
		return []Suggestion{}
	}
	fields := strings.Fields(text)
	prefix := ""
	if !strings.HasSuffix(text, " ") && !strings.HasSuffix(text, "\t") {
		prefix, fields = fields[len(fields)-1], fields[:len(fields)-1]
	}
	if len(fields) == 0 {
		var list []Suggestion
		for _, c := range r.Specs(input.Client) {
			list = append(list, Suggestion{Value: "/" + c.Name, Label: c.Usage, Detail: c.Summary})
		}
		return filter(list, prefix, false)
	}
	c, ok := r.lookup(strings.TrimPrefix(fields[0], "/"), input.Client)
	if !ok || len(fields)-1 >= len(c.Args) || c.OwnerOnly && !owner {
		return []Suggestion{}
	}
	// Model listings can refresh from vendors; typing must not wait on them.
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, call := parse(input, owner)
	return filter(c.Args[len(fields)-1](ctx, call, fields[1:]), prefix, true)
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

// Choices is an argument with fixed values.
func Choices(values ...string) Argument {
	return func(context.Context, CommandCall, []string) []Suggestion {
		list := make([]Suggestion, len(values))
		for i, v := range values {
			list[i] = Suggestion{Value: v, Label: v}
		}
		return list
	}
}

// Fence shows text verbatim in Markdown, whatever backticks it contains.
func Fence(language, text string) string {
	fence := "```"
	for strings.Contains(text, fence) {
		fence += "`"
	}
	return fence + language + "\n" + strings.TrimSuffix(text, "\n") + "\n" + fence
}

// Cell makes text safe inside a Markdown table cell.
func Cell(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	return strings.ReplaceAll(text, "|", "\\|")
}

// Reply is a command result that shows Markdown.
func Reply(markdown string) (CommandResult, error) { return CommandResult{Markdown: markdown}, nil }

// ReplyJSON shows value as indented JSON under title.
func ReplyJSON(title string, value any) (CommandResult, error) {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return CommandResult{}, err
	}
	return Reply(title + "\n\n" + Fence("json", string(raw)))
}

// Interactive are the clients where people type commands into Mob itself.
var Interactive = []string{ClientWeb, ClientTUI}
