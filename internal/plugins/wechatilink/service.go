package wechatilink

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/channel"
	"github.com/fdkevin0/mob/internal/chat"
)

// Service answers WeChat iLink messages.
type Service struct {
	Store        *chat.Store
	Conversation *chat.ConversationService
}

func (s *Service) bridge() *channel.Bridge {
	return &channel.Bridge{Name: "WeChat iLink", Client: chat.ClientWeChat, Store: s.Store, Conversation: s.Conversation, Texts: texts}
}

var texts = channel.Texts{
	Help:      "Mob 已连接，直接发消息即可聊天。这台电脑需要保持运行。",
	Approvals: approvalPrompt,
	Decided: func(a chat.Answer) string {
		if !a.Approved {
			return fmt.Sprintf("已拒绝操作（ID: %s）。", a.ID)
		}
		result := fmt.Sprintf("已批准操作（ID: %s）。", a.ID)
		if a.Remember != "" {
			result += "已记住这个决定，以后同类请求不再询问；可回复 /grants 查看，/revoke 撤销。"
		}
		return result
	},
	Stale: func(id string) string {
		return fmt.Sprintf("⚠️ 审批指令无效或该审批已过期（ID: %s）", id)
	},
	Failed: func(err error) string {
		if command := (*chat.CommandError)(nil); errors.As(err, &command) {
			return "\n⚠️ " + command.Message
		}
		if errors.Is(err, context.Canceled) {
			return "\n（对话已取消）"
		}
		return "\n⚠️ Mob 出错：" + err.Error() + "。完整结果可在桌面端或终端查看。"
	},
	Unsupported: "这个命令需要在桌面端或终端使用。",
	Empty:       "（无回复内容）",
	Used: func(used []channel.Use) string {
		names := make([]string, len(used))
		for i, u := range used {
			names[i] = u.String()
		}
		return "\n\n（使用了 " + strings.Join(names, "、") + "，详情见桌面端会话。）"
	},
}

// message is what senderID wrote, as the bridge reads it; id is empty for a
// message that is not delivered from WeChat.
func message(c Config, id, senderID, text string) channel.Message {
	return channel.Message{ID: id, Key: "wechat-ilink-conv:" + senderID, Owner: c.IsOwner(senderID), Text: strings.TrimSpace(text)}
}

// ProcessMessage answers a message from senderID.
func (s *Service) ProcessMessage(ctx context.Context, c Config, senderID, contextToken, text string) (string, error) {
	reply, err := s.answer(ctx, c, senderID, message(c, "", senderID, text))
	return reply.Text, err
}

// answer refuses senders not allowed to use the bot and reads 批准 and 拒绝
// as /approve and /deny.
func (s *Service) answer(ctx context.Context, c Config, senderID string, m channel.Message) (channel.Reply, error) {
	if !c.IsUserAllowed(senderID) {
		return channel.Reply{Text: "⚠️ 抱歉，当前微信账号未在授权白名单内。请在 Mob 桌面端或设置中添加您的用户 ID 并确认授权。"}, nil
	}
	if answer, ok := parseApprovalCommand(m.Text); ok {
		command, refusal := s.decision(m.Key, answer)
		if command == "" {
			return channel.Reply{Text: refusal}, nil
		}
		m.Text = command
	}
	return s.bridge().Answer(ctx, m)
}

// decision is the command for answer, or why there is none.
func (s *Service) decision(key string, answer chat.Answer) (command, refusal string) {
	if answer.ID == "" {
		var convID string
		_ = s.Store.Setting(key, &convID)
		pending := s.Conversation.Pending(convID)
		switch len(pending) {
		case 0:
			return "", "当前没有待审批的请求。"
		case 1:
			answer.ID = pending[0].ID
		default:
			var b strings.Builder
			b.WriteString("有多个待审批请求，请回复「批准 ID」或「拒绝 ID」：")
			for _, p := range pending {
				fmt.Fprintf(&b, "\n%s: %s", p.Tool, p.ID)
			}
			return "", b.String()
		}
	}
	if len(answer.ID) != 32 {
		return "", fmt.Sprintf("⚠️ 审批 ID 格式不正确（需为 32 位字符，当前: %s）", answer.ID)
	}
	if !answer.Approved {
		// A command is one line; a reason on several would be sent as chat.
		return strings.TrimSpace("/deny " + answer.ID + " " + strings.Join(strings.Fields(answer.Reason), " ")), ""
	}
	return strings.TrimSpace("/approve " + answer.ID + " " + answer.Remember), ""
}

// Loop runs the long-polling loop against WeChat iLink getupdates.
func (s *Service) Loop(ctx context.Context, c Config, status func(string)) {
	if !c.Enabled || c.BotToken == "" {
		status("Disabled or missing Bot Token")
		return
	}

	client := NewClient(c, nil)
	cursorKey := "wechat-ilink-cursor:" + c.BotID
	var cursor string
	if err := s.Store.Setting(cursorKey, &cursor); err != nil {
		status("Cannot load WeChat update cursor")
		return
	}

	status("Connected · Polling WeChat messages")

	for ctx.Err() == nil {
		res, err := client.GetUpdates(ctx, cursor)
		if err != nil {
			status("Polling error: " + err.Error())
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
			continue
		}

		status("Active · Polling WeChat messages")

		for _, msg := range res.Msgs {
			if ctx.Err() != nil {
				return
			}
			// Extract text from item_list
			var textContent string
			for _, item := range msg.ItemList {
				if item.Type == 1 && item.TextItem != nil {
					textContent += item.TextItem.Text
				}
			}

			if strings.TrimSpace(textContent) != "" && msg.FromUserID != "" {
				if id, err := s.deliver(ctx, c, client, msg, textContent); err != nil {
					status(err.Error())
					if accepted, readErr := s.Store.DeliveryAccepted(id); readErr != nil || !accepted {
						return
					}
				}
			}
		}

		if res.GetUpdatesBuf != "" {
			if err := s.Store.SaveSetting(cursorKey, res.GetUpdatesBuf); err != nil {
				status("Cannot save WeChat update cursor")
				return
			}
			cursor = res.GetUpdatesBuf
		}
	}
}

// approvalPrompt shows what each requested call would do and how to answer,
// given how many requests the conversation has pending.
func approvalPrompt(approvals []chat.PendingApproval, pending int) string {
	var b strings.Builder
	for _, a := range approvals {
		fmt.Fprintf(&b, "\n\n⚠️ 【操作审批】%s\n审批 ID: %s", chat.DescribeApproval(a.Tool, a.Input), a.ID)
	}
	if pending > 1 {
		b.WriteString("\n\n有多个待审批请求，请回复「批准 ID」或「拒绝 ID 原因」，原因可省略；「批准 ID 总是」以后同类请求不再询问。")
	} else {
		b.WriteString("\n\n允许请回复「批准」，拒绝请回复「拒绝」，可在后面写上原因。回复「批准 总是」以后同类请求不再询问。")
	}
	return b.String()
}

// deliver answers msg and sends the reply once. A message without an ID
// cannot be recorded, so it is answered as it comes.
func (s *Service) deliver(ctx context.Context, c Config, client *Client, msg InboundMessage, text string) (id string, err error) {
	if msg.MsgID != "" {
		id = "wx:" + c.BotID + ":" + msg.MsgID
	}
	m := message(c, id, msg.FromUserID, text)
	send := func(ctx context.Context, r channel.Reply) error {
		return client.SendMessage(ctx, msg.FromUserID, msg.ContextToken, r.Text)
	}
	// Typing is only a hint; the reply goes out without it.
	_ = client.SendTyping(ctx, msg.FromUserID, msg.ContextToken)
	answer := func(ctx context.Context) (channel.Reply, error) { return s.answer(ctx, c, msg.FromUserID, m) }
	if id == "" {
		reply, err := answer(ctx)
		return id, errors.Join(send(ctx, reply), err)
	}
	return id, s.bridge().Deliver(ctx, id, answer, send)
}

// parseApprovalCommand reads "批准 [ID] [总是|本会话]" or "拒绝 [ID] [原因]".
// Without an ID it answers the only pending request; a denial's other text is
// its reason.
func parseApprovalCommand(text string) (answer chat.Answer, ok bool) {
	lower := strings.ToLower(text)
	prefixes := []struct {
		prefix   string
		approved bool
	}{
		{"批准", true},
		{"approve", true},
		{"允许", true},
		{"拒绝", false},
		{"reject", false},
		{"否决", false},
	}
	remember := map[string]string{"": "", "总是": chat.RememberAlways, "always": chat.RememberAlways, "本会话": chat.RememberConversation, "conversation": chat.RememberConversation}

	for _, p := range prefixes {
		if !strings.HasPrefix(lower, p.prefix) {
			continue
		}
		answer.Approved = p.approved
		rest := strings.TrimSpace(text[len(p.prefix):])
		if fields := strings.Fields(rest); len(fields) > 0 && len(fields[0]) == 32 {
			answer.ID = fields[0]
			rest = strings.TrimSpace(strings.TrimPrefix(rest, fields[0]))
		}
		if !p.approved {
			answer.Reason = rest
			return answer, true
		}
		how, known := remember[strings.ToLower(rest)]
		if !known {
			// Not an ID nor a known word: report it as a malformed ID.
			answer.ID = rest
		}
		answer.Remember = how
		return answer, true
	}
	return answer, false
}
