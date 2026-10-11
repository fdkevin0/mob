package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/configuration"
	"github.com/fdkevin0/mob/internal/extension"
	"github.com/fdkevin0/mob/internal/plugins/cloudflare"
	"github.com/fdkevin0/mob/internal/plugins/email"
	"github.com/fdkevin0/mob/internal/plugins/mcp"
	"github.com/fdkevin0/mob/internal/plugins/telegram"
	"github.com/fdkevin0/mob/internal/plugins/wechatilink"
)

func (s *Server) pluginConfig() (configuration.Plugins, error) {
	var c configuration.Plugins
	err := s.Store.Setting("plugins", &c)
	c.Telegram.Transport = s.HTTPTransport
	c.Cloudflare.Transport = s.HTTPTransport
	return c, err
}

// plugin is what one plugin adds to Mob besides its configuration section,
// which package configuration describes.
type plugin struct {
	name     string
	commands []chat.Command
	tools    []chat.Tool
	routes   []extension.Route
	// source lists tools that change while Mob runs.
	source func() []chat.Tool
	// background is set for a plugin that runs while it is enabled.
	background *extension.Extension
}

// plugins lists every plugin and what it adds. Each plugin reads the saved
// configuration whenever it needs it.
func (s *Server) plugins() []plugin {
	mail := email.Host{Config: func() (email.Config, error) { c, err := s.pluginConfig(); return c.Email, err }, Store: s.Store, Model: s.defaultModel}
	cloud := func() (cloudflare.Config, error) { c, err := s.pluginConfig(); return c.Cloudflare, err }
	bot := func() (telegram.Config, error) { c, err := s.pluginConfig(); return c.Telegram, err }
	wechat := wechatilink.Host{Config: func() (wechatilink.Config, error) { c, err := s.pluginConfig(); return c.WeChatILink, err }, Store: s.Store, Conversation: s.ConversationService, Transport: func() http.RoundTripper { return s.HTTPTransport }}
	telegramRun := telegram.Extension(bot, s.Store, s.ConversationService)
	wechatRun := wechatilink.Extension(wechat)
	mcpRun := mcp.Extension(s.MCP)
	return []plugin{
		{name: "email", commands: email.Commands(mail), tools: email.Tools(mail.Config), routes: email.Routes(mail)},
		{name: "telegram", background: &telegramRun},
		{name: "cloudflare", commands: cloudflare.Commands(cloud), tools: cloudflare.Tools(cloud), routes: cloudflare.Routes(cloud)},
		{name: "wechat_ilink", routes: wechatilink.Routes(wechat), background: &wechatRun},
		{name: "mcp", commands: mcp.Commands(s.MCP), source: s.MCP.Tools, background: &mcpRun},
	}
}

// register adds every plugin's commands, tools and background run.
func (s *Server) register() {
	for _, p := range s.plugins() {
		s.Commands.Register(p.commands...)
		s.Tools.Register(p.tools...)
		if p.source != nil {
			s.Tools.RegisterSource(p.source)
		}
		if p.background != nil {
			s.extensions.Register(*p.background)
		}
	}
}

// pluginRoute serves a plugin's route, mapping its errors to statuses.
func pluginRoute(route extension.Route) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		result, err := route.Handle(r)
		var command *chat.CommandError
		if errors.As(err, &command) {
			http.Error(w, command.Message, command.Status)
			return
		}
		pluginResult(w, result, err)
	}
}

func (s *Server) StartPlugins() error { return s.extensions.StartAll() }

func (s *Server) closePlugins() { s.extensions.Close() }

func decodeRequest(w http.ResponseWriter, r *http.Request, dest any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(dest) != nil || d.Decode(new(any)) != io.EOF {
		http.Error(w, "invalid request", 400)
		return false
	}
	return true
}

func pluginResult(w http.ResponseWriter, result any, err error) {
	if err != nil {
		http.Error(w, err.Error(), 502)
	} else {
		writeJSON(w, 200, result)
	}
}

func (s *Server) pluginRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/deliveries", func(w http.ResponseWriter, r *http.Request) { data, err := s.Store.Deliveries(); respond(w, data, err) })
	mux.HandleFunc("GET /api/plugins", func(w http.ResponseWriter, r *http.Request) {
		c, err := s.pluginConfig()
		if err != nil {
			respond(w, nil, err)
			return
		}
		writeJSON(w, 200, map[string]any{"config": c.Public(), "sections": configuration.Sections(), "telegramStatus": s.extensions.Status("telegram"), "wechatStatus": s.extensions.Status("wechat_ilink")})
	})
	mux.HandleFunc("POST /api/plugins/{plugin}", s.savePlugin)
	mux.HandleFunc("POST /api/plugins/{plugin}/test", func(w http.ResponseWriter, r *http.Request) {
		result, err := s.testPlugin(r.Context(), r.PathValue("plugin"))
		var command *chat.CommandError
		if errors.As(err, &command) {
			http.Error(w, command.Message, command.Status)
			return
		}
		pluginResult(w, result, err)
	})
	for _, p := range s.plugins() {
		for _, route := range p.routes {
			mux.HandleFunc(route.Method+" /api/plugins/"+p.name+"/"+route.Path, pluginRoute(route))
		}
	}
}

// testPlugin checks an enabled plugin's connection. A disabled or unknown
// plugin is a *chat.CommandError.
func (s *Server) testPlugin(ctx context.Context, name string) (any, error) {
	section, ok := configuration.Lookup(name)
	if !ok {
		return nil, &chat.CommandError{Status: 404, Message: "unknown plugin " + name}
	}
	c, err := s.pluginConfig()
	if err != nil {
		return nil, err
	}
	if !section.Enabled(c) {
		return nil, &chat.CommandError{Status: 409, Message: section.Label + " is disabled"}
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return section.Test(ctx, c)
}

func (s *Server) savePlugin(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256<<10))
	if err != nil {
		http.Error(w, "invalid configuration", 400)
		return
	}
	c, err := s.updatePlugin(r.PathValue("plugin"), raw)
	var command *chat.CommandError
	if errors.As(err, &command) {
		http.Error(w, command.Message, command.Status)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	writeJSON(w, 200, c.Public())
}

// updatePlugin saves one plugin's configuration and restarts it if it runs in
// the background.
func (s *Server) updatePlugin(name string, raw []byte) (configuration.Plugins, error) {
	if s.extensions.Closed() {
		return configuration.Plugins{}, &chat.CommandError{Status: 503, Message: "service is stopping"}
	}
	c, err := s.Configuration.UpdatePlugin(name, raw)
	if err != nil {
		return c, err
	}
	if err := s.extensions.Reload(name); err != nil && !errors.Is(err, extension.ErrClosed) {
		return c, err
	}
	return c, nil
}
