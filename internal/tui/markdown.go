package tui

import (
	"strings"

	"charm.land/glamour/v2"
)

// markdown renders Markdown for the terminal at one width, remembering what it
// rendered so redrawing a long transcript stays cheap.
type markdown struct {
	style    string
	width    int
	renderer *glamour.TermRenderer
	cache    map[string]string
}

// maxRendered bounds the cache; past it the cache starts over.
const maxRendered = 512

// render turns already sanitized text into styled terminal output. Text that
// cannot be rendered is shown as it is.
func (r *markdown) render(text string, width int) string {
	if r.renderer == nil || width != r.width {
		style := r.style
		if style == "" {
			style = "dark"
		}
		renderer, err := glamour.NewTermRenderer(glamour.WithStandardStyle(style), glamour.WithWordWrap(width))
		if err != nil {
			return text
		}
		r.renderer, r.width, r.cache = renderer, width, map[string]string{}
	}
	if out, ok := r.cache[text]; ok {
		return out
	}
	out, err := r.renderer.Render(text)
	if err != nil {
		return text
	}
	out = strings.Trim(out, "\n")
	if len(r.cache) >= maxRendered {
		r.cache = map[string]string{}
	}
	r.cache[text] = out
	return out
}
