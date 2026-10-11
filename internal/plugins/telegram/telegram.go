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
		return fmt.Errorf("Telegram HTTP %d / error %d; check token, webhook, bot permissions or another polling client", resp.StatusCode, reply.Code)
	}
	if result != nil {
		return json.Unmarshal(reply.Result, result)
	}
	return nil
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
	Text string `json:"text"`
	From struct {
		ID int64 `json:"id"`
	} `json:"from"`
	Chat struct {
		ID   int64  `json:"id"`
		Type string `json:"type"`
	} `json:"chat"`
}

type Update struct {
	ID      int64    `json:"update_id"`
	Message *Message `json:"message"`
	// CallbackQuery is a tap on an approval button.
	CallbackQuery *struct {
		ID   string `json:"id"`
		Data string `json:"data"`
		From struct {
			ID int64 `json:"id"`
		} `json:"from"`
	} `json:"callback_query"`
}

// tapped makes the owner's tap on an approval button the private message it
// stands for, answering the tap so Telegram stops showing it as loading.
func (c Config) tapped(ctx context.Context, u Update) Update {
	q := u.CallbackQuery
	if q == nil || q.From.ID != c.UserID {
		return u
	}
	// Best effort: an unanswered tap only keeps its spinner a little longer.
	_ = c.Call(ctx, "answerCallbackQuery", map[string]any{"callback_query_id": q.ID}, nil)
	if !strings.HasPrefix(q.Data, "/approve ") && !strings.HasPrefix(q.Data, "/deny ") {
		return u
	}
	m := &Message{Text: q.Data}
	m.From.ID, m.Chat.ID, m.Chat.Type = c.UserID, c.UserID, "private"
	u.Message = m
	return u
}

func (c Config) Updates(ctx context.Context, offset int64) ([]Update, error) {
	var result []Update
	err := c.Call(ctx, "getUpdates", map[string]any{"offset": offset, "timeout": 25, "limit": 20, "allowed_updates": []string{"message", "callback_query"}}, &result)
	return result, err
}

// Send sends text, with Approve and Deny buttons under its last chunk for
// each pending approval.
func (c Config) Send(ctx context.Context, chatID int64, text string, approvals ...chat.PendingApproval) error {
	// Chunk below Telegram's UTF-16 limit even when every character is supplementary.
	runes := []rune(text)
	for len(runes) > 0 {
		n := min(2000, len(runes))
		message := map[string]any{"chat_id": chatID, "text": string(runes[:n])}
		if n == len(runes) && len(approvals) > 0 {
			message["reply_markup"] = map[string]any{"inline_keyboard": buttons(approvals)}
		}
		if err := c.Call(ctx, "sendMessage", message, nil); err != nil {
			return err
		}
		runes = runes[n:]
	}
	return nil
}

// buttons is one Approve/Deny row per approval; a tap arrives as a callback
// query whose data is the matching command.
func buttons(approvals []chat.PendingApproval) [][]map[string]string {
	rows := make([][]map[string]string, len(approvals))
	for i, a := range approvals {
		label := ""
		if len(approvals) > 1 {
			label = " " + a.Tool
		}
		rows[i] = []map[string]string{
			{"text": "Approve" + label, "callback_data": "/approve " + a.ID},
			{"text": "Deny" + label, "callback_data": "/deny " + a.ID},
		}
	}
	return rows
}
