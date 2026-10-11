package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/configuration"
	"github.com/fdkevin0/mob/internal/extension"
	"github.com/fdkevin0/mob/internal/plugins/cloudflare"
	"github.com/fdkevin0/mob/internal/plugins/email"
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

// channels are the plugins that run in the background: each polls its
// service while its configuration has it on.
func (s *Server) channels() []extension.Extension {
	return []extension.Extension{
		{Name: "telegram", Start: func() (extension.Serve, error) {
			c, err := s.pluginConfig()
			if err != nil || !c.Telegram.Enabled {
				return nil, err
			}
			service := &telegram.Service{Store: s.Store, Conversation: s.ConversationService}
			return func(ctx context.Context, status func(string)) { service.Loop(ctx, c.Telegram, status) }, nil
		}},
		{Name: "wechat_ilink", Start: func() (extension.Serve, error) {
			c, err := s.pluginConfig()
			if err != nil || !c.WeChatILink.Enabled || c.WeChatILink.BotToken == "" {
				return nil, err
			}
			service := &wechatilink.Service{Store: s.Store, Conversation: s.ConversationService}
			return func(ctx context.Context, status func(string)) { service.Loop(ctx, c.WeChatILink, status) }, nil
		}},
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
	mux.HandleFunc("POST /api/plugins/wechat_ilink/qrcode", func(w http.ResponseWriter, r *http.Request) {
		c, err := s.pluginConfig()
		if err != nil {
			respond(w, nil, err)
			return
		}
		client := wechatilink.NewClient(c.WeChatILink, s.HTTPTransport)
		qr, err := client.GetQRCode(r.Context())
		pluginResult(w, qr, err)
	})
	mux.HandleFunc("GET /api/plugins/wechat_ilink/qrcode/status", func(w http.ResponseWriter, r *http.Request) {
		c, err := s.pluginConfig()
		if err != nil {
			respond(w, nil, err)
			return
		}
		qrcode := r.URL.Query().Get("qrcode")
		if qrcode == "" {
			http.Error(w, "missing qrcode parameter", 400)
			return
		}
		client := wechatilink.NewClient(c.WeChatILink, s.HTTPTransport)
		status, err := client.GetQRCodeStatus(r.Context(), qrcode)
		pluginResult(w, status, err)
	})
	mux.HandleFunc("POST /api/plugins/wechat_ilink/message", func(w http.ResponseWriter, r *http.Request) {
		c, err := s.pluginConfig()
		if err != nil || !c.WeChatILink.Enabled {
			http.Error(w, "wechat_ilink plugin disabled", 409)
			return
		}
		var payload struct {
			SenderID     string `json:"senderId"`
			ContextToken string `json:"contextToken"`
			Text         string `json:"text"`
		}
		if !decodeRequest(w, r, &payload) {
			return
		}
		wechatSvc := &wechatilink.Service{
			Store:        s.Store,
			Conversation: s.ConversationService,
		}
		reply, err := wechatSvc.ProcessMessage(r.Context(), c.WeChatILink, payload.SenderID, payload.ContextToken, payload.Text)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJSON(w, 200, map[string]string{"reply": reply})
	})
	mux.HandleFunc("GET /api/plugins/email/inbox", func(w http.ResponseWriter, r *http.Request) {
		c, ok := s.emailConfig(w)
		if !ok {
			return
		}
		result, err := c.Inbox(r.Context())
		pluginResult(w, result, err)
	})
	mux.HandleFunc("GET /api/plugins/email/messages/{uid}", func(w http.ResponseWriter, r *http.Request) {
		c, ok := s.emailConfig(w)
		if !ok {
			return
		}
		uid, e1 := strconv.ParseUint(r.PathValue("uid"), 10, 32)
		validity, e2 := strconv.ParseUint(r.URL.Query().Get("validity"), 10, 32)
		if e1 != nil || e2 != nil || uid == 0 || validity == 0 {
			http.Error(w, "invalid message identity", 400)
			return
		}
		result, err := c.Read(r.Context(), uint32(uid), uint32(validity))
		pluginResult(w, result, err)
	})
	mux.HandleFunc("POST /api/plugins/email/send", s.sendEmail)
	mux.HandleFunc("POST /api/plugins/email/analyze", s.analyzeEmail)
	mux.HandleFunc("POST /api/plugins/cloudflare/action", func(w http.ResponseWriter, r *http.Request) {
		var a cloudflare.Action
		if !decodeRequest(w, r, &a) {
			return
		}
		c, err := s.pluginConfig()
		if err != nil {
			respond(w, nil, err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		defer cancel()
		result, err := c.Cloudflare.Do(ctx, a)
		pluginResult(w, result, err)
	})
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

// enabledEmail is the email configuration, or a *chat.CommandError when the
// plugin is disabled.
func (s *Server) enabledEmail() (email.Config, error) {
	c, err := s.pluginConfig()
	if err != nil {
		return email.Config{}, err
	}
	if !c.Email.Enabled {
		return email.Config{}, &chat.CommandError{Status: 409, Message: "email plugin is disabled"}
	}
	return c.Email, nil
}

func (s *Server) emailConfig(w http.ResponseWriter) (email.Config, bool) {
	c, err := s.enabledEmail()
	var command *chat.CommandError
	if errors.As(err, &command) {
		http.Error(w, command.Message, command.Status)
	} else if err != nil {
		respond(w, nil, err)
	}
	return c, err == nil
}

func (s *Server) sendEmail(w http.ResponseWriter, r *http.Request) {
	c, ok := s.emailConfig(w)
	if !ok {
		return
	}
	var input struct {
		email.Draft
		RequestID string `json:"requestId"`
	}
	if !decodeRequest(w, r, &input) {
		return
	}
	err := (&email.Service{Config: c, Store: s.Store, Model: s.defaultModel}).Send(r.Context(), input.RequestID, input.Draft)
	var command *chat.CommandError
	if errors.As(err, &command) {
		http.Error(w, command.Message, command.Status)
		return
	}
	pluginResult(w, map[string]bool{"sent": true}, err)
}

func (s *Server) analyzeEmail(w http.ResponseWriter, r *http.Request) {
	c, ok := s.emailConfig(w)
	if !ok {
		return
	}
	var input struct {
		UID      uint32 `json:"uid"`
		Validity uint32 `json:"validity"`
	}
	if !decodeRequest(w, r, &input) {
		return
	}
	if input.UID == 0 || input.Validity == 0 {
		http.Error(w, "invalid message identity", 400)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	verdict, err := (&email.Service{Config: c, Store: s.Store, Model: s.defaultModel}).Analyze(ctx, input.UID, input.Validity)
	pluginResult(w, verdict, err)
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
