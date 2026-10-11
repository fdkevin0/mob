package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/configuration"
	"github.com/fdkevin0/mob/internal/plugins/cloudflare"
	"github.com/fdkevin0/mob/internal/plugins/email"
	"github.com/fdkevin0/mob/internal/plugins/wechatilink"
)

func (s *Server) pluginConfig() (configuration.Plugins, error) {
	var c configuration.Plugins
	err := s.Store.Setting("plugins", &c)
	c.Telegram.Transport = s.HTTPTransport
	c.Cloudflare.Transport = s.HTTPTransport
	return c, err
}

type pluginRuntime struct {
	mu           sync.Mutex
	cancel       context.CancelFunc
	done         chan struct{}
	status       string
	generation   uint64
	wechatCancel context.CancelFunc
	wechatDone   chan struct{}
	wechatStatus string
	wechatGen    uint64
	closed       bool
}

func (s *Server) StartPlugins() error {
	s.plugins.mu.Lock()
	defer s.plugins.mu.Unlock()
	c, err := s.pluginConfig()
	if err != nil {
		return err
	}
	s.restartTelegram(c.Telegram)
	s.restartWechat(c.WeChatILink)
	return nil
}

func (s *Server) closePlugins() {
	s.plugins.mu.Lock()
	s.plugins.closed = true
	if s.plugins.cancel != nil {
		s.plugins.cancel()
	}
	if s.plugins.wechatCancel != nil {
		s.plugins.wechatCancel()
	}
	done := s.plugins.done
	wechatDone := s.plugins.wechatDone
	s.plugins.mu.Unlock()
	if done != nil {
		<-done
	}
	if wechatDone != nil {
		<-wechatDone
	}
}

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
		s.plugins.mu.Lock()
		status := s.plugins.status
		wechatStatus := s.plugins.wechatStatus
		s.plugins.mu.Unlock()
		writeJSON(w, 200, map[string]any{"config": c.Public(), "telegramStatus": status, "wechatStatus": wechatStatus})
	})
	mux.HandleFunc("POST /api/plugins/{plugin}", s.savePlugin)
	mux.HandleFunc("POST /api/plugins/{plugin}/test", func(w http.ResponseWriter, r *http.Request) {
		c, err := s.pluginConfig()
		if err != nil {
			respond(w, nil, err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		var result any = map[string]bool{"ok": true}
		switch r.PathValue("plugin") {
		case "email":
			if !c.Email.Enabled {
				http.Error(w, "email plugin is disabled", 409)
				return
			}
			err = c.Email.Test(ctx)
		case "telegram":
			if !c.Telegram.Enabled {
				http.Error(w, "Telegram is disabled", 409)
				return
			}
			result, err = c.Telegram.Test(ctx)
		case "cloudflare":
			if !c.Cloudflare.Enabled {
				http.Error(w, "Cloudflare is disabled", 409)
				return
			}
			result, err = c.Cloudflare.Test(ctx)
		case "wechat_ilink", "wechatilink":
			if !c.WeChatILink.Enabled {
				http.Error(w, "WeChat iLink is disabled", 409)
				return
			}
			result, err = c.WeChatILink.Test(ctx)
		default:
			http.NotFound(w, r)
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

func (s *Server) emailConfig(w http.ResponseWriter) (email.Config, bool) {
	c, err := s.pluginConfig()
	if err != nil {
		respond(w, nil, err)
		return email.Config{}, false
	}
	if !c.Email.Enabled {
		http.Error(w, "email plugin is disabled", 409)
		return email.Config{}, false
	}
	return c.Email, true
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
	s.plugins.mu.Lock()
	defer s.plugins.mu.Unlock()
	if s.plugins.closed {
		http.Error(w, "service is stopping", 503)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256<<10))
	if err != nil {
		http.Error(w, "invalid configuration", 400)
		return
	}
	c, err := s.Configuration.UpdatePlugin(r.PathValue("plugin"), raw)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if r.PathValue("plugin") == "telegram" {
		c.Telegram.Transport = s.HTTPTransport
		s.restartTelegram(c.Telegram)
	}
	if r.PathValue("plugin") == "wechat_ilink" || r.PathValue("plugin") == "wechatilink" {
		s.restartWechat(c.WeChatILink)
	}
	writeJSON(w, 200, c.Public())
}
