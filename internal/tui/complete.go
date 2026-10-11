package tui

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/fdkevin0/mob/internal/chat"
)

// shownSuggestions bounds the completion list drawn above the input.
const shownSuggestions = 6

type completions struct {
	Seq  uint64
	Text string
	List []chat.Suggestion
}

// refreshCompletion asks the service for suggestions when the input is a
// command; any older answer is discarded by its sequence number.
func (m *model) refreshCompletion() tea.Cmd {
	m.completionSeq++
	text := m.input.Value()
	if !strings.HasPrefix(text, "/") || strings.Contains(text, "\n") {
		m.setSuggestions(nil, "")
		return nil
	}
	client, seq, request := *m, m.completionSeq, chat.CommandRequest{Client: chat.ClientTUI, ConversationID: m.id, Text: text}
	return func() tea.Msg {
		var list []chat.Suggestion
		// Completion is a convenience; a failure only leaves the list empty.
		_ = client.json("POST", "/api/commands/complete", request, &list)
		return completions{Seq: seq, Text: text, List: list}
	}
}

// setSuggestions shows suggestions computed for text. They stay visible while
// a newer answer is on its way but apply only to the text they were made for.
func (m *model) setSuggestions(list []chat.Suggestion, text string) {
	m.suggestions, m.suggestionsFor, m.selected = list, text, 0
	m.layout()
}

// lastToken is the part of text a suggestion replaces.
func lastToken(text string) (head, token string) {
	i := strings.LastIndexAny(text, " \t") + 1
	return text[:i], text[i:]
}

// suggestionKey handles keys while suggestions are shown. Enter accepts only
// a suggestion that changes a partly typed token, so a complete command still
// sends; neither Tab nor Enter applies suggestions made for older text.
func (m *model) suggestionKey(key string) (tea.Cmd, bool) {
	if len(m.suggestions) == 0 {
		return nil, false
	}
	switch key {
	case "up":
		m.selected = (m.selected + len(m.suggestions) - 1) % len(m.suggestions)
	case "down":
		m.selected = (m.selected + 1) % len(m.suggestions)
	case "esc":
		m.completionSeq++
		m.setSuggestions(nil, "")
	case "enter", "tab":
		head, token := lastToken(m.input.Value())
		choice := m.suggestions[m.selected]
		stale := m.input.Value() != m.suggestionsFor
		if key == "enter" && (stale || token == "" || token == choice.Value) {
			return nil, false
		}
		if stale {
			return nil, true
		}
		m.input.SetValue(head + choice.Value + " ")
		return m.refreshCompletion(), true
	default:
		return nil, false
	}
	return nil, true
}

func (m model) suggestionView() string {
	if len(m.suggestions) == 0 {
		return ""
	}
	start := max(0, m.selected-shownSuggestions+1)
	end := min(len(m.suggestions), start+shownSuggestions)
	line := lipgloss.NewStyle().MaxWidth(max(20, m.width-4))
	chosen := line.Reverse(true)
	detail := lipgloss.NewStyle().Faint(true)
	var b strings.Builder
	for i := start; i < end; i++ {
		s := m.suggestions[i]
		text := "  " + safe(s.Label)
		if s.Detail != "" {
			text += "  " + detail.Render(safe(s.Detail))
		}
		if i == m.selected {
			b.WriteString(chosen.Render(text) + "\n")
		} else {
			b.WriteString(line.Render(text) + "\n")
		}
	}
	return b.String()
}

// layout gives the transcript the rows the completion list does not use.
func (m *model) layout() {
	if m.height == 0 {
		return
	}
	m.viewport.SetHeight(max(3, m.height-10-min(len(m.suggestions), shownSuggestions)))
}

// runCommand asks the service to run a slash command; one it does not run
// comes back unhandled and is sent as chat.
func (m model) runCommand(text string) tea.Cmd {
	request := chat.CommandRequest{Client: chat.ClientTUI, ConversationID: m.id, Text: text}
	return func() tea.Msg {
		var result chat.CommandResult
		err := m.json("POST", "/api/commands/run", request, &result)
		return commandRan{Text: text, Result: result, Err: err}
	}
}

// apply carries out what a command asked of this client.
func (m model) apply(a *chat.Action) (tea.Model, tea.Cmd) {
	if a == nil {
		return m, nil
	}
	switch a.Kind {
	case chat.OpenConversation:
		m.generation++
		return m, m.load(a.ConversationID, false)
	case chat.Decide:
		request := chat.ChatRequest{ID: m.id, RequestID: chat.NewID()}
		request.Approval = &struct {
			ID       string `json:"id"`
			Approved bool   `json:"approved"`
		}{a.ApprovalID, a.Approved}
		cmd := m.stream(request)
		m.render()
		return m, cmd
	case chat.OpenPlugins:
		return m, m.loadPlugins()
	case chat.ComposeMail:
		m.plugin = newPluginForm()
		m.plugin.name = "compose"
		m.plugin.config = map[string]map[string]any{"compose": {}}
		m.plugin.fields = composeFields
		m.plugin.index = 0
		m.plugin.requestID = chat.NewID()
		m.plugin.focus()
	}
	return m, nil
}

// send starts a chat turn with text.
func (m *model) send(text string) tea.Cmd {
	request := chat.ChatRequest{ID: m.id, Text: text, RequestID: chat.NewID()}
	m.messages = append(m.messages, chat.Message{ID: request.RequestID, Role: "user", Parts: []chat.Part{{"type": "text", "text": text}}})
	cmd := m.stream(request)
	m.viewport.GotoBottom()
	m.render()
	return cmd
}
