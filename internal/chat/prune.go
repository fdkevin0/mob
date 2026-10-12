package chat

import (
	"fmt"

	"github.com/fdkevin0/mob/internal/llm"
)

// toolOutput is a tool output in a prompt, by its index among the messages, and
// where it is saved, if it is.
type toolOutput struct {
	index int
	file  string
}

// outputs are tool outputs cleared together to make room in a prompt, with
// the tokens they take: estimated, or measured from the provider's usage.
type outputs struct {
	list     []toolOutput
	tokens   int
	measured bool
	cleared  bool
}

// each groups every tool output in messages on its own, with its estimated
// tokens; saved gives where each message's output is saved.
func each(messages []llm.Message, saved []string) []*outputs {
	var groups []*outputs
	for i, m := range messages {
		if m.Role == "tool" {
			groups = append(groups, &outputs{list: []toolOutput{{i, saved[i]}}, tokens: tokens(m.Text)})
		}
	}
	return groups
}

// clearOutputs makes room in a prompt by replacing groups of tool outputs
// before index end, oldest first, with a short note of what was there, until
// about need tokens are freed. It returns the tokens freed. When the prompt's
// size is measured, only measured groups are cleared, so the room claimed is
// never an estimate. Groups that would free little are left.
func clearOutputs(messages []llm.Message, groups []*outputs, end, need int, measured bool) int {
	freed := 0
	for _, g := range groups {
		if freed >= need {
			break
		}
		if g.cleared || measured && !g.measured || g.list[len(g.list)-1].index >= end {
			continue
		}
		notes, cost := make([]string, len(g.list)), 0
		for i, o := range g.list {
			notes[i] = cleared(messages[o.index], o.file)
			cost += noteTokens(notes[i])
		}
		if g.tokens-cost <= cost {
			continue
		}
		for i, o := range g.list {
			messages[o.index].Text = notes[i]
		}
		g.cleared = true
		freed += g.tokens - cost
	}
	return freed
}

// noteTokens counts a note's tokens generously, so clearing never claims more
// room than it makes.
func noteTokens(note string) int { return len(note)/2 + 1 }

// cleared is what the model reads in place of a tool output cleared to fit
// the context window: what it was and, when saved, where it is.
func cleared(m llm.Message, file string) string {
	note := fmt.Sprintf("This earlier %s output, about %d tokens, was cleared to fit the context window.", m.ToolName, tokens(m.Text))
	if file != "" {
		note += " The whole output is saved at " + file + "."
	} else {
		note += " Run the tool again if you need it."
	}
	return string(encode(map[string]any{"cleared": true, "note": note}))
}
