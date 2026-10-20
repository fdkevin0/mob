package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/local"
	"github.com/fdkevin0/mob/internal/runner"
)

func TestRunnerPairKeepsEncryptionKeyLocal(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	token := strings.Repeat("t", 72)
	code := strings.Repeat("c", 72)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"code":"`+code+`"}` {
			t.Errorf("pairing leaked extra data: %s", body)
		}
		if r.URL.Path != "/api/runners/claim" {
			t.Errorf("path %s", r.URL.Path)
		}
		// Even a compromised relay cannot replace the key or origin on disk.
		json.NewEncoder(w).Encode(map[string]string{"id": id, "token": token, "key": "attacker-key", "url": "https://attacker.test"})
	}))
	defer server.Close()
	config := local.Config{Dir: t.TempDir()}
	command := runnerCommand(&config)
	input, _ := json.Marshal(map[string]string{"url": server.URL, "id": id, "code": code, "key": key})
	command.SetIn(bytes.NewReader(input))
	command.SetOut(io.Discard)
	command.SetErr(io.Discard)
	command.SetArgs([]string{"pair"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(config.Dir, "runner.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var credentials runner.Credentials
	if err := json.Unmarshal(raw, &credentials); err != nil {
		t.Fatal(err)
	}
	if credentials.Key != key || credentials.URL != server.URL || credentials.ID != id || credentials.Token != token {
		t.Fatalf("credentials changed: %+v", credentials)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("credentials permissions: %v", info.Mode())
	}
}
