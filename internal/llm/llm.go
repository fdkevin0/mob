// Package llm is the provider-neutral model interface the conversation engine
// depends on. Drivers translate it to one wire protocol each; the provider
// registry decides which driver, endpoint and key a model reference uses.
package llm

import (
	"bufio"
	"context"
	"io"
	"slices"
	"strings"
)

// Ref names a model as users type it: provider/model[:effort]. Model IDs may
// contain slashes and colons (@cf/meta/llama, llama3.2:3b), so only the first
// slash separates the provider and only a known effort level is a suffix.
type Ref struct {
	Provider, Model, Effort string
}

// Efforts are the reasoning levels a reference suffix may carry.
var Efforts = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}

func ParseRef(s string) (Ref, bool) {
	provider, model, ok := strings.Cut(strings.TrimSpace(s), "/")
	if !ok || provider == "" || model == "" {
		return Ref{}, false
	}
	r := Ref{Provider: provider, Model: model}
	if i := strings.LastIndex(model, ":"); i > 0 && slices.Contains(Efforts, model[i+1:]) {
		r.Model, r.Effort = model[:i], model[i+1:]
	}
	return r, true
}

// Key is the reference without its effort.
func (r Ref) Key() string { return r.Provider + "/" + r.Model }
func (r Ref) String() string {
	if r.Effort != "" {
		return r.Key() + ":" + r.Effort
	}
	return r.Key()
}

// Info is what is known about a model: the catalog's metadata, the user's
// overrides, or conservative defaults when neither says.
type Info struct {
	ID        string   `json:"id"`
	Name      string   `json:"name,omitempty"`
	Context   int      `json:"context,omitempty"`
	Output    int      `json:"output,omitempty"`
	Reasoning bool     `json:"reasoning,omitempty"`
	Tools     bool     `json:"tools"`
	Vision    bool     `json:"vision,omitempty"`
	Efforts   []string `json:"efforts,omitempty"`
	Cost      *Cost    `json:"cost,omitempty"`
	// Known is set when the catalog described the model.
	Known bool `json:"known"`
}

// Cost is USD per million tokens.
type Cost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead,omitempty"`
	CacheWrite float64 `json:"cacheWrite,omitempty"`
}

// Group is one provider's models, as /models and the API list them.
type Group struct {
	Provider string `json:"provider"`
	Name     string `json:"name"`
	Models   []Info `json:"models"`
	Error    string `json:"error,omitempty"`
}

type ToolCall struct {
	ID, Name, Arguments string
}

type Tool struct {
	Name, Description string
	Parameters        map[string]any
}

// Message is one turn of a prompt. Reasoning and Signature belong to the
// model that produced them; the engine replays them only to that model.
type Message struct {
	Role       string // system, user, assistant, tool
	Text       string
	Reasoning  string
	Signature  string
	ToolCalls  []ToolCall
	ToolCallID string
	ToolName   string
}

type Request struct {
	System    string
	Messages  []Message
	Tools     []Tool
	MaxTokens int
}

// Usage counts Input as every prompt token, cached or not, on every protocol.
type Usage struct {
	Input      int     `json:"inputTokens"`
	Output     int     `json:"outputTokens"`
	Reasoning  int     `json:"reasoningTokens,omitempty"`
	CacheRead  int     `json:"cacheReadTokens,omitempty"`
	CacheWrite int     `json:"cacheWriteTokens,omitempty"`
	Cost       float64 `json:"cost,omitempty"`
}

// Priced fills Cost from the model's list price, when known.
func (u Usage) Priced(c *Cost) Usage {
	if c != nil {
		u.Cost = (float64(u.Input-u.CacheRead-u.CacheWrite)*c.Input + float64(u.Output)*c.Output + float64(u.CacheRead)*c.CacheRead + float64(u.CacheWrite)*c.CacheWrite) / 1e6
	}
	return u
}

type Result struct {
	Text, Reasoning, Signature string
	Calls                      []ToolCall
	Usage                      *Usage
}

// Model is a callable model. Stream emits "text" and "reasoning" deltas as
// they arrive and returns the whole step.
type Model interface {
	Ref() Ref
	Info() Info
	Stream(ctx context.Context, req Request, emit func(kind, delta string) error) (Result, error)
}

// Limits every driver enforces on untrusted model output.
const (
	MaxResponseBytes  = 2 << 20
	MaxToolCalls      = 16
	MaxToolArguments  = 1 << 20
	MaxToolCallID     = 200
	MaxToolNameLength = 100
)

// ReadSSE also handles CRLF and multi-line data fields; callers choose how to interpret events.
func ReadSSE(r io.Reader, handle func(event string, data []byte) error) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	var event string
	var data []string
	flush := func() error {
		if len(data) == 0 {
			event = ""
			return nil
		}
		raw := strings.Join(data, "\n")
		name := event
		data, event = nil, ""
		return handle(name, []byte(raw))
	}
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "":
			if err := flush(); err != nil {
				return err
			}
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return flush()
}
