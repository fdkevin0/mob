package chat

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"unicode"

	"github.com/fdkevin0/mob/internal/llm"
)

// Exposure is how a tool reaches the model.
type Exposure int

const (
	// Direct tools are declared to every turn that may use them.
	Direct Exposure = iota
	// Deferred tools are declared once tool_search has loaded them in the
	// conversation, or once it has called them, so that many tools cost the
	// prompt nothing until a task needs them.
	Deferred
	// Hidden tools are never offered.
	Hidden
)

// ParseExposure reads direct, deferred or hidden.
func ParseExposure(s string) (Exposure, error) {
	switch s {
	case "direct":
		return Direct, nil
	case "deferred":
		return Deferred, nil
	case "hidden":
		return Hidden, nil
	}
	return Direct, fmt.Errorf("exposure %q is not direct, deferred or hidden", s)
}

func (e Exposure) String() string {
	return [...]string{"direct", "deferred", "hidden"}[e]
}

// Entry is something tool_search finds that is not a tool to load, such as a
// skill another tool loads by name.
type Entry struct {
	// Kind names what it is, such as skill.
	Kind        string
	Name        string
	Description string
	// Use tells the model how to use it, such as which tool to call.
	Use string
	// OwnerOnly entries are found only in the owner's turns.
	OwnerOnly bool
}

// searchName is reserved for tool_search, which a turn offers while it has
// tools to load or entries to find.
const searchName = "tool_search"

const (
	searchLimit       = 5
	searchMax         = 10
	searchDescription = 300
)

// searchPrompt tells the model what tool_search can find.
func searchPrompt(waiting []Tool, entries []Entry) string {
	counts := map[string]int{}
	var groups []string
	for _, t := range waiting {
		group := cmp.Or(t.Namespace, "other")
		if counts[group] == 0 {
			groups = append(groups, group)
		}
		counts[group]++
	}
	for _, e := range entries {
		group := e.Kind + "s"
		if counts[group] == 0 {
			groups = append(groups, group)
		}
		counts[group]++
	}
	var parts []string
	for _, group := range groups {
		parts = append(parts, fmt.Sprintf("%s (%d)", group, counts[group]))
	}
	return "More tools and skills are available than are declared: " + strings.Join(parts, ", ") + ". Before saying you cannot do something, call tool_search with keywords for the task; the tools it finds can be called in your next step."
}

// toolSearch is the tool_search tool of one turn: it ranks tools not yet
// declared, and entries, and loads the tools it finds through load.
func toolSearch(waiting func() []Tool, loaded func() []Tool, entries []Entry, load func([]Tool)) Tool {
	return Tool{
		Tool: llm.Tool{
			Name:        searchName,
			Description: "Find tools and skills that are not declared yet by keywords, such as \"github issue\" or \"send email\". Tools found are loaded and can be called in the next step; skills found say how to use them.",
			Parameters: map[string]any{"type": "object", "properties": map[string]any{
				"query": map[string]any{"type": "string", "description": "Keywords for what the task needs, or a tool's exact name"},
				"limit": map[string]any{"type": "integer", "minimum": 1, "maximum": searchMax, "description": fmt.Sprintf("Results to return; default %d", searchLimit)},
			}, "required": []string{"query"}, "additionalProperties": false},
		},
		Run: func(_ context.Context, call ToolCall) (any, error) {
			query, _ := call.Input["query"].(string)
			if strings.TrimSpace(query) == "" {
				return nil, errors.New("query must name what the task needs")
			}
			limit := searchLimit
			if n, ok := call.Input["limit"].(float64); ok && n >= 1 {
				limit = min(int(n), searchMax)
			}
			return search(query, limit, waiting(), loaded(), entries, load), nil
		},
	}
}

// found is one result of tool_search as the model reads it.
type found struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Description string `json:"description,omitempty"`
	Namespace   string `json:"namespace,omitempty"`
	Use         string `json:"use"`
}

// searchResult is what tool_search returns. Loaded is read back from
// history to keep the tools loaded in later turns.
type searchResult struct {
	Loaded  []string `json:"loaded"`
	Results []found  `json:"results"`
	Note    string   `json:"note,omitempty"`
}

func search(query string, limit int, waiting, loaded []Tool, entries []Entry, load func([]Tool)) searchResult {
	type candidate struct {
		tool   *Tool
		entry  *Entry
		loaded bool
	}
	var candidates []candidate
	var docs []document
	for i := range waiting {
		candidates = append(candidates, candidate{tool: &waiting[i]})
		docs = append(docs, toolDocument(waiting[i]))
	}
	for i := range loaded {
		candidates = append(candidates, candidate{tool: &loaded[i], loaded: true})
		docs = append(docs, toolDocument(loaded[i]))
	}
	for i := range entries {
		candidates = append(candidates, candidate{entry: &entries[i]})
		docs = append(docs, document{name: entries[i].Name, fields: []field{{entries[i].Name, 3}, {entries[i].Kind, 1}, {entries[i].Description, 1}}})
	}
	result := searchResult{Loaded: []string{}, Results: []found{}}
	var toLoad []Tool
	for _, i := range rank(docs, query, limit) {
		c := candidates[i]
		if c.entry != nil {
			result.Results = append(result.Results, found{Name: c.entry.Name, Kind: c.entry.Kind, Description: brief(c.entry.Description), Use: c.entry.Use})
			continue
		}
		use := "Loaded; call it in your next step."
		if c.loaded {
			use = "Already loaded; call it."
		} else {
			toLoad = append(toLoad, *c.tool)
			result.Loaded = append(result.Loaded, c.tool.Name)
		}
		result.Results = append(result.Results, found{Name: c.tool.Name, Kind: "tool", Description: brief(c.tool.Description), Namespace: c.tool.Namespace, Use: use})
	}
	if len(toLoad) > 0 {
		load(toLoad)
	}
	if len(result.Results) == 0 {
		result.Note = "Nothing matched; try other keywords, such as the service or action the task needs."
	}
	return result
}

// brief is a description cut to what a search result shows.
func brief(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > searchDescription {
		return string(r[:searchDescription]) + "…"
	}
	return s
}

// document is what tool_search ranks: weighted text fields, and the name an
// exact query finds first.
type document struct {
	name   string
	fields []field
}

// field is text a document ranks by, and how much each word in it counts.
type field struct {
	text   string
	weight float64
}

func toolDocument(t Tool) document {
	fields := []field{{t.Name, 3}, {t.Namespace, 2}, {t.Description, 1}}
	if properties, ok := t.Parameters["properties"].(map[string]any); ok {
		names := slices.Sorted(func(yield func(string) bool) {
			for name := range properties {
				if !yield(name) {
					return
				}
			}
		})
		for _, name := range names {
			fields = append(fields, field{name, 1})
			if p, ok := properties[name].(map[string]any); ok {
				if d, ok := p["description"].(string); ok {
					fields = append(fields, field{d, 1})
				}
			}
		}
	}
	return document{name: t.Name, fields: fields}
}

// rank orders documents by BM25 against query and returns the indices of at
// most limit that match, best first. A document named exactly by the query
// comes first.
func rank(docs []document, query string, limit int) []int {
	const k1, b = 1.2, 0.75
	terms := slices.Compact(slices.Sorted(slices.Values(words(query))))
	counts := make([]map[string]float64, len(docs))
	lengths := make([]float64, len(docs))
	frequency := map[string]int{}
	total := 0.0
	for i, d := range docs {
		counts[i] = map[string]float64{}
		for _, f := range d.fields {
			for _, term := range words(f.text) {
				counts[i][term] += f.weight
				lengths[i] += f.weight
			}
		}
		for term := range counts[i] {
			frequency[term]++
		}
		total += lengths[i]
	}
	if len(docs) == 0 {
		return nil
	}
	average := max(total/float64(len(docs)), 1)
	exact := strings.TrimSpace(query)
	scores := make([]float64, len(docs))
	var matched []int
	for i := range docs {
		for _, term := range terms {
			tf := counts[i][term]
			if tf == 0 {
				continue
			}
			n := float64(frequency[term])
			idf := math.Log(1 + (float64(len(docs))-n+0.5)/(n+0.5))
			scores[i] += idf * tf * (k1 + 1) / (tf + k1*(1-b+b*lengths[i]/average))
		}
		if docs[i].name == exact {
			scores[i] += 1000
		}
		if scores[i] > 0 {
			matched = append(matched, i)
		}
	}
	slices.SortStableFunc(matched, func(x, y int) int { return cmp.Compare(scores[y], scores[x]) })
	return matched[:min(len(matched), limit)]
}

// stopwords are left out of queries and documents.
var stopwords = map[string]bool{"a": true, "an": true, "and": true, "the": true, "of": true, "to": true, "in": true, "on": true, "for": true, "with": true, "or": true, "is": true, "it": true, "by": true, "from": true, "this": true, "that": true, "be": true, "as": true, "at": true, "mcp": true, "tool": true, "server": true}

// words splits text into lowercase words at punctuation and underscores,
// each Han character its own word, without stopwords and with a plural s
// dropped. A camelCase word also gives its parts, so GitHub matches both
// github and hub.
func words(text string) []string {
	var out []string
	add := func(w string) {
		w = strings.ToLower(w)
		if len(w) > 3 && strings.HasSuffix(w, "s") && !strings.HasSuffix(w, "ss") {
			w = w[:len(w)-1]
		}
		if !stopwords[w] {
			out = append(out, w)
		}
	}
	var word []rune
	flush := func() {
		if len(word) == 0 {
			return
		}
		add(string(word))
		start := 0
		for i := 1; i < len(word); i++ {
			if unicode.IsUpper(word[i]) && unicode.IsLower(word[i-1]) {
				add(string(word[start:i]))
				start = i
			}
		}
		if start > 0 {
			add(string(word[start:]))
		}
		word = word[:0]
	}
	for _, r := range text {
		switch {
		case unicode.Is(unicode.Han, r):
			flush()
			out = append(out, string(r))
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			word = append(word, r)
		default:
			flush()
		}
	}
	flush()
	return out
}
