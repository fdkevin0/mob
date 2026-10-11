// Package email owns the optional SMTP/IMAP protocol and mail use cases.
package email

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
	_ "github.com/emersion/go-message/charset"
	message "github.com/emersion/go-message/mail"
	"golang.org/x/net/html"
)

type Endpoint struct {
	roots       *x509.CertPool
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Security    string `json:"security"`
	Username    string `json:"username"`
	Password    string `json:"password,omitempty"`
	HasPassword bool   `json:"hasPassword,omitempty"`
}
type Config struct {
	Enabled bool     `json:"enabled"`
	From    string   `json:"from"`
	IMAP    Endpoint `json:"imap"`
	SMTP    Endpoint `json:"smtp"`
	Channel Channel  `json:"channel"`
}

// Channel is whether and to whom Mob answers mail in INBOX.
type Channel struct {
	Enabled bool `json:"enabled"`
	// Owner is the only address whose mail Mob answers, as the owner.
	Owner string `json:"owner"`
	// Verifier is the authserv-id the mail provider names itself with in the
	// Authentication-Results header it adds, such as mx.google.com. Mail is
	// answered only when that header says the owner's domain signed it.
	Verifier string `json:"verifier"`
}

func (c Config) Public() Config {
	c.IMAP.HasPassword = c.IMAP.Password != ""
	c.SMTP.HasPassword = c.SMTP.Password != ""
	c.IMAP.Password = ""
	c.SMTP.Password = ""
	return c
}
func (c Config) Validate() error {
	if !c.Enabled {
		return nil
	}
	if _, err := mail.ParseAddress(c.From); err != nil || strings.ContainsAny(c.From, "\r\n") {
		return errors.New("email: enter a valid From address")
	}
	for _, e := range []Endpoint{c.IMAP, c.SMTP} {
		if e.Host == "" || strings.ContainsAny(e.Host, "/\r\n \t") || e.Port < 1 || e.Port > 65535 || e.Username == "" || e.Password == "" {
			return errors.New("email: host, port, username and password are required for IMAP and SMTP")
		}
		if e.Security != "tls" && e.Security != "starttls" {
			return errors.New("email: choose TLS or STARTTLS")
		}
	}
	if c.Channel.Enabled {
		owner, err := mail.ParseAddress(c.Channel.Owner)
		if err != nil || owner.Address != c.Channel.Owner || !strings.Contains(owner.Address, "@") {
			return errors.New("email: enter the owner's address to answer mail from")
		}
		if c.Channel.Verifier == "" || strings.ContainsAny(c.Channel.Verifier, "; \t\r\n") {
			return errors.New("email: enter the authserv-id your provider writes in Authentication-Results, such as mx.google.com")
		}
	}
	return nil
}
func (e Endpoint) tlsConfig() *tls.Config {
	return &tls.Config{ServerName: e.Host, MinVersion: tls.VersionTLS12, RootCAs: e.roots}
}
func connect(ctx context.Context, e Endpoint) (net.Conn, func(), error) {
	d := net.Dialer{Timeout: 10 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(e.Host, strconv.Itoa(e.Port)))
	if err != nil {
		return nil, nil, errors.New("email: connection failed; check host and port")
	}
	deadline := time.Now().Add(25 * time.Second)
	if v, ok := ctx.Deadline(); ok && v.Before(deadline) {
		deadline = v
	}
	conn.SetDeadline(deadline)
	raw := conn
	stop := context.AfterFunc(ctx, func() { raw.Close() })
	close := func() { stop(); raw.Close() }
	if e.Security == "tls" {
		secured := tls.Client(conn, e.tlsConfig())
		if err := secured.HandshakeContext(ctx); err != nil {
			close()
			return nil, nil, errors.New("email: TLS handshake failed")
		}
		conn = secured
	}
	return conn, close, nil
}
func (c Config) imap(ctx context.Context) (*client.Client, func(), error) {
	return c.session(ctx, nil)
}

// session signs in to IMAP. With updates set, it reports the server's
// unilateral updates there and the connection stays open until ctx ends;
// otherwise it ends at the usual deadline.
func (c Config) session(ctx context.Context, updates chan<- client.Update) (*client.Client, func(), error) {
	conn, close, err := connect(ctx, c.IMAP)
	if err != nil {
		return nil, nil, err
	}
	cl, err := client.New(conn)
	if err == nil && updates != nil {
		cl.Updates = updates
	}
	if err == nil && c.IMAP.Security == "starttls" {
		err = cl.StartTLS(c.IMAP.tlsConfig())
	}
	if err == nil {
		err = cl.Login(c.IMAP.Username, c.IMAP.Password)
	}
	if err != nil {
		close()
		return nil, nil, errors.New("IMAP: TLS or login failed; check credentials/app password")
	}
	if updates != nil {
		conn.SetDeadline(time.Time{})
	}
	return cl, close, nil
}
func (c Config) smtp(ctx context.Context) (*smtp.Client, func(), error) {
	conn, close, err := connect(ctx, c.SMTP)
	if err != nil {
		return nil, nil, err
	}
	cl, err := smtp.NewClient(conn, c.SMTP.Host)
	if err == nil && c.SMTP.Security == "starttls" {
		err = cl.StartTLS(c.SMTP.tlsConfig())
	}
	if err == nil {
		err = cl.Auth(smtp.PlainAuth("", c.SMTP.Username, c.SMTP.Password, c.SMTP.Host))
	}
	if err != nil {
		close()
		return nil, nil, errors.New("SMTP: TLS or login failed; check credentials/app password")
	}
	return cl, close, nil
}
func (c Config) Test(ctx context.Context) error {
	if err := c.active(); err != nil {
		return err
	}
	_, close, err := c.imap(ctx)
	if err != nil {
		return err
	}
	close()
	_, close, err = c.smtp(ctx)
	if err != nil {
		return err
	}
	close()
	return nil
}

type Summary struct {
	UID      uint32 `json:"uid"`
	Validity uint32 `json:"validity"`
	Subject  string `json:"subject"`
	From     string `json:"from"`
	Date     string `json:"date"`
}
type Mail struct {
	Summary
	Text        string   `json:"text"`
	Attachments []string `json:"attachments"`
}

func (c Config) Inbox(ctx context.Context) ([]Summary, error) {
	if err := c.active(); err != nil {
		return nil, err
	}
	cl, close, err := c.imap(ctx)
	if err != nil {
		return nil, err
	}
	defer close()
	box, err := cl.Select("INBOX", true)
	if err != nil {
		return nil, errors.New("IMAP: cannot open INBOX")
	}
	result := []Summary{}
	if box.Messages == 0 {
		return result, nil
	}
	set := new(imap.SeqSet)
	set.AddRange(max(1, box.Messages-min(box.Messages, 49)), box.Messages)
	ch := make(chan *imap.Message, 50)
	err = cl.Fetch(set, []imap.FetchItem{imap.FetchUid, imap.FetchEnvelope}, ch)
	if err != nil {
		return nil, errors.New("IMAP: could not read inbox")
	}
	for m := range ch {
		if m.Envelope != nil {
			result = append(result, summary(m, box.UidValidity))
		}
	}
	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}
	return result, nil
}
func summary(m *imap.Message, validity uint32) Summary {
	e := m.Envelope
	from := []string{}
	for _, a := range e.From {
		from = append(from, (&mail.Address{Name: a.PersonalName, Address: a.MailboxName + "@" + a.HostName}).String())
	}
	return Summary{m.Uid, validity, e.Subject, strings.Join(from, ", "), e.Date.Format(time.RFC3339)}
}
func (c Config) Read(ctx context.Context, uid, validity uint32) (Mail, error) {
	if err := c.active(); err != nil {
		return Mail{}, err
	}
	cl, close, err := c.imap(ctx)
	if err != nil {
		return Mail{}, err
	}
	defer close()
	box, err := cl.Select("INBOX", true)
	if err != nil {
		return Mail{}, errors.New("IMAP: cannot open INBOX")
	}
	if validity != box.UidValidity {
		return Mail{}, errors.New("INBOX changed; refresh the message list")
	}
	set := new(imap.SeqSet)
	set.AddNum(uid)
	section := &imap.BodySectionName{Peek: true, Partial: []int{0, 2 << 20}}
	ch := make(chan *imap.Message, 1)
	if err = cl.UidFetch(set, []imap.FetchItem{imap.FetchUid, imap.FetchEnvelope, imap.FetchRFC822Size, section.FetchItem()}, ch); err != nil {
		return Mail{}, errors.New("IMAP: could not read message")
	}
	m := <-ch
	if m == nil || m.Envelope == nil {
		return Mail{}, errors.New("message no longer exists; refresh INBOX")
	}
	if m.Size > 2<<20 {
		return Mail{}, errors.New("message exceeds the 2 MiB preview limit")
	}
	body := m.GetBody(section)
	if body == nil {
		return Mail{}, errors.New("message body unavailable")
	}
	result := Mail{Summary: summary(m, validity), Attachments: []string{}}
	result.Text, result.Attachments, err = parseBody(body)
	return result, err
}
func parseBody(r io.Reader) (string, []string, error) {
	_, text, attachments, err := parse(r)
	return text, attachments, err
}

// parse reads a message's header, its text, preferring plain text to HTML,
// and its attachments' names.
func parse(r io.Reader) (message.Header, string, []string, error) {
	mr, err := message.CreateReader(io.LimitReader(r, 2<<20))
	if err != nil {
		return message.Header{}, "", nil, errors.New("cannot decode email")
	}
	defer mr.Close()
	text, attachments, err := parts(mr)
	return mr.Header, text, attachments, err
}

func parts(mr *message.Reader) (string, []string, error) {
	text, htmlText := "", ""
	attachments := []string{}
	for {
		p, e := mr.NextPart()
		if e == io.EOF {
			break
		}
		if e != nil {
			return "", nil, errors.New("cannot decode email part")
		}
		switch h := p.Header.(type) {
		case *message.AttachmentHeader:
			name, _ := h.Filename()
			attachments = append(attachments, name)
		case *message.InlineHeader:
			kind, _, _ := h.ContentType()
			raw, e := io.ReadAll(io.LimitReader(p.Body, 256<<10))
			if e != nil {
				return "", nil, errors.New("cannot read email body")
			}
			if kind == "text/plain" {
				text += string(raw)
			} else if kind == "text/html" {
				htmlText += plainHTML(string(raw))
			}
		}
	}
	if text == "" {
		text = htmlText
	}
	return text, attachments, nil
}
func plainHTML(raw string) string {
	z := html.NewTokenizer(strings.NewReader(raw))
	var b strings.Builder
	skip := 0
	for {
		switch z.Next() {
		case html.ErrorToken:
			return strings.TrimSpace(b.String())
		case html.StartTagToken:
			t := z.Token()
			if t.Data == "script" || t.Data == "style" {
				skip++
			}
			if t.Data == "br" || t.Data == "p" || t.Data == "div" {
				b.WriteByte('\n')
			}
		case html.EndTagToken:
			t := z.Token()
			if (t.Data == "script" || t.Data == "style") && skip > 0 {
				skip--
			}
		case html.TextToken:
			if skip == 0 {
				b.Write(z.Text())
			}
		}
	}
}

type Draft struct {
	To      string `json:"to"`
	Subject string `json:"subject"`
	Text    string `json:"text"`
}

func (d Draft) Validate() error {
	if strings.ContainsAny(d.To+d.Subject, "\r\n") || len(d.Subject) > 1000 || len(d.Text) > 128<<10 || strings.TrimSpace(d.Text) == "" {
		return errors.New("enter a recipient, single-line subject and message (max 128 KiB)")
	}
	list, err := mail.ParseAddressList(d.To)
	if err != nil || len(list) == 0 || len(list) > 20 {
		return errors.New("enter 1–20 valid recipients")
	}
	return nil
}
func (c Config) Send(ctx context.Context, d Draft) error {
	_, err := c.send(ctx, d, "")
	return err
}

// send sends d with header, which is complete header lines, and returns the
// message's ID.
func (c Config) send(ctx context.Context, d Draft, header string) (string, error) {
	if err := c.active(); err != nil {
		return "", err
	}
	if err := d.Validate(); err != nil {
		return "", err
	}
	from, err := mail.ParseAddress(c.From)
	if err != nil {
		return "", err
	}
	id := rand.Text() + "@" + from.Address[strings.LastIndex(from.Address, "@")+1:]
	recipients, _ := mail.ParseAddressList(d.To)
	names := make([]string, len(recipients))
	for i, a := range recipients {
		names[i] = a.String()
	}
	cl, close, err := c.smtp(ctx)
	if err != nil {
		return "", err
	}
	defer close()
	if err = cl.Mail(from.Address); err != nil {
		return "", errors.New("SMTP rejected sender")
	}
	for _, to := range recipients {
		if err = cl.Rcpt(to.Address); err != nil {
			return "", errors.New("SMTP rejected recipient")
		}
	}
	w, err := cl.Data()
	if err != nil {
		return "", errors.New("SMTP refused message")
	}
	_, err = fmt.Fprintf(w, "From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%s>\r\n%sMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n", from.String(), strings.Join(names, ", "), mime.QEncoding.Encode("utf-8", d.Subject), time.Now().Format(time.RFC1123Z), id, header)

	if err != nil {
		return "", errors.New("SMTP delivery interrupted before body")
	}
	q := quotedprintable.NewWriter(w)
	if _, err = io.WriteString(q, d.Text); err != nil {
		return "", errors.New("SMTP delivery interrupted while writing body")
	}
	if err = q.Close(); err != nil {
		return "", errors.New("SMTP delivery interrupted while encoding body")
	}
	if err = w.Close(); err != nil {
		return "", errors.New("SMTP delivery status unknown; check the recipient before retrying")
	}

	return id, nil
}

func (c Config) active() error {
	if !c.Enabled {
		return errors.New("email plugin is disabled")
	}
	return c.Validate()
}
