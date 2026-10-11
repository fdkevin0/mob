package telegram

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/channel"
	"github.com/fdkevin0/mob/internal/chat"
)

type Service struct {
	Store        *chat.Store
	Conversation *chat.ConversationService
}

// botCommand is one entry of Telegram's command menu.
type botCommand struct {
	Command     string `json:"command"`
	Description string `json:"description"`
}

// commandName is what setMyCommands accepts as a command.
var commandName = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)

// menu is the commands in the form setMyCommands accepts; names Telegram
// rejects are left out.
func menu(specs []chat.CommandSpec) []botCommand {
	list := []botCommand{}
	for _, spec := range specs {
		description := []rune(strings.TrimSpace(spec.Summary))
		if !commandName.MatchString(spec.Name) || len(description) == 0 {
			continue
		}
		list = append(list, botCommand{Command: spec.Name, Description: string(description[:min(len(description), 256)])})
	}
	return list
}

// PublishCommands shows the registry's Telegram commands in the owner's chat
// menu, the only chat the bot answers.
func (s *Service) PublishCommands(ctx context.Context, c Config) error {
	return c.Call(ctx, "setMyCommands", map[string]any{
		"commands": menu(s.Conversation.Commands.Specs(chat.ClientTelegram)),
		"scope":    map[string]any{"type": "chat", "chat_id": c.UserID},
	}, nil)
}

func waitTelegram(ctx context.Context) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(10 * time.Second):
		return true
	}
}
func (s *Service) Loop(ctx context.Context, c Config, status func(string)) {
	botID := strings.SplitN(c.Token, ":", 2)[0]
	offsetKey := "telegram-offset:" + botID
	var offset int64
	published := false
	if err := s.Store.Setting(offsetKey, &offset); err != nil {
		status("Cannot load Telegram update offset")
		return
	}
	for ctx.Err() == nil {
		if _, err := c.Test(ctx); err != nil {
			status(err.Error())
			if !waitTelegram(ctx) {
				return
			}
			continue
		}
		status("Connected · polling private messages")
		if !published {
			// The menu is a convenience; polling goes on without it and the
			// next connection retries.
			if err := s.PublishCommands(ctx, c); err != nil {
				status("Connected · polling private messages · command menu not updated: " + err.Error())
			} else {
				published = true
			}
		}
		for ctx.Err() == nil {
			updates, err := c.Updates(ctx, offset)
			if err != nil {
				status(err.Error())
				if !waitTelegram(ctx) {
					return
				}
				break
			}
			for _, update := range updates {
				if ctx.Err() != nil {
					return
				}
				if update.ID < offset {
					continue
				}
				update = c.tapped(ctx, update)
				m := update.Message
				if m != nil && m.From.ID == c.UserID && m.Chat.ID == c.UserID && m.Chat.Type == "private" && m.Text != "" {
					if err = s.Message(ctx, c, botID, update); err != nil {
						status(err.Error())
						accepted, readErr := s.Store.DeliveryAccepted("tg:" + botID + ":" + strconv.FormatInt(update.ID, 10))
						if readErr != nil || !accepted {
							return
						}
					}
				}
				if ctx.Err() != nil {
					return
				}
				offset = update.ID + 1
				if err = s.Store.SaveSetting(offsetKey, offset); err != nil {
					status("Cannot save Telegram update offset; polling stopped")
					return
				}
			}
		}
	}
}

// bridge answers the owner's messages in the bot's conversation.
func (s *Service) bridge() *channel.Bridge {
	return &channel.Bridge{Name: "Telegram", Client: chat.ClientTelegram, Store: s.Store, Conversation: s.Conversation, Texts: texts, Limit: 32000}
}

var texts = channel.Texts{
	Help: "Mob is connected. Send a message to chat. This computer must remain running.",
	Approvals: func(approvals []chat.PendingApproval, pending int) string {
		var b strings.Builder
		for _, a := range approvals {
			b.WriteString("\n\nApproval needed: " + chat.DescribeApproval(a.Tool, a.Input) + "\nID: " + a.ID)
		}
		return b.String() + "\n\n" + decideHint(pending)
	},
	Stale: func(id string) string { return "Approval " + id + " is unknown, expired, or already decided." },
	Failed: func(err error) string {
		return "\nMob: " + err.Error() + ". Open the desktop/TUI for the saved result."
	},
	Unsupported: "That command needs the desktop or terminal app.",
	Empty:       "Done. Open the local conversation for details.",
}

// message is the owner's message in update u, as the bridge reads it.
func message(c Config, botID string, u Update) channel.Message {
	text := u.Message.Text
	if text == "/start" {
		text = "/help"
	}
	return channel.Message{
		ID:  "tg:" + botID + ":" + strconv.FormatInt(u.ID, 10),
		Key: "telegram-conversation:" + botID + ":" + strconv.FormatInt(c.UserID, 10),
		// The bot answers only its configured user, who owns this Mob.
		Owner: true,
		Text:  text,
	}
}

// Message answers the owner's message in update u and sends the reply once.
func (s *Service) Message(ctx context.Context, c Config, botID string, u Update) error {
	b, m := s.bridge(), message(c, botID, u)
	answer := func(ctx context.Context) (channel.Reply, error) { return b.Answer(ctx, m) }
	return b.Deliver(ctx, m.ID, answer, func(ctx context.Context, r channel.Reply) error {
		return c.Send(ctx, u.Message.Chat.ID, r.Text, r.Approvals...)
	})
}

// Reply answers text as if the owner had sent it to the bot.
func (s *Service) Reply(ctx context.Context, c Config, botID, requestID, text string) (string, error) {
	reply, err := s.reply(ctx, c, botID, requestID, text)
	return reply.Text, err
}

func (s *Service) reply(ctx context.Context, c Config, botID, requestID, text string) (channel.Reply, error) {
	m := message(c, botID, Update{Message: &Message{Text: text}})
	m.ID = requestID
	return s.bridge().Answer(ctx, m)
}

// decideHint tells the owner how to answer, given how many requests are pending.
func decideHint(pending int) string {
	if pending > 1 {
		return "Tap a button, or reply /approve ID, or /deny ID with an optional reason. Always allow stops asking for calls like this; /grants lists them."
	}
	return "Tap a button, or reply /approve, or /deny with an optional reason. Always allow stops asking for calls like this; /grants lists them."
}
