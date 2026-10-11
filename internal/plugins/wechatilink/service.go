package wechatilink

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
)

// Service coordinates message polling, session tracking, and execution for WeChat iLink.
type Service struct {
	Store        *chat.Store
	Conversation *chat.ConversationService
}

// ProcessMessage processes a single WeChat message, interacts with the Agent, and returns the response.
func (s *Service) ProcessMessage(ctx context.Context, c Config, senderID, contextToken, text string) (string, error) {
	if !c.IsUserAllowed(senderID) {
		return "⚠️ 抱歉，当前微信账号未在授权白名单内。请在 Mob 桌面端或设置中添加您的用户 ID 并确认授权。", nil
	}

	trimmed := strings.TrimSpace(text)

	// 1. Natural language approval command check: "批准 <id>" / "拒绝 <id>"
	if answer, ok := parseApprovalCommand(trimmed); ok {
		return s.handleApproval(ctx, senderID, answer, c.IsOwner(senderID))
	}

	// 2. Normal conversation flow
	var convID string
	err := s.Store.Setting("wechat-ilink-conv:"+senderID, &convID)
	if err != nil || len(convID) != 32 {
		newConv, createErr := s.Store.Create()
		if createErr != nil {
			return "", fmt.Errorf("failed to create conversation: %w", createErr)
		}
		convID = newConv.ID
		_ = s.Store.SaveSetting("wechat-ilink-conv:"+senderID, convID)
	}

	var reply strings.Builder
	var approvals []chat.PendingApproval

	input := chat.ChatRequest{
		ID:        convID,
		RequestID: chat.NewID(),
		Text:      trimmed,
		Owner:     c.IsOwner(senderID),
	}

	turnErr := s.Conversation.Execute(ctx, input, func(e chat.Event) error {
		switch e.Kind {
		case chat.SegmentDelta:
			reply.WriteString(e.Text)
		case chat.ApprovalRequested:
			approvals = append(approvals, chat.PendingApproval{ID: e.ApprovalID, Tool: e.ToolName, Input: e.Input})
		}
		return nil
	})

	if turnErr != nil {
		if errors.Is(turnErr, context.Canceled) {
			return "（对话已取消）", nil
		}
		return "", turnErr
	}

	result := reply.String()
	if len(approvals) > 0 {
		result += approvalPrompt(approvals, len(s.Conversation.Pending(convID)))
	}

	if result == "" {
		result = "（无回复内容）"
	}
	return result, nil
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
	_ = s.Store.Setting(cursorKey, &cursor)

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
				// Show typing state while processing
				_ = client.SendTyping(ctx, msg.FromUserID, msg.ContextToken)

				replyText, procErr := s.ProcessMessage(ctx, c, msg.FromUserID, msg.ContextToken, textContent)
				if procErr == nil && replyText != "" {
					_ = client.SendMessage(ctx, msg.FromUserID, msg.ContextToken, replyText)
				}
			}
		}

		if res.GetUpdatesBuf != "" {
			cursor = res.GetUpdatesBuf
			_ = s.Store.SaveSetting(cursorKey, cursor)
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

func (s *Service) handleApproval(ctx context.Context, senderID string, answer chat.Answer, owner bool) (string, error) {
	approvalID, approved := answer.ID, answer.Approved
	var convID string
	_ = s.Store.Setting("wechat-ilink-conv:"+senderID, &convID)
	if convID == "" {
		return "未找到当前会话上下文", nil
	}

	if approvalID == "" {
		pending := s.Conversation.Pending(convID)
		switch len(pending) {
		case 0:
			return "当前没有待审批的请求。", nil
		case 1:
			approvalID = pending[0].ID
			answer.ID = approvalID
		default:
			var b strings.Builder
			b.WriteString("有多个待审批请求，请回复「批准 ID」或「拒绝 ID」：")
			for _, p := range pending {
				fmt.Fprintf(&b, "\n%s: %s", p.Tool, p.ID)
			}
			return b.String(), nil
		}
	}

	if len(approvalID) != 32 {
		return fmt.Sprintf("⚠️ 审批 ID 格式不正确（需为 32 位字符，当前: %s）", approvalID), nil
	}

	input := chat.ChatRequest{
		ID:       convID,
		Owner:    owner,
		Approval: &answer,
	}

	var reply strings.Builder
	err := s.Conversation.Execute(ctx, input, func(e chat.Event) error {
		if e.Kind == chat.SegmentDelta {
			reply.WriteString(e.Text)
		}
		return nil
	})

	action := "已批准"
	if !approved {
		action = "已拒绝"
	}

	var command *chat.CommandError
	if err != nil {
		if errors.Is(err, chat.ErrStaleApproval) || errors.Is(err, sql.ErrNoRows) {
			return fmt.Sprintf("⚠️ 审批指令无效或该审批已过期（ID: %s）", approvalID), nil
		}
		if errors.As(err, &command) {
			return "⚠️ " + command.Message, nil
		}
		return "", err
	}

	result := fmt.Sprintf("%s操作（ID: %s）。", action, approvalID)
	if answer.Remember != "" {
		result += "已记住这个决定，以后同类请求不再询问；可在网页端或终端用 /grants 查看和撤销。"
	}
	if out := reply.String(); out != "" {
		result += "\n\n" + out
	}
	return result, nil
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
