package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// magpie (https://github.com/yetone/magpie) is a gateway on the user's own
// machine that serves every provider they signed in to there, its plugins
// included, through the OpenAI and Anthropic APIs.
const (
	magpiePort = 3425
	// magpieKey names Mob to the gateway, which takes any key from this
	// machine and counts the calls as Mob's in its usage and routing rules.
	magpieKey = "magpie-mob"
)

// magpieSettings is magpie's settings file, which Mob only reads.
func magpieSettings() string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if !filepath.IsAbs(dir) {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "magpie", "settings.json")
}

// magpieAddress is where the gateway listens: the port in magpie's settings,
// else its default.
func magpieAddress() string {
	port := magpiePort
	if raw, err := os.ReadFile(magpieSettings()); err == nil {
		var settings struct {
			Port int `json:"port"`
		}
		if json.Unmarshal(raw, &settings) == nil && settings.Port > 0 && settings.Port < 1<<16 {
			port = settings.Port
		}
	}
	return "http://127.0.0.1:" + strconv.Itoa(port)
}

// FindMagpie is the base URLs of the magpie gateway running on this machine,
// for the Chat Completions and Anthropic Messages APIs. It fails when
// nothing answers there, or what answers is not magpie.
func FindMagpie(ctx context.Context, transport http.RoundTripper) (chat, anthropic string, err error) {
	address := magpieAddress()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", address+"/api/hello", nil)
	if err != nil {
		return "", "", err
	}
	client := http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("magpie is not running at %s; start the app or `magpie serve`", address)
	}
	defer resp.Body.Close()
	var hello struct {
		Name string `json:"name"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&hello) != nil || hello.Name != "magpie" {
		return "", "", fmt.Errorf("%s is not magpie", address)
	}
	return address + "/v1", address, nil
}
