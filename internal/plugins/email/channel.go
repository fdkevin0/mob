package email

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
	message "github.com/emersion/go-message/mail"

	"github.com/fdkevin0/mob/internal/channel"
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/extension"
)

// Mailer answers the owner's mail in INBOX, each mail thread in its own
// conversation, and replies in the thread.
type Mailer struct {
	Store        *chat.Store
	Conversation *chat.ConversationService
	// send sends a reply; it is Config.send outside tests.
	send func(c Config, ctx context.Context, d Draft, header string) (string, error)
}

// Extension answers mail while the plugin and its channel are enabled.
func Extension(config func() (Config, error), store *chat.Store, conversation *chat.ConversationService) extension.Extension {
	return extension.Extension{Name: "email", Start: func() (extension.Serve, error) {
		c, err := config()
		if err != nil || !c.Enabled || !c.Channel.Enabled {
			return nil, err
		}
		m := &Mailer{Store: store, Conversation: conversation}
		return func(ctx context.Context, status func(string)) { m.Loop(ctx, c, status) }, nil
	}}
}

// wait is how long the loop waits after a failure, and at most between
// checks of INBOX while the server reports nothing.
var wait = struct{ retry, check time.Duration }{30 * time.Second, 10 * time.Minute}

// cursor is the last INBOX message the loop has handled.
type cursor struct {
	Validity uint32 `json:"validity"`
	UID      uint32 `json:"uid"`
}

// Loop answers new mail until ctx ends. Mail already in INBOX when it first
// runs is left alone.
func (m *Mailer) Loop(ctx context.Context, c Config, status func(string)) {
	key := "email-cursor:" + c.IMAP.Username + "@" + c.IMAP.Host
	for ctx.Err() == nil {
		err := m.serve(ctx, c, key, status)
		if ctx.Err() != nil {
			return
		}
		status(err.Error())
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait.retry):
		}
	}
}

// serve answers mail over one IMAP connection until it fails or ctx ends.
func (m *Mailer) serve(ctx context.Context, c Config, key string, status func(string)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	updates := make(chan client.Update, 16)
	cl, close, err := c.session(ctx, updates)
	if err != nil {
		return err
	}
	defer close()
	// Any update may be new mail; the loop checks after each.
	arrived := make(chan struct{}, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-updates:
				select {
				case arrived <- struct{}{}:
				default:
				}
			}
		}
	}()
	box, err := cl.Select("INBOX", true)
	if err != nil {
		return errors.New("IMAP: cannot open INBOX")
	}
	var at cursor
	if err := m.Store.Setting(key, &at); err != nil {
		return errors.New("Cannot load the email cursor")
	}
	if at.Validity != box.UidValidity {
		// The first run, or INBOX was rebuilt: answer only mail that arrives
		// from now on.
		at = cursor{box.UidValidity, max(box.UidNext, 1) - 1}
		if err := m.Store.SaveSetting(key, at); err != nil {
			return errors.New("Cannot save the email cursor")
		}
	}
	status("Connected · answering mail from " + c.Channel.Owner)
	for {
		if at, err = m.check(ctx, c, cl, key, at, status); err != nil {
			return err
		}
		stop := make(chan struct{})
		idled := make(chan error, 1)
		go func() { idled <- cl.Idle(stop, nil) }()
		select {
		case <-arrived:
		case <-time.After(wait.check):
		case <-ctx.Done():
		case err := <-idled:
			return errIdle(err)
		}
		closeOnce(stop)
		if err := <-idled; err != nil {
			return errIdle(err)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
}

func closeOnce(stop chan struct{}) {
	select {
	case <-stop:
	default:
		close(stop)
	}
}

func errIdle(err error) error {
	if err == nil {
		err = errors.New("server ended IDLE")
	}
	return errors.New("IMAP: connection lost; reconnecting (" + err.Error() + ")")
}

// check answers the mail after at, moving the cursor past each message.
func (m *Mailer) check(ctx context.Context, c Config, cl *client.Client, key string, at cursor, status func(string)) (cursor, error) {
	criteria := imap.NewSearchCriteria()
	criteria.Uid = new(imap.SeqSet)
	criteria.Uid.AddRange(at.UID+1, 0)
	uids, err := cl.UidSearch(criteria)
	if err != nil {
		return at, errors.New("IMAP: cannot search INBOX")
	}
	for _, uid := range newer(uids, at.UID) {
		raw, err := fetch(cl, uid)
		if err != nil {
			return at, err
		}
		if raw != nil {
			if id, err := m.answer(ctx, c, at.Validity, uid, raw); err != nil {
				status(err.Error())
				if ctx.Err() != nil {
					return at, ctx.Err()
				}
				// Mail whose delivery was never recorded is tried again.
				if accepted, readErr := m.Store.DeliveryAccepted(id); readErr != nil || !accepted {
					return at, err
				}
			}
		}
		at.UID = uid
		if err := m.Store.SaveSetting(key, at); err != nil {
			return at, errors.New("Cannot save the email cursor; stopped answering mail")
		}
	}
	return at, nil
}

// newer is the UIDs after last, oldest first. SEARCH may answer in any
// order, and the cursor must never pass a message not yet handled; a range
// ending in * always includes the newest message, even an old one.
func newer(uids []uint32, last uint32) []uint32 {
	uids = slices.DeleteFunc(slices.Clone(uids), func(uid uint32) bool { return uid <= last })
	slices.Sort(uids)
	return slices.Compact(uids)
}

// maxMail is the largest message the channel reads; larger ones are skipped.
const maxMail = 2 << 20

// fetch reads a whole message without marking it read, or nil for one too
// large to answer. Its size is asked for first, and the body fetch is
// bounded, so a large message is never downloaded.
func fetch(cl *client.Client, uid uint32) ([]byte, error) {
	set := new(imap.SeqSet)
	set.AddNum(uid)
	sizes := make(chan *imap.Message, 1)
	if err := cl.UidFetch(set, []imap.FetchItem{imap.FetchUid, imap.FetchRFC822Size}, sizes); err != nil {
		return nil, errors.New("IMAP: could not read new mail")
	}
	small := false
	for msg := range sizes {
		small = msg.Size > 0 && msg.Size <= maxMail
	}
	if !small {
		return nil, nil
	}
	section := &imap.BodySectionName{Peek: true, Partial: []int{0, maxMail}}
	ch := make(chan *imap.Message, 1)
	if err := cl.UidFetch(set, []imap.FetchItem{imap.FetchUid, section.FetchItem()}, ch); err != nil {
		return nil, errors.New("IMAP: could not read new mail")
	}
	var raw []byte
	for msg := range ch {
		if body := msg.GetBody(section); body != nil {
			raw, _ = io.ReadAll(io.LimitReader(body, maxMail))
		}
	}
	return raw, nil
}

// Incoming is a message as the channel reads it.
type Incoming struct {
	ID string
	// Thread are the IDs of the messages it answers, oldest first.
	Thread  []string
	Subject string
	Text    string
}

// answer answers raw, the message uid in INBOX, if the owner sent it, and
// replies once. id is the delivery it is recorded under.
func (m *Mailer) answer(ctx context.Context, c Config, validity, uid uint32, raw []byte) (id string, err error) {
	in, ok := Read(c.Channel, raw)
	if !ok {
		return "", nil
	}
	b := bridge(m)
	id = "mail:" + in.ID
	if in.ID == "" {
		id = fmt.Sprintf("mail:%d:%d", validity, uid)
	}
	root := in.ID
	if len(in.Thread) > 0 {
		root = in.Thread[0]
	}
	if root == "" {
		root = id
	}
	msg := channel.Message{ID: id, Key: "email-thread:" + root, Owner: true, Text: in.Text}
	answer := func(ctx context.Context) (channel.Reply, error) { return b.Answer(ctx, msg) }
	return id, b.Deliver(ctx, id, answer, func(ctx context.Context, r channel.Reply) error {
		send := m.send
		if send == nil {
			send = Config.send
		}
		_, err := send(c, ctx, Draft{To: c.Channel.Owner, Subject: reSubject(in.Subject), Text: r.Text}, threadHeader(in))
		return err
	})
}

func bridge(m *Mailer) *channel.Bridge {
	// The limit keeps a reply within what Draft accepts.
	return &channel.Bridge{Name: "Email", Client: chat.ClientEmail, Store: m.Store, Conversation: m.Conversation, Texts: texts, Limit: 100 << 10}
}

var texts = channel.Texts{
	Help: "Mob answers your mail here. Each mail thread is its own conversation. This computer must remain running.",
	Approvals: func(approvals []chat.PendingApproval, pending int) string {
		var b strings.Builder
		for _, a := range approvals {
			b.WriteString("\n\nApproval needed: " + chat.DescribeApproval(a.Tool, a.Input) + "\nID: " + a.ID)
		}
		if pending > 1 {
			return b.String() + "\n\nReply with /approve ID or /deny ID and an optional reason as the first line."
		}
		return b.String() + "\n\nReply with /approve, or /deny and an optional reason, as the first line."
	},
	Stale: func(id string) string { return "Approval " + id + " is unknown, expired, or already decided." },
	Failed: func(err error) string {
		return "\n\nMob: " + err.Error() + ". Open the desktop app or terminal for the saved result."
	},
	Unsupported: "That command needs the desktop app or terminal.",
	Empty:       "Done. Open the local conversation for details.",
	Used: func(used []channel.Use) string {
		names := make([]string, len(used))
		for i, u := range used {
			names[i] = u.String()
		}
		return "\n\n(Used " + strings.Join(names, ", ") + ". Details are in the local conversation.)"
	},
}

// Read reads raw as mail to answer: the owner sent it, their provider
// verified that, and no program sent it on its own.
func Read(ch Channel, raw []byte) (Incoming, bool) {
	header, text, _, err := parse(bytes.NewReader(raw))
	if err != nil || automatic(header) || !fromOwner(header, ch) {
		return Incoming{}, false
	}
	in := Incoming{Text: Fresh(text)}
	in.ID, _ = header.MessageID()
	in.Subject, _ = header.Subject()
	references, _ := header.MsgIDList("References")
	replied, _ := header.MsgIDList("In-Reply-To")
	for _, id := range append(references, replied...) {
		if messageID.MatchString(id) && !slices.Contains(in.Thread, id) {
			in.Thread = append(in.Thread, id)
		}
	}
	if !messageID.MatchString(in.ID) {
		in.ID = ""
	}
	switch {
	case strings.HasPrefix(in.Text, "/"):
		// A command is the first line; the rest is usually a signature.
		in.Text, _, _ = strings.Cut(in.Text, "\n")
	case len(in.Thread) == 0 && strings.TrimSpace(in.Subject) != "":
		in.Text = strings.TrimSpace(in.Subject + "\n\n" + in.Text)
	}
	if in.Text == "" {
		return Incoming{}, false
	}
	return in, true
}

// messageID is a message ID this channel will repeat in a header.
var messageID = regexp.MustCompile(`^[^\s<>"()\[\]\\,;:]{1,250}@[^\s<>"()\[\]\\,;:@]{1,250}$`)

// automatic reports mail a program sent on its own, such as an auto-reply,
// a bounce, a mailing list or Mob's own reply, which is never answered.
func automatic(h message.Header) bool {
	if v := strings.ToLower(strings.TrimSpace(h.Get("Auto-Submitted"))); v != "" && v != "no" {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(h.Get("Precedence"))) {
	case "bulk", "list", "junk", "auto_reply":
		return true
	}
	return h.Get("List-Id") != "" || strings.TrimSpace(h.Get("Return-Path")) == "<>"
}

// fromOwner reports whether the owner alone is the sender and the topmost
// Authentication-Results header from the verifier says the owner's domain
// passed DMARC, or signed the mail with DKIM.
func fromOwner(h message.Header, ch Channel) bool {
	from, err := h.AddressList("From")
	if err != nil || len(from) != 1 || !strings.EqualFold(from[0].Address, ch.Owner) {
		return false
	}
	domain := strings.ToLower(ch.Owner[strings.LastIndex(ch.Owner, "@")+1:])
	for _, value := range h.Values("Authentication-Results") {
		value = comment.ReplaceAllString(value, "")
		id, results, _ := strings.Cut(value, ";")
		if fields := strings.Fields(id); len(fields) == 0 || !strings.EqualFold(fields[0], ch.Verifier) {
			continue
		}
		// Only the provider's own header counts; it is the topmost one.
		for _, result := range strings.Split(results, ";") {
			fields := strings.Fields(strings.ToLower(result))
			if len(fields) == 0 {
				continue
			}
			props := map[string]string{}
			for _, f := range fields[1:] {
				if k, v, ok := strings.Cut(f, "="); ok {
					props[k] = strings.Trim(v, `"`)
				}
			}
			switch fields[0] {
			case "dmarc=pass":
				if d, ok := props["header.from"]; !ok || d == domain {
					return true
				}
			case "dkim=pass":
				if props["header.d"] == domain || strings.HasSuffix(props["header.i"], "@"+domain) {
					return true
				}
			}
		}
		return false
	}
	return false
}

// comment is a parenthesised comment in a header.
var comment = regexp.MustCompile(`\([^()]*\)`)

// quoted starts the quoted message or signature below a reply.
var quoted = regexp.MustCompile(`(?i)^(on .+ wrote:|.*写道[:：]|-{2,}\s*(original|forwarded) message\s*-{2,}|_{20,}|--)$`)

// Fresh is what a reply adds to the thread: its text above the quoted message
// and the signature.
func Fresh(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, ">") || quoted.MatchString(line) {
			lines = lines[:i]
			break
		}
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// reSubject is the subject of a reply.
func reSubject(subject string) string {
	subject = strings.Join(strings.Fields(subject), " ")
	if r := []rune(subject); len(r) > 200 {
		subject = string(r[:200])
	}
	if subject == "" {
		return "Re: Mob"
	}
	if strings.HasPrefix(strings.ToLower(subject), "re:") {
		return subject
	}
	return "Re: " + subject
}

// threadHeader keeps a reply in its thread and marks it as sent by a
// program, so no one's auto-reply answers it.
func threadHeader(in Incoming) string {
	h := "Auto-Submitted: auto-replied\r\n"
	if in.ID == "" {
		return h
	}
	ids := append(append([]string{}, in.Thread...), in.ID)
	h += "In-Reply-To: <" + in.ID + ">\r\nReferences:"
	for _, id := range ids {
		h += "\r\n <" + id + ">"
	}
	return h + "\r\n"
}
