// Package catalog knows what models can do. It reads the models.dev catalog
// from Mob's cache (or OpenCode's) and refreshes it in the background. The
// catalog describes models; it never decides which ones a provider serves.
package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/adrg/xdg"
	"github.com/fdkevin0/mob/internal/llm"
)

// URL is the models.dev catalog; a variable for tests.
var URL = "https://models.dev/api.json"

const (
	staleAfter = 24 * time.Hour
	checkEvery = time.Hour
	maxSize    = 64 << 20
)

type Catalog struct {
	// Path is Mob's cache; Fallbacks are read when it is missing (OpenCode's cache).
	Path      string
	Fallbacks []string
	Transport http.RoundTripper

	mu     sync.Mutex
	loaded bool
	data   map[string]provider
	byID   map[string]llm.Info // bare id → what most providers serving it say
	syncMu sync.Mutex
}

type provider struct {
	Name   string           `json:"name"`
	Models map[string]model `json:"models"`
}

type model struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ReleaseDate string `json:"release_date"`
	Reasoning   bool   `json:"reasoning"`
	ToolCall    bool   `json:"tool_call"`
	Attachment  bool   `json:"attachment"`
	Options     []struct {
		Type   string   `json:"type"`
		Values []string `json:"values"`
	} `json:"reasoning_options"`
	Modalities struct {
		Input  []string `json:"input"`
		Output []string `json:"output"`
	} `json:"modalities"`
	Cost *struct {
		Input      float64 `json:"input"`
		Output     float64 `json:"output"`
		CacheRead  float64 `json:"cache_read"`
		CacheWrite float64 `json:"cache_write"`
	} `json:"cost"`
	Limit struct {
		Context int `json:"context"`
		Input   int `json:"input"`
		Output  int `json:"output"`
	} `json:"limit"`
}

// chat reports whether the model answers in text: image and embedding
// models are kept out of every list.
func (m model) chat() bool {
	return len(m.Modalities.Output) == 0 || slices.Contains(m.Modalities.Output, "text")
}

func (m model) info(id string) llm.Info {
	i := llm.Info{ID: id, Name: m.Name, Output: m.Limit.Output, Reasoning: m.Reasoning, Tools: m.ToolCall, Known: true,
		Vision: slices.Contains(m.Modalities.Input, "image")}
	// The input limit, where given, is what a prompt may hold of the window.
	i.Context = m.Limit.Context
	if m.Limit.Input > 0 && (i.Context == 0 || m.Limit.Input < i.Context) {
		i.Context = m.Limit.Input
	}
	for _, o := range m.Options {
		if o.Type == "effort" {
			i.Efforts = o.Values
		}
	}
	if m.Cost != nil {
		i.Cost = &llm.Cost{Input: m.Cost.Input, Output: m.Cost.Output, CacheRead: m.Cost.CacheRead, CacheWrite: m.Cost.CacheWrite}
	}
	return i
}

// bare drops a routing prefix: a gateway's "deepseek/deepseek-chat" is deepseek-chat.
func bare(id string) string {
	if i := strings.LastIndex(id, "/"); i >= 0 {
		id = id[i+1:]
	}
	return strings.ToLower(id)
}

func (c *Catalog) load() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.loaded {
		return
	}
	c.loaded = true
	for _, path := range append([]string{c.Path}, c.Fallbacks...) {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var data map[string]provider
		if json.Unmarshal(raw, &data) != nil || len(data) == 0 {
			continue
		}
		c.data = data
		c.byID = vote(data)
		return
	}
}

// vote describes each bare model id as most of the providers serving it do,
// for providers the catalog does not know (relays, local servers).
func vote(data map[string]provider) map[string]llm.Info {
	type tally struct {
		first                    llm.Info
		reasoning, tools, vision int
		contexts, outputs        map[int]int
	}
	tallies := map[string]*tally{}
	pids := slices.Sorted(maps.Keys(data))
	for _, pid := range pids {
		for id, m := range data[pid].Models {
			if !m.chat() {
				continue
			}
			key := bare(id)
			i := m.info(key)
			t := tallies[key]
			if t == nil {
				t = &tally{first: i, contexts: map[int]int{}, outputs: map[int]int{}}
				tallies[key] = t
			}
			// Names and reasoning levels come from the first provider giving any.
			if t.first.Name == "" {
				t.first.Name = i.Name
			}
			if len(t.first.Efforts) == 0 {
				t.first.Efforts = i.Efforts
			}
			for _, v := range []struct {
				n  *int
				ok bool
			}{{&t.reasoning, i.Reasoning}, {&t.tools, i.Tools}, {&t.vision, i.Vision}} {
				if v.ok {
					*v.n++
				} else {
					*v.n--
				}
			}
			if i.Context > 0 {
				t.contexts[i.Context]++
			}
			if i.Output > 0 {
				t.outputs[i.Output]++
			}
		}
	}
	most := func(counts map[int]int) int {
		best, n := 0, 0
		for v, c := range counts {
			if c > n || (c == n && v < best) {
				best, n = v, c
			}
		}
		return best
	}
	out := make(map[string]llm.Info, len(tallies))
	for id, t := range tallies {
		i := t.first
		i.Reasoning, i.Tools, i.Vision = t.reasoning > 0, t.tools > 0, t.vision > 0
		i.Context, i.Output = most(t.contexts), most(t.outputs)
		i.Cost = nil // a relay's price is no maker's list price
		out[id] = i
	}
	return out
}

// Lookup describes a model: the provider's own entry first, then the bare
// id across providers. ok is false when the catalog does not know it.
func (c *Catalog) Lookup(providerID, modelID string) (llm.Info, bool) {
	c.load()
	c.mu.Lock()
	defer c.mu.Unlock()
	if m, ok := c.data[providerID].Models[modelID]; ok && providerID != "" {
		return m.info(modelID), true
	}
	if i, ok := c.byID[bare(modelID)]; ok {
		i.ID = modelID
		return i, true
	}
	return llm.Info{ID: modelID}, false
}

// Models lists one catalog provider's chat models, newest first.
func (c *Catalog) Models(providerID string) []llm.Info {
	c.load()
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.data[providerID]
	ids := make([]string, 0, len(p.Models))
	for id, m := range p.Models {
		if m.chat() {
			ids = append(ids, id)
		}
	}
	slices.SortFunc(ids, func(a, b string) int {
		if d := strings.Compare(p.Models[b].ReleaseDate, p.Models[a].ReleaseDate); d != 0 {
			return d
		}
		return strings.Compare(a, b)
	})
	out := make([]llm.Info, len(ids))
	for i, id := range ids {
		out[i] = p.Models[id].info(id)
	}
	return out
}

// Source is the catalog file in use, or "" before any was fetched.
func (c *Catalog) Source() string {
	for _, path := range append([]string{c.Path}, c.Fallbacks...) {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return ""
}

func (c *Catalog) stale() bool {
	st, err := os.Stat(c.Path)
	return err != nil || time.Since(st.ModTime()) > staleAfter
}

// Sync downloads the catalog into Path and reloads it.
func (c *Catalog) Sync(ctx context.Context) error {
	c.syncMu.Lock()
	defer c.syncMu.Unlock()
	req, err := http.NewRequestWithContext(ctx, "GET", URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "mob")
	client := http.Client{Transport: c.Transport, Timeout: time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("models.dev: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("models.dev: HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxSize+1))
	if err != nil {
		return err
	}
	var probe map[string]provider
	if len(raw) > maxSize || json.Unmarshal(raw, &probe) != nil || len(probe) == 0 {
		return errors.New("models.dev: unexpected payload")
	}
	if err = os.MkdirAll(filepath.Dir(c.Path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(c.Path), ".models-*.json")
	if err != nil {
		return err
	}
	_, err = tmp.Write(raw)
	err = errors.Join(err, tmp.Close())
	if err == nil {
		err = os.Rename(tmp.Name(), c.Path)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	c.mu.Lock()
	c.loaded = false
	c.mu.Unlock()
	return nil
}

// KeepFresh refreshes a stale catalog now and hourly until ctx ends.
func (c *Catalog) KeepFresh(ctx context.Context, report func(error)) {
	for {
		if c.stale() {
			if err := c.Sync(ctx); err != nil && ctx.Err() == nil {
				report(err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(checkEvery):
		}
	}
}

// Default caches in Mob's XDG cache directory and falls back to OpenCode's copy.
func Default() *Catalog {
	c := &Catalog{Path: filepath.Join(xdg.CacheHome, "mob", "models.json")}
	if home, err := os.UserHomeDir(); err == nil {
		c.Fallbacks = []string{filepath.Join(home, ".cache", "opencode", "models.json")}
	}
	return c
}
