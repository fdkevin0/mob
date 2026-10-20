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

func TestRunnerPairsFromEnvironmentOnce(t *testing.T) {
	const id = "22222222-2222-4222-8222-222222222222"
	const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	claims := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims++
		json.NewEncoder(w).Encode(map[string]string{"id": id, "token": strings.Repeat("t", 72)})
	}))
	defer server.Close()
	input, _ := json.Marshal(map[string]string{"url": server.URL, "id": id, "code": strings.Repeat("c", 72), "key": key})
	t.Setenv("MOB_RUNNER_PAIRING", string(input))
	config := local.Config{Dir: t.TempDir()}
	// Each start reads the variable again; the spent code is claimed only once.
	for range 2 {
		command := runnerCommand(&config)
		command.SetOut(io.Discard)
		command.SetArgs(nil)
		// Without a running Mob the command stops after pairing.
		if err := command.Execute(); err == nil || strings.Contains(err.Error(), "MOB_RUNNER_PAIRING") {
			t.Fatalf("want a missing service after pairing, got %v", err)
		}
	}
	if claims != 1 {
		t.Fatalf("claimed %d times", claims)
	}
	if !pairedAs(filepath.Join(config.Dir, "runner.json"), string(input)) {
		t.Fatal("runner.json does not hold the pairing")
	}
}
