package telegram

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fdkevin0/mob/internal/channel"
	"github.com/fdkevin0/mob/internal/chat"
)

type Service struct {
	Store        *chat.Store
	Conversation *chat.ConversationService

	once sync.Once
	b    *channel.Bridge
	// drafts counts the drafts shown, so that each reply has its own.
	drafts atomic.Int64
	mu     sync.Mutex
	// stops stops the turn each draft shows, for a tap on its stop button.
	stops map[int64]func()
	// edits orders changes to approval buttons; decided holds, per message,
	// the buttons first seen and the approvals decided since.
	edits   sync.Mutex
	decided map[[2]int64]*decisions
}

type decisions struct {
	keyboard keyboard
	ids      map[string]bool
}

// placeholderDelay is how long a reply may take before Mob shows that it is
// being written; quick ones, such as commands, need no placeholder.
var placeholderDelay = time.Second

// draftRefresh is how often the placeholder is shown again; a draft lasts
// about 30 seconds and a typing status about five.
var draftRefresh, typingRefresh = 20 * time.Second, 4 * time.Second

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

// Loop answers the owner's messages until ctx is done. Replies run alongside
// polling, so the owner can stop one or decide an approval while another is
// being written.
func (s *Service) Loop(ctx context.Context, c Config, status func(string)) {
	var replies sync.WaitGroup
	defer replies.Wait()
	// previous closes once the message before has started; each message waits
	// for it, so that, say, a message after /new goes to the new conversation.
	previous := make(chan struct{})
	close(previous)
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
				// Replies to the app run alongside polling, so that a slow one
				// never holds back a stop further in the batch.
				var acknowledge func(context.Context)
				update, acknowledge = c.tapped(update)
				if acknowledge != nil {
					replies.Go(func() { acknowledge(ctx) })
				}
				if update.Stopped != nil && update.Stopped.Chat.ID == c.UserID {
					s.stop(update.Stopped.DraftID)
				}
				m := update.Message
				if m != nil && m.From.ID == c.UserID && m.Chat.ID == c.UserID && m.Chat.Type == "private" {
					if m.Text == "" && m.Caption != "" {
						m.Text = m.Caption
					}
					if m.Text == "" {
						if m.Media {
							// Best effort: the owner can send it again as text.
							replies.Go(func() { _ = c.Send(ctx, m.Chat.ID, mediaUnsupported) })
						}
					} else if fresh, err := s.bridge().Accept(messageID(botID, update)); err != nil {
						status(err.Error())
						accepted, readErr := s.Store.DeliveryAccepted(messageID(botID, update))
						if readErr != nil || !accepted {
							return
						}
					} else if fresh {
						replies.Add(1)
						started := make(chan struct{})
						go func(u Update, previous <-chan struct{}) {
							defer replies.Done()
							var once sync.Once
							start := func(func()) { once.Do(func() { close(started) }) }
							defer start(nil)
							select {
							case <-previous:
							case <-ctx.Done():
							}
							if err := s.finish(ctx, c, botID, u, start); err != nil {
								status(err.Error())
							}
						}(update, previous)
						previous = started
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
	s.once.Do(func() {
		// Drafts are numbered from the time, so that a tap on a draft shown
		// before Mob restarted matches none shown since.
		s.drafts.Store(time.Now().UnixMilli())
		s.b = &channel.Bridge{Name: "Telegram", Client: chat.ClientTelegram, Store: s.Store, Conversation: s.Conversation, Texts: texts, Limit: 32000}
	})
	return s.b
}

// stop stops the turn draft shows, for a tap on its stop button; a tap on a
// draft whose reply is done does nothing.
func (s *Service) stop(draft int64) {
	s.mu.Lock()
	stop := s.stops[draft]
	s.mu.Unlock()
	if stop != nil {
		stop()
	}
}

// showing records stop as stopping the turn draft shows, until done.
func (s *Service) showing(draft int64, stop func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stops == nil {
		s.stops = map[int64]func(){}
	}
	s.stops[draft] = stop
}

// done forgets the turn draft showed, once its answer is ready.
func (s *Service) done(draft int64) {
	s.mu.Lock()
	delete(s.stops, draft)
	s.mu.Unlock()
}

const mediaUnsupported = "Mob reads only text here for now; send photos, files and voice notes from the desktop app, or describe them in a message."

var texts = channel.Texts{
	Help: "Mob is connected. Send a message to chat. This computer must remain running.",
	Approvals: func(approvals []chat.PendingApproval, pending int) string {
		var b strings.Builder
		for _, a := range approvals {
			b.WriteString("\n\n**Approval needed**\n" + fence(chat.DescribeApproval(a.Tool, a.Input)) + "\nID: `" + a.ID + "`")
		}
		return b.String() + "\n\n" + decideHint(pending)
	},
	Busy:    "Still working on your last message. Send /stop to stop it, then send this again.",
	Stopped: "Stopped.",
	Stale:   func(id string) string { return "Approval " + id + " is unknown, expired, or already decided." },
	Failed: func(err error) string {
		return "\nMob: " + err.Error() + ". Open the desktop/TUI for the saved result."
	},
	Unsupported: "That command needs the desktop or terminal app.",
	Empty:       "Done. Open the local conversation for details.",
	Used: func(used []channel.Use) string {
		names := make([]string, len(used))
		for i, u := range used {
			names[i] = u.String()
		}
		return "\n\n(Used " + strings.Join(names, ", ") + ". Details are in the local conversation.)"
	},
}

// fence is text as a Markdown code block, fenced so nothing in it ends the block.
func fence(text string) string {
	longest, run := 0, 0
	for _, r := range text {
		if r == '`' {
			run++
			longest = max(longest, run)
		} else {
			run = 0
		}
	}
	f := strings.Repeat("`", max(3, longest+1))
	return f + "\n" + text + "\n" + f
}

func messageID(botID string, u Update) string {
	return "tg:" + botID + ":" + strconv.FormatInt(u.ID, 10)
}

func conversationKey(botID string, c Config) string {
	return "telegram-conversation:" + botID + ":" + strconv.FormatInt(c.UserID, 10)
}

// message is the owner's message in update u, as the bridge reads it.
func message(c Config, botID string, u Update) channel.Message {
	text := u.Message.Text
	if text == "/start" {
		text = "/help"
	}
	return channel.Message{
		ID:  messageID(botID, u),
		Key: conversationKey(botID, c),
		// The bot answers only its configured user, who owns this Mob.
		Owner: true,
		Text:  text,
	}
}

// Message answers the owner's message in update u and sends the reply once.
func (s *Service) Message(ctx context.Context, c Config, botID string, u Update) error {
	fresh, err := s.bridge().Accept(messageID(botID, u))
	if !fresh || err != nil {
		return err
	}
	return s.finish(ctx, c, botID, u, nil)
}

// finish answers the owner's message in update u, which the bridge accepted,
// calling started as the bridge does, and showing that the reply is being written until it is sent.
func (s *Service) finish(ctx context.Context, c Config, botID string, u Update, started func(stop func())) error {
	b, m := s.bridge(), message(c, botID, u)
	draft := s.drafts.Add(1)
	m.Started = func(stop func()) {
		if stop != nil {
			s.showing(draft, stop)
		}
		if started != nil {
			started(stop)
		}
	}
	answer := func(ctx context.Context) (channel.Reply, error) {
		defer s.done(draft)
		// The placeholder's requests end with the answer, so that none holds
		// back the reply.
		placeholding, cancel := context.WithCancel(ctx)
		shown := make(chan struct{})
		go func() { defer close(shown); s.placeholder(placeholding, c, u.Message.Chat.ID, draft) }()
		defer func() { cancel(); <-shown }()
		return b.Answer(ctx, m)
	}
	return b.Finish(ctx, m.ID, answer, func(ctx context.Context, r channel.Reply) error {
		err := c.Send(ctx, u.Message.Chat.ID, r.Text, r.Approvals...)
		if r.Settled != "" && u.Message.Buttons != nil {
			s.settle(ctx, c, *u.Message.Buttons, r.Settled)
		}
		return err
	})
}

// settle removes the buttons for approval id, which no longer waits for a
// decision, from the message a tap found them on, along with those for the
// approvals settled before. Best effort: a button left behind only answers
// that it was decided.
func (s *Service) settle(ctx context.Context, c Config, b shown, id string) {
	s.edits.Lock()
	defer s.edits.Unlock()
	if s.decided == nil {
		s.decided = map[[2]int64]*decisions{}
	}
	key := [2]int64{b.Chat, b.Message}
	d := s.decided[key]
	if d == nil {
		d = &decisions{keyboard: b.Keyboard, ids: map[string]bool{}}
		s.decided[key] = d
	}
	d.ids[id] = true
	left := d.keyboard.decided(d.ids)
	if len(left.Rows) == 0 {
		delete(s.decided, key)
	}
	_ = c.Call(ctx, "editMessageReplyMarkup", map[string]any{"chat_id": b.Chat, "message_id": b.Message, "reply_markup": left}, nil)
}

// placeholder shows a draft with a stop button while a reply is written,
// once it takes longer than placeholderDelay, until ctx is done. Where drafts
// are unavailable it shows the bot typing instead. Both are best effort.
func (s *Service) placeholder(ctx context.Context, c Config, chatID, draftID int64) {
	wait, typing := placeholderDelay, false
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if !typing {
			typing = c.Draft(ctx, chatID, draftID) != nil
		}
		if typing {
			_ = c.Typing(ctx, chatID)
			wait = typingRefresh
		} else {
			wait = draftRefresh
		}
	}
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
