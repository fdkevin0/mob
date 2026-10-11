package provider

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
)

// quirk adapts one vendor's requests after the driver builds them.
type quirk func(model string, req *http.Request, body map[string]any)

// openCodeVersion is the client release version accepted by OpenCode Zen's gateway.
const openCodeVersion = "1.18.34"

// openCodeFreeIDs are Zen's free models whose IDs do not end with "-free".
var openCodeFreeIDs = map[string]bool{"big-pickle": true, "grok-code": true}

func openCodeFree(model string) bool {
	return strings.HasSuffix(model, "-free") || openCodeFreeIDs[model]
}

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// openCodeID matches OpenCode CLI identifiers: deterministic for a seed, random without one.
func openCodeID(prefix, seed string) string {
	var b [32]byte
	if seed != "" {
		b = sha256.Sum256([]byte(seed))
	} else {
		_, _ = rand.Read(b[:])
	}
	id := []byte(prefix + "_" + hex.EncodeToString(b[:6]))
	for _, c := range b[6:20] {
		id = append(id, base62[int(c)%len(base62)])
	}
	return string(id)
}

// openCode presents requests as the OpenCode CLI does. Its free tier also
// rejects requests whose tools lack the CLI's bash and read, so inert stubs
// are declared when missing.
func openCode(model string, req *http.Request, body map[string]any) {
	h := req.Header
	h.Set("User-Agent", "opencode/"+openCodeVersion)
	h.Set("x-opencode-client", "cli")
	h.Set("x-opencode-project", "global")
	h.Set("x-opencode-session", openCodeID("ses", "global"))
	h.Set("x-opencode-request", openCodeID("msg", ""))
	if !openCodeFree(model) {
		return
	}
	tools, _ := body["tools"].([]map[string]any)
	have := map[string]bool{}
	for _, t := range tools {
		if fn, ok := t["function"].(map[string]any); ok {
			name, _ := fn["name"].(string)
			have[name] = true
		}
	}
	for _, name := range []string{"bash", "read"} {
		if !have[name] {
			tools = append(tools, map[string]any{"type": "function", "function": map[string]any{
				"name": name, "description": "Not available in this session. Never call this tool.", "parameters": map[string]any{"type": "object", "properties": map[string]any{}}}})
		}
	}
	body["tools"] = tools
}
