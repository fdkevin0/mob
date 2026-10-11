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
		m.setSuggestions(nil)
		return nil
	}
	client, seq, request := *m, m.completionSeq, chat.CompletionRequest{Client: chat.ClientTUI, ConversationID: m.id, Text: text}
	return func() tea.Msg {
		var list []chat.Suggestion
		// Completion is a convenience; a failure only leaves the list empty.
		_ = client.json("POST", "/api/commands/complete", request, &list)
		return completions{Seq: seq, Text: text, List: list}
	}
}

func (m *model) setSuggestions(list []chat.Suggestion) {
	m.suggestions, m.selected = list, 0
	m.layout()
}

// lastToken is the part of text a suggestion replaces.
func lastToken(text string) (head, token string) {
	i := strings.LastIndexAny(text, " \t") + 1
	return text[:i], text[i:]
}

// suggestionKey handles keys while suggestions are shown. Enter accepts only
// a suggestion that changes a partly typed token, so a complete command still
// sends.
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
		m.setSuggestions(nil)
	case "enter", "tab":
		head, token := lastToken(m.input.Value())
		choice := m.suggestions[m.selected]
		if key == "enter" && (token == "" || token == choice.Value) {
			return nil, false
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
