package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/fdkevin0/mob/internal/catalog"
	"github.com/fdkevin0/mob/internal/llm"
)

func TestFileLifecycle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "providers.json")
	f, err := Load(path)
	if err != nil || f.Default != "opencode/mimo-v2.6-flash-free" || len(f.Providers) != 1 {
		t.Fatalf("initial %+v %v", f, err)
	}
	f.Providers = append(f.Providers, Provider{ID: "deepseek", Preset: "deepseek", Key: "sk-secret-1234"})
	if err = Save(path, f); err != nil {
		t.Fatal(err)
	}
	if err = Save(path, f); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(path); runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatalf("mode %v", info.Mode())
	}
	if _, err = os.Stat(path + ".bak"); err != nil {
		t.Fatal("previous file not kept")
	}
	got, err := Load(path)
	if err != nil || got.Find("deepseek").Key != "sk-secret-1234" {
		t.Fatalf("round trip %+v %v", got, err)
	}
	if p := got.Find("deepseek").Public(); p.Key != "sk-…1234" {
		t.Fatalf("masked %q", p.Key)
	}
	for _, bad := range []string{`{"providers":[{"id":"x","chat":"http://example.com/v1"}]}`, `{"providers":[],"extra":1}`, `{"providers":[{"id":"demo","preset":"openai"}]}`, `not json`} {
		if err = os.WriteFile(path, []byte(bad), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err = Load(path); !errors.Is(err, ErrUnreadable) {
			t.Errorf("%s: %v", bad, err)
		}
	}
	if runtime.GOOS != "windows" {
		if err = os.WriteFile(path, []byte(`{"providers":[]}`), 0644); err != nil {
			t.Fatal(err)
		}
		os.Chmod(path, 0644)
		if _, err = Load(path); !errors.Is(err, ErrUnreadable) {
			t.Fatal("world-readable keys accepted")
		}
	}
}

func TestPicks(t *testing.T) {
	listed := []string{"a", "b", "c"}
	if got := Picks(Provider{}, listed); strings.Join(got, ",") != "a,b,c" {
		t.Fatal(got)
	}
	// Picks that held everything listed take in what is listed since.
	if got := Picks(Provider{Models: []string{"a", "b"}, PickedFrom: []string{"a", "b"}}, listed); strings.Join(got, ",") != "a,b,c" {
		t.Fatal(got)
	}
	if got := Picks(Provider{Models: []string{"a"}, PickedFrom: []string{"a", "b"}}, listed); strings.Join(got, ",") != "a" {
		t.Fatal(got)
	}
}

// vendor serves a model list and records chat requests.
func vendor(t *testing.T, ids ...string) (*httptest.Server, *[]*http.Request, *[]map[string]any) {
	var reqs []*http.Request
	var bodies []map[string]any
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/models") {
			data := []map[string]string{}
			for _, id := range ids {
				data = append(data, map[string]string{"id": id})
			}
			json.NewEncoder(w).Encode(map[string]any{"data": data})
			return
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		reqs, bodies = append(reqs, r), append(bodies, body)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(s.Close)
	return s, &reqs, &bodies
}

func TestResolve(t *testing.T) {
	one, _, _ := vendor(t, "deepseek-chat", "deepseek-reasoner", "text-embedding-3")
	two, _, _ := vendor(t, "claude-sonnet-5", "gpt-6", "deepseek-chat")
	r, err := Open("", &catalog.Catalog{}, File{Default: "one/deepseek-chat", Providers: []Provider{
		{ID: "one", Chat: one.URL + "/v1", Key: "k1"},
		{ID: "two", Chat: two.URL + "/v1", Anthropic: two.URL, Key: "k2", ModelPrefs: map[string]ModelPref{"gpt-6": {Context: 400000, Efforts: []string{"low", "high"}}}},
		{ID: "off", Chat: one.URL + "/v1", Off: true},
	}})
	if err != nil {
		t.Fatal(err)
	}
	groups := r.List(context.Background(), "")
	if len(groups) != 2 || len(groups[0].Models) != 2 || groups[1].Models[1].ID != "deepseek-chat" {
		t.Fatalf("groups %+v", groups)
	}
	if g := r.List(context.Background(), "reasoner"); len(g) != 1 || len(g[0].Models) != 1 {
		t.Fatalf("filter %+v", g)
	}
	for query, want := range map[string]string{
		"one/deepseek-chat": "one/deepseek-chat",
		"reasoner":          "one/deepseek-reasoner",
		"gpt-6:high":        "two/gpt-6:high",
		"two/unlisted-id":   "two/unlisted-id",
		"sonnet":            "two/claude-sonnet-5",
	} {
		m, err := r.Resolve(query)
		if err != nil || m.Ref().String() != want {
			t.Errorf("%s → %v %v", query, m, err)
		}
	}
	var ambiguous *AmbiguousError
	if _, err = r.Resolve("deepseek-chat"); !errors.As(err, &ambiguous) || len(ambiguous.Candidates) != 2 {
		t.Fatalf("ambiguous: %v", err)
	}
	if _, err = r.Resolve("gpt-6:max"); err == nil {
		t.Fatal("effort outside the model's levels accepted")
	}
	if _, err = r.Resolve("off/deepseek-chat"); err == nil {
		t.Fatal("switched-off provider resolved")
	}
	if m, _ := r.Resolve("two/gpt-6"); m.Info().Context != 400000 {
		t.Fatal("preference ignored")
	}
	// Claude models go to the Anthropic endpoint when the provider has one.
	if m, _ := r.Resolve("sonnet"); fmt.Sprintf("%T", m) != "*anthropic.Model" {
		t.Fatalf("protocol %T", m)
	}
	if m, _ := r.Resolve("two/gpt-6"); fmt.Sprintf("%T", m) != "*openai.Model" {
		t.Fatalf("protocol %T", m)
	}
}

func TestPresetKeys(t *testing.T) {
	zen, reqs, bodies := vendor(t, "mimo-v2.6-flash-free", "paid-model")
	r, err := Open("", &catalog.Catalog{}, File{Providers: []Provider{
		{ID: "opencode", Preset: "opencode", Chat: zen.URL},
		{ID: "deepseek", Preset: "deepseek"},
		{ID: "local", Preset: "ollama", Chat: zen.URL},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = r.Resolve("deepseek/deepseek-chat"); err == nil || !strings.Contains(err.Error(), "no API key") {
		t.Fatalf("keyless preset: %v", err)
	}
	if _, err = r.Resolve("opencode/paid-model"); err == nil {
		t.Fatal("paid Zen model resolved without a key")
	}
	m, err := r.Resolve("opencode/mimo-v2.6-flash-free")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Stream(context.Background(), llm.Request{Messages: []llm.Message{{Role: "user", Text: "hi"}}}, func(string, string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	req, body := (*reqs)[0], (*bodies)[0]
	if req.Header.Get("Authorization") != "Bearer public" || req.Header.Get("User-Agent") != "opencode/"+openCodeVersion || !strings.HasPrefix(req.Header.Get("x-opencode-session"), "ses_") {
		t.Fatalf("headers %v", req.Header)
	}
	if tools, _ := body["tools"].([]any); len(tools) != 2 {
		t.Fatalf("free tier needs bash and read stubs: %v", body["tools"])
	}
	// Without a key, only Zen's free models are offered.
	if g := r.List(context.Background(), "opencode"); len(g[0].Models) != 1 {
		t.Fatalf("keyless Zen list %+v", g)
	}
	m, err = r.Resolve("local/llama")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Stream(context.Background(), llm.Request{}, func(string, string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if last := (*reqs)[len(*reqs)-1]; last.Header.Get("Authorization") != "" || last.Header.Get("x-opencode-client") != "" {
		t.Fatalf("local server got credentials or Zen headers: %v", last.Header)
	}
}

func TestUpdateAndDefault(t *testing.T) {
	path := filepath.Join(t.TempDir(), "providers.json")
	server, _, _ := vendor(t, "m1")
	r, err := Open(path, &catalog.Catalog{}, File{})
	if err != nil {
		t.Fatal(err)
	}
	if err = r.Update(func(f *File) error {
		f.Providers = []Provider{{ID: "custom", Chat: server.URL}} // no network: drop the initial OpenCode entry
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	r.List(context.Background(), "")
	if ref, err := r.SetDefault("m1"); err != nil || ref.String() != "custom/m1" {
		t.Fatalf("%v %v", ref, err)
	}
	other, _ := Open(path, &catalog.Catalog{}, File{})
	if other.Default() != "custom/m1" {
		t.Fatalf("default not saved: %q", other.Default())
	}
	if err = r.Update(func(f *File) error { f.Providers[0].Chat = "http://example.com"; return nil }); err == nil {
		t.Fatal("invalid change saved")
	}
	if loaded, _ := Load(path); loaded.Find("custom").Chat != server.URL {
		t.Fatal("rejected change reached the file")
	}
	r.Demo = true
	if r.Default() != "demo/echo" {
		t.Fatal("demo default")
	}
}

func TestAuditRegressions(t *testing.T) {
	// Vendors echoing the key never pass it on.
	echo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		fmt.Fprintf(w, `{"error":{"message":"Invalid key: %s, header %s"}}`, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), r.Header.Get("X-Team"))
	}))
	defer echo.Close()
	r := Memory(File{Providers: []Provider{{ID: "leaky", Chat: echo.URL, Key: "sk-very-secret", Headers: map[string]string{"X-Team": "team-secret"}}}})
	g := r.List(context.Background(), "")
	m, _ := r.Resolve("leaky/x")
	_, err := m.Stream(context.Background(), llm.Request{}, func(string, string) error { return nil })
	for _, text := range []string{g[0].Error, err.Error()} {
		if !strings.Contains(text, "Invalid key") || strings.Contains(text, "sk-very-secret") || strings.Contains(text, "team-secret") {
			t.Fatalf("secret in error: %q", text)
		}
	}

	// A provider file removed while running keeps the providers in effect.
	path := filepath.Join(t.TempDir(), "providers.json")
	if err = Save(path, File{Default: "work/m", Providers: []Provider{{ID: "work", Chat: echo.URL}}}); err != nil {
		t.Fatal(err)
	}
	r, _ = Open(path, nil, File{})
	os.Remove(path)
	if err = r.Reload(); err == nil || r.Default() != "work/m" {
		t.Fatalf("removal accepted: %v %q", err, r.Default())
	}
	// Saving after the removal starts from the providers in effect, not OpenCode.
	if _, err = r.SetDefault("work/other"); err != nil {
		t.Fatal(err)
	}
	if f, _ := Load(path); f.Find("opencode") != nil || f.Find("work") == nil || f.Default != "work/other" {
		t.Fatalf("rewrite after removal: %+v", f)
	}

	// Short credentials are never echoed either: the message is dropped.
	short := Memory(File{Providers: []Provider{{ID: "short", Chat: echo.URL, Key: "abc", Headers: map[string]string{"X-Team": "xyz"}}}})
	g = short.List(context.Background(), "")
	m, _ = short.Resolve("short/x")
	_, err = m.Stream(context.Background(), llm.Request{}, func(string, string) error { return nil })
	for _, text := range []string{g[0].Error, err.Error()} {
		if !strings.Contains(text, "HTTP 401") || strings.Contains(text, "abc") || strings.Contains(text, "xyz") {
			t.Fatalf("short secret in error: %q", text)
		}
	}

	// A short name for the demo model, or for a provider removed meanwhile, never panics.
	r = Offline()
	if m, err := r.Resolve("echo"); err != nil || m.Ref().String() != "demo/echo" {
		t.Fatalf("demo short name: %v", err)
	}
	r = Memory(File{Providers: []Provider{{ID: "gone", Chat: echo.URL, Models: []string{"only-here"}}}})
	r.Update(func(f *File) error { f.Providers = nil; return nil })
	if _, err = r.model(llm.Ref{Provider: "gone", Model: "only-here"}); err == nil {
		t.Fatal("removed provider built")
	}

	// A changed endpoint under the same ID is listed again.
	a, _, _ := vendor(t, "old-model")
	b, _, _ := vendor(t, "new-model")
	r = Memory(File{Providers: []Provider{{ID: "p", Chat: a.URL}}})
	r.List(context.Background(), "")
	r.Update(func(f *File) error { f.Providers[0].Chat = b.URL; return nil })
	if r.Default() == "p/old-model" {
		t.Fatal("old server's list served after the endpoint changed")
	}
	if g := r.List(context.Background(), ""); len(g[0].Models) != 1 || g[0].Models[0].ID != "new-model" {
		t.Fatalf("stale list after endpoint change: %+v", g)
	}
}

func TestConcurrentWritersKeepEveryChange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "providers.json")
	service, _ := Open(path, &catalog.Catalog{}, File{})
	cli, _ := Open(path, &catalog.Catalog{}, File{})
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func(r *Registry) {
			defer wg.Done()
			if err := r.Update(func(f *File) error {
				f.Providers = append(f.Providers, Provider{ID: fmt.Sprintf("p%d", i), Chat: "https://example.com/v1"})
				return nil
			}); err != nil {
				t.Error(err)
			}
		}([]*Registry{service, cli}[i%2])
	}
	wg.Wait()
	f, err := Load(path)
	if err != nil || len(f.Providers) != 21 {
		t.Fatalf("lost writes: %d providers, %v", len(f.Providers), err)
	}
}
