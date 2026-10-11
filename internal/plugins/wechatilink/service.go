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
	if approvalID, approved, ok := parseApprovalCommand(trimmed); ok {
		return s.handleApproval(ctx, senderID, approvalID, approved, c.IsOwner(senderID))
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
	var pendingApprovalID string
	var pendingToolName string

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
			pendingApprovalID = e.ApprovalID
			pendingToolName = e.ToolName
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
	if pendingApprovalID != "" {
		prompt := fmt.Sprintf("\n\n⚠️ 【操作审批提醒】\nAgent 申请执行操作: %s\n审批 ID: %s\n如需允许，请回复: 批准 %s\n如需拒绝，请回复: 拒绝 %s",
			pendingToolName, pendingApprovalID, pendingApprovalID, pendingApprovalID)
		result += prompt
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

func (s *Service) handleApproval(ctx context.Context, senderID, approvalID string, approved, owner bool) (string, error) {
	var convID string
	_ = s.Store.Setting("wechat-ilink-conv:"+senderID, &convID)
	if convID == "" {
		return "未找到当前会话上下文", nil
	}

	if len(approvalID) != 32 {
		return fmt.Sprintf("⚠️ 审批 ID 格式不正确（需为 32 位字符，当前: %s）", approvalID), nil
	}

	input := chat.ChatRequest{
		ID:    convID,
		Owner: owner,
		Approval: &struct {
			ID       string `json:"id"`
			Approved bool   `json:"approved"`
		}{
			ID:       approvalID,
			Approved: approved,
		},
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

	if err != nil {
		if errors.Is(err, chat.ErrStaleApproval) || errors.Is(err, sql.ErrNoRows) {
			return fmt.Sprintf("⚠️ 审批指令无效或该审批已过期（ID: %s）", approvalID), nil
		}
		return "", err
	}

	out := reply.String()
	if out != "" {
		return fmt.Sprintf("%s操作（ID: %s）。\n\n%s", action, approvalID, out), nil
	}
	return fmt.Sprintf("%s操作（ID: %s）。", action, approvalID), nil
}

func parseApprovalCommand(text string) (approvalID string, approved bool, ok bool) {
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

	for _, p := range prefixes {
		if strings.HasPrefix(lower, p.prefix) {
			rest := strings.TrimSpace(text[len(p.prefix):])
			if rest != "" {
				return rest, p.approved, true
			}
		}
	}
	return "", false, false
}
