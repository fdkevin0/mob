// Package sandbox runs Mob's model-directed commands inside a container, so
// a command may do anything there without reaching the host. Each
// conversation keeps one workspace directory, mounted at /workspace; nothing
// else on the host is visible to the container.
package sandbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fdkevin0/mob/internal/container"
)

const (
	// DefaultImage has a shell, Python and apt, enough for most work.
	DefaultImage = "python:3.13-slim"
	// Workdir is where a conversation's workspace appears in the container.
	Workdir = "/workspace"
	// DefaultTimeout and MaxTimeout bound one command.
	DefaultTimeout = 2 * time.Minute
	MaxTimeout     = 5 * time.Minute
	// outputCap bounds each of stdout and stderr returned to the model.
	outputCap = 16 << 10
)

// Settings is the sandbox section of config.yaml.
type Settings struct {
	Enabled bool   `mapstructure:"enabled"`
	Runtime string `mapstructure:"runtime"`
	Image   string `mapstructure:"image"`
}

// Validate rejects settings that could never run, without naming their values.
func (s Settings) Validate() error {
	if s.Runtime != "" {
		if _, err := container.New(s.Runtime); err != nil {
			return errors.New("sandbox.runtime must be " + strings.Join(container.Names, ", ") + " or empty")
		}
	}
	if s.Image == "" || strings.HasPrefix(s.Image, "-") || strings.ContainsAny(s.Image, " \t\r\n") {
		return errors.New("sandbox.image must be an image reference")
	}
	return nil
}

// Result is what one command produced. A nonzero exit is a result, not an error.
type Result struct {
	ExitCode  int    `json:"exitCode"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	TimedOut  bool   `json:"timedOut,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

// Sandbox runs commands in fresh containers that share a per-conversation workspace.
type Sandbox struct {
	Runtime *container.Runtime
	Image   string
	// Root holds one workspace directory per conversation.
	Root string

	mu     sync.Mutex
	pulled bool
}

// New returns the sandbox the settings describe, or nil when it is disabled.
func New(s Settings, dataDir string) (*Sandbox, error) {
	if !s.Enabled {
		return nil, nil
	}
	if err := s.Validate(); err != nil {
		return nil, err
	}
	r, err := container.New(s.Runtime)
	if err != nil {
		return nil, err
	}
	return &Sandbox{Runtime: r, Image: s.Image, Root: filepath.Join(dataDir, "sandbox")}, nil
}

// Workspace is the host directory a conversation's containers share.
func (b *Sandbox) Workspace(conversationID string) (string, error) {
	if conversationID == "" || strings.Trim(conversationID, "0123456789abcdefABCDEF") != "" {
		return "", errors.New("invalid conversation ID")
	}
	dir := filepath.Join(b.Root, conversationID)
	return dir, os.MkdirAll(dir, 0700)
}

// Exec runs command with sh in a new container. The image is pulled on first
// use within ctx; timeout then bounds the command alone.
func (b *Sandbox) Exec(ctx context.Context, conversationID, command string, timeout time.Duration) (Result, error) {
	if strings.TrimSpace(command) == "" {
		return Result{}, errors.New("command is required")
	}
	if timeout <= 0 || timeout > MaxTimeout {
		timeout = DefaultTimeout
	}
	workspace, err := b.Workspace(conversationID)
	if err != nil {
		return Result{}, err
	}
	if err := b.pull(ctx); err != nil {
		return Result{}, err
	}
	name := "mob-" + random()
	spec := container.Spec{Name: name, Image: b.Image, Command: []string{"sh", "-c", command}, Mounts: []container.Mount{{Source: workspace, Target: Workdir}}, Workdir: Workdir}
	run, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	stdout, stderr := &capped{}, &capped{}
	code, err := b.Runtime.Stream(run, spec, stdout, stderr)
	result := Result{ExitCode: code, Stdout: stdout.String(), Stderr: stderr.String(), Truncated: stdout.over || stderr.over}
	if run.Err() != nil {
		// The interrupted CLI may leave its container running.
		cleanup, done := context.WithTimeout(context.Background(), 30*time.Second)
		defer done()
		_ = b.Runtime.Remove(cleanup, name)
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		result.TimedOut = true
		return result, nil
	}
	if err != nil {
		return result, fmt.Errorf("%w: %v", container.ErrUnavailable, err)
	}
	return result, nil
}

// pull fetches the image once per sandbox. A failed pull is not fatal while
// the runtime answers: the image may already be local (registries rate-limit
// and go offline), and run reports a missing one itself.
func (b *Sandbox) pull(ctx context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pulled {
		return nil
	}
	err := b.Runtime.Pull(ctx, b.Image)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		return b.Runtime.Check(ctx)
	}
	b.pulled = true
	return nil
}

func random() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// capped keeps the first outputCap bytes written to it.
type capped struct {
	b    strings.Builder
	over bool
}

func (c *capped) Write(p []byte) (int, error) {
	n := len(p)
	if room := outputCap - c.b.Len(); room < n {
		c.over = true
		p = p[:max(room, 0)]
	}
	c.b.Write(p)
	// Claim the whole write so the CLI keeps running past the cap.
	return n, nil
}

func (c *capped) String() string { return strings.ToValidUTF8(c.b.String(), "\uFFFD") }
