package telegram

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/channel"
	"github.com/fdkevin0/mob/internal/chat"
)

// Buttons stand in for typing commands: a tap sends the command its data
// holds, which the registry runs as if the owner had typed it.

// menuButtons are what /help and /start offer.
var menuButtons = [][]button{
	{{Text: "New conversation", Data: "/new"}, {Text: "Conversations", Data: "/list"}},
	{{Text: "Model", Data: "/model"}, {Text: "Compact", Data: "/compact"}},
	{{Text: "Remembered approvals", Data: "/grants"}},
}

var stopButton = [][]button{{{Text: "Stop", Data: "/stop"}}}

// picks names, for a command whose reply offers things to pick from, the
// command a button for each of them sends.
var picks = map[string]string{"/list": "/open", "/open": "/open", "/model": "/model", "/models": "/model", "/grants": "/revoke", "/revoke": "/revoke"}

const (
	pickConversation = "Conversations, most recent first. Tap one to continue it here; ✓ marks the current one."
	expired          = "That button has expired. Here is the menu again."
	// callbackLimit is the most bytes a button's data may hold.
	callbackLimit = 64
	// labelLimit keeps a button's label to what a phone shows on one line.
	labelLimit = 48
)

// present is the reply to sent as the bot shows it, with the buttons that go
// under it.
func (s *Service) present(ctx context.Context, c Config, botID, sent string, r channel.Reply) (channel.Reply, [][]button) {
	if r.Text == texts.Busy {
		return r, stopButton
	}
	name, rest, _ := strings.Cut(strings.TrimSpace(sent), " ")
	rest = strings.TrimSpace(rest)
	switch {
	case name == "/help":
		// The menu replaces the command list, which stays in the / menu.
		r.Text = texts.Help
		return r, menuButtons
	case name == "/open" && rest != "" && r.Text == "":
		r.Text = "Switched to " + s.title(rest) + "."
		return r, nil
	}
	command, ok := picks[name]
	if !ok || rest != "" && (name != "/models" || strings.ContainsAny(rest, " \t")) {
		return r, nil
	}
	rows := s.choices(ctx, c, botID, command, rest)
	if command == "/open" {
		r.Text = pickConversation
		rows = append(rows, menuButtons[0][:1])
	}
	return r, rows
}

// choices are buttons sending command with each value the registry suggests
// for its argument, filtered as filter would be when typed.
func (s *Service) choices(ctx context.Context, c Config, botID, command, filter string) [][]button {
	var current string
	if err := s.Store.Setting(conversationKey(botID, c), &current); err != nil {
		return nil
	}
	suggestions := s.Conversation.Commands.Complete(ctx, chat.CommandRequest{Client: chat.ClientTelegram, ConversationID: current, Text: command + " " + filter}, true)
	rows := [][]button{}
	for _, choice := range suggestions {
		label := choice.Label
		switch {
		case command == "/open" && strings.TrimSpace(label) == "":
			label = "Untitled"
		case command == "/model" && choice.Value == "default":
			label = "Follow the default model"
		case command == "/revoke" && choice.Value == "all":
			label = "Forget all"
		case command == "/revoke":
			label = "Forget " + label
			if choice.Detail != "" {
				label += " · " + choice.Detail
			}
		}
		label = clip(label)
		if command == "/open" && choice.Value == current {
			label = "✓ " + label
		}
		rows = append(rows, []button{{Text: label, Data: s.callback(command + " " + choice.Value)}})
	}
	return rows
}

// title is how the conversation with id is named on a button.
func (s *Service) title(id string) string {
	list, _ := s.Store.List()
	for _, c := range list {
		if c.ID == id && strings.TrimSpace(c.Title) != "" {
			return "“" + clip(c.Title) + "”"
		}
	}
	return "the conversation"
}

func clip(label string) string {
	label = strings.Join(strings.Fields(label), " ")
	if runes := []rune(label); len(runes) > labelLimit {
		return string(runes[:labelLimit-1]) + "…"
	}
	return label
}

// callback is the data of a button sending command. A command too long for
// Telegram to carry is kept here under a short token until Mob restarts.
func (s *Service) callback(command string) string {
	if len(command) <= callbackLimit {
		return command
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tokens == 0 {
		// Tokens are numbered from the time, so that a button shown before
		// Mob restarted matches none shown since.
		s.tokens = time.Now().UnixMilli()
	}
	if s.callbacks == nil || len(s.callbacks) >= 512 {
		// Old buttons answer that they expired.
		s.callbacks = map[string]string{}
	}
	s.tokens++
	token := "#" + strconv.FormatInt(s.tokens, 36)
	s.callbacks[token] = command
	return token
}

// command is what a tap on a button with data sends; "" for a token that has
// expired.
func (s *Service) command(data string) string {
	if !strings.HasPrefix(data, "#") {
		return data
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.callbacks[data]
}

// picked reports whether text, sent by a tap, picked one of a list's choices,
// which then no longer stands.
func picked(text string) bool {
	name, rest, _ := strings.Cut(text, " ")
	_, ok := picks[name]
	return ok && strings.TrimSpace(rest) != ""
}
