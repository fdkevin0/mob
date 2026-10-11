package app

import (
	"errors"
	"github.com/fdkevin0/mob/internal/configuration"
)

func (s *Server) ReloadConfiguration(next configuration.Environment) error {
	s.plugins.mu.Lock()
	defer s.plugins.mu.Unlock()
	if s.plugins.closed {
		return errors.New("service is stopping")
	}
	provider, err := s.Configuration.ReplaceBase(next.Provider, next.KeySource)
	if err != nil {
		return err
	}
	s.SetProvider(provider)
	return nil
}
