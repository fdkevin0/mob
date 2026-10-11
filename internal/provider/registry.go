package provider

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
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

	"github.com/fdkevin0/mob/internal/catalog"
	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/llm/anthropic"
	"github.com/fdkevin0/mob/internal/llm/demo"
	"github.com/fdkevin0/mob/internal/llm/openai"
	"github.com/gofrs/flock"
)

// listFresh is how long a vendor's model list is used before /models asks again.
const listFresh = 10 * time.Minute

// Registry resolves model references against providers.json. It is safe for
// concurrent use; the file stays the only source of truth.
type Registry struct {
	// Path is providers.json; empty keeps the registry in memory (tests).
	Path      string
	Catalog   *catalog.Catalog
	Transport http.RoundTripper
	// Demo makes the offline model the default, for MOB_DEMO.
	Demo bool

	mu    sync.RWMutex
	file  File
	lists map[string]list
}

// list is a vendor's model list, valid only for the endpoint and
// credentials it was fetched with (of).
type list struct {
	ids []string
	at  time.Time
	err error
	of  string
}

// fingerprint identifies what a model list depends on, so a provider whose
// endpoint or key changes under the same ID is asked again.
func fingerprint(p Provider) string {
	h := sha256.New()
	h.Write([]byte(p.Destination() + "\x00" + p.Key + "\x00"))
	for _, k := range slices.Sorted(maps.Keys(p.Headers)) {
		h.Write([]byte(k + "\x00" + p.Headers[k] + "\x00"))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// listOf is the provider's cached list, if it still matches the provider.
func (r *Registry) listOf(p Provider) list {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if l := r.lists[p.ID]; l.of == fingerprint(p) {
		return l
	}
	return list{}
}

// Open loads path, or holds file in memory when path is empty.
func Open(path string, c *catalog.Catalog, file File) (*Registry, error) {
	if c == nil {
		c = &catalog.Catalog{}
	}
	r := &Registry{Path: path, Catalog: c, file: file, lists: map[string]list{}}
	if path != "" {
		f, err := Load(path) // a missing file is the initial configuration
		if err != nil {
			return nil, err
		}
		r.file = f
	}
	return r, nil
}

// Reload rereads providers.json; a file that cannot be used leaves the
// providers in effect unchanged. A file removed while running is refused
// too: falling back to the initial configuration would quietly send
// conversations to another provider. Only Open accepts a missing file.
func (r *Registry) Reload() error {
	f, err := read(r.Path)
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.file = f
	r.mu.Unlock()
	return nil
}

func (r *Registry) File() File {
	r.mu.RLock()
	defer r.mu.RUnlock()
	f := r.file
	f.Providers = slices.Clone(f.Providers)
	return f
}

// Update applies change to the file as it is on disk and saves it.
func (r *Registry) Update(change func(*File) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f := r.file
	if r.Path != "" {
		// The service and CLI each change the file; a lock across processes
		// keeps one's read-change-save from overwriting the other's.
		if err := os.MkdirAll(filepath.Dir(r.Path), 0700); err != nil {
			return err
		}
		lock := flock.New(r.Path + ".lock")
		if err := lock.Lock(); err != nil {
			return fmt.Errorf("cannot lock providers.json: %w", err)
		}
		defer lock.Unlock()
		// A file removed meanwhile is rewritten from the providers in
		// effect, never from the initial configuration.
		if disk, err := read(r.Path); err == nil {
			f = disk
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	f.Providers = slices.Clone(f.Providers)
	if err := change(&f); err != nil {
		return err
	}
	if err := f.Validate(); err != nil {
		return err
	}
	if r.Path != "" {
		if err := Save(r.Path, f); err != nil {
			return err
		}
	}
	r.file = f
	return nil
}

// Default is the model reference a conversation starts with.
func (r *Registry) Default() string {
	if r.Demo {
		return demo.Ref.String()
	}
	f := r.File()
	if f.Default != "" {
		return f.Default
	}
	for _, p := range f.Providers {
		if ids := r.available(p); !p.Off && len(ids) > 0 {
			return p.ID + "/" + ids[0]
		}
	}
	return ""
}

// SetDefault resolves query and saves it as the default model.
func (r *Registry) SetDefault(query string) (llm.Ref, error) {
	m, err := r.Resolve(query)
	if err != nil {
		return llm.Ref{}, err
	}
	ref := m.Ref()
	if ref.Provider == demo.ID {
		return llm.Ref{}, errors.New("the demo model cannot be the saved default")
	}
	return ref, r.Update(func(f *File) error { f.Default = ref.String(); return nil })
}

// available lists a provider's model IDs without asking the vendor: the
// user's picks, else its last fetched list, else its catalog entry.
func (r *Registry) available(p Provider) []string {
	ids := Picks(p, r.listOf(p).ids)
	if len(ids) == 0 && p.preset() != nil && p.preset().Catalog != "" {
		for _, i := range r.Catalog.Models(p.preset().Catalog) {
			ids = append(ids, i.ID)
		}
	}
	if pr := p.preset(); pr != nil && pr.PublicKey != "" && p.Key == "" {
		// Without a key only the free tier answers.
		ids = slices.DeleteFunc(ids, func(id string) bool { return !openCodeFree(id) })
		if len(ids) == 0 && pr.Default != "" {
			ids = []string{pr.Default}
		}
	}
	return ids
}

// Picks are the models a provider offers: every one listed when the user
// picked none; otherwise the picks, plus models listed since when the
// picks held everything listed at the time (so "all" stays all).
func Picks(p Provider, listed []string) []string {
	if len(p.Models) == 0 {
		return slices.Clone(listed)
	}
	out := slices.Clone(p.Models)
	if len(p.PickedFrom) == 0 || !subset(p.PickedFrom, p.Models) {
		return out
	}
	for _, id := range listed {
		if !slices.Contains(p.PickedFrom, id) && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

func subset(a, b []string) bool {
	for _, v := range a {
		if !slices.Contains(b, v) {
			return false
		}
	}
	return true
}

// info is the catalog's description of a model with the user's overrides.
// An unknown model is assumed to take tools, as nearly every chat API does.
func (r *Registry) info(p Provider, id string) llm.Info {
	catalogID := ""
	if pr := p.preset(); pr != nil {
		catalogID = pr.Catalog
	}
	i, known := r.Catalog.Lookup(catalogID, id)
	if !known {
		i = llm.Info{ID: id, Tools: true}
	}
	pref := p.ModelPrefs[id]
	i.Name = cmp.Or(pref.Name, i.Name)
	if pref.Context > 0 {
		i.Context = pref.Context
	}
	if pref.Output > 0 {
		i.Output = pref.Output
	}
	for _, v := range []struct {
		dst *bool
		src *bool
	}{{&i.Reasoning, pref.Reasoning}, {&i.Tools, pref.Tools}, {&i.Vision, pref.Vision}} {
		if v.src != nil {
			*v.dst = *v.src
		}
	}
	if len(pref.Efforts) > 0 {
		i.Efforts = pref.Efforts
	}
	if pref.Cost != nil {
		i.Cost = pref.Cost
	}
	return i
}

// protocol picks the API a model is asked on: the user's choice, the only
// one the provider serves, or Anthropic's own for Claude models.
func (p Provider) protocol(model string) Protocol {
	if api := p.ModelPrefs[model].API; api != "" {
		return api
	}
	chat, messages := p.Endpoint(Chat), p.Endpoint(Anthropic)
	if chat == "" || (messages != "" && strings.Contains(strings.ToLower(model), "claude")) {
		return Anthropic
	}
	return Chat
}

func (r *Registry) build(p Provider, ref llm.Ref) (llm.Model, error) {
	info := r.info(p, ref.Model)
	if ref.Effort != "" && ref.Effort != "none" && len(info.Efforts) > 0 && !slices.Contains(info.Efforts, ref.Effort) {
		return nil, fmt.Errorf("%s takes reasoning levels %s", ref.Key(), strings.Join(info.Efforts, ", "))
	}
	key := p.Key
	if pr := p.preset(); key == "" && pr != nil {
		switch {
		case pr.PublicKey != "" && openCodeFree(ref.Model):
			key = pr.PublicKey
		case pr.AppKey != "":
			key = pr.AppKey
		case !pr.NoKey:
			return nil, fmt.Errorf("provider %s has no API key; run: mob provider add %s --key-stdin", p.ID, p.ID)
		}
	}
	proto := p.protocol(ref.Model)
	base := p.Endpoint(proto)
	if base == "" {
		return nil, fmt.Errorf("provider %s has no %s base URL", p.ID, proto)
	}
	if proto == Anthropic {
		return anthropic.New(ref, info, anthropic.Config{BaseURL: base, Key: key, Headers: p.Headers, Transport: r.Transport}), nil
	}
	c := openai.Config{BaseURL: base, Key: key, Headers: p.Headers, Transport: r.Transport}
	if pr := p.preset(); pr != nil && pr.quirk != nil {
		q := pr.quirk
		c.Prepare = func(req *http.Request, body map[string]any) { q(ref.Model, req, body) }
	}
	return openai.New(ref, info, c), nil
}

// AmbiguousError lists the models a short name could mean.
type AmbiguousError struct {
	Query      string
	Candidates []string
}

func (e *AmbiguousError) Error() string {
	return fmt.Sprintf("%q matches several models: %s; use the full provider/model name", e.Query, strings.Join(e.Candidates, ", "))
}

// Resolve finds a model by full reference (provider/model[:effort]), by its
// bare ID when one provider has it, or by a fragment of its ID or name when
// that is unique. A full reference to a configured provider is accepted even
// when the model is not listed: the user may know an ID the list lacks.
func (r *Registry) Resolve(query string) (llm.Model, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, errors.New("no model given")
	}
	if ref, ok := llm.ParseRef(query); ok && (ref.Provider == demo.ID || r.File().Find(ref.Provider) != nil) {
		return r.model(ref)
	}
	effort := ""
	if i := strings.LastIndex(query, ":"); i > 0 && slices.Contains(llm.Efforts, query[i+1:]) {
		query, effort = query[:i], query[i+1:]
	}
	needle := strings.ToLower(query)
	var exact, partial []llm.Ref
	for _, g := range r.groups("") {
		for _, m := range g.Models {
			ref := llm.Ref{Provider: g.Provider, Model: m.ID, Effort: effort}
			id := strings.ToLower(m.ID)
			switch {
			case id == needle || strings.ToLower(ref.Key()) == needle:
				exact = append(exact, ref)
			case strings.Contains(id, needle) || strings.Contains(strings.ToLower(m.Name), needle):
				partial = append(partial, ref)
			}
		}
	}
	for _, found := range [][]llm.Ref{exact, partial} {
		switch {
		case len(found) == 1:
			return r.model(found[0])
		case len(found) > 1:
			names := make([]string, 0, min(len(found), 10))
			for _, ref := range found[:min(len(found), 10)] {
				names = append(names, ref.Key())
			}
			return nil, &AmbiguousError{Query: query, Candidates: names}
		}
	}
	return nil, fmt.Errorf("no model matches %q; /models lists them", query)
}

// model builds a reference to the demo model or a configured, enabled
// provider; the provider may have been removed since the reference was found.
func (r *Registry) model(ref llm.Ref) (llm.Model, error) {
	if ref.Provider == demo.ID {
		return demo.Model{}, nil
	}
	p := r.File().Find(ref.Provider)
	switch {
	case p == nil:
		return nil, fmt.Errorf("no provider %s", ref.Provider)
	case p.Off:
		return nil, fmt.Errorf("provider %s is switched off", p.ID)
	}
	return r.build(*p, ref)
}

// groups describes every enabled provider's models from what is known now.
func (r *Registry) groups(query string) []llm.Group {
	f := r.File()
	query = strings.ToLower(strings.TrimSpace(query))
	var out []llm.Group
	if r.Demo {
		f.Providers = append([]Provider{{ID: demo.ID, Name: demo.Info.Name}}, f.Providers...)
	}
	for _, p := range f.Providers {
		if p.Off {
			continue
		}
		g := llm.Group{Provider: p.ID, Name: p.DisplayName(), Models: []llm.Info{}}
		if p.ID == demo.ID {
			g.Models = []llm.Info{demo.Info}
		} else {
			for _, id := range r.available(p) {
				g.Models = append(g.Models, r.info(p, id))
			}
		}
		if err := r.listOf(p).err; err != nil {
			g.Error = err.Error()
		}
		if query != "" && !strings.Contains(p.ID, query) && !strings.Contains(strings.ToLower(g.Name), query) {
			g.Models = slices.DeleteFunc(g.Models, func(i llm.Info) bool {
				return !strings.Contains(strings.ToLower(i.ID), query) && !strings.Contains(strings.ToLower(i.Name), query)
			})
			if len(g.Models) == 0 {
				continue
			}
		}
		out = append(out, g)
	}
	return out
}

// List refreshes vendors' model lists older than ten minutes, then describes
// every enabled provider's models matching query.
func (r *Registry) List(ctx context.Context, query string) []llm.Group {
	var wg sync.WaitGroup
	for _, p := range r.File().Providers {
		if p.Off || time.Since(r.listOf(p).at) < listFresh {
			continue
		}
		wg.Add(1)
		go func(p Provider) {
			defer wg.Done()
			ids, err := r.Fetch(ctx, p)
			of := fingerprint(p)
			if err != nil {
				ids = r.listOf(p).ids // keep the last good list for the same endpoint
			}
			r.mu.Lock()
			r.lists[p.ID] = list{ids: ids, at: time.Now(), err: err, of: of}
			r.mu.Unlock()
		}(p)
	}
	wg.Wait()
	return r.groups(query)
}

// nonChat are fragments of model IDs that do not converse.
var nonChat = []string{"embed", "whisper", "tts", "dall-e", "image", "moderation", "transcribe", "rerank", "audio", "realtime", "sora"}

// Fetch asks the vendor which models it serves: ModelsURL, else /models
// under the chat base, else Anthropic's /v1/models.
func (r *Registry) Fetch(ctx context.Context, p Provider) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	url, anthropicAPI := p.ModelsURL, false
	if url == "" && p.Endpoint(Chat) != "" {
		url = strings.TrimRight(p.Endpoint(Chat), "/") + "/models"
	} else if url == "" {
		url, anthropicAPI = strings.TrimRight(p.Endpoint(Anthropic), "/")+"/v1/models?limit=1000", true
	}
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	key := p.Key
	if pr := p.preset(); key == "" && pr != nil {
		key = cmp.Or(pr.PublicKey, pr.AppKey)
	}
	if key != "" {
		if anthropicAPI {
			req.Header.Set("x-api-key", key)
			req.Header.Set("anthropic-version", "2023-06-01")
		} else {
			req.Header.Set("Authorization", "Bearer "+key)
		}
	}
	for k, v := range p.Headers {
		req.Header.Set(k, v)
	}
	client := http.Client{Transport: r.Transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: model list unavailable", p.ID)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %w", p.ID, openai.StatusError(resp, openai.Secrets(key, p.Headers)...))
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&body); err != nil {
		return nil, fmt.Errorf("%s: invalid model list", p.ID)
	}
	ids := []string{}
	for _, m := range body.Data {
		lower := strings.ToLower(m.ID)
		if m.ID == "" || len(m.ID) > 256 || strings.ContainsAny(m.ID, "\r\n\x00 ") || slices.ContainsFunc(nonChat, func(s string) bool { return strings.Contains(lower, s) }) {
			continue
		}
		if !slices.Contains(ids, m.ID) {
			ids = append(ids, m.ID)
		}
	}
	slices.Sort(ids)
	return ids, nil
}

// Memory holds f without a file.
func Memory(f File) *Registry {
	r, _ := Open("", nil, f)
	return r
}

// Offline has no providers; its default is the demo model.
func Offline() *Registry {
	r := Memory(File{})
	r.Demo = true
	return r
}
