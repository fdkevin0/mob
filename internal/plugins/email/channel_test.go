package email

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/backend/memory"
	"github.com/emersion/go-imap/server"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/provider"
)

var owner = Channel{Enabled: true, Owner: "me@example.org", Verifier: "mx.example.net"}

// ownerMail is a message from the owner, verified by their provider unless
// header says otherwise.
func ownerMail(header, body string) []byte {
	if !strings.Contains(header, "Authentication-Results") {
		header = "Authentication-Results: mx.example.net; spf=pass; dkim=pass header.d=example.org; dmarc=pass (p=reject) header.from=example.org\r\n" + header
	}
	if !strings.Contains(header, "From:") {
		header += "From: Me <me@example.org>\r\n"
	}
	return []byte(header + "Content-Type: text/plain; charset=UTF-8\r\n\r\n" + body)
}

func TestReadAnswersOnlyTheVerifiedOwner(t *testing.T) {
	for name, raw := range map[string][]byte{
		"another sender":    ownerMail("From: Eve <eve@example.org>\r\n", "hi"),
		"two senders":       ownerMail("From: me@example.org, eve@example.org\r\n", "hi"),
		"no verification":   ownerMail("Authentication-Results: other.example; dmarc=pass header.from=example.org\r\n", "hi"),
		"failed DMARC":      ownerMail("Authentication-Results: mx.example.net; dkim=fail; dmarc=fail header.from=example.org\r\n", "hi"),
		"another domain":    ownerMail("Authentication-Results: mx.example.net; dkim=pass header.d=evil.example; dmarc=none\r\n", "hi"),
		"forged lower down": ownerMail("Authentication-Results: mx.example.net; dmarc=fail header.from=example.org\r\nAuthentication-Results: mx.example.net; dmarc=pass header.from=example.org\r\n", "hi"),
		"an auto-reply":     ownerMail("Auto-Submitted: auto-replied\r\n", "hi"),
		"a mailing list":    ownerMail("List-Id: <news.example.org>\r\n", "hi"),
		"nothing new":       ownerMail("References: <a@example.org>\r\n", "> quoted"),
	} {
		if _, ok := Read(owner, raw); ok {
			t.Errorf("%s was answered", name)
		}
	}
	for name, raw := range map[string][]byte{
		"DMARC": ownerMail("", "hi"),
		"DKIM":  ownerMail("Authentication-Results: mx.example.net (comment; here); dkim=pass header.i=@example.org\r\n", "hi"),
		"case":  ownerMail("From: ME@Example.org\r\n", "hi"),
	} {
		if _, ok := Read(owner, raw); !ok {
			t.Errorf("%s was not answered", name)
		}
	}
}

func TestReadKeepsWhatTheReplyAdds(t *testing.T) {
	in, ok := Read(owner, ownerMail("Message-ID: <b@example.org>\r\nIn-Reply-To: <a@example.org>\r\nReferences: <root@example.org> <a@example.org>\r\nSubject: Re: plans\r\n",
		"Sounds good.\r\nThanks\r\n\r\nOn Mon, 12 Oct 2026, Mob <mob@example.org> wrote:\r\n> earlier\r\n"))
	if !ok || in.Text != "Sounds good.\nThanks" || in.ID != "b@example.org" || strings.Join(in.Thread, " ") != "root@example.org a@example.org" {
		t.Fatalf("%+v", in)
	}
	in, _ = Read(owner, ownerMail("Subject: Weekend plans\r\n", "What's on?\r\n-- \r\nMe"))
	if in.Text != "Weekend plans\n\nWhat's on?" || len(in.Thread) != 0 {
		t.Fatalf("new thread: %+v", in)
	}
	in, _ = Read(owner, ownerMail("Subject: Re: x\r\nReferences: <a@example.org>\r\n", "/approve\r\nSent from my phone\r\n在 2026年10月12日，Mob 写道：\r\n> x"))
	if in.Text != "/approve" {
		t.Fatalf("command: %q", in.Text)
	}
	if h := threadHeader(Incoming{ID: "b@example.org", Thread: []string{"a@example.org"}}); h != "Auto-Submitted: auto-replied\r\nIn-Reply-To: <b@example.org>\r\nReferences:\r\n <a@example.org>\r\n <b@example.org>\r\n" {
		t.Fatalf("header: %q", h)
	}
	if reSubject("RE: x") != "RE: x" || reSubject(" plans ") != "Re: plans" {
		t.Fatal("subject")
	}
}

type sent struct {
	draft  Draft
	header string
}

func TestLoopAnswersNewMailInItsThread(t *testing.T) {
	fixture := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	certificate := fixture.TLS.Certificates[0]
	roots := x509.NewCertPool()
	roots.AddCert(fixture.Certificate())
	fixture.Close()
	backend := memory.New()
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal(err)
	}
	commands := &tap{Listener: listener}
	listener = commands
	imapServer := server.New(backend)
	// The tap hides that its connections are TLS, which the server would
	// otherwise require before login.
	imapServer.AllowInsecureAuth = true
	served := make(chan struct{})
	go func() { defer close(served); _ = imapServer.Serve(listener) }()
	t.Cleanup(func() { imapServer.Close(); <-served })
	user, err := backend.Login(nil, "username", "password")
	if err != nil {
		t.Fatal(err)
	}
	inbox, err := user.GetMailbox("INBOX")
	if err != nil {
		t.Fatal(err)
	}
	deliver := func(raw []byte) {
		if err := inbox.(*memory.Mailbox).CreateMessage(nil, time.Now(), bytes.NewBuffer(raw)); err != nil {
			t.Fatal(err)
		}
	}

	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	conversation := chat.NewConversation(store, provider.Offline())
	defer conversation.Close()
	replies := make(chan sent, 4)
	m := &Mailer{Store: store, Conversation: conversation, send: func(_ Config, _ context.Context, d Draft, header string) (string, error) {
		replies <- sent{d, header}
		return "reply@example.org", nil
	}}
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	p, _ := strconv.Atoi(port)
	endpoint := Endpoint{Host: host, Port: p, Security: "tls", Username: "username", Password: "password", roots: roots}
	c := Config{Enabled: true, From: "mob@example.org", IMAP: endpoint, SMTP: endpoint, Channel: owner}

	defer func(saved struct{ retry, check time.Duration }) { wait = saved }(wait)
	wait.check, wait.retry = 50*time.Millisecond, 50*time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// run runs the loop until it has sent want replies, or for a while when
	// it should send none. The memory backend is not safe for concurrent use,
	// so mail is delivered only while no loop runs.
	run := func(want int) {
		t.Helper()
		ctx, stop := context.WithCancel(ctx)
		checked, done := make(chan struct{}), make(chan struct{})
		go func() {
			defer close(done)
			m.Loop(ctx, c, func(s string) {
				if strings.HasPrefix(s, "Connected") {
					close(checked)
				}
			})
		}()
		select {
		case <-checked:
		case <-ctx.Done():
			t.Fatal("the loop did not connect")
		}
		for deadline := time.Now().Add(5 * time.Second); len(replies) < want && time.Now().Before(deadline); {
			time.Sleep(10 * time.Millisecond)
		}
		if want == 0 {
			time.Sleep(300 * time.Millisecond)
		}
		stop()
		<-done
	}
	reply := func() sent {
		t.Helper()
		select {
		case r := <-replies:
			return r
		default:
			t.Fatal("no reply")
			return sent{}
		}
	}

	// The backend's sample message was in INBOX before the loop first ran
	// and is left alone.
	run(0)
	if len(replies) != 0 {
		t.Fatal("answered mail that was already in INBOX")
	}
	deliver(ownerMail("From: Eve <eve@example.org>\r\nMessage-ID: <eve@example.org>\r\n", "hi"))
	deliver(ownerMail("Message-ID: <big@example.org>\r\nSubject: Large\r\n", strings.Repeat("x", 3<<20)))
	deliver(ownerMail("Message-ID: <q1@example.org>\r\nSubject: Question\r\n", "Hello there"))
	run(1)
	first := reply()
	// Eve's message is read before its sender is checked; the 3 MiB message
	// after it is skipped by its size and its body never fetched; the
	// owner's is fetched at most 2 MiB at a time.
	var fetches []string
	for _, line := range strings.Split(commands.String(), "\r\n") {
		if _, command, ok := strings.Cut(line, " "); ok && strings.HasPrefix(command, "UID FETCH ") {
			fetches = append(fetches, command)
		}
	}
	var eve int
	if len(fetches) > 0 {
		eve, _ = strconv.Atoi(strings.Fields(fetches[0])[2])
	}
	size, body := "UID FETCH %d (UID RFC822.SIZE)", "UID FETCH %d (UID BODY.PEEK[]<0.2097152>)"
	want := []string{fmt.Sprintf(size, eve), fmt.Sprintf(body, eve), fmt.Sprintf(size, eve+1), fmt.Sprintf(size, eve+2), fmt.Sprintf(body, eve+2)}
	if !slices.Equal(fetches, want) {
		t.Fatalf("fetches %q, want %q", fetches, want)
	}
	if first.draft.To != owner.Owner || first.draft.Subject != "Re: Question" || !strings.Contains(first.header, "In-Reply-To: <q1@example.org>") || first.draft.Text == "" {
		t.Fatalf("first reply: %+v", first)
	}
	if len(replies) != 0 {
		t.Fatal("answered another sender or mail over the size limit")
	}
	deliver(ownerMail("Message-ID: <q2@example.org>\r\nSubject: Re: Question\r\nIn-Reply-To: <reply@example.org>\r\nReferences: <q1@example.org> <reply@example.org>\r\n", "/new\r\n\r\nOn Monday Mob wrote:\r\n> hi"))
	run(1)
	if second := reply(); second.draft.Text != "New conversation started." || !strings.Contains(second.header, " <q1@example.org>\r\n <reply@example.org>\r\n <q2@example.org>") {
		t.Fatalf("second reply: %+v", second)
	}
	var thread string
	if err := store.Setting("email-thread:q1@example.org", &thread); err != nil || thread == "" {
		t.Fatalf("the thread has no conversation: %v", err)
	}
	if list, _ := store.List(); len(list) != 2 {
		t.Fatalf("%d conversations, want the first and the one /new started", len(list))
	}
}

func TestNewerHandlesUIDsOldestFirst(t *testing.T) {
	// SEARCH may answer in any order; the cursor must not pass UID 11
	// before it is handled.
	if got := newer([]uint32{12, 10, 11, 12, 9}, 10); !slices.Equal(got, []uint32{11, 12}) {
		t.Fatalf("newer: %v", got)
	}
}

// tap records what clients send to a listener's connections.
type tap struct {
	net.Listener
	mu  sync.Mutex
	log bytes.Buffer
}

func (t *tap) Accept() (net.Conn, error) {
	conn, err := t.Listener.Accept()
	return tapped{conn, t}, err
}

func (t *tap) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.log.String()
}

type tapped struct {
	net.Conn
	tap *tap
}

func (c tapped) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	c.tap.mu.Lock()
	c.tap.log.Write(b[:n])
	c.tap.mu.Unlock()
	return n, err
}
