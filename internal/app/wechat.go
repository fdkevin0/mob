package app

import (
	"context"

	"github.com/fdkevin0/mob/internal/plugins/wechatilink"
)

// restartWechat is called under plugins.mu; the replacement waits for the
// previous poller to release its connection, so configuration changes cannot race.
func (s *Server) restartWechat(c wechatilink.Config) {
	if s.plugins.wechatCancel != nil {
		s.plugins.wechatCancel()
	}
	previous := s.plugins.wechatDone
	s.plugins.wechatGen++
	generation := s.plugins.wechatGen
	s.plugins.wechatStatus = "Disabled"
	if !c.Enabled || c.BotToken == "" {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.plugins.wechatCancel = cancel
	s.plugins.wechatDone = done
	s.plugins.wechatStatus = "Connecting…"
	go func() {
		defer close(done)
		if previous != nil {
			select {
			case <-previous:
			case <-ctx.Done():
				return
			}
		}
		status := func(text string) {
			s.plugins.mu.Lock()
			defer s.plugins.mu.Unlock()
			if s.plugins.wechatGen == generation {
				s.plugins.wechatStatus = text
			}
		}
		(&wechatilink.Service{Store: s.Store, Conversation: s.ConversationService}).Loop(ctx, c, status)
	}()
}
