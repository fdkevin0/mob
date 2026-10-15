// Package mcp connects Mob to Model Context Protocol servers and offers their
// tools to the model. Servers are listed under mcp_servers in config.yaml.
package mcp

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/fdkevin0/mob/internal/chat"
)

// Server is how Mob reaches one MCP server: a command it starts and talks to
// over stdin and stdout, or the URL of a Streamable HTTP endpoint.
type Server struct {
	Command string   `mapstructure:"command"`
	Args    []string `mapstructure:"args"`
	// Env adds KEY=VALUE entries to the environment the command inherits
	// from Mob, which leaves out Mob's own MOB_* variables.
	Env []string `mapstructure:"env"`
	// Dir is the command's working directory; empty is Mob's.
	Dir string `mapstructure:"dir"`
	URL string `mapstructure:"url"`
	// Headers are sent with every request to URL, such as Authorization.
	Headers map[string]string `mapstructure:"headers"`
	// Exposure is how the server's tools reach the model: deferred, the
	// default, until tool_search loads them; direct; or hidden.
	Exposure string `mapstructure:"exposure"`
	// ToolExposure sets the exposure of the tools whose names match a glob,
	// such as "get_*", over Exposure. An exact name wins over a glob, and a
	// longer glob over a shorter one.
	ToolExposure map[string]string `mapstructure:"tool_exposure"`
}

// Servers are the configured servers by name.
type Servers map[string]Server

// serverName is what a server may be called: its tools are named
// mcp__<server>__<tool>, and models accept only these characters. A name
// neither contains __ nor begins or ends with _, so the first __ after the
// prefix always ends the server's name: fs with _read_file and fs_ with
// read_file cannot both become mcp__fs___read_file.
var serverName = regexp.MustCompile(`^[a-z0-9-]+(_[a-z0-9-]+)*$`)

// Validate refuses a server that names neither or both of a command and a
// URL, or that cannot be told apart in tool names.
func (s Servers) Validate() error {
	for _, name := range s.names() {
		server := s[name]
		fail := func(message string) error { return fmt.Errorf("mcp_servers.%s: %s", name, message) }
		if len(name) > 32 || !serverName.MatchString(name) {
			return fail("names use a-z, 0-9, - and single _ between them, up to 32 characters")
		}
		if server.Exposure != "" {
			if _, err := chat.ParseExposure(server.Exposure); err != nil {
				return fail(err.Error())
			}
		}
		for glob, exposure := range server.ToolExposure {
			if _, err := path.Match(glob, ""); err != nil {
				return fail(fmt.Sprintf("tool_exposure %q is not a valid glob", glob))
			}
			if _, err := chat.ParseExposure(exposure); err != nil {
				return fail("tool_exposure " + strconv.Quote(glob) + ": " + err.Error())
			}
		}
		switch {
		case (server.Command == "") == (server.URL == ""):
			return fail("set either command or url")
		case server.URL != "":
			u, err := url.Parse(server.URL)
			if err != nil || u.Scheme != "https" && u.Scheme != "http" || u.Host == "" {
				return fail("url must be an http or https URL")
			}
			if len(server.Args) > 0 || len(server.Env) > 0 || server.Dir != "" {
				return fail("args, env and dir are for a command")
			}
		default:
			if len(server.Headers) > 0 {
				return fail("headers are for a url")
			}
			for _, entry := range server.Env {
				if key, _, ok := strings.Cut(entry, "="); !ok || key == "" {
					return fail("env entries are KEY=VALUE")
				}
			}
		}
	}
	return nil
}

// names are the servers in order.
func (s Servers) names() []string {
	var names []string
	for name := range s {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

// exposure is how the server's tool reaches the model.
func (s Server) exposure(tool string) chat.Exposure {
	best, chosen, value := -1, "", s.Exposure
	for glob, exposure := range s.ToolExposure {
		weight := len(glob)
		if glob == tool {
			weight = math.MaxInt
		}
		// Equal globs are told apart by their text, so the choice is stable.
		if ok, _ := path.Match(glob, tool); ok && (weight > best || weight == best && glob < chosen) {
			best, chosen, value = weight, glob, exposure
		}
	}
	e, err := chat.ParseExposure(value)
	if err != nil {
		return chat.Deferred
	}
	return e
}

// target is what an approval shows the server as: its URL, or its command
// and each argument quoted.
func (s Server) target() string {
	if s.URL != "" {
		return s.URL
	}
	words := []string{strconv.Quote(s.Command)}
	for _, arg := range s.Args {
		words = append(words, strconv.Quote(arg))
	}
	return strings.Join(words, " ")
}

// fingerprint identifies the whole configuration of a server, its
// environment, directory and headers included, without showing their values.
// An approved call runs only while the fingerprint is unchanged, so a server
// switched to another account or program asks again.
func (s Server) fingerprint() string {
	canonical := struct {
		Command, Dir, URL string
		Args, Env         []string
		Headers           map[string]string
	}{s.Command, s.Dir, s.URL, s.Args, s.Env, s.Headers}
	if len(canonical.Args) == 0 {
		canonical.Args = nil
	}
	if len(canonical.Env) == 0 {
		canonical.Env = nil
	}
	if len(canonical.Headers) == 0 {
		canonical.Headers = nil
	}
	raw, _ := json.Marshal(canonical)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:12])
}

// errUnknown is a call to a server that is not configured any more.
var errUnknown = errors.New("this MCP server is no longer configured")
