// Package mcp connects Mob to Model Context Protocol servers and offers their
// tools to the model. Servers are listed under mcp_servers in config.yaml.
package mcp

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
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
}

// Servers are the configured servers by name.
type Servers map[string]Server

// serverName is what a server may be called: its tools are named
// mcp__<server>__<tool>, and models accept only these characters.
var serverName = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

// Validate refuses a server that names neither or both of a command and a
// URL, or that cannot be told apart in tool names.
func (s Servers) Validate() error {
	for _, name := range s.names() {
		server := s[name]
		fail := func(message string) error { return fmt.Errorf("mcp_servers.%s: %s", name, message) }
		if !serverName.MatchString(name) || strings.Contains(name, "__") {
			return fail("names use a-z, 0-9, - and single _, up to 32 characters")
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

// target is what an approved call reaches: the command line or the URL. A
// call approved for one target does not run against another.
func (s Server) target() string {
	if s.URL != "" {
		return s.URL
	}
	return strings.Join(append([]string{s.Command}, s.Args...), " ")
}

// errUnknown is a call to a server that is not configured any more.
var errUnknown = errors.New("this MCP server is no longer configured")
