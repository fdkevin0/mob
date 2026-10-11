package telegram

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/fdkevin0/mob/internal/chat"
	"regexp"
	"strconv"
	"strings"
	"time"
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
func (s *Service) Message(ctx context.Context, c Config, botID string, u Update) error {
	id := "tg:" + botID + ":" + strconv.FormatInt(u.ID, 10)
	delivery, err := s.Store.Delivery(id)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return errors.New("Cannot read Telegram delivery state")
	}
	state, reply := delivery.State, delivery.Reply
	var approvals []chat.PendingApproval
	var processingErr error
	switch state {
	case "sent", "failed-or-unknown", "cancelled", "processing-failed", "processing":
		return nil
	case "sending":
		err = s.Store.UpdateDelivery(id, "failed-or-unknown", reply, errors.New("service interrupted during send"))
		if err != nil {
			return err
		}
		return errors.New("Telegram reply delivery is uncertain; see local conversation history")
	case "":
		accepted, acceptErr := s.Store.AcceptDelivery(id, "processing")
		if acceptErr != nil {
			return errors.New("Cannot save Telegram update")
		}
		if !accepted {
			return nil
		}
		reply, approvals, processingErr = s.reply(ctx, c, botID, id, u.Message.Text)
	}
	if ctx.Err() != nil {
		return errors.Join(ctx.Err(), s.Store.UpdateDelivery(id, "cancelled", reply, ctx.Err()))
	}
	if err = s.Store.UpdateDelivery(id, "sending", reply, nil); err != nil {
		return errors.New("Cannot save Telegram reply")
	}
	err = c.Send(ctx, u.Message.Chat.ID, reply, approvals...)
	state = "sent"
	if processingErr != nil {
		state = "processing-failed"
	}
	if err != nil {
		state = "failed-or-unknown"
	}
	saveErr := s.Store.UpdateDelivery(id, state, reply, errors.Join(err, processingErr))
	if saveErr != nil {
		return errors.New("Cannot save Telegram delivery status")
	}
	// ponytail: no automatic retry after an ambiguous send; the persisted reply and
	// chat history remain available locally. Add a reviewable outbox before retries.
	if err != nil {
		return errors.New("Telegram reply delivery failed or is uncertain; see local conversation history")
	}
	return processingErr
}
func (s *Service) Reply(ctx context.Context, c Config, botID, requestID, text string) (string, error) {
	reply, _, err := s.reply(ctx, c, botID, requestID, text)
	return reply, err
}

// reply also returns the approvals the turn requested, which get buttons.
func (s *Service) reply(ctx context.Context, c Config, botID, requestID, text string) (string, []chat.PendingApproval, error) {
	if text == "/start" {
		text = "/help"
	}
	key := "telegram-conversation:" + botID + ":" + strconv.FormatInt(c.UserID, 10)
	var id string
	if err := s.Store.Setting(key, &id); err != nil {
		return "Cannot load the Telegram conversation.", nil, err
	}
	if id == "" && text != "/new" && text != "/help" {
		conversation, err := s.Store.Create()
		if err != nil {
			return "Cannot create a conversation.", nil, err
		}
		id = conversation.ID
		if err = s.Store.SaveSetting(key, id); err != nil {
			return "Cannot save the Telegram conversation.", nil, err
		}
	}
	// The bot answers only its configured user, who owns this Mob.
	result, err := s.Conversation.Commands.Run(ctx, chat.CommandRequest{Client: chat.ClientTelegram, ConversationID: id, Text: text}, true)
	if err != nil {
		return "Mob: " + err.Error(), nil, err
	}
	input := chat.ChatRequest{ID: id, Text: text, RequestID: requestID, Owner: true}
	if result.Handled {
		reply := result.Markdown
		if text == "/help" {
			reply = "Mob is connected. Send a message to chat. This computer must remain running.\n\n" + reply
		}
		switch a := result.Action; {
		case a == nil:
			return reply, nil, nil
		case a.Kind == chat.OpenConversation:
			if err := s.Store.SaveSetting(key, a.ConversationID); err != nil {
				return "Cannot save the Telegram conversation.", nil, err
			}
			return reply, nil, nil
		case a.Kind == chat.Decide:
			input.Text = ""
			input.Approval = &chat.Answer{ID: a.ApprovalID, Approved: a.Approved, Reason: a.Reason, Remember: a.Remember}
		default:
			return "That command needs the desktop or terminal app.", nil, nil
		}
	}
	var reply strings.Builder
	var approvals []chat.PendingApproval
	err = s.Conversation.Execute(ctx, input, func(event chat.Event) error {
		switch event.Kind {
		case chat.SegmentDelta:
			if event.Segment != "text" {
				break
			}
			reply.WriteString(fmt.Sprint(event.Text))
		case chat.ApprovalRequested:
			approvals = append(approvals, chat.PendingApproval{ID: event.ApprovalID, Tool: event.ToolName, Input: event.Input})
			reply.WriteString("\n\nApproval needed: " + chat.DescribeApproval(event.ToolName, event.Input) + "\nID: " + event.ApprovalID)
		case chat.TurnFailed:
			reply.WriteString("\nError: " + fmt.Sprint(event.Error))
		}
		if reply.Len() > 32000 {
			return errors.New("reply exceeds Telegram bridge limit")
		}
		return nil
	})
	if err != nil {
		reply.WriteString("\nMob: " + err.Error() + ". Open the desktop/TUI for the saved result.")
	}
	if len(approvals) > 0 {
		reply.WriteString("\n\n" + decideHint(len(s.Conversation.Pending(id))))
	}
	if reply.Len() == 0 {
		return "Done. Open the local conversation for details.", nil, nil
	}
	return reply.String(), approvals, err
}

// decideHint tells the owner how to answer, given how many requests are pending.
func decideHint(pending int) string {
	if pending > 1 {
		return "Tap a button, or reply /approve ID, or /deny ID with an optional reason. Always allow stops asking for calls like this; /grants lists them."
	}
	return "Tap a button, or reply /approve, or /deny with an optional reason. Always allow stops asking for calls like this; /grants lists them."
}
