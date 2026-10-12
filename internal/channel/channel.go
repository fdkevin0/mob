// Package channel is what the messaging apps Mob answers in share: each
// message runs the command registry or a turn, answers in the app's own words,
// and is recorded so a restart never answers or sends it twice. A channel
// plugin brings only its transport (receiving and sending) and who is writing.
package channel

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"sync"

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

	// mu keeps messages that arrive together from each creating a
	// conversation for the same sender.
	mu sync.Mutex
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
	// Used, when set, follows the reply of a turn that called tools, to say
	// which in a line.
	Used func([]Use) string
	// Busy, when set, answers a message sent while the conversation's
	// previous turn is still running.
	Busy string
	// Stopped, when set, follows the reply of a turn the sender stopped.
	Stopped string
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
	// Started, when set, is called once the message's turn is running, or
	// when it has no turn, once its answer is ready; it may be called more
	// than once. An app answering messages concurrently waits for it before
	// answering the next, so they take effect in the order they were sent.
	Started func()
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
	if m.Started != nil {
		defer m.Started()
	}
	id, failure, err := b.conversation(m)
	if err != nil {
		return Reply{Text: failure}, err
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
	reply, err := b.turn(ctx, input, m.Started)
	if input.Approval != nil && (errors.Is(err, chat.ErrStaleApproval) || errors.Is(err, sql.ErrNoRows)) {
		return Reply{Text: b.Texts.Stale(input.Approval.ID)}, nil
	}
	var refused *chat.CommandError
	switch {
	case errors.As(err, &refused) && refused.Status == 409 && b.Texts.Busy != "" && strings.TrimSpace(reply.Text) == "":
		// The previous turn is still running; this message was not taken.
		reply.Text, err = b.Texts.Busy, nil
	case errors.Is(err, context.Canceled) && ctx.Err() == nil && b.Texts.Stopped != "":
		// Stopped by the sender rather than by Mob shutting down.
		reply.Text += "\n\n" + b.Texts.Stopped
		err = nil
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

// conversation is the ID of the conversation m's sender writes to, created
// for a first message; on a failure it also says what went wrong.
func (b *Bridge) conversation(m Message) (string, string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var id string
	if err := b.Store.Setting(m.Key, &id); err != nil {
		return "", "Cannot load the " + b.Name + " conversation.", err
	}
	if id == "" && m.Text != "/new" && m.Text != "/help" && m.Text != "/stop" {
		conversation, err := b.Store.Create()
		if err != nil {
			return "", "Cannot create a conversation.", err
		}
		id = conversation.ID
		if err = b.Store.SaveSetting(m.Key, id); err != nil {
			return "", "Cannot save the " + b.Name + " conversation.", err
		}
	}
	return id, "", nil
}

// turn runs one turn and collects what the sender sees of it: the text of its
// last step that wrote any, which concludes the turn, the tools it used, its
// failures and the approvals it asks for. Text written between tool calls,
// reasoning and tool calls stay in the local conversation.
func (b *Bridge) turn(ctx context.Context, input chat.ChatRequest, started func()) (Reply, error) {
	input.Channel = b.Name
	var step, last, failures strings.Builder
	var used []Use
	var approvals []chat.PendingApproval
	err := b.Conversation.Execute(ctx, input, func(event chat.Event) error {
		if started != nil {
			// Events come only from an admitted turn.
			started()
		}
		switch event.Kind {
		case chat.StepStarted:
			if strings.TrimSpace(step.String()) != "" {
				last.Reset()
				last.WriteString(step.String())
			}
			step.Reset()
		case chat.SegmentDelta:
			if event.Segment == "text" {
				step.WriteString(event.Text)
			}
		case chat.ToolInput:
			used = use(used, event.ToolName)
		case chat.ApprovalRequested:
			approvals = append(approvals, chat.PendingApproval{ID: event.ApprovalID, Tool: event.ToolName, Input: event.Input})
		case chat.TurnFailed:
			failures.WriteString("\nError: " + event.Error)
		}
		if b.over(max(step.Len(), last.Len())+failures.Len(), approvals) {
			return b.overLimit()
		}
		return nil
	})
	text := step.String()
	if strings.TrimSpace(text) == "" {
		text = last.String()
	}
	text = strings.TrimSpace(text)
	if len(used) > 0 && b.Texts.Used != nil {
		text += b.Texts.Used(used)
	}
	text += failures.String()
	if len(approvals) > 0 {
		text += b.Texts.Approvals(approvals, len(b.Conversation.Pending(input.ID)))
	}
	if err == nil && b.Limit > 0 && len(text) > b.Limit {
		err = b.overLimit()
	}
	return Reply{Text: text, Approvals: approvals}, err
}

// Use is a tool a turn called and how many times.
type Use struct {
	Tool  string
	Times int
}

// String is the tool's name, with how many times when more than once.
func (u Use) String() string {
	if u.Times > 1 {
		return u.Tool + " ×" + strconv.Itoa(u.Times)
	}
	return u.Tool
}

func use(used []Use, tool string) []Use {
	for i := range used {
		if used[i].Tool == tool {
			used[i].Times++
			return used
		}
	}
	return append(used, Use{Tool: tool, Times: 1})
}

// over reports whether a reply of n bytes followed by the prompt for
// approvals passes the limit. The prompt is measured as if one or several
// requests were pending, since the count is known only after the turn.
func (b *Bridge) over(n int, approvals []chat.PendingApproval) bool {
	if b.Limit <= 0 {
		return false
	}
	if len(approvals) > 0 {
		n += max(len(b.Texts.Approvals(approvals, 1)), len(b.Texts.Approvals(approvals, 2)))
	}
	return n > b.Limit
}

func (b *Bridge) overLimit() error {
	return errors.New("reply exceeds the " + b.Name + " bridge limit")
}

// Deliver answers the message with id and sends the answer once. Each step is
// recorded under id: a message already answered, or whose reply may have been
// sent, is never answered or sent again, and an interrupted send is reported
// rather than retried. A failed answer is still sent and then returned.
func (b *Bridge) Deliver(ctx context.Context, id string, answer func(context.Context) (Reply, error), send func(context.Context, Reply) error) error {
	fresh, err := b.Accept(id)
	if !fresh || err != nil {
		return err
	}
	return b.Finish(ctx, id, answer, send)
}

// Accept records the message with id as taken, so that a restart never
// answers it again, and reports whether it is new and must be finished with
// Finish. A message whose send a restart interrupted is reported instead.
func (b *Bridge) Accept(id string) (bool, error) {
	delivery, err := b.Store.Delivery(id)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, errors.New("Cannot read " + b.Name + " delivery state")
	}
	switch delivery.State {
	case "sending":
		if err := b.Store.UpdateDelivery(id, "failed-or-unknown", delivery.Reply, errors.New("service interrupted during send")); err != nil {
			return false, err
		}
		return false, errors.New(b.Name + " reply delivery is uncertain; see local conversation history")
	case "":
		accepted, err := b.Store.AcceptDelivery(id, "processing")
		if err != nil {
			return false, errors.New("Cannot save " + b.Name + " message")
		}
		return accepted, nil
	}
	return false, nil
}

// Finish answers the message with id, which Accept took, and sends the answer
// once, as Deliver does.
func (b *Bridge) Finish(ctx context.Context, id string, answer func(context.Context) (Reply, error), send func(context.Context, Reply) error) error {
	reply, answerErr := answer(ctx)
	if ctx.Err() != nil {
		return errors.Join(ctx.Err(), b.Store.UpdateDelivery(id, "cancelled", reply.Text, ctx.Err()))
	}
	if err := b.Store.UpdateDelivery(id, "sending", reply.Text, nil); err != nil {
		return errors.New("Cannot save " + b.Name + " reply")
	}
	err := send(ctx, reply)
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
