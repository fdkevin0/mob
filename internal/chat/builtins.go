package chat

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

var (
	everyClient = []string{ClientWeb, ClientTUI, ClientTelegram, ClientWeChat}
	interactive = []string{ClientWeb, ClientTUI}
	approving   = []string{ClientWeb, ClientTUI, ClientTelegram}
)

// builtins are the commands about conversations and models.
func (s *ConversationService) builtins() []Command {
	return []Command{
		{CommandSpec: CommandSpec{"model", "/model [NAME | default [NAME]]", "Show or switch this conversation's model", everyClient, true}, Args: []Argument{s.modelOrDefault, s.defaultModel}},
		{CommandSpec: CommandSpec{"models", "/models [FILTER]", "List available models", everyClient, true}},
		{CommandSpec: CommandSpec{"new", "/new", "Start a new conversation", approving, false}, Run: s.newConversation},
		{CommandSpec: CommandSpec{"list", "/list", "List conversations", interactive, false}, Run: s.listConversations},
		{CommandSpec: CommandSpec{"open", "/open ID", "Switch to a conversation", interactive, false}, Args: []Argument{s.conversations}, Run: s.openConversation},
		{CommandSpec: CommandSpec{"approve", "/approve [ID]", "Approve a pending tool request", approving, false}, Args: []Argument{s.approvals}, Run: s.decide(true)},
		{CommandSpec: CommandSpec{"deny", "/deny [ID] [reason]", "Deny a pending tool request, optionally saying why", approving, false}, Args: []Argument{s.approvals}, Run: s.decide(false)},
		{CommandSpec: CommandSpec{"help", "/help", "Show commands", []string{ClientTelegram}, false}, Run: s.help},
	}
}

func (s *ConversationService) modelChoices(ctx context.Context) []Suggestion {
	var list []Suggestion
	for _, g := range s.Models.List(ctx, "") {
		for _, m := range g.Models {
			ref := g.Provider + "/" + m.ID
			list = append(list, Suggestion{Value: ref, Label: ref, Detail: describe(m)})
		}
	}
	return list
}

func (s *ConversationService) modelOrDefault(ctx context.Context, _ CommandCall, _ []string) []Suggestion {
	return append([]Suggestion{{Value: "default", Label: "default", Detail: "Follow or set the default model"}}, s.modelChoices(ctx)...)
}

func (s *ConversationService) defaultModel(ctx context.Context, _ CommandCall, prior []string) []Suggestion {
	if prior[0] != "default" {
		return nil
	}
	return s.modelChoices(ctx)
}

func (s *ConversationService) conversations(context.Context, CommandCall, []string) []Suggestion {
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

// pending are the conversation's tool requests still awaiting a decision.
func (s *ConversationService) pending(id string) []Suggestion {
	var list []Suggestion
	for _, p := range s.Pending(id) {
		list = append(list, Suggestion{Value: p.ID, Label: p.ID, Detail: p.Tool})
	}
	return list
}

func (s *ConversationService) approvals(_ context.Context, call CommandCall, _ []string) []Suggestion {
	return s.pending(call.ConversationID)
}

func (s *ConversationService) newConversation(context.Context, CommandCall) (CommandResult, error) {
	c, err := s.Store.Create()
	if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{Markdown: "New conversation started.", Action: &Action{Kind: OpenConversation, ConversationID: c.ID}}, nil
}

func (s *ConversationService) listConversations(_ context.Context, call CommandCall) (CommandResult, error) {
	list, err := s.Store.List()
	if err != nil {
		return CommandResult{}, err
	}
	var b strings.Builder
	b.WriteString("| Conversation | ID |\n| --- | --- |\n")
	for _, c := range list {
		title := Cell(c.Title)
		if c.ID == call.ConversationID {
			title = "**" + title + "** (current)"
		}
		fmt.Fprintf(&b, "| %s | `%s` |\n", title, c.ID)
	}
	b.WriteString("\nSwitch with `/open ID`.")
	return CommandResult{Markdown: b.String()}, nil
}

func (s *ConversationService) openConversation(_ context.Context, call CommandCall) (CommandResult, error) {
	if len(call.Fields) != 1 {
		return CommandResult{Markdown: "Use `/open ID`; `/list` shows conversations."}, nil
	}
	id := call.Fields[0]
	if _, err := s.Store.History(id); errors.Is(err, sql.ErrNoRows) {
		return CommandResult{Markdown: "No conversation has ID `" + Cell(id) + "`."}, nil
	} else if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{Action: &Action{Kind: OpenConversation, ConversationID: id}}, nil
}

// decide resolves the named approval, or the only pending one when no ID is
// given. /deny may say why after the ID, or alone when one request is pending.
func (s *ConversationService) decide(approved bool) func(context.Context, CommandCall) (CommandResult, error) {
	form := map[bool]string{true: "/approve ID", false: "/deny ID [reason]"}[approved]
	return func(_ context.Context, call CommandCall) (CommandResult, error) {
		id, reason := "", strings.TrimSpace(call.Rest)
		if len(call.Fields) > 0 && len(call.Fields[0]) == 32 {
			id = call.Fields[0]
			reason = strings.TrimSpace(strings.TrimPrefix(reason, id))
		}
		if approved && reason != "" {
			return CommandResult{Markdown: "Use `" + form + "`."}, nil
		}
		if id == "" {
			pending := s.pending(call.ConversationID)
			if len(pending) != 1 {
				return CommandResult{Markdown: fmt.Sprintf("%d requests are pending; use `%s`.", len(pending), form)}, nil
			}
			id = pending[0].Value
		}
		return CommandResult{Action: &Action{Kind: Decide, ApprovalID: id, Approved: approved, Reason: reason}}, nil
	}
}

func (s *ConversationService) help(_ context.Context, call CommandCall) (CommandResult, error) {
	return CommandResult{Markdown: s.Commands.Help(call.Client)}, nil
}
