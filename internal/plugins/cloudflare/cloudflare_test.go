package cloudflare

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestServiceRequests(t *testing.T) {
	var paths []string
	transport := transportFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.cloudflare.com" || r.Header.Get("Authorization") != "Bearer secret-token" {
			t.Errorf("unexpected destination or auth")
		}
		path := r.URL.Path
		paths = append(paths, path)
		result := `{"success":true,"result":[]}`
		switch {
		case strings.HasSuffix(path, "/tokens/verify"):
			result = `{"success":true,"result":{"status":"active"}}`
		case strings.Contains(path, "/ai/run/@cf/embed"):
			result = `{"success":true,"result":{"data":[[0.1,0.2]]}}`
		case strings.HasSuffix(path, "/indexes/test/query"):
			var body struct {
				Vector []float64 `json:"vector"`
				TopK   int       `json:"topK"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			if len(body.Vector) != 2 || body.TopK != 5 {
				t.Error("embedding not passed to Vectorize")
			}
		case strings.HasSuffix(path, "/d1/database/db/query"):
			var body struct {
				SQL    string `json:"sql"`
				Params []any  `json:"params"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			if body.SQL != "SELECT ?" || len(body.Params) != 1 {
				t.Error("D1 query parameters lost")
			}
		case strings.Contains(path, "/values/"):
			result = "stored value"
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(result)), Header: make(http.Header)}, nil
	})
	c := Config{Transport: transport, Enabled: true, AccountID: strings.Repeat("a", 32), Token: "secret-token", Model: "@cf/chat", EmbeddingModel: "@cf/embed", Index: "test", DatabaseID: "db", NamespaceID: "ns"}
	for _, a := range []Action{{Operation: "test"}, {Operation: "ai.models"}, {Operation: "ai.run", Text: "hello"}, {Operation: "vectorize.indexes"}, {Operation: "vectorize.query", Text: "find a fact"}, {Operation: "d1.databases"}, {Operation: "d1.query", SQL: "SELECT ?", Params: []any{"value"}}, {Operation: "kv.namespaces"}, {Operation: "kv.get", Key: "hello/world"}, {Operation: "r2.buckets"}} {
		if _, err := c.Do(context.Background(), a); err != nil {
			t.Fatalf("%s: %v", a.Operation, err)
		}
	}
	if len(paths) != 11 {
		t.Fatalf("expected 11 requests, got %d", len(paths))
	}
	listPaths := []string{paths[1], paths[3], paths[6], paths[8], paths[10]}
	for i := range listPaths {
		listPaths[i] = strings.TrimPrefix(listPaths[i], "/client/v4/accounts/"+c.AccountID)
	}
	if !slices.Equal(listPaths, []string{"/ai/models/search", "/vectorize/v2/indexes", "/d1/database", "/storage/kv/namespaces", "/r2/buckets"}) {
		t.Fatalf("unexpected list routes: %v", listPaths)
	}
	disabled := c
	disabled.Enabled = false
	for _, operation := range []string{"ai.models", "vectorize.indexes", "d1.databases", "kv.namespaces", "r2.buckets"} {
		if _, err := disabled.Do(context.Background(), Action{Operation: operation}); err == nil || len(paths) != 11 {
			t.Fatalf("disabled list operation sent to Cloudflare: %s", operation)
		}
	}
	if _, err := c.Do(context.Background(), Action{Operation: "r2.get", Key: "private"}); err == nil {
		t.Fatal("R2 object access allowed without S3 credentials")
	}
	c.Index = "../bad"
	before := len(paths)
	if _, err := c.Do(context.Background(), Action{Operation: "vectorize.query", Text: "x"}); err == nil || len(paths) != before {
		t.Fatal("invalid resource path sent to Cloudflare")
	}
	if c.Public().Token != "" {
		t.Fatal("API token exposed")
	}
}
