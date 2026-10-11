package app

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/fdkevin0/mob/internal/configuration"
	"github.com/fdkevin0/mob/internal/sandbox"
)

// ReloadConfiguration accepts a changed config.yaml. Providers reload from
// providers.json on their own; demo mode is fixed for a process.
func (s *Server) ReloadConfiguration(next configuration.Environment) error {
	if next.Demo != s.Providers.Demo {
		return errors.New("demo changes require a restart; current configuration retained")
	}
	s.SetToolSteps(next.MaxToolSteps)
	if s.MCP.Configure(next.MCPServers) {
		if err := s.extensions.Reload("mcp"); err != nil {
			return err
		}
	}
	return s.ApplySandbox(next.Sandbox, next.Dir)
}

// ApplySandbox gives later turns the sandbox settings describe; a disabled
// sandbox withdraws the tool. An enabled one that cannot run is logged, and
// the model is told why when it tries.
func (s *Server) ApplySandbox(settings sandbox.Settings, dataDir string) error {
	if settings == s.sandbox {
		return nil
	}
	box, err := sandbox.New(settings, dataDir)
	if err != nil {
		return err
	}
	s.sandbox = settings
	if box == nil {
		s.SetSandbox(nil)
		return nil
	}
	s.SetSandbox(box)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := box.Runtime.Check(ctx); err != nil {
			log.Printf("Sandbox enabled but not ready: %s", err)
		}
	}()
	return nil
}
