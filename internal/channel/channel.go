// Package channel is what the messaging apps Mob answers in share: each
// message runs the command registry or a turn, answers in the app's own words,
// and is recorded so a restart never answers or sends it twice. A channel
// plugin brings only its transport (receiving and sending) and who is writing.
package channel

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/fdkevin0/mob/internal/chat"
)

// Bridge answers one messaging app's messages.
type Bridge struct {
	// Name is the app's name in errors and statuses, such as "Telegram".
	Name string
	// Client names the app to the command registry.
	Client       string
	Store        *chat.Store
	Conversation *chat.ConversationService
	Texts        Texts
	// Limit, when set, ends a turn whose reply grows past it, in bytes.
	Limit int
}

// Texts are what a channel says in its own words.
type Texts struct {
	// Help comes before the command list that /help shows.
	Help string
	// Approvals follows a reply whose turn requested approvals; pending is how
	// many requests the conversation has waiting.
	Approvals func(approvals []chat.PendingApproval, pending int) string
	// Decided, when set, comes before the reply to a decision.
	Decided func(chat.Answer) string
	// Stale answers a decision on an approval that is unknown, expired or
	// already decided.
	Stale func(id string) string
	// Failed follows the reply when a command or turn failed.
	Failed func(error) string
	// Unsupported answers a command only the desktop and terminal apps can carry out.
	Unsupported string
	// Empty answers a turn that said nothing.
	Empty string
}

// Message is one message someone sent Mob in an app.
type Message struct {
	// ID, when set, is unique and stable for the message in its app and is
	// the turn's request ID.
	ID string
	// Key is the setting naming the conversation the sender writes to.
	Key string
	// Owner says the sender owns this Mob.
	Owner bool
	Text  string
}

// Reply is what Mob answers a message with.
type Reply struct {
	Text string
	// Approvals are the requests the turn made, for apps that show buttons.
	Approvals []chat.PendingApproval
}

// Answer runs m as a command or a turn in the sender's conversation. On a
// failure the reply still says what happened.
func (b *Bridge) Answer(ctx context.Context, m Message) (Reply, error) {
	var id string
	if err := b.Store.Setting(m.Key, &id); err != nil {
		return Reply{Text: "Cannot load the " + b.Name + " conversation."}, err
	}
	if id == "" && m.Text != "/new" && m.Text != "/help" {
		conversation, err := b.Store.Create()
		if err != nil {
			return Reply{Text: "Cannot create a conversation."}, err
		}
		id = conversation.ID
		if err = b.Store.SaveSetting(m.Key, id); err != nil {
			return Reply{Text: "Cannot save the " + b.Name + " conversation."}, err
		}
	}
	result, err := b.Conversation.Commands.Run(ctx, chat.CommandRequest{Client: b.Client, ConversationID: id, Text: m.Text}, m.Owner)
	if err != nil {
		return Reply{Text: strings.TrimSpace(b.Texts.Failed(err))}, err
	}
	requestID := m.ID
	if requestID == "" || len(requestID) > 100 {
		requestID = chat.NewID()
	}
	input := chat.ChatRequest{ID: id, Text: m.Text, RequestID: requestID, Owner: m.Owner}
	var prefix string
	if result.Handled {
		reply := result.Markdown
		if m.Text == "/help" && b.Texts.Help != "" {
			reply = b.Texts.Help + "\n\n" + reply
		}
		switch a := result.Action; {
		case a == nil:
			return Reply{Text: reply}, nil
		case a.Kind == chat.OpenConversation:
			if err := b.Store.SaveSetting(m.Key, a.ConversationID); err != nil {
				return Reply{Text: "Cannot save the " + b.Name + " conversation."}, err
			}
			return Reply{Text: reply}, nil
		case a.Kind == chat.Decide:
			input.Text = ""
			input.Approval = &chat.Answer{ID: a.ApprovalID, Approved: a.Approved, Reason: a.Reason, Remember: a.Remember}
			if b.Texts.Decided != nil {
				prefix = b.Texts.Decided(*input.Approval)
			}
		default:
			return Reply{Text: b.Texts.Unsupported}, nil
		}
	}
	reply, err := b.turn(ctx, input)
	if input.Approval != nil && (errors.Is(err, chat.ErrStaleApproval) || errors.Is(err, sql.ErrNoRows)) {
		return Reply{Text: b.Texts.Stale(input.Approval.ID)}, nil
	}
	var refused *chat.CommandError
	switch {
	case errors.As(err, &refused) && refused.Status == 403:
		// The sender may not do this, such as a guest remembering an
		// approval; saying so is the answer.
		reply.Text += b.Texts.Failed(err)
		err = nil
	case err != nil:
		reply.Text += b.Texts.Failed(err)
	case prefix != "":
		reply.Text = prefix + "\n\n" + reply.Text
	}
	if reply.Text = strings.TrimSpace(reply.Text); reply.Text == "" {
		reply.Text = b.Texts.Empty
	}
	return reply, err
}

// turn runs one turn and collects what the sender sees of it: the text it
// writes, its failures and the approvals it asks for, but not its reasoning or
// tool calls.
func (b *Bridge) turn(ctx context.Context, input chat.ChatRequest) (Reply, error) {
	var text strings.Builder
	var approvals []chat.PendingApproval
	err := b.Conversation.Execute(ctx, input, func(event chat.Event) error {
		switch event.Kind {
		case chat.SegmentDelta:
			if event.Segment == "text" {
				text.WriteString(event.Text)
			}
		case chat.ApprovalRequested:
			approvals = append(approvals, chat.PendingApproval{ID: event.ApprovalID, Tool: event.ToolName, Input: event.Input})
		case chat.TurnFailed:
			text.WriteString("\nError: " + event.Error)
		}
		if b.Limit > 0 && text.Len() > b.Limit {
			return errors.New("reply exceeds the " + b.Name + " bridge limit")
		}
		return nil
	})
	if len(approvals) > 0 {
		text.WriteString(b.Texts.Approvals(approvals, len(b.Conversation.Pending(input.ID))))
	}
	return Reply{Text: text.String(), Approvals: approvals}, err
}

// Deliver answers the message with id and sends the answer once. Each step is
// recorded under id: a message already answered, or whose reply may have been
// sent, is never answered or sent again, and an interrupted send is reported
// rather than retried. A failed answer is still sent and then returned.
func (b *Bridge) Deliver(ctx context.Context, id string, answer func(context.Context) (Reply, error), send func(context.Context, Reply) error) error {
	delivery, err := b.Store.Delivery(id)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return errors.New("Cannot read " + b.Name + " delivery state")
	}
	var reply Reply
	var answerErr error
	switch delivery.State {
	case "sent", "failed-or-unknown", "cancelled", "processing-failed", "processing":
		return nil
	case "sending":
		if err := b.Store.UpdateDelivery(id, "failed-or-unknown", delivery.Reply, errors.New("service interrupted during send")); err != nil {
			return err
		}
		return errors.New(b.Name + " reply delivery is uncertain; see local conversation history")
	case "":
		accepted, err := b.Store.AcceptDelivery(id, "processing")
		if err != nil {
			return errors.New("Cannot save " + b.Name + " message")
		}
		if !accepted {
			return nil
		}
		reply, answerErr = answer(ctx)
	}
	if ctx.Err() != nil {
		return errors.Join(ctx.Err(), b.Store.UpdateDelivery(id, "cancelled", reply.Text, ctx.Err()))
	}
	if err := b.Store.UpdateDelivery(id, "sending", reply.Text, nil); err != nil {
		return errors.New("Cannot save " + b.Name + " reply")
	}
	err = send(ctx, reply)
	state := "sent"
	if answerErr != nil {
		state = "processing-failed"
	}
	if err != nil {
		state = "failed-or-unknown"
	}
	if saveErr := b.Store.UpdateDelivery(id, state, reply.Text, errors.Join(err, answerErr)); saveErr != nil {
		return errors.New("Cannot save " + b.Name + " delivery status")
	}
	// ponytail: no automatic retry after an ambiguous send; the persisted reply and
	// chat history remain available locally. Add a reviewable outbox before retries.
	if err != nil {
		return errors.New(b.Name + " reply delivery failed or is uncertain; see local conversation history")
	}
	return answerErr
}
