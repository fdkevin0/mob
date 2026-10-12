package chat

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

var (
	everyClient = []string{ClientWeb, ClientTUI, ClientTelegram, ClientWeChat, ClientEmail}
	interactive = []string{ClientWeb, ClientTUI}
	messaging   = []string{ClientTelegram, ClientWeChat, ClientEmail}
)

// builtins are the commands about conversations and models.
func (s *ConversationService) builtins() []Command {
	return []Command{
		{CommandSpec: CommandSpec{"model", "/model [NAME | default [NAME]]", "Show or switch this conversation's model", everyClient, true}, Args: []Argument{s.modelOrDefault, s.defaultModel}},
		{CommandSpec: CommandSpec{"models", "/models [FILTER]", "List available models", everyClient, true}},
		{CommandSpec: CommandSpec{"compact", "/compact", "Summarize the conversation so far, so later turns read the summary in its place", everyClient, true}},
		{CommandSpec: CommandSpec{"new", "/new", "Start a new conversation", everyClient, false}, Run: s.newConversation},
		{CommandSpec: CommandSpec{"list", "/list", "List conversations", interactive, false}, Run: s.listConversations},
		{CommandSpec: CommandSpec{"open", "/open ID", "Switch to a conversation", interactive, false}, Args: []Argument{s.conversations}, Run: s.openConversation},
		{CommandSpec: CommandSpec{"approve", "/approve [ID] [conversation|always]", "Approve a pending tool request, optionally remembering it", everyClient, false}, Args: []Argument{s.approvals, Choices(RememberConversation, RememberAlways)}, Run: s.decide(true)},
		{CommandSpec: CommandSpec{"deny", "/deny [ID] [reason]", "Deny a pending tool request, optionally saying why", everyClient, false}, Args: []Argument{s.approvals}, Run: s.decide(false)},
		{CommandSpec: CommandSpec{"grants", "/grants", "List remembered approvals", everyClient, false}, OwnerOnly: true, Run: s.listGrants},
		{CommandSpec: CommandSpec{"revoke", "/revoke ID|all", "Forget a remembered approval", everyClient, false}, OwnerOnly: true, Args: []Argument{s.grantIDs}, Run: s.revokeGrant},
		{CommandSpec: CommandSpec{"stop", "/stop", "Stop the reply in progress", []string{ClientTelegram}, false}, Run: s.stop},
		{CommandSpec: CommandSpec{"help", "/help", "Show commands", messaging, false}, Run: s.help},
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

// stop ends the conversation's turn in progress, which then answers that it
// stopped.
func (s *ConversationService) stop(_ context.Context, call CommandCall) (CommandResult, error) {
	if !s.Stop(call.ConversationID) {
		return CommandResult{Markdown: "Nothing is running."}, nil
	}
	return CommandResult{Markdown: "Stopping."}, nil
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
// given. /approve may remember the approval for this conversation or always;
// /deny may say why, after the ID or alone when one request is pending.
func (s *ConversationService) decide(approved bool) func(context.Context, CommandCall) (CommandResult, error) {
	form := map[bool]string{true: "/approve [ID] [conversation|always]", false: "/deny [ID] [reason]"}[approved]
	return func(_ context.Context, call CommandCall) (CommandResult, error) {
		id, rest := "", strings.TrimSpace(call.Rest)
		if len(call.Fields) > 0 && len(call.Fields[0]) == 32 {
			id = call.Fields[0]
			rest = strings.TrimSpace(strings.TrimPrefix(rest, id))
		}
		a := &Action{Kind: Decide, Approved: approved}
		switch {
		case !approved:
			a.Reason = rest
		case rest == "" || rest == RememberConversation || rest == RememberAlways:
			a.Remember = rest
		default:
			return CommandResult{Markdown: "Use `" + form + "`."}, nil
		}
		if id == "" {
			pending := s.pending(call.ConversationID)
			if len(pending) != 1 {
				return CommandResult{Markdown: fmt.Sprintf("%d requests are pending; use `%s`.", len(pending), form)}, nil
			}
			id = pending[0].Value
		}
		a.ApprovalID = id
		return CommandResult{Action: a}, nil
	}
}

// listGrants shows the remembered approvals and how to revoke them.
func (s *ConversationService) listGrants(context.Context, CommandCall) (CommandResult, error) {
	grants, err := s.Store.Grants()
	if err != nil {
		return CommandResult{}, err
	}
	if len(grants) == 0 {
		return CommandResult{Markdown: "No approvals are remembered. Approve with `/approve ID always` or `/approve ID conversation` to remember one."}, nil
	}
	var b strings.Builder
	b.WriteString("| Tool | Covers | Where | Revoke |\n| --- | --- | --- | --- |\n")
	for _, g := range grants {
		covers, where := g.Scope, "every conversation"
		if covers == "" {
			covers = "every call"
		}
		if g.ConversationID != "" {
			where = "conversation `" + g.ConversationID + "`"
		}
		fmt.Fprintf(&b, "| %s | %s | %s | `/revoke %s` |\n", Cell(g.Tool), Cell(covers), where, g.ID)
	}
	b.WriteString("\n`/revoke all` forgets every one.")
	return CommandResult{Markdown: b.String()}, nil
}

func (s *ConversationService) revokeGrant(_ context.Context, call CommandCall) (CommandResult, error) {
	if len(call.Fields) != 1 {
		return CommandResult{Markdown: "Use `/revoke ID` or `/revoke all`; `/grants` lists them."}, nil
	}
	n, err := s.Store.Revoke(call.Fields[0])
	if err != nil {
		return CommandResult{}, err
	}
	if n == 0 {
		return CommandResult{Markdown: "No remembered approval has ID `" + Cell(call.Fields[0]) + "`."}, nil
	}
	return CommandResult{Markdown: fmt.Sprintf("Forgot %d remembered approval(s); those calls will ask again.", n)}, nil
}

func (s *ConversationService) grantIDs(context.Context, CommandCall, []string) []Suggestion {
	grants, _ := s.Store.Grants()
	list := []Suggestion{{Value: "all", Label: "all", Detail: "every remembered approval"}}
	for _, g := range grants {
		list = append(list, Suggestion{Value: g.ID, Label: g.Tool, Detail: g.Scope})
	}
	return list
}

func (s *ConversationService) help(_ context.Context, call CommandCall) (CommandResult, error) {
	return CommandResult{Markdown: s.Commands.Help(call.Client)}, nil
}
