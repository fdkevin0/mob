package sandbox

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/container"
)

const conversation = "0123456789abcdef0123456789abcdef"

func fake(t *testing.T, run container.Runner) *Sandbox {
	t.Helper()
	box, err := New(Settings{Enabled: true, Runtime: container.Containerd, Image: "alpine:3.20"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	box.Runtime.Run = run
	return box
}

func TestDisabledAndInvalidSettings(t *testing.T) {
	if box, err := New(Settings{Image: DefaultImage}, t.TempDir()); box != nil || err != nil {
		t.Fatalf("disabled sandbox built: %v %v", box, err)
	}
	for _, s := range []Settings{{Enabled: true, Runtime: "docker", Image: DefaultImage}, {Enabled: true, Image: ""}, {Enabled: true, Image: "--privileged"}, {Enabled: true, Image: "a b"},
		{Enabled: true, Image: DefaultImage, Network: "host"}, {Enabled: true, Image: DefaultImage, CPUs: -1}, {Enabled: true, Image: DefaultImage, Memory: "512"}, {Enabled: true, Image: DefaultImage, Memory: "32m"}} {
		if _, err := New(s, t.TempDir()); err == nil {
			t.Errorf("accepted %+v", s)
		}
	}
}

func TestLimitsReachTheRun(t *testing.T) {
	var run string
	box, err := New(Settings{Enabled: true, Runtime: container.Apple, Image: "alpine:3.20", Network: "none", CPUs: 1, Memory: "1g"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	box.Runtime.Run = func(_ context.Context, _ string, args []string, _ io.Reader, _, _ io.Writer) (int, error) {
		if args[0] == "run" {
			run = strings.Join(args, " ")
		}
		return 0, nil
	}
	if !box.Offline() {
		t.Fatal("network none not reported offline")
	}
	if _, err := box.Exec(context.Background(), conversation, "ls", 0); err != nil || !strings.Contains(run, "-w /workspace --network none --cpus 1 --memory 1024m -v ") {
		t.Fatalf("limits not passed: %q %v", run, err)
	}
	if fake(t, nil).Offline() {
		t.Fatal("default network reported offline")
	}
}

func TestExecMountsOnlyTheWorkspace(t *testing.T) {
	var calls [][]string
	box := fake(t, func(_ context.Context, _ string, args []string, _ io.Reader, stdout, stderr io.Writer) (int, error) {
		calls = append(calls, args)
		if args[2] == "run" {
			io.WriteString(stdout, strings.Repeat("x", outputCap+10))
			io.WriteString(stderr, "warn")
			return 7, nil
		}
		return 0, nil
	})
	for range 2 {
		result, err := box.Exec(context.Background(), conversation, "pip install x && ls", 0)
		if err != nil || result.ExitCode != 7 || len(result.Stdout) != outputCap || !result.Truncated || result.Stderr != "warn" {
			t.Fatalf("exec: %+v %v", result, err)
		}
	}
	if len(calls) != 3 || strings.Join(calls[0], " ") != "--namespace mob image pull alpine:3.20" {
		t.Fatalf("image not pulled exactly once: %q", calls)
	}
	workspace := filepath.Join(box.Root, conversation)
	run := strings.Join(calls[1], " ")
	want := "-w /workspace -v " + workspace + ":/workspace alpine:3.20 sh -c pip install x && ls"
	if !strings.HasPrefix(run, "--namespace mob run --rm --name mob-") || !strings.HasSuffix(run, want) || strings.Count(run, " -v ") != 1 {
		t.Fatalf("run: %q", run)
	}
	if info, err := os.Stat(workspace); err != nil || !info.IsDir() {
		t.Fatalf("workspace not created: %v", err)
	}
	if _, err := box.Exec(context.Background(), "../escape", "ls", 0); err == nil {
		t.Fatal("conversation ID used as a path")
	}
	if _, err := box.Exec(context.Background(), conversation, "  ", 0); err == nil {
		t.Fatal("empty command accepted")
	}
}

func TestTimeoutRemovesTheContainer(t *testing.T) {
	var removed string
	box := fake(t, func(ctx context.Context, _ string, args []string, _ io.Reader, stdout, _ io.Writer) (int, error) {
		switch args[2] {
		case "run":
			io.WriteString(stdout, "partial")
			<-ctx.Done()
			return -1, ctx.Err()
		case "rm":
			removed = args[len(args)-1]
		}
		return 0, nil
	})
	result, err := box.Exec(context.Background(), conversation, "sleep 100", 20*time.Millisecond)
	if err != nil || !result.TimedOut || result.Stdout != "partial" || !strings.HasPrefix(removed, "mob-") {
		t.Fatalf("timeout: %+v %v removed %q", result, err, removed)
	}
	// A failed pull leaves the run to use a local image.
	box = fake(t, func(_ context.Context, _ string, args []string, _ io.Reader, _, stderr io.Writer) (int, error) {
		if args[2] == "image" {
			io.WriteString(stderr, "429 Too Many Requests")
			return 1, nil
		}
		return 0, nil
	})
	if result, err := box.Exec(context.Background(), conversation, "ls", time.Second); err != nil || result.ExitCode != 0 {
		t.Fatalf("failed pull blocked a local image: %+v %v", result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := box.Exec(ctx, conversation, "ls", time.Second); err == nil {
		t.Fatal("cancelled turn reported as a result")
	}
}
