package app

import (
	"context"
	"github.com/fdkevin0/mob/internal/plugins/telegram"
)

// restartTelegram is called under plugins.mu; the replacement waits for the
// previous poller to release its connection, so configuration changes cannot race.
func (s *Server) restartTelegram(c telegram.Config) {
	if s.plugins.cancel != nil {
		s.plugins.cancel()
	}
	previous := s.plugins.done
	s.plugins.generation++
	generation := s.plugins.generation
	s.plugins.status = "Disabled"
	if !c.Enabled {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.plugins.cancel = cancel
	s.plugins.done = done
	s.plugins.status = "Connecting…"
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
			if s.plugins.generation == generation {
				s.plugins.status = text
			}
		}
		(&telegram.Service{Store: s.Store, Conversation: s.ConversationService}).Loop(ctx, c, status)
	}()
}
