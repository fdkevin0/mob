package chat

import (
	"fmt"

	"github.com/fdkevin0/mob/internal/llm"
)

// clearOutputs makes room in a prompt by replacing tool outputs in
// messages, oldest first, with a short note of what was there, until about
// need tokens are freed. Small outputs are left, as clearing them frees
// little. It returns the tokens freed.
func clearOutputs(messages []llm.Message, files map[string]string, need int) int {
	freed := 0
	for i := range messages {
		if freed >= need {
			break
		}
		m := &messages[i]
		if m.Role != "tool" {
			continue
		}
		note := cleared(*m, files[m.ToolCallID])
		if gain := tokens(m.Text) - tokens(note); gain > tokens(note) {
			m.Text = note
			freed += gain
		}
	}
	return freed
}

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

// outputFiles maps the tool calls in history to where their outputs are saved.
func outputFiles(history []Message) map[string]string {
	files := map[string]string{}
	for _, m := range history {
		for _, part := range m.Parts {
			id, _ := part["toolCallId"].(string)
			if file, _ := part["outputFile"].(string); id != "" && file != "" {
				files[id] = file
			}
		}
	}
	return files
}
