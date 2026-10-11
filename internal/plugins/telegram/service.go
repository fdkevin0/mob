package telegram

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/fdkevin0/mob/internal/chat"
	"strconv"
	"strings"
	"time"
)

type Service struct {
	Store        *chat.Store
	Conversation *chat.ConversationService
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
		reply, processingErr = s.Reply(ctx, c, botID, id, u.Message.Text)
	}
	if ctx.Err() != nil {
		return errors.Join(ctx.Err(), s.Store.UpdateDelivery(id, "cancelled", reply, ctx.Err()))
	}
	if err = s.Store.UpdateDelivery(id, "sending", reply, nil); err != nil {
		return errors.New("Cannot save Telegram reply")
	}
	err = c.Send(ctx, u.Message.Chat.ID, reply)
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
	if text == "/start" || text == "/help" {
		return "Mob is connected. Send a message to chat. /new starts a conversation. /approve ID or /deny ID resolves a memory request. This computer must remain running.", nil
	}
	key := "telegram-conversation:" + botID + ":" + strconv.FormatInt(c.UserID, 10)
	var id string
	if err := s.Store.Setting(key, &id); err != nil {
		return "Cannot load the Telegram conversation.", err
	}
	if id == "" || text == "/new" {
		conversation, err := s.Store.Create()
		if err != nil {
			return "Cannot create a conversation.", err
		}
		id = conversation.ID
		if err = s.Store.SaveSetting(key, id); err != nil {
			return "Cannot save the Telegram conversation.", err
		}
		if text == "/new" {
			return "New conversation started.", nil
		}
	}
	input := chat.ChatRequest{ID: id, Text: text, RequestID: requestID}
	if strings.HasPrefix(text, "/approve ") || strings.HasPrefix(text, "/deny ") {
		fields := strings.Fields(text)
		if len(fields) != 2 {
			return "Use /approve ID or /deny ID.", nil
		}
		input.Text = ""
		input.Approval = &struct {
			ID       string `json:"id"`
			Approved bool   `json:"approved"`
		}{fields[1], fields[0] == "/approve"}
	}
	var reply strings.Builder
	err := s.Conversation.Execute(ctx, input, func(event chat.Event) error {
		switch event.Kind {
		case chat.SegmentDelta:
			if event.Segment != "text" {
				break
			}
			reply.WriteString(fmt.Sprint(event.Text))
		case chat.ApprovalRequested:
			reply.WriteString("\nMemory approval required. Review the fact in the desktop/TUI, then /approve " + fmt.Sprint(event.ApprovalID) + " or /deny " + fmt.Sprint(event.ApprovalID) + ".")
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
	if reply.Len() == 0 {
		return "Done. Open the local conversation for details.", nil
	}
	return reply.String(), err
}
