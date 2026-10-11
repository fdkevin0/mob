package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/configuration"
	"github.com/fdkevin0/mob/internal/extension"
	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/protocol"
	"github.com/fdkevin0/mob/internal/provider"
	"github.com/fdkevin0/mob/internal/sandbox"
	"github.com/fdkevin0/mob/internal/version"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
)

type Server struct {
	// HTTPTransport is injected before starting optional HTTP integrations.
	HTTPTransport      http.RoundTripper
	Shutdown           func()
	ConfigurationError func() string
	Configuration      *configuration.Service
	Providers          *provider.Registry
	extensions         extension.Manager
	sandbox            sandbox.Settings
	*chat.ConversationService
	// PersistToken saves a rotated token; nil when the token comes from MOB_TOKEN.
	PersistToken func(token string) error
	access       access
}

func NewServer(store *chat.Store, providers *provider.Registry, token string) *Server {
	s := &Server{Configuration: &configuration.Service{Store: store}, Providers: providers, ConversationService: chat.NewConversation(store, providers), access: access{token: token}}
	s.Commands.Register(s.pluginCommands()...)
	s.register()
	return s
}

func (s *Server) defaultModel() (llm.Model, error) { return s.Providers.Resolve(s.Providers.Default()) }

func (s *Server) Close() {
	s.closePlugins()
	s.ConversationService.Close()
}

func (s *Server) Handler(assets fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/runtime", func(w http.ResponseWriter, r *http.Request) {
		failure := ""
		if s.ConfigurationError != nil {
			failure = s.ConfigurationError()
		}
		writeJSON(w, 200, map[string]any{"background": s.Shutdown != nil, "configError": failure, "version": version.Current})
	})
	mux.HandleFunc("POST /api/runtime/stop", func(w http.ResponseWriter, r *http.Request) {
		if s.Shutdown == nil {
			http.Error(w, "service belongs to a foreground/UI process", 409)
			return
		}
		writeJSON(w, 202, map[string]bool{"stopping": true})
		s.Shutdown()
	})
	s.pluginRoutes(mux)
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, configuration.Snapshot{DefaultModel: s.Providers.Default(), Demo: s.Providers.Demo})
	})
	mux.HandleFunc("GET /api/models", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, s.Providers.List(r.Context(), r.URL.Query().Get("q")))
	})
	mux.HandleFunc("GET /api/providers", func(w http.ResponseWriter, r *http.Request) {
		f := s.Providers.File()
		public := make([]provider.Provider, len(f.Providers))
		for i, p := range f.Providers {
			public[i] = p.Public()
		}
		writeJSON(w, 200, map[string]any{"default": f.Default, "providers": public})
	})
	mux.HandleFunc("GET /api/conversations", func(w http.ResponseWriter, r *http.Request) { data, err := s.Store.List(); respond(w, data, err) })
	mux.HandleFunc("POST /api/conversations", func(w http.ResponseWriter, r *http.Request) { data, err := s.Store.Create(); respond(w, data, err) })
	mux.HandleFunc("GET /api/conversations/{id}", func(w http.ResponseWriter, r *http.Request) {
		messages, err := s.Store.History(r.PathValue("id"))
		if err != nil {
			respond(w, nil, err)
			return
		}
		model, err := s.Model(r.PathValue("id"))
		if err != nil {
			respond(w, nil, err)
			return
		}
		writeJSON(w, 200, map[string]any{"messages": messages, "active": s.Active(r.PathValue("id")), "model": model})
	})
	mux.HandleFunc("POST /api/conversations/{id}/stop", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]bool{"stopped": s.Stop(r.PathValue("id"))})
	})
	mux.HandleFunc("GET /api/commands", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, s.Commands.Specs(r.URL.Query().Get("client")))
	})
	mux.HandleFunc("POST /api/commands/complete", func(w http.ResponseWriter, r *http.Request) {
		var input chat.CommandRequest
		if decodeRequest(w, r, &input) {
			writeJSON(w, 200, s.Commands.Complete(r.Context(), input, true))
		}
	})
	mux.HandleFunc("POST /api/commands/run", s.runCommand)
	mux.HandleFunc("POST /api/chat", s.chat)
	mux.HandleFunc("POST /api/pairing", s.pair)
	mux.HandleFunc("POST /api/pairing/claim", s.claim)
	mux.HandleFunc("POST /api/token/rotate", s.rotate)
	if assets != nil {
		mux.Handle("/", http.FileServerFS(assets))
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		origin := r.Header.Get("Origin")
		if !allowedOrigin(origin, r.Host) {
			http.Error(w, "origin denied", http.StatusForbidden)
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == "OPTIONS" {
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.WriteHeader(204)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			if r.URL.Path != "/api/pairing/claim" && !s.authorized(r.Header.Get("Authorization")) {
				http.Error(w, "unauthorized", 401)
				return
			}
		}
		// Reject arbitrary Host headers too, preventing DNS rebinding against a local service.
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			http.Error(w, "host denied", 403)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func allowedOrigin(origin, host string) bool {
	if origin == "" || origin == "wails://wails" || origin == "http://wails.localhost" {
		return true
	}
	// Wails adds a dynamic asset-server port to the macOS development origin.
	if u, err := url.Parse(origin); err == nil && u.Port() != "" && origin == "wails://wails.localhost:"+u.Port() {
		return true
	}
	if origin == "http://"+host {
		return true
	}
	return origin == "http://localhost:5173" || origin == "http://127.0.0.1:5173"
}

func (s *Server) chat(w http.ResponseWriter, r *http.Request) {
	var input chat.ChatRequest
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		http.Error(w, "invalid chat request", 400)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		http.Error(w, "expected one JSON object", 400)
		return
	}
	// Holders of the local token run this Mob.
	input.Owner = true
	started := false
	emit := func(e chat.Event) error {
		if !started {
			beginStream(w)
			started = true
		}
		return writeEvent(w, e)
	}
	err := s.Execute(r.Context(), input, emit)
	if err != nil {
		if !started {
			var command *chat.CommandError
			if errors.As(err, &command) {
				http.Error(w, command.Message, command.Status)
			} else if errors.Is(err, chat.ErrStaleApproval) {
				http.Error(w, err.Error(), 409)
			} else {
				respond(w, nil, err)
			}
			return
		}
		if errors.Is(err, context.Canceled) {
			_ = emit(chat.Event{Kind: chat.TurnAborted})
		} else {
			_ = emit(chat.Event{Kind: chat.TurnFailed, Error: err.Error()})
		}
		_ = emit(chat.Event{Kind: chat.TurnFinished, Reason: "error"})
	}
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	_ = http.NewResponseController(w).Flush()
}

func beginStream(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("x-vercel-ai-ui-message-stream", "v1")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
}
func writeEvent(w http.ResponseWriter, e chat.Event) error {
	raw, err := json.Marshal(protocol.Encode(e))
	if err != nil {
		return err
	}
	if _, err = fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
		return err
	}
	return http.NewResponseController(w).Flush()
}
func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
func respond(w http.ResponseWriter, data any, err error) {
	if errors.Is(err, sql.ErrNoRows) {
		http.Error(w, "conversation not found", 404)
	} else if err != nil {
		log.Printf("database operation failed: %v", err)
		http.Error(w, "database operation failed", 500)
	} else {
		writeJSON(w, 200, data)
	}
}
