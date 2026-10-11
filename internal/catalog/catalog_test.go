package catalog

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

const fixture = `{
 "deepseek": {"name": "DeepSeek", "models": {
  "deepseek-chat": {"id": "deepseek-chat", "name": "DeepSeek Chat", "release_date": "2025-01-01", "tool_call": true, "limit": {"context": 128000, "output": 8192}, "cost": {"input": 0.27, "output": 1.1}},
  "deepseek-reasoner": {"id": "deepseek-reasoner", "name": "DeepSeek Reasoner", "release_date": "2025-02-01", "reasoning": true, "tool_call": true, "limit": {"context": 128000, "output": 64000}}
 }},
 "relay-a": {"name": "A", "models": {"maker/vision-1": {"id": "maker/vision-1", "tool_call": true, "modalities": {"input": ["text", "image"]}, "limit": {"context": 200000, "input": 150000}, "reasoning_options": [{"type": "effort", "values": ["low", "high"]}]}}},
 "relay-b": {"name": "B", "models": {
  "vision-1": {"id": "vision-1", "modalities": {"input": ["text", "image"]}, "limit": {"context": 150000}},
  "painter": {"id": "painter", "modalities": {"input": ["text"], "output": ["image"]}}
 }}
}`

func TestLookupAndModels(t *testing.T) {
	path := filepath.Join(t.TempDir(), "models.json")
	if err := os.WriteFile(path, []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	c := &Catalog{Path: filepath.Join(t.TempDir(), "absent.json"), Fallbacks: []string{path}}
	i, ok := c.Lookup("deepseek", "deepseek-chat")
	if !ok || i.Name != "DeepSeek Chat" || i.Context != 128000 || i.Output != 8192 || !i.Tools || i.Cost.Input != 0.27 {
		t.Fatalf("provider entry %+v", i)
	}
	// An unknown provider's model is described as most providers serving it say.
	i, ok = c.Lookup("my-relay", "Vision-1")
	if !ok || !i.Vision || i.Context != 150000 || i.Cost != nil || i.ID != "Vision-1" || len(i.Efforts) != 2 {
		t.Fatalf("voted %+v", i)
	}
	if _, ok = c.Lookup("", "painter"); ok {
		t.Fatal("image model described as chat")
	}
	ms := c.Models("deepseek")
	if len(ms) != 2 || ms[0].ID != "deepseek-reasoner" {
		t.Fatalf("models %+v", ms)
	}
}

func TestSync(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, fixture) }))
	defer server.Close()
	old := URL
	URL = server.URL
	defer func() { URL = old }()
	c := &Catalog{Path: filepath.Join(t.TempDir(), "cache", "models.json")}
	if _, ok := c.Lookup("deepseek", "deepseek-chat"); ok || !c.stale() {
		t.Fatal("empty catalog knew a model")
	}
	if err := c.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Lookup("deepseek", "deepseek-chat"); !ok || c.stale() || c.Source() != c.Path {
		t.Fatal("synced catalog not loaded")
	}
}
