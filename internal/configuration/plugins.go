package configuration

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"slices"

	"github.com/fdkevin0/mob/internal/plugins/cloudflare"
	"github.com/fdkevin0/mob/internal/plugins/email"
	"github.com/fdkevin0/mob/internal/plugins/telegram"
	"github.com/fdkevin0/mob/internal/plugins/wechatilink"
)

type Plugins struct {
	Email       email.Config       `json:"email"`
	Telegram    telegram.Config    `json:"telegram"`
	Cloudflare  cloudflare.Config  `json:"cloudflare"`
	WeChatILink wechatilink.Config `json:"wechat_ilink"`
}

func (c Plugins) Public() Plugins {
	c.Email = c.Email.Public()
	c.Telegram = c.Telegram.Public()
	c.Cloudflare = c.Cloudflare.Public()
	c.WeChatILink = c.WeChatILink.Public()
	return c
}

// SecretUpdate distinguishes an omitted/kept credential from an explicit clear.
type SecretUpdate struct {
	Mode  string `json:"mode"`
	Value string `json:"value,omitempty"`
}
type Updates map[string]SecretUpdate

// secret resolves a credential from the saved value, the value submitted in
// the form field and an explicit update.
func secret(old, submitted string, sameOwner bool, update SecretUpdate) (string, error) {
	switch update.Mode {
	case "":
		if submitted != "" {
			return submitted, nil
		}
		if sameOwner {
			return old, nil
		}
		return "", nil
	case "keep":
		if !sameOwner {
			return "", errors.New("cannot keep a credential after changing its owner")
		}
		return old, nil
	case "clear":
		return "", nil
	case "replace":
		if update.Value == "" {
			return "", errors.New("replacement credential is empty")
		}
		return update.Value, nil
	default:
		return "", errors.New("unknown secret update mode")
	}
}
func decode(raw []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(target) != nil || d.Decode(new(any)) != io.EOF {
		return errors.New("invalid configuration")
	}
	return nil
}
func (s *Service) Plugins() (Plugins, error) {
	var c Plugins
	err := s.Store.Setting("plugins", &c)
	return c, err
}
func (s *Service) UpdatePlugin(name string, raw []byte) (Plugins, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := s.Plugins()
	if err != nil {
		return c, err
	}
	var payload map[string]json.RawMessage
	if err = decode(raw, &payload); err != nil {
		return c, err
	}
	var updates Updates
	if value, ok := payload["secrets"]; ok {
		if err = decode(value, &updates); err != nil {
			return c, err
		}
		delete(payload, "secrets")
	}
	raw, err = json.Marshal(payload)
	if err != nil {
		return c, err
	}
	section, ok := Lookup(name)
	if !ok {
		return c, errUnknownPlugin
	}
	if err = section.update(&c, raw, updates); err != nil {
		return c, err
	}
	for name := range updates {
		if !slices.Contains(section.Secrets, name) {
			return c, errors.New("unknown secret field")
		}
	}
	err = s.Store.SaveSetting("plugins", c)
	return c, err
}
