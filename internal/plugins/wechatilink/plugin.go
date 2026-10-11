package wechatilink

import (
	"context"
	"net/http"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/extension"
)

// Host is what the WeChat iLink plugin uses from Mob.
type Host struct {
	// Config reads the saved configuration.
	Config       func() (Config, error)
	Store        *chat.Store
	Conversation *chat.ConversationService
	// Transport returns what carries the plugin's HTTP requests; without it,
	// or when it returns nil, the default transport does.
	Transport func() http.RoundTripper
}

func (h Host) service() *Service { return &Service{Store: h.Store, Conversation: h.Conversation} }

func (h Host) client(c Config) *Client {
	var transport http.RoundTripper
	if h.Transport != nil {
		transport = h.Transport()
	}
	return NewClient(c, transport)
}

// Extension polls WeChat iLink while the plugin is enabled and signed in.
func Extension(h Host) extension.Extension {
	return extension.Extension{Name: "wechat_ilink", Start: func() (extension.Serve, error) {
		c, err := h.Config()
		if err != nil || !c.Enabled || c.BotToken == "" {
			return nil, err
		}
		service := h.service()
		return func(ctx context.Context, status func(string)) { service.Loop(ctx, c, status) }, nil
	}}
}

// Routes serve QR code sign-in and let the web UI send a message as a WeChat
// user would.
func Routes(h Host) []extension.Route {
	return []extension.Route{
		{Method: "POST", Path: "qrcode", Handle: func(r *http.Request) (any, error) {
			c, err := h.Config()
			if err != nil {
				return nil, err
			}
			return h.client(c).GetQRCode(r.Context())
		}},
		{Method: "GET", Path: "qrcode/status", Handle: func(r *http.Request) (any, error) {
			c, err := h.Config()
			if err != nil {
				return nil, err
			}
			qrcode := r.URL.Query().Get("qrcode")
			if qrcode == "" {
				return nil, &chat.CommandError{Status: 400, Message: "missing qrcode parameter"}
			}
			return h.client(c).GetQRCodeStatus(r.Context(), qrcode)
		}},
		{Method: "POST", Path: "message", Handle: func(r *http.Request) (any, error) {
			c, err := h.Config()
			if err != nil || !c.Enabled {
				return nil, &chat.CommandError{Status: 409, Message: "wechat_ilink plugin disabled"}
			}
			var payload struct {
				SenderID     string `json:"senderId"`
				ContextToken string `json:"contextToken"`
				Text         string `json:"text"`
			}
			if err := extension.Decode(r, &payload); err != nil {
				return nil, err
			}
			reply, err := h.service().ProcessMessage(r.Context(), c, payload.SenderID, payload.ContextToken, payload.Text)
			if err != nil {
				return nil, err
			}
			return map[string]string{"reply": reply}, nil
		}},
	}
}
