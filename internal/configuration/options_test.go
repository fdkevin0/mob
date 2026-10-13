package configuration

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/spf13/pflag"
)

func TestUnifiedSourcesAndDaemonForwarding(t *testing.T) {
	cleanEnvironment(t)
	for _, o := range options() {
		t.Setenv(o.env(), "")
	}
	path := filepath.Join(t.TempDir(), "config.yaml")
	secret := strings.Repeat("s", 32)
	body := "token: " + secret + "\ngateway:\n  addr: localhost:9000\n  url: https://file.example\n  node_id: file-node\n  token: file-secret\nweb_url: https://file.example\nsandbox:\n  image: alpine:3.20\nmcp_servers:\n  docs:\n    url: https://docs.example/mcp\n"
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MOB_CONFIG", path)
	loader, err := NewLoader(nil)
	if err != nil {
		t.Fatal(err)
	}
	file, err := loader.Read()
	if err != nil {
		t.Fatal(err)
	}
	if file.Token != secret || file.Gateway.NodeID != "file-node" || file.Gateway.Addr != "localhost:9000" || file.Sandbox.Image != "alpine:3.20" || len(file.MCPServers) != 1 {
		t.Fatal("file values not loaded")
	}
	t.Setenv("MOB_GATEWAY_NODE_ID", "env-node")
	t.Setenv("MOB_NODE_ID", "legacy-ignored")
	t.Setenv("MOB_SANDBOX_IMAGE", "alpine:3.21")
	t.Setenv("MOB_GATEWAY_TOKEN", "environment-secret")
	env, err := loader.Read()
	if err != nil {
		t.Fatal(err)
	}
	if env.Gateway.NodeID != "env-node" || env.Sandbox.Image != "alpine:3.21" || env.Gateway.Token != "environment-secret" {
		t.Fatal("environment did not override file")
	}
	flags := pflag.NewFlagSet("test", pflag.ContinueOnError)
	AddFlags(flags)
	if err := flags.Parse([]string{"--gateway-node-id=flag-node", "--gateway-token=flag-secret", "--token=", "--web-url=", "--sandbox-image=alpine:3.22", `--mcp-servers={"other":{"url":"https://other.example/mcp"}}`}); err != nil {
		t.Fatal(err)
	}
	loader, err = NewLoader(flags)
	if err != nil {
		t.Fatal(err)
	}
	got, err := loader.Read()
	if err != nil {
		t.Fatal(err)
	}
	if got.Gateway.NodeID != "flag-node" || got.Gateway.Token != "flag-secret" || got.Token != "" || got.WebURL != "" || got.Sandbox.Image != "alpine:3.22" || len(got.MCPServers) != 1 || got.MCPServers["other"].URL != "https://other.example/mcp" {
		t.Fatal("flags did not override environment/file, or MCP maps were merged")
	}
	if strings.Contains(strings.Join(loader.Arguments(), " "), "flag-secret") || strings.Contains(strings.Join(loader.Arguments(), " "), "other.example") {
		t.Fatal("secret arguments forwarded in argv")
	}
	for _, entry := range loader.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok && strings.HasPrefix(key, "MOB_") {
			t.Setenv(key, value)
		}
	}
	childFlags := pflag.NewFlagSet("child", pflag.ContinueOnError)
	AddFlags(childFlags)
	if err := childFlags.Parse(loader.Arguments()); err != nil {
		t.Fatal(err)
	}
	child, err := NewLoader(childFlags)
	if err != nil {
		t.Fatal(err)
	}
	forwarded, err := child.Read()
	if err != nil {
		t.Fatal(err)
	}
	got.Loader = nil
	forwarded.Loader = nil
	if !reflect.DeepEqual(got, forwarded) {
		t.Fatal("daemon configuration differs from parent")
	}
}

func TestUnifiedValidationAndReference(t *testing.T) {
	cleanEnvironment(t)
	for _, o := range options() {
		t.Setenv(o.env(), "")
	}
	path := filepath.Join(t.TempDir(), "config.yaml")
	t.Setenv("MOB_CONFIG", path)
	loader, err := NewLoader(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{"token: secret-short", "gateway:\n  addr: bad-secret", "gateway:\n  url: secret-invalid", "mcp_servers: secret-invalid", "config: secret-path", "gateway:\n  unknown: secret-value"} {
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := loader.Read(); err == nil || strings.Contains(err.Error(), "secret-") {
			t.Fatalf("unsafe validation for fixture %q: %v", body, err)
		}
	}
	if err := os.WriteFile(path, []byte("demo: false\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"MOB_DEMO", "MOB_MAX_TOOL_STEPS", "MOB_SANDBOX_CPUS", "MOB_MCP_SERVERS"} {
		t.Setenv(name, "secret-invalid")
		if _, err := loader.Read(); err == nil || strings.Contains(err.Error(), "secret-invalid") {
			t.Fatalf("unsafe environment validation for %s: %v", name, err)
		}
		t.Setenv(name, "")
	}
	if runtime.GOOS != "windows" {
		if err := os.WriteFile(path, []byte("token: "+strings.Repeat("x", 32)), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := loader.Read(); err == nil {
			t.Fatal("readable token file accepted")
		}
	}
	t.Setenv("MOB_TOKEN", "secret-never-rendered")
	reference := Reference()
	if strings.Contains(reference, "secret-never-rendered") {
		t.Fatal("reference contains current credentials")
	}
	saved, err := os.ReadFile("../../docs/environment-variables.md")
	if err != nil {
		t.Fatal(err)
	}
	if string(saved) != reference {
		t.Fatal("configuration reference is stale; run go run ./cmd/configdocs")
	}
}
