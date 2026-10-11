package email

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"io"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/http/httptest"
	"net/mail"
	"net/textproto"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/backend/memory"
	"github.com/emersion/go-imap/server"
)

func TestTLSMailRoundTrip(t *testing.T) {
	fixture := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	certificate := fixture.TLS.Certificates[0]
	roots := x509.NewCertPool()
	roots.AddCert(fixture.Certificate())
	fixture.Close()
	for _, security := range []string{"tls", "starttls"} {
		t.Run(security, func(t *testing.T) {
			tlsConfig := &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}
			imapListener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			imapServer := server.New(memory.New())
			imapServer.TLSConfig = tlsConfig
			wire := imapListener
			if security == "tls" {
				wire = tls.NewListener(wire, tlsConfig)
			}
			done := make(chan struct{})
			go func() { defer close(done); _ = imapServer.Serve(wire) }()
			t.Cleanup(func() { imapServer.Close(); <-done })
			smtpListener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			var wg sync.WaitGroup
			sent := make(chan string, 1)
			acceptDone := make(chan struct{})
			go func() {
				defer close(acceptDone)
				for {
					conn, err := smtpListener.Accept()
					if err != nil {
						return
					}
					wg.Add(1)
					go func() {
						defer wg.Done()
						defer conn.Close()
						conn.SetDeadline(time.Now().Add(5 * time.Second))
						smtpFixture(conn, tlsConfig, security, sent)
					}()
				}
			}()
			t.Cleanup(func() { smtpListener.Close(); <-acceptDone; wg.Wait() })
			endpoint := func(address string) Endpoint {
				host, p, _ := net.SplitHostPort(address)
				port, _ := strconv.Atoi(p)
				return Endpoint{Host: host, Port: port, Security: security, Username: "username", Password: "password", roots: roots}
			}
			config := Config{Enabled: true, From: "Sender <sender@example.org>", IMAP: endpoint(imapListener.Addr().String()), SMTP: endpoint(smtpListener.Addr().String())}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err = config.Test(ctx); err != nil {
				t.Fatal(err)
			}
			inbox, err := config.Inbox(ctx)
			if err != nil || len(inbox) != 1 {
				t.Fatalf("inbox: %+v %v", inbox, err)
			}
			msg, err := config.Read(ctx, inbox[0].UID, inbox[0].Validity)
			if err != nil || msg.Text != "Hi there :)" {
				t.Fatalf("read: %+v %v", msg, err)
			}
			if _, err = config.Read(ctx, inbox[0].UID, inbox[0].Validity+1); err == nil {
				t.Fatal("stale UIDVALIDITY accepted")
			}
			draft := Draft{To: "收件人 <recipient@example.org>", Subject: "你好", Text: "First line\n第二行"}
			if err = config.Send(ctx, draft); err != nil {
				t.Fatal(err)
			}
			select {
			case raw := <-sent:
				m, e := mail.ReadMessage(strings.NewReader(raw))
				if e != nil {
					t.Fatal(e)
				}
				body, e := io.ReadAll(quotedprintable.NewReader(m.Body))
				if e != nil || !strings.Contains(string(body), "第二行") {
					t.Fatalf("MIME body: %q %v", body, e)
				}
				if m.Header.Get("Message-ID") == "" {
					t.Fatal("missing message identity")
				}
			case <-ctx.Done():
				t.Fatal("mail was not delivered to the fixture")
			}
			insecure := config
			insecure.SMTP.roots = nil
			if err = insecure.Send(ctx, draft); err == nil {
				t.Fatal("untrusted certificate accepted")
			}
		})
	}
}
func smtpFixture(conn net.Conn, config *tls.Config, security string, sent chan<- string) {
	if security == "tls" {
		conn = tls.Server(conn, config)
	}
	reader := bufio.NewReader(conn)
	fmt.Fprint(conn, "220 fixture ESMTP\r\n")
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		verb := strings.Fields(line)
		if len(verb) == 0 {
			return
		}
		switch strings.ToUpper(verb[0]) {
		case "EHLO":
			fmt.Fprint(conn, "250-fixture\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n")
		case "STARTTLS":
			fmt.Fprint(conn, "220 Ready\r\n")
			conn = tls.Server(conn, config)
			reader = bufio.NewReader(conn)
		case "AUTH":
			if len(verb) < 3 {
				return
			}
			raw, _ := base64.StdEncoding.DecodeString(verb[2])
			if string(raw) != "\x00username\x00password" {
				fmt.Fprint(conn, "535 Bad auth\r\n")
			} else {
				fmt.Fprint(conn, "235 OK\r\n")
			}
		case "MAIL", "RCPT":
			fmt.Fprint(conn, "250 OK\r\n")
		case "DATA":
			fmt.Fprint(conn, "354 Go\r\n")
			body, err := textproto.NewReader(reader).ReadDotBytes()
			if err != nil {
				return
			}
			sent <- string(body)
			fmt.Fprint(conn, "250 Accepted\r\n")
		case "QUIT":
			fmt.Fprint(conn, "221 Bye\r\n")
			return
		default:
			fmt.Fprint(conn, "500 Unsupported\r\n")
		}
	}
}
func TestMailBoundaries(t *testing.T) {
	if (Draft{To: "a@b.com\r\nBcc: bad@b.com", Text: "x"}).Validate() == nil {
		t.Fatal("header injection accepted")
	}
	body := "MIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<p>Hello</p><script>bad()</script><img src='https://tracker.invalid/x'>"
	text, _, err := parseBody(strings.NewReader(body))
	if err != nil || text != "Hello" {
		t.Fatalf("unsafe HTML preview: %q %v", text, err)
	}
	c := Config{IMAP: Endpoint{Password: "secret"}, SMTP: Endpoint{Password: "secret"}}
	if c.Public().IMAP.Password != "" || !c.Public().SMTP.HasPassword {
		t.Fatal("password was not redacted")
	}
}
