package app

import (
	"errors"

	"github.com/fdkevin0/mob/internal/configuration"
)

// ReloadConfiguration accepts a changed config.yaml. Providers reload from
// providers.json on their own; demo mode is fixed for a process.
func (s *Server) ReloadConfiguration(next configuration.Environment) error {
	if next.Demo != s.Providers.Demo {
		return errors.New("demo changes require a restart; current configuration retained")
	}
	return nil
}
