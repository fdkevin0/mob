package configuration

import (
	"context"
	"errors"
	"slices"

	"github.com/fdkevin0/mob/internal/plugins/cloudflare"
	"github.com/fdkevin0/mob/internal/plugins/email"
	"github.com/fdkevin0/mob/internal/plugins/telegram"
	"github.com/fdkevin0/mob/internal/plugins/wechatilink"
)

// Section is one plugin's part of Plugins: how a submitted configuration is
// decoded and merged with the saved one, which credentials it holds, and how
// its connection is tested.
type Section struct {
	Name string `json:"name"`
	// Title names the plugin in menus; Label names it in messages, e.g.
	// "Telegram is disabled".
	Title string `json:"title"`
	Label string `json:"-"`
	// Fields describe the configuration for clients that build their form
	// from it; a plugin without fields is configured in its own UI.
	Fields []Field `json:"fields"`
	// Secrets are the credentials an update may keep, replace or clear.
	Secrets []string                                    `json:"secrets"`
	Enabled func(Plugins) bool                          `json:"-"`
	Test    func(context.Context, Plugins) (any, error) `json:"-"`
	update  func(saved *Plugins, raw []byte, updates Updates) error
}

// Field is one configuration value: Path is its JSON key, dotted for a
// nested one, and Kind is bool, int, text or secret.
type Field struct {
	Path  string `json:"path"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
}

// Secret is a credential within a plugin's configuration C. A blank
// submission keeps the saved value while Owner is unchanged; a nil Owner
// never changes.
type Secret[C any] struct {
	Name  string
	Value func(*C) *string
	Owner func(C) string
}

type validated interface{ Validate() error }

// section builds a Section over the configuration that field selects.
func section[C validated](name, title, label string, fields []Field, field func(*Plugins) *C, enabled func(C) bool, test func(C, context.Context) (any, error), secrets ...Secret[C]) Section {
	s := Section{
		Name:    name,
		Title:   title,
		Label:   label,
		Fields:  fields,
		Enabled: func(p Plugins) bool { return enabled(*field(&p)) },
		Test:    func(ctx context.Context, p Plugins) (any, error) { return test(*field(&p), ctx) },
	}
	for _, secret := range secrets {
		s.Secrets = append(s.Secrets, secret.Name)
	}
	s.update = func(saved *Plugins, raw []byte, updates Updates) error {
		var next C
		if err := decode(raw, &next); err != nil {
			return err
		}
		old := field(saved)
		for _, v := range secrets {
			same := v.Owner == nil || v.Owner(next) == v.Owner(*old)
			value, err := secret(*v.Value(old), *v.Value(&next), same, updates[v.Name])
			if err != nil {
				return err
			}
			*v.Value(&next) = value
		}
		if err := next.Validate(); err != nil {
			return err
		}
		*old = next
		return nil
	}
	return s
}

// sections are the plugins, in the order they are listed.
var sections = []Section{
	section("email", "Email plugin · SMTP / IMAP", "email plugin", []Field{
		{"enabled", "Enable email (true/false)", "bool"}, {"from", "From address", "text"},
		{"imap.host", "IMAP host", "text"}, {"imap.port", "IMAP port (993 TLS / 143 STARTTLS)", "int"}, {"imap.security", "IMAP security (tls/starttls)", "text"}, {"imap.username", "IMAP username", "text"}, {"imap.password", "IMAP password (blank keeps existing for same host/user)", "secret"},
		{"smtp.host", "SMTP host", "text"}, {"smtp.port", "SMTP port (465 TLS / 587 STARTTLS)", "int"}, {"smtp.security", "SMTP security (tls/starttls)", "text"}, {"smtp.username", "SMTP username", "text"}, {"smtp.password", "SMTP password (blank keeps existing for same host/user)", "secret"},
	}, func(p *Plugins) *email.Config { return &p.Email },
		func(c email.Config) bool { return c.Enabled },
		func(c email.Config, ctx context.Context) (any, error) {
			return map[string]bool{"ok": true}, c.Test(ctx)
		},
		Secret[email.Config]{"imap.password", func(c *email.Config) *string { return &c.IMAP.Password }, func(c email.Config) string { return c.IMAP.Host + "\x00" + c.IMAP.Username }},
		Secret[email.Config]{"smtp.password", func(c *email.Config) *string { return &c.SMTP.Password }, func(c email.Config) string { return c.SMTP.Host + "\x00" + c.SMTP.Username }},
	),
	section("telegram", "Telegram Bot API", "Telegram", []Field{
		{"enabled", "Enable Telegram (true/false)", "bool"}, {"token", "Bot Token (blank keeps saved token)", "secret"}, {"userId", "Allowed Telegram user ID (private messages only)", "int"},
	}, func(p *Plugins) *telegram.Config { return &p.Telegram },
		func(c telegram.Config) bool { return c.Enabled },
		telegram.Config.Test,
		Secret[telegram.Config]{"token", func(c *telegram.Config) *string { return &c.Token }, nil},
	),
	section("cloudflare", "Cloudflare services", "Cloudflare", []Field{
		{"enabled", "Enable Cloudflare (true/false)", "bool"}, {"accountId", "Cloudflare account ID", "text"}, {"token", "API Token (blank keeps existing for same account)", "secret"}, {"model", "Workers AI model for /cloud ai.run", "text"}, {"embeddingModel", "Workers AI embedding model", "text"}, {"index", "Vectorize index", "text"}, {"databaseId", "D1 database ID", "text"}, {"namespaceId", "KV namespace ID", "text"}, {"bucket", "R2 bucket", "text"}, {"accessKey", "R2 S3 Access Key ID", "text"}, {"secretKey", "R2 S3 Secret Access Key (blank keeps saved value)", "secret"},
	}, func(p *Plugins) *cloudflare.Config { return &p.Cloudflare },
		func(c cloudflare.Config) bool { return c.Enabled },
		func(c cloudflare.Config, ctx context.Context) (any, error) { return c.Test(ctx) },
		Secret[cloudflare.Config]{"token", func(c *cloudflare.Config) *string { return &c.Token }, func(c cloudflare.Config) string { return c.AccountID }},
		Secret[cloudflare.Config]{"secretKey", func(c *cloudflare.Config) *string { return &c.SecretKey }, func(c cloudflare.Config) string { return c.AccountID + "\x00" + c.AccessKey }},
	),
	// WeChat iLink signs in by QR code in the web UI, so it has no fields.
	section("wechat_ilink", "WeChat iLink", "WeChat iLink", []Field{}, func(p *Plugins) *wechatilink.Config { return &p.WeChatILink },
		func(c wechatilink.Config) bool { return c.Enabled },
		wechatilink.Config.Test,
		Secret[wechatilink.Config]{"botToken", func(c *wechatilink.Config) *string { return &c.BotToken }, nil},
	),
}

// Sections lists every plugin's section.
func Sections() []Section { return slices.Clone(sections) }

// Lookup finds a plugin's section by name.
func Lookup(name string) (Section, bool) {
	i := slices.IndexFunc(sections, func(s Section) bool { return s.Name == name })
	if i < 0 {
		return Section{}, false
	}
	return sections[i], true
}

var errUnknownPlugin = errors.New("unknown plugin")
