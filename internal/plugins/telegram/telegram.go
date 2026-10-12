package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
)

type Config struct {
	Transport http.RoundTripper `json:"-"`
	Enabled   bool              `json:"enabled"`
	Token     string            `json:"token,omitempty"`
	HasToken  bool              `json:"hasToken,omitempty"`
	UserID    int64             `json:"userId"`
}

var tokenPattern = regexp.MustCompile(`^[0-9]+:[a-zA-Z0-9_-]+$`)

func (c Config) Validate() error {
	if c.Enabled && (!tokenPattern.MatchString(c.Token) || c.UserID <= 0) {
		return errors.New("Telegram: Bot Token and allowed user ID are required")
	}
	return nil
}
func (c Config) Public() Config { c.HasToken = c.Token != ""; c.Token = ""; return c }
func (c Config) Call(ctx context.Context, method string, input, result any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.telegram.org/bot"+c.Token+"/"+method, bytes.NewReader(body))
	if err != nil {
		return errors.New("invalid Telegram request")
	}
	req.Header.Set("Content-Type", "application/json")
	cl := http.Client{Transport: c.Transport, Timeout: 40 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := cl.Do(req)
	if err != nil {
		return errors.New("Telegram connection failed")
	}
	defer resp.Body.Close()
	var reply struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Code   int             `json:"error_code"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&reply) != nil {
		return errors.New("invalid Telegram response")
	}
	if !reply.OK {
		return &apiError{Status: resp.StatusCode, Code: reply.Code}
	}
	if result != nil {
		return json.Unmarshal(reply.Result, result)
	}
	return nil
}

// apiError is a request the Bot API refused.
type apiError struct{ Status, Code int }

func (e *apiError) Error() string {
	return fmt.Sprintf("Telegram HTTP %d / error %d; check token, webhook, bot permissions or another polling client", e.Status, e.Code)
}

// rejected reports whether the Bot API refused the request as malformed,
// so it surely did not act on it.
func rejected(err error) bool {
	var refused *apiError
	return errors.As(err, &refused) && refused.Code == 400
}

func (c Config) Test(ctx context.Context) (any, error) {
	var me struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
	}
	if err := c.Call(ctx, "getMe", nil, &me); err != nil {
		return nil, err
	}
	var hook struct {
		URL string `json:"url"`
	}
	if err := c.Call(ctx, "getWebhookInfo", nil, &hook); err != nil {
		return nil, err
	}
	if hook.URL != "" {
		return nil, errors.New("Telegram bot has an active webhook; remove it in the existing deployment before enabling local polling")
	}
	return me, nil
}

type Message struct {
	ID   int64  `json:"message_id"`
	Text string `json:"text"`
	// Caption is the text sent with a photo, file or other media.
	Caption string `json:"caption"`
	// Media is set when the message carries something other than text,
	// such as a photo, file, voice note or sticker.
	Media bool `json:"-"`
	// Tap says the message stands for a tap on a button, whose data is Text.
	Tap bool `json:"-"`
	// Buttons, for a tap, is the message holding them.
	Buttons *shown `json:"-"`
	From    struct {
		ID int64 `json:"id"`
	} `json:"from"`
	Chat struct {
		ID   int64  `json:"id"`
		Type string `json:"type"`
	} `json:"chat"`
}

// UnmarshalJSON notes whether the message carries media, without decoding it.
func (m *Message) UnmarshalJSON(data []byte) error {
	type message Message
	var fields struct {
		message
		Photo     json.RawMessage `json:"photo"`
		Document  json.RawMessage `json:"document"`
		Voice     json.RawMessage `json:"voice"`
		Audio     json.RawMessage `json:"audio"`
		Video     json.RawMessage `json:"video"`
		VideoNote json.RawMessage `json:"video_note"`
		Animation json.RawMessage `json:"animation"`
		Sticker   json.RawMessage `json:"sticker"`
		Location  json.RawMessage `json:"location"`
		Contact   json.RawMessage `json:"contact"`
	}
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*m = Message(fields.message)
	for _, media := range []json.RawMessage{fields.Photo, fields.Document, fields.Voice, fields.Audio, fields.Video, fields.VideoNote, fields.Animation, fields.Sticker, fields.Location, fields.Contact} {
		m.Media = m.Media || len(media) > 0
	}
	return nil
}

type Update struct {
	ID      int64    `json:"update_id"`
	Message *Message `json:"message"`
	// CallbackQuery is a tap on a button.
	CallbackQuery *struct {
		ID   string `json:"id"`
		Data string `json:"data"`
		From struct {
			ID int64 `json:"id"`
		} `json:"from"`
		// Message is the message whose button was tapped.
		Message *struct {
			ID   int64 `json:"message_id"`
			Chat struct {
				ID int64 `json:"id"`
			} `json:"chat"`
			ReplyMarkup *keyboard `json:"reply_markup"`
		} `json:"message"`
	} `json:"callback_query"`
	// Stopped is a tap on the stop button of a draft showing a reply in progress.
	Stopped *struct {
		Chat struct {
			ID int64 `json:"id"`
		} `json:"chat"`
		DraftID int64 `json:"draft_id"`
	} `json:"stopped_message_generation"`
}

type keyboard struct {
	Rows [][]button `json:"inline_keyboard"`
}

type button struct {
	Text string `json:"text"`
	Data string `json:"callback_data"`
}

// tapped makes the owner's tap on a button the private message it stands for:
// the command, or the token of a command, its data holds. acknowledge answers the tap, best effort; it is nil for a tap
// that is not the owner's, and may run alongside polling.
func (c Config) tapped(u Update) (_ Update, acknowledge func(context.Context)) {
	q := u.CallbackQuery
	if q == nil || q.From.ID != c.UserID {
		return u, nil
	}
	acknowledge = func(ctx context.Context) {
		// An unanswered tap only keeps its spinner a little longer.
		_ = c.Call(ctx, "answerCallbackQuery", map[string]any{"callback_query_id": q.ID}, nil)
	}
	if !strings.HasPrefix(q.Data, "/") && !strings.HasPrefix(q.Data, "#") {
		return u, acknowledge
	}
	m := &Message{Text: q.Data, Tap: true}
	m.From.ID, m.Chat.ID, m.Chat.Type = c.UserID, c.UserID, "private"
	if q.Message != nil && q.Message.ReplyMarkup != nil {
		m.Buttons = &shown{Chat: q.Message.Chat.ID, Message: q.Message.ID, Keyboard: *q.Message.ReplyMarkup}
	}
	u.Message = m
	return u, acknowledge
}

// shown is a message's buttons as a tap saw them.
type shown struct {
	Chat, Message int64
	Keyboard      keyboard
}

// decided is the keyboard less the rows of buttons for the decided approvals.
func (k keyboard) decided(ids map[string]bool) keyboard {
	rows := [][]button{}
	for _, row := range k.Rows {
		if len(row) == 0 || len(strings.Fields(row[0].Data)) < 2 || !ids[strings.Fields(row[0].Data)[1]] {
			rows = append(rows, row)
		}
	}
	return keyboard{Rows: rows}
}

func (c Config) Updates(ctx context.Context, offset int64) ([]Update, error) {
	var result []Update
	err := c.Call(ctx, "getUpdates", map[string]any{"offset": offset, "timeout": 25, "limit": 20, "allowed_updates": []string{"message", "callback_query", "stopped_message_generation"}}, &result)
	return result, err
}

// Send sends Markdown text formatted as Telegram shows it, with rows of
// buttons under its last message. A message Telegram cannot format is sent as
// plain text.
func (c Config) Send(ctx context.Context, chatID int64, text string, rows ...[]button) error {
	list := chunks(text, chunkLimit)
	for i, part := range list {
		message := map[string]any{"chat_id": chatID, "text": part.HTML, "parse_mode": "HTML", "link_preview_options": map[string]any{"is_disabled": true}}
		if i == len(list)-1 && len(rows) > 0 {
			message["reply_markup"] = keyboard{Rows: rows}
		}
		err := c.Call(ctx, "sendMessage", message, nil)
		if rejected(err) {
			delete(message, "parse_mode")
			message["text"] = part.Plain
			err = c.Call(ctx, "sendMessage", message, nil)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// Draft shows that a reply is being written, with a button to stop it, until
// a message is sent or about 30 seconds pass.
func (c Config) Draft(ctx context.Context, chatID, draftID int64) error {
	return c.Call(ctx, "sendMessageDraft", map[string]any{"chat_id": chatID, "draft_id": draftID, "text": "", "can_stop": true}, nil)
}

// Typing shows that the bot is typing for about five seconds.
func (c Config) Typing(ctx context.Context, chatID int64) error {
	return c.Call(ctx, "sendChatAction", map[string]any{"chat_id": chatID, "action": "typing"}, nil)
}

// buttons is one Approve/Always allow/Deny row per approval; a tap arrives as
// a callback query whose data is the matching command.
func buttons(approvals []chat.PendingApproval) [][]button {
	rows := make([][]button, len(approvals))
	for i, a := range approvals {
		label := ""
		if len(approvals) > 1 {
			label = " " + a.Tool
		}
		rows[i] = []button{
			{Text: "Approve" + label, Data: "/approve " + a.ID},
			{Text: "Always allow" + label, Data: "/approve " + a.ID + " " + chat.RememberAlways},
			{Text: "Deny" + label, Data: "/deny " + a.ID},
		}
	}
	return rows
}
