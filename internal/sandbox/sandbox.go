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
	// minMemoryMiB is the least memory a shell and Python start in reliably.
	minMemoryMiB = 64
)

// Settings is the sandbox section of config.yaml.
type Settings struct {
	Enabled bool   `mapstructure:"enabled"`
	Runtime string `mapstructure:"runtime"`
	Image   string `mapstructure:"image"`
	// Network "none" cuts the container off from every network; empty keeps
	// the runtime's default, which reaches the internet.
	Network string `mapstructure:"network"`
	// CPUs and Memory (e.g. 512m, 2g) cap one command; zero and empty keep
	// the runtime's defaults.
	CPUs   int    `mapstructure:"cpus"`
	Memory string `mapstructure:"memory"`
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
	_, err := s.limits()
	return err
}

func (s Settings) limits() (container.Limits, error) {
	l := container.Limits{Network: s.Network, CPUs: s.CPUs}
	if s.Network != "" && s.Network != container.NoNetwork {
		return l, errors.New(`sandbox.network must be "none" or empty`)
	}
	if s.CPUs < 0 {
		return l, errors.New("sandbox.cpus must be a whole number of CPUs, or 0 for the runtime's default")
	}
	if s.Memory != "" {
		mib, err := container.ParseMemory(s.Memory)
		if err != nil || mib < minMemoryMiB {
			return l, fmt.Errorf("sandbox.memory must be a size of at least %dm, such as 512m or 2g, or empty", minMemoryMiB)
		}
		l.MemoryMiB = mib
	}
	return l, nil
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
	Limits  container.Limits
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
	limits, _ := s.limits()
	return &Sandbox{Runtime: r, Image: s.Image, Limits: limits, Root: filepath.Join(dataDir, "sandbox")}, nil
}

// Offline reports whether commands run without any network.
func (b *Sandbox) Offline() bool { return b.Limits.Network == container.NoNetwork }

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
	spec := container.Spec{Name: name, Image: b.Image, Command: []string{"sh", "-c", command}, Mounts: []container.Mount{{Source: workspace, Target: Workdir}}, Workdir: Workdir, Limits: b.Limits}
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
