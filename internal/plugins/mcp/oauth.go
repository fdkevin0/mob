package mcp

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/oauthex"
	"golang.org/x/oauth2"
)

// signInTimeout bounds how long Mob waits for the user to sign in.
const signInTimeout = 10 * time.Minute

// grantsKey is the setting that keeps each server's OAuth sign-in.
const grantsKey = "mcp_oauth"

// Settings keeps what Mob learns while it runs, such as OAuth tokens.
type Settings interface {
	Setting(key string, dest any) error
	SaveSetting(key string, value any) error
}

// grant is one server's OAuth sign-in: the client Mob registered, where its
// tokens come from, and the latest token, so a restart need not sign in again.
type grant struct {
	// URL is the server's URL when it was signed in to; a server moved to
	// another URL signs in again.
	URL          string        `json:"url"`
	ClientID     string        `json:"clientId"`
	ClientSecret string        `json:"clientSecret,omitempty"`
	AuthURL      string        `json:"authUrl"`
	TokenURL     string        `json:"tokenUrl"`
	AuthStyle    int           `json:"authStyle"`
	Scopes       []string      `json:"scopes,omitempty"`
	Token        *oauth2.Token `json:"token"`
}

func (g grant) config() *oauth2.Config {
	return &oauth2.Config{
		ClientID:     g.ClientID,
		ClientSecret: g.ClientSecret,
		Endpoint:     oauth2.Endpoint{AuthURL: g.AuthURL, TokenURL: g.TokenURL, AuthStyle: oauth2.AuthStyle(g.AuthStyle)},
		Scopes:       g.Scopes,
	}
}

// grants are the saved sign-ins by server name.
func (h *Hub) grants() map[string]grant {
	grants := map[string]grant{}
	if h.Settings != nil {
		h.Settings.Setting(grantsKey, &grants)
	}
	return grants
}

// saveGrant keeps a server's sign-in; a nil grant forgets it.
func (h *Hub) saveGrant(name string, g *grant) error {
	if h.Settings == nil {
		return nil
	}
	h.grantsMu.Lock()
	defer h.grantsMu.Unlock()
	grants := h.grants()
	if g == nil {
		delete(grants, name)
	} else {
		grants[name] = *g
	}
	return h.Settings.SaveSetting(grantsKey, grants)
}

// signIn authorizes requests to one OAuth server. It starts with the saved
// token, if any; when the server refuses it, the user signs in again.
type signIn struct {
	hub    *Hub
	name   string
	server Server
	// client fetches metadata and tokens; it sends no configured headers.
	client *http.Client
	report func()

	mu     sync.Mutex
	source oauth2.TokenSource
}

func (h *Hub) signIn(name string, server Server, report func()) *signIn {
	s := &signIn{hub: h, name: name, server: server, client: &http.Client{Transport: h.base()}, report: report}
	if g, ok := h.grants()[name]; ok && g.URL == server.URL && g.Token != nil {
		s.source = s.saving(g.config(), g.Token)
	}
	return s
}

func (s *signIn) TokenSource(context.Context) (oauth2.TokenSource, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.source, nil
}

// Authorize lets the user sign in: it registers Mob with the server's
// authorization server for a loopback address that it listens on only while
// the user signs in, and shows the sign-in link in the server's status.
func (s *signIn) Authorize(ctx context.Context, req *http.Request, resp *http.Response) error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		resp.Body.Close()
		return err
	}
	results := make(chan *auth.AuthorizationResult, 1)
	callback := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		result := &auth.AuthorizationResult{Code: query.Get("code"), State: query.Get("state"), Iss: query.Get("iss")}
		message := "You are signed in to " + s.name + ". You can close this page."
		if failure := query.Get("error"); failure != "" || result.Code == "" {
			message = "Signing in to " + s.name + " failed: " + failure + " " + query.Get("error_description")
			result = nil
		}
		select {
		case results <- result:
		default:
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, "<!doctype html><title>Mob</title><p>%s</p>", html.EscapeString(message))
	}), ReadHeaderTimeout: 5 * time.Second}
	go callback.Serve(listener)
	defer callback.Close()
	redirect := "http://" + listener.Addr().String() + "/callback"
	// A browser on another device cannot reach the loopback address, so the
	// user may paste the address it was sent to instead.
	s.hub.wait(redirect, s.name, results)
	defer s.hub.unwait(redirect)
	handler, err := auth.NewAuthorizationCodeHandler(&auth.AuthorizationCodeHandlerConfig{
		DynamicClientRegistrationConfig: &auth.DynamicClientRegistrationConfig{Metadata: &oauthex.ClientRegistrationMetadata{
			ClientName:              "Mob",
			RedirectURIs:            []string{redirect},
			GrantTypes:              []string{"authorization_code", "refresh_token"},
			ResponseTypes:           []string{"code"},
			TokenEndpointAuthMethod: "none",
		}},
		AuthorizationCodeFetcher: func(ctx context.Context, args *auth.AuthorizationArgs) (*auth.AuthorizationResult, error) {
			s.hub.set(s.name, func(st *state) { st.status = "sign in to connect: " + args.URL })
			s.report()
			select {
			case result := <-results:
				if result == nil {
					return nil, errors.New("signing in failed")
				}
				return result, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(signInTimeout):
				return nil, errors.New("nobody signed in")
			}
		},
		RequestRefreshToken: true,
		Client:              s.client,
		NewTokenSource: func(ctx context.Context, config *oauth2.Config, token *oauth2.Token) (oauth2.TokenSource, error) {
			return s.saving(config, token), nil
		},
	})
	if err != nil {
		resp.Body.Close()
		return err
	}
	if err := handler.Authorize(ctx, req, resp); err != nil {
		return err
	}
	// Authorize succeeds without a token when the server refused the request
	// for a reason signing in cannot fix; the current token stays.
	if source, _ := handler.TokenSource(ctx); source != nil {
		s.mu.Lock()
		s.source = source
		s.mu.Unlock()
	}
	return nil
}

// saving is a token source that refreshes token with config and saves each
// new token as the server's grant.
func (s *signIn) saving(config *oauth2.Config, token *oauth2.Token) oauth2.TokenSource {
	ctx := context.WithValue(context.Background(), oauth2.HTTPClient, s.client)
	g := grant{URL: s.server.URL, ClientID: config.ClientID, ClientSecret: config.ClientSecret, AuthURL: config.Endpoint.AuthURL, TokenURL: config.Endpoint.TokenURL, AuthStyle: int(config.Endpoint.AuthStyle), Scopes: config.Scopes}
	return &savingSource{base: config.TokenSource(ctx, token), save: func(token *oauth2.Token) {
		g.Token = token
		s.hub.saveGrant(s.name, &g)
	}}
}

type savingSource struct {
	base oauth2.TokenSource
	save func(*oauth2.Token)

	mu sync.Mutex
	// last is the token saved most recently.
	last *oauth2.Token
}

func (s *savingSource) Token() (*oauth2.Token, error) {
	token, err := s.base.Token()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.last == nil || token.AccessToken != s.last.AccessToken {
		s.last = token
		s.save(token)
	}
	return token, nil
}

// waiting is a sign-in that waits for its result.
type waiting struct {
	server  string
	results chan *auth.AuthorizationResult
}

func (h *Hub) wait(redirect, server string, results chan *auth.AuthorizationResult) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.signIns == nil {
		h.signIns = map[string]waiting{}
	}
	h.signIns[redirect] = waiting{server, results}
}

func (h *Hub) unwait(redirect string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.signIns, redirect)
}

// SignInHint tells the user what to do when the page a sign-in returns to
// does not open, as on a phone.
const SignInHint = "If the page you return to after signing in does not open, copy its address and send /signin followed by it."

// FinishSignIn completes a sign-in with the address the user's browser was
// sent back to, pasted when it could not reach Mob, and names the server.
func (h *Hub) FinishSignIn(address string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(address))
	if err != nil || u.Host == "" {
		return "", errors.New("paste the whole address the browser was sent to, starting with http://127.0.0.1")
	}
	h.mu.Lock()
	w, ok := h.signIns[u.Scheme+"://"+u.Host+u.Path]
	h.mu.Unlock()
	if !ok {
		return "", errors.New("no sign-in is waiting for that address; it may have finished or expired, so check /mcp")
	}
	query := u.Query()
	if failure := query.Get("error"); failure != "" || query.Get("code") == "" {
		return "", fmt.Errorf("the address carries no sign-in: %s %s", failure, query.Get("error_description"))
	}
	select {
	case w.results <- &auth.AuthorizationResult{Code: query.Get("code"), State: query.Get("state"), Iss: query.Get("iss")}:
		return w.server, nil
	default:
		return "", errors.New("that sign-in has already finished")
	}
}
