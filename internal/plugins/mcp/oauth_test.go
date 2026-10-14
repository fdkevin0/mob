package mcp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// settings is a Settings kept in memory.
type settings struct {
	mu     sync.Mutex
	values map[string][]byte
}

func (s *settings) Setting(key string, dest any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if raw, ok := s.values[key]; ok {
		return json.Unmarshal(raw, dest)
	}
	return nil
}

func (s *settings) SaveSetting(key string, value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := json.Marshal(value)
	if s.values == nil {
		s.values = map[string][]byte{}
	}
	s.values[key] = raw
	return err
}

// oauthServer is an MCP server behind a minimal OAuth authorization server.
// It accepts only the access token it last issued.
type oauthServer struct {
	*httptest.Server
	mu        sync.Mutex
	token     string
	issued    int
	registers int
}

func newOAuthServer(t *testing.T) *oauthServer {
	o := &oauthServer{}
	mcp := sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return testServer() }, nil)
	mux := http.NewServeMux()
	write := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("/.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"resource": o.URL + "/mcp", "authorization_servers": []string{o.URL}})
	})
	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{
			"issuer": o.URL, "authorization_endpoint": o.URL + "/authorize", "token_endpoint": o.URL + "/token",
			"registration_endpoint": o.URL + "/register", "response_types_supported": []string{"code"},
			"code_challenge_methods_supported": []string{"S256"}, "grant_types_supported": []string{"authorization_code", "refresh_token"},
			"token_endpoint_auth_methods_supported": []string{"none"},
		})
	})
	mux.HandleFunc("POST /register", func(w http.ResponseWriter, r *http.Request) {
		var metadata map[string]any
		json.NewDecoder(r.Body).Decode(&metadata)
		o.mu.Lock()
		o.registers++
		o.mu.Unlock()
		metadata["client_id"] = "mob-client"
		w.WriteHeader(http.StatusCreated)
		write(w, metadata)
	})
	mux.HandleFunc("GET /authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("client_id") != "mob-client" || q.Get("code_challenge") == "" || q.Get("resource") != o.URL+"/mcp" {
			http.Error(w, "bad request", 400)
			return
		}
		http.Redirect(w, r, q.Get("redirect_uri")+"?code=the-code&state="+q.Get("state"), http.StatusFound)
	})
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		grant := r.Form.Get("grant_type")
		if grant == "authorization_code" && (r.Form.Get("code") != "the-code" || r.Form.Get("code_verifier") == "") ||
			grant == "refresh_token" && r.Form.Get("refresh_token") != "the-refresh" {
			w.WriteHeader(400)
			write(w, map[string]string{"error": "invalid_grant"})
			return
		}
		o.mu.Lock()
		o.issued++
		o.token = "token-" + strings.Repeat("x", o.issued)
		token := o.token
		o.mu.Unlock()
		write(w, map[string]any{"access_token": token, "token_type": "Bearer", "refresh_token": "the-refresh", "expires_in": 3600})
	})
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		o.mu.Lock()
		ok := o.token != "" && r.Header.Get("Authorization") == "Bearer "+o.token
		o.mu.Unlock()
		if !ok {
			w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="`+o.URL+`/.well-known/oauth-protected-resource/mcp"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mcp.ServeHTTP(w, r)
	})
	o.Server = httptest.NewServer(mux)
	t.Cleanup(o.Close)
	return o
}

// signInLink waits for the server's status to show a sign-in link.
func signInLink(t *testing.T, h *Hub, name string) string {
	t.Helper()
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if _, link, ok := strings.Cut(h.Status(), name+": sign in to connect: "); ok {
			return link
		}
	}
	t.Fatalf("no sign-in link: %s", h.Status())
	return ""
}

func TestOAuthSignInIsKept(t *testing.T) {
	o := newOAuthServer(t)
	server := Server{URL: o.URL + "/mcp", OAuth: true}
	saved := &settings{}
	h := &Hub{Settings: saved}
	h.Configure(Servers{"web": server})
	go func() {
		// The user opens the link; the authorization server sends their
		// browser back to Mob.
		resp, err := http.Get(signInLink(t, h, "web"))
		if err == nil {
			resp.Body.Close()
		}
	}()
	running(t, h, "web")
	out, err := approve(t, h, "mcp__web__shout", request{Server: "web", Tool: "shout", Arguments: map[string]any{"text": "ok"}, Target: server.target(), Config: server.fingerprint()})
	if err != nil || out != "OK" {
		t.Fatalf("call: %v %v", out, err)
	}
	g, ok := h.grants()["web"]
	if !ok || g.URL != server.URL || g.ClientID != "mob-client" || g.Token == nil || g.Token.RefreshToken != "the-refresh" {
		t.Fatalf("grant: %+v", g)
	}

	// After a restart Mob connects with the saved token, without asking the
	// user to sign in again.
	again := &Hub{Settings: saved}
	again.Configure(Servers{"web": server})
	running(t, again, "web")
	if o.registers != 1 {
		t.Fatalf("signed in %d times", o.registers)
	}

	// A token the server stopped accepting is refreshed with the saved
	// refresh token, and the new token is saved.
	g.Token.Expiry = time.Now().Add(-time.Minute)
	saved.SaveSetting(grantsKey, map[string]grant{"web": g})
	refreshed := &Hub{Settings: saved}
	refreshed.Configure(Servers{"web": server})
	running(t, refreshed, "web")
	if o.registers != 1 || refreshed.grants()["web"].Token.AccessToken != o.token {
		t.Fatalf("not refreshed: %d sign-ins, saved %+v, server's %s", o.registers, refreshed.grants()["web"].Token, o.token)
	}

	// A sign-in for another URL is not used.
	moved := Server{URL: o.URL + "/mcp?account=b", OAuth: true}
	other := &Hub{Settings: saved}
	other.Configure(Servers{"web": moved})
	if s := other.signIn("web", moved, func() {}); s.source != nil {
		t.Fatal("used a sign-in made for another URL")
	}
}

func TestOAuthValidateAndFingerprint(t *testing.T) {
	for _, c := range []struct {
		server Server
		ok     bool
	}{
		{Server{URL: "https://example.com/mcp", OAuth: true}, true},
		{Server{URL: "https://example.com/mcp", OAuth: true, Headers: map[string]string{"X-Team": "a"}}, true},
		{Server{URL: "https://example.com/mcp", OAuth: true, Headers: map[string]string{"authorization": "Bearer x"}}, false},
		{Server{Command: "x", OAuth: true}, false},
	} {
		if err := (Servers{"s": c.server}).Validate(); (err == nil) != c.ok {
			t.Errorf("%+v: %v", c.server, err)
		}
	}
	plain := Server{URL: "https://example.com/mcp"}
	signedIn := plain
	signedIn.OAuth = true
	if plain.fingerprint() == signedIn.fingerprint() {
		t.Fatal("the fingerprint ignores oauth")
	}
	// Servers without oauth keep the fingerprint they had before it existed,
	// so approvals given for them stay valid.
	if got := plain.fingerprint(); got != "ac285510d08fddebe99b9362" {
		t.Fatalf("fingerprint changed: %s", got)
	}
}
