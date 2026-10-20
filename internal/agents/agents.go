// Package agents hands coding work to outside coding agents, such as Codex,
// over the Agent Client Protocol (ACP). Each task is a conversation the agent
// answers, working in its own git worktree of a project; the permissions it
// asks for are the owner's approvals, and Mob's own model manages the tasks.
package agents

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
)

// Preset is a coding agent Mob knows how to start.
type Preset struct {
	Name, Title string
	// Commands start the agent's ACP server; the first whose program is
	// installed is used.
	Commands [][]string
	// Mode is the session mode that lets the agent edit its working
	// directory and run commands there without asking.
	Mode string
	// SignIn tells the owner how to sign the agent in.
	SignIn string
	// Tally, for agents whose prompt responses do not say what they used,
	// reads what the agent recorded its session used so far, and the model
	// it last used.
	Tally func(session string) (model string, used llm.Usage, err error)
}

// Presets are the agents tasks can use; the first is the default.
var Presets = []Preset{{
	Name:     "codex",
	Title:    "Codex",
	Commands: [][]string{{"codex-acp"}, {"npx", "-y", "@zed-industries/codex-acp@0.16.0"}},
	Mode:     "auto",
	SignIn:   "run `codex login` on the computer Mob runs on (`codex login --device-auth` without a browser there), or set OPENAI_API_KEY or CODEX_API_KEY for the Mob service",
	Tally:    codexTally,
}, {
	Name:     "claude",
	Title:    "Claude Agent",
	Commands: [][]string{{"claude-agent-acp"}, {"npx", "-y", "@agentclientprotocol/claude-agent-acp@0.94.0"}},
	Mode:     "acceptEdits",
	SignIn:   "run `claude` and sign in with your Claude subscription (/login) on the computer Mob runs on, or set ANTHROPIC_API_KEY for the Mob service",
}}

// preset finds an agent by name; empty is the default.
func preset(name string) (Preset, error) {
	if name == "" {
		return Presets[0], nil
	}
	if i := slices.IndexFunc(Presets, func(p Preset) bool { return p.Name == name }); i >= 0 {
		return Presets[i], nil
	}
	names := make([]string, len(Presets))
	for i, p := range Presets {
		names[i] = p.Name
	}
	return Preset{}, fmt.Errorf("unknown coding agent %q; available: %s", name, strings.Join(names, ", "))
}

// Project is a git repository tasks work on. Projects are saved in the
// "projects" setting.
type Project struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// Conn is a started agent's standard input and output.
type Conn struct {
	In  io.Writer
	Out io.Reader
	// Stop ends the agent.
	Stop func()
	// Stderr is the end of what the agent wrote to standard error.
	Stderr func() string
}

// start runs the first installed command of p in dir.
func start(ctx context.Context, p Preset, dir string) (Conn, error) {
	command, ok := command(p)
	if !ok {
		return Conn{}, fmt.Errorf("%s is not installed: install %s, or Node.js for npx", p.Title, p.Commands[0][0])
	}
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Dir = dir
	// The agent and what it starts, such as the binary npx runs, end
	// together.
	group(cmd)
	cmd.Env = environment()
	stderr := &tail{}
	cmd.Stderr = stderr
	in, err := cmd.StdinPipe()
	if err != nil {
		return Conn{}, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return Conn{}, err
	}
	if err := cmd.Start(); err != nil {
		return Conn{}, err
	}
	var once sync.Once
	stop := func() {
		once.Do(func() {
			_ = in.Close()
			kill(cmd)
			_ = cmd.Wait()
		})
	}
	return Conn{In: in, Out: out, Stop: stop, Stderr: stderr.String}, nil
}

// command is the first of p's commands whose program is installed.
func command(p Preset) ([]string, bool) {
	for _, c := range p.Commands {
		if _, err := exec.LookPath(c[0]); err == nil {
			return c, true
		}
	}
	return nil, false
}

// environment is Mob's environment without its own MOB_* variables, such as
// its access token.
func environment() []string {
	var env []string
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(entry), "MOB_") {
			env = append(env, entry)
		}
	}
	return env
}

// tail keeps the last few kilobytes written to it.
type tail struct {
	mu  sync.Mutex
	buf []byte
}

const tailSize = 4 << 10

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > tailSize {
		t.buf = t.buf[len(t.buf)-tailSize:]
	}
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(bytes.TrimSpace(t.buf))
}

// Projects are the saved projects.
func (s *Service) Projects() ([]Project, error) {
	list := []Project{}
	err := s.Store.Setting("projects", &list)
	return list, err
}

// project finds a saved project by name, or by its path.
func (s *Service) project(name string) (Project, bool, error) {
	list, err := s.Projects()
	if err != nil {
		return Project{}, false, err
	}
	i := slices.IndexFunc(list, func(p Project) bool { return p.Name == name || p.Path == name })
	if i < 0 {
		return Project{}, false, nil
	}
	return list[i], true, nil
}

// AddProject saves the git repository at path as a project called name, or
// after its directory when name is empty.
func (s *Service) AddProject(ctx context.Context, path, name string) (Project, error) {
	if !filepath.IsAbs(path) {
		return Project{}, errors.New("project path must be absolute")
	}
	top, err := git(ctx, path, "rev-parse", "--show-toplevel")
	if err != nil {
		return Project{}, fmt.Errorf("%s is not a git repository: %w", path, err)
	}
	if name == "" {
		name = filepath.Base(top)
	}
	name = strings.TrimSpace(name)
	if name == "" || strings.ContainsAny(name, " \t\n/") || len(name) > 64 {
		return Project{}, errors.New("project names are up to 64 characters without spaces or slashes")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.Projects()
	if err != nil {
		return Project{}, err
	}
	for _, p := range list {
		if p.Name == name || p.Path == top {
			return p, nil
		}
	}
	p := Project{Name: name, Path: top}
	return p, s.Store.SaveSetting("projects", append(list, p))
}

// RemoveProject forgets project name; its tasks and worktrees stay.
func (s *Service) RemoveProject(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.Projects()
	if err != nil {
		return err
	}
	n := len(list)
	list = slices.DeleteFunc(list, func(p Project) bool { return p.Name == name })
	if len(list) == n {
		return fmt.Errorf("no project is called %s", name)
	}
	return s.Store.SaveSetting("projects", list)
}

// git runs git in dir and returns its trimmed output.
func git(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return "", errors.New(msg)
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// worktree makes a new branch for a task, checked out in its own directory
// under s.Dir.
func (s *Service) worktree(ctx context.Context, p Project, title string) (dir, branch string, err error) {
	if s.Dir == "" {
		return "", "", errors.New("coding agents need a data directory")
	}
	id := chat.NewID()[:8]
	branch = "mob/" + slug(title) + "-" + id
	dir = filepath.Join(s.Dir, "worktrees", p.Name+"-"+id)
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return "", "", err
	}
	if _, err := git(ctx, p.Path, "worktree", "add", "-b", branch, dir, "HEAD"); err != nil {
		return "", "", fmt.Errorf("create a worktree of %s: %w", p.Name, err)
	}
	return dir, branch, nil
}

// slug is title in lower-case ASCII letters, digits and dashes, for a branch.
func slug(title string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(title) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case !dash && b.Len() > 0:
			b.WriteByte('-')
			dash = true
		}
		if b.Len() >= 40 {
			break
		}
	}
	s := strings.Trim(b.String(), "-")
	if s == "" {
		return "task"
	}
	return s
}
