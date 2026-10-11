package tui

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode"

	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/local"
	"github.com/fdkevin0/mob/internal/protocol"
)

type snapshot struct {
	Generation uint64
	ID         string
	Messages   []chat.Message
	Active     bool
	Model      string
	Err        error
}
type streamEvent struct {
	Event protocol.Chunk
	Err   error
	Done  bool
}
type tick struct{}

// modelConfiguration is the service's answer to GET /api/config.
type modelConfiguration struct {
	DefaultModel string
	Err          error
}

// commandRan is the service's answer to a typed slash command.
type commandRan struct {
	Text   string
	Result chat.CommandResult
	Err    error
}
type model struct {
	plugin              *pluginForm
	connection          local.Connection
	configured, checked bool
	id, modelRef        string
	messages            []chat.Message
	input               textarea.Model
	viewport            viewport.Model
	status, draft       string
	failure, listText   string
	generation          uint64
	busy, remoteBusy    bool
	running             bool
	markdown            *markdown
	width, height       int
	suggestions         []chat.Suggestion
	suggestionsFor      string
	selected            int
	completionSeq       uint64
	events              chan streamEvent
	ctx                 context.Context
	cancel              context.CancelFunc
	streamCancel        context.CancelFunc
}

func Run(connection local.Connection) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	input := textarea.New()
	input.Placeholder = "Message · Enter send · Alt+Enter newline"
	input.SetHeight(3)
	input.KeyMap.InsertNewline.SetKeys("alt+enter", "shift+enter", "ctrl+j")
	input.CharLimit = 16000
	input.Focus()
	style := "light"
	if lipgloss.HasDarkBackground(os.Stdin, os.Stdout) {
		style = "dark"
	}
	m := model{connection: connection, input: input, viewport: viewport.New(), ctx: ctx, cancel: cancel, width: 80, status: "Connecting…", markdown: &markdown{style: style}}
	_, err := tea.NewProgram(m).Run()
	return err
}

func (m model) Init() tea.Cmd { return tea.Batch(m.checkConfig(), nextTick()) }
func (m model) checkConfig() tea.Cmd {
	return func() tea.Msg {
		var result modelConfiguration
		result.Err = m.json("GET", "/api/config", nil, &result)
		return result
	}
}
func nextTick() tea.Cmd { return tea.Tick(2*time.Second, func(time.Time) tea.Msg { return tick{} }) }

func (m model) request(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, m.connection.URL+path, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+m.connection.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		text, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("%s", strings.TrimSpace(string(text)))
	}
	return resp, nil
}

// timeoutFor bounds a request. Plugin routes and command execution reach
// remote services that the service itself allows up to 45 seconds.
func timeoutFor(path string) time.Duration {
	if strings.HasPrefix(path, "/api/plugins") || path == "/api/commands/run" {
		return 60 * time.Second
	}
	return 10 * time.Second
}

func (m model) json(method, path string, body, dest any) error {
	ctx, cancel := context.WithTimeout(m.ctx, timeoutFor(path))
	defer cancel()
	resp, err := m.request(ctx, method, path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(dest)
}

func (m model) load(id string, create bool) tea.Cmd {
	return func() tea.Msg {
		var list []chat.Conversation
		if err := m.json("GET", "/api/conversations", nil, &list); err != nil {
			return snapshot{Generation: m.generation, Err: err}
		}
		if create || len(list) == 0 {
			var c chat.Conversation
			if err := m.json("POST", "/api/conversations", map[string]any{}, &c); err != nil {
				return snapshot{Generation: m.generation, Err: err}
			}
			id = c.ID
		} else if id == "" {
			id = list[0].ID
		}
		var s snapshot
		s.Generation = m.generation
		s.ID = id
		s.Err = m.json("GET", "/api/conversations/"+id, nil, &s)
		return s
	}
}

func (m *model) stream(input chat.ChatRequest) tea.Cmd {
	m.busy = true
	m.draft = ""
	m.status = "Generating…"
	m.events = make(chan streamEvent, 32)
	ctx, cancel := context.WithCancel(m.ctx)
	m.streamCancel = cancel
	events := m.events
	copy := *m
	send := func(e streamEvent) {
		select {
		case events <- e:
		case <-m.ctx.Done():
		}
	}
	return tea.Batch(func() tea.Msg {
		defer cancel()
		resp, err := copy.request(ctx, "POST", "/api/chat", input)
		if err == nil {
			defer resp.Body.Close()
			err = llm.ReadSSE(resp.Body, func(_ string, raw []byte) error {
				if string(raw) == "[DONE]" {
					return nil
				}
				var e protocol.Chunk
				if err := json.Unmarshal(raw, &e); err != nil {
					return err
				}
				send(streamEvent{Event: e})
				return nil
			})
		}
		send(streamEvent{Err: err, Done: true})
		return nil
	}, waitEvent(events))
}

func waitEvent(events <-chan streamEvent) tea.Cmd { return func() tea.Msg { return <-events } }

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case pluginsLoaded:
		if msg.Err != nil {
			m.failure = msg.Err.Error()
			return m, nil
		}
		m.plugin = newPluginForm()
		m.plugin.config = msg.Config
		m.failure = ""
		return m, nil
	case pluginSaved:
		if m.plugin == nil {
			return m, nil
		}
		m.plugin.saving = false
		if msg.Err != nil {
			m.failure = msg.Err.Error()
			return m, nil
		}
		m.plugin = nil
		m.failure = ""
		m.status = "Saved"
		return m, nil
	case modelConfiguration:
		m.checked = true
		if msg.Err != nil {
			m.failure = msg.Err.Error()
			return m, nil
		}
		if !m.configured {
			m.configured = true
			m.failure = ""
			return m, m.load("", false)
		}
		return m, nil
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.input.SetWidth(max(20, msg.Width-4))
		m.viewport.SetWidth(max(20, msg.Width-4))
		m.layout()
		m.render()
	case completions:
		if msg.Seq == m.completionSeq && msg.Text == m.input.Value() {
			m.setSuggestions(msg.List, msg.Text)
		}
	case snapshot:
		if msg.Generation != m.generation {
			return m, nil
		}
		if msg.Err != nil {
			m.failure = msg.Err.Error()
			break
		}
		if m.busy {
			break
		}
		m.id = msg.ID
		m.messages = msg.Messages
		m.remoteBusy = msg.Active
		m.modelRef = msg.Model
		m.status = "Ready · " + m.modelRef + " · " + m.id
		if m.remoteBusy {
			m.status = "Another client is generating · Ctrl+S to stop"
		}
		m.render()
	case commandRan:
		m.running = false
		if msg.Err != nil {
			m.failure = msg.Err.Error()
			if m.input.Value() == "" {
				m.input.SetValue(msg.Text)
			}
			return m, nil
		}
		if !msg.Result.Handled {
			return m, m.send(msg.Text)
		}
		if msg.Result.Markdown != "" {
			m.listText = msg.Result.Markdown
			m.render()
		}
		return m.apply(msg.Result.Action)
	case tick:
		if m.plugin != nil {
			return m, nextTick()
		}
		if !m.configured {
			return m, nextTick()
		}
		if !m.busy {
			return m, tea.Batch(nextTick(), m.load(m.id, false))
		}
		return m, nextTick()
	case streamEvent:
		if msg.Done {
			m.busy = false
			m.draft = ""
			if msg.Err != nil {
				m.failure = msg.Err.Error()
			}
			return m, m.load(m.id, false)
		}
		switch msg.Event.Type {
		case "text-delta":
			m.draft += fmt.Sprint(msg.Event.Delta)
		case "tool-input-available":
			m.draft += "\n[tool: " + fmt.Sprint(msg.Event.ToolName) + "]\n"
		case "tool-approval-request":
			m.draft += "Approval required: " + fmt.Sprint(msg.Event.ApprovalID) + "\n"
		case "error":
			m.draft += "\nError: " + fmt.Sprint(msg.Event.ErrorText)
		}
		m.render()
		return m, waitEvent(m.events)
	case tea.KeyPressMsg:
		if m.plugin != nil {
			return m.pluginKey(msg)
		}
		if msg.String() == "ctrl+p" && !m.busy && !m.remoteBusy {
			return m, m.loadPlugins()
		}
		if !m.configured {
			if msg.String() == "ctrl+c" {
				m.cancel()
				return m, tea.Quit
			}
			if msg.String() == "ctrl+r" {
				return m, m.checkConfig()
			}
			return m, nil
		}
		if cmd, ok := m.suggestionKey(msg.String()); ok {
			return m, cmd
		}
		switch msg.String() {
		case "ctrl+c":
			m.cancel()
			return m, tea.Quit
		case "ctrl+s":
			if m.streamCancel != nil {
				m.streamCancel()
			}
			return m, func() tea.Msg {
				var result any
				err := m.json("POST", "/api/conversations/"+m.id+"/stop", map[string]any{}, &result)
				if err != nil {
					return snapshot{Generation: m.generation, Err: err}
				}
				return nil
			}
		case "pgup", "pgdown":
			var cmd tea.Cmd
			m.viewport, cmd = m.viewport.Update(msg)
			return m, cmd
		case "enter":
			if m.busy || m.remoteBusy || m.running || m.id == "" {
				return m, nil
			}
			text := strings.TrimSpace(m.input.Value())
			if text == "" {
				return m, nil
			}
			m.input.Reset()
			m.completionSeq++
			m.setSuggestions(nil, "")
			m.failure = ""
			m.listText = ""
			m.generation++
			if strings.HasPrefix(text, "/") {
				m.running = true
				return m, m.runCommand(text)
			}
			return m, m.send(text)
		}
	}
	var cmd tea.Cmd
	if m.plugin != nil {
		m.plugin.input, cmd = m.plugin.input.Update(msg)
		return m, cmd
	}
	if !m.configured {
		return m, nil
	}
	before := m.input.Value()
	m.input, cmd = m.input.Update(msg)
	if m.input.Value() != before {
		return m, tea.Batch(cmd, m.refreshCompletion())
	}
	return m, cmd
}

// Strip terminal control characters from model/user content before rendering.
func safe(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || !unicode.IsControl(r) {
			return r
		}
		return -1
	}, s)
}

// render draws the transcript, or the last command result in its place.
// Content is sanitized before Markdown rendering, which adds its own styling.
func (m *model) render() {
	if m.markdown == nil {
		m.markdown = &markdown{}
	}
	width := max(20, m.width-4)
	if m.listText != "" {
		m.viewport.SetContent(m.markdown.render(safe(m.listText), width))
		return
	}
	plain := lipgloss.NewStyle().Width(width)
	role := lipgloss.NewStyle().Bold(true)
	var b strings.Builder
	for _, message := range m.messages {
		b.WriteString(role.Render(strings.ToUpper(safe(message.Role))) + "\n")
		for _, p := range message.Parts {
			if p["type"] == "text" {
				text := safe(fmt.Sprint(p["text"]))
				if message.Role == "assistant" {
					b.WriteString(m.markdown.render(text, width) + "\n")
				} else {
					b.WriteString(plain.Render(text) + "\n")
				}
			}
			if strings.HasPrefix(fmt.Sprint(p["type"]), "tool-") {
				raw, _ := json.Marshal(p["input"])
				line := fmt.Sprintf("[%s · %s] %s", p["type"], p["state"], raw)
				if p["state"] == "approval-requested" {
					if approval, ok := p["approval"].(map[string]any); ok {
						line += "\n/approve " + fmt.Sprint(approval["id"]) + "  or  /deny " + fmt.Sprint(approval["id"])
					}
				}
				b.WriteString(plain.Render(safe(line)) + "\n")
			}
		}
		if message.Metadata["error"] != nil {
			b.WriteString(plain.Render(safe("["+fmt.Sprint(message.Metadata["error"])+"]")) + "\n")
		}
		b.WriteString("\n")
	}
	if m.busy {
		// A reply in progress stays plain until it is complete.
		b.WriteString(role.Render("ASSISTANT") + "\n" + plain.Render(safe(m.draft)))
	}
	atBottom := m.viewport.AtBottom()
	m.viewport.SetContent(b.String())
	if atBottom {
		m.viewport.GotoBottom()
	}
}
func (m model) View() tea.View {
	title := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("6")).Render("Mob / terminal")
	body := title + "\n" + safe(m.status) + "\n" + safe(m.failure) + "\n" + m.viewport.View() + "\n" + m.suggestionView() + m.input.View() + "\n/ commands · Tab complete · Ctrl+P connections · Ctrl+S stop · Ctrl+C quit · PgUp/PgDn scroll"
	if !m.configured {
		body = title + "\nConnecting… (Ctrl+R retry · Ctrl+C quit)\n" + safe(m.failure)
	}
	if m.plugin != nil {
		body = title + "\n" + m.plugin.view() + "\n" + safe(m.failure)
	}
	v := tea.NewView(lipgloss.NewStyle().Padding(1, 2).Render(body))
	v.AltScreen = true
	return v
}
