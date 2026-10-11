package chat

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"maps"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	// inlineOutput is the most of a tool's output, as JSON bytes, the model
	// reads in place: about 8000 tokens, close to what other agents allow.
	inlineOutput = 24000
	// savedPreview is how much of a saved output the model reads in place;
	// it reads the rest from the file when it needs to.
	savedPreview = 4000
)

// Saver keeps a large tool output where the model's own tools can read it,
// returning the path to give the model; package sandbox implements it.
type Saver interface {
	Save(conversationID, name, text string) (string, error)
}

// save keeps output in saver when it is too large to read in place, and
// returns where; "" means it is read in place or could not be saved.
func save(saver Saver, conversationID, callID string, output any) string {
	if saver == nil {
		return ""
	}
	if raw, _ := json.Marshal(output); len(raw) <= inlineOutput {
		return ""
	}
	sum := sha256.Sum256([]byte(callID))
	path, err := saver.Save(conversationID, hex.EncodeToString(sum[:8])+".txt", readable(output))
	if err != nil {
		return ""
	}
	return path
}

// modelOutput is a tool output as the model reads it: whole when small,
// otherwise its head and tail, with where the whole is saved, if it is.
func modelOutput(output any, file string) string {
	raw, _ := json.Marshal(output)
	if len(raw) <= inlineOutput {
		return string(raw)
	}
	text := readable(output)
	budget, note := inlineOutput, "The middle of this output was left out, as it is too long to read whole."
	if file != "" {
		budget, note = savedPreview, "The whole output is saved at "+file+"; read the parts you need with the sandbox tool, such as grep, sed -n or tail."
	}
	head, tail := ends(text, budget*2/3, budget/3)
	view, _ := json.Marshal(map[string]any{"truncated": true, "bytes": len(text), "head": head, "tail": tail, "note": note})
	return string(view)
}

// readable is output as text to read or search: a string as it is, an
// object's fields in name order, long or multi-line strings as their own
// sections, anything else as indented JSON. The order makes a stored output
// read the same as the value it was saved from.
func readable(output any) string {
	if s, ok := output.(string); ok {
		return s
	}
	raw, _ := json.Marshal(output)
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		var indented bytes.Buffer
		_ = json.Indent(&indented, raw, "", "  ")
		return indented.String()
	}
	var b strings.Builder
	for _, key := range slices.Sorted(maps.Keys(fields)) {
		var s string
		if json.Unmarshal(fields[key], &s) == nil && (strings.Contains(s, "\n") || len(s) > 200) {
			b.WriteString("--- " + key + " ---\n" + s)
			if !strings.HasSuffix(s, "\n") {
				b.WriteString("\n")
			}
			continue
		}
		b.WriteString(key + ": " + string(fields[key]) + "\n")
	}
	return b.String()
}

// ends is up to head bytes from the start of s and tail bytes from its end,
// cut at character boundaries.
func ends(s string, head, tail int) (string, string) {
	if len(s) <= head+tail {
		return s, ""
	}
	for head > 0 && !utf8.RuneStart(s[head]) {
		head--
	}
	start := len(s) - tail
	for start < len(s) && !utf8.RuneStart(s[start]) {
		start++
	}
	return s[:head], s[start:]
}
