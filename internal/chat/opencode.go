package chat

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// OpenCodeVersion is the client release version accepted by OpenCode Zen's gateway.
const OpenCodeVersion = "1.18.34"

// DefaultOpenCodeZenBaseURL is the official OpenCode Zen OpenAI-compatible API endpoint.
const DefaultOpenCodeZenBaseURL = "https://opencode.ai/zen/v1"

// DefaultOpenCodeZenModel is the default free-tier model offered by OpenCode Zen.
const DefaultOpenCodeZenModel = "mimo-v2.6-flash-free"

// DefaultOpenCodeZenKey is the default public key for anonymous free-tier access.
const DefaultOpenCodeZenKey = "public"

// openCodeFreeKnownIDs tracks Zen's free models whose IDs do not end with "-free".
var openCodeFreeKnownIDs = map[string]bool{
	"big-pickle": true,
	"grok-code":  true,
}

var openCodeIDRe = regexp.MustCompile(`^[a-z]{3}_[0-9a-f]{12}[0-9A-Za-z]{14}$`)

const base62Chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// OpenCodeID generates a deterministic or pseudo-random identifier matching OpenCode CLI conventions.
func OpenCodeID(prefix, seed string) string {
	if strings.HasPrefix(seed, prefix+"_") && openCodeIDRe.MatchString(seed) {
		return seed
	}
	var b [32]byte
	if seed != "" {
		b = sha256.Sum256([]byte(seed))
	} else if _, err := rand.Read(b[:]); err != nil {
		b = sha256.Sum256([]byte(NewID()))
	}
	id := []byte(prefix + "_" + hex.EncodeToString(b[:6]))
	for _, c := range b[6:20] {
		id = append(id, base62Chars[int(c)%len(base62Chars)])
	}
	return string(id)
}

// IsOpenCodeZen returns whether the provider targets the OpenCode Zen gateway.
func (p Provider) IsOpenCodeZen() bool {
	u, err := url.Parse(p.BaseURL)
	return err == nil && u.Scheme == "https" && strings.EqualFold(u.Hostname(), "opencode.ai") && (u.Port() == "" || u.Port() == "443") &&
		(u.Path == "/zen" || strings.HasPrefix(u.Path, "/zen/"))
}

// IsOpenCodeFreeTier returns whether this request uses OpenCode's free-tier route.
func (p Provider) IsOpenCodeFreeTier() bool {
	return p.IsOpenCodeZen() && (strings.HasSuffix(p.Model, "-free") || openCodeFreeKnownIDs[p.Model])
}

// ApplyOpenCodeHeaders decorates HTTP headers to match OpenCode official client signatures.
func (p Provider) ApplyOpenCodeHeaders(h http.Header, conversationID string) {
	if !p.IsOpenCodeZen() {
		return
	}
	h.Set("User-Agent", "opencode/"+OpenCodeVersion)
	h.Set("x-opencode-client", "cli")
	h.Set("x-opencode-project", "global")
	sessionID := conversationID
	if sessionID == "" {
		sessionID = "global"
	}
	h.Set("x-opencode-session", OpenCodeID("ses", sessionID))
	h.Set("x-opencode-request", OpenCodeID("msg", ""))
}

// EnsureOpenCodeFreeTools guarantees that tool definitions sent to OpenCode Zen free models
// include the required 'bash' and 'read' declarations required by the upstream validator.
func EnsureOpenCodeFreeTools(existing []any) []any {
	hasBash, hasRead := false, false
	for _, item := range existing {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if fn, ok := m["function"].(map[string]any); ok {
			if name, ok := fn["name"].(string); ok {
				if name == "bash" {
					hasBash = true
				} else if name == "read" {
					hasRead = true
				}
			}
		}
	}
	res := append([]any(nil), existing...)
	schema := map[string]any{"type": "object", "properties": map[string]any{}}
	stubDesc := "Not available in this session. Never call this tool."
	if !hasBash {
		res = append(res, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        "bash",
				"description": stubDesc,
				"parameters":  schema,
			},
		})
	}
	if !hasRead {
		res = append(res, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        "read",
				"description": stubDesc,
				"parameters":  schema,
			},
		})
	}
	return res
}
