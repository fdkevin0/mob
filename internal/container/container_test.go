package container

import (
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestDefaultPerPlatform(t *testing.T) {
	for goos, want := range map[string]string{"linux": Containerd, "darwin": Apple, "windows": WSLC, "plan9": ""} {
		if got := Default(goos); got != want {
			t.Errorf("Default(%s) = %q, want %q", goos, got, want)
		}
	}
	if _, err := New("docker"); err == nil || !strings.Contains(err.Error(), "containerd, apple, wslc") {
		t.Fatalf("unknown runtime accepted: %v", err)
	}
}

func TestRunArgs(t *testing.T) {
	spec := Spec{Image: "python:3.13", Command: []string{"python", "-c", "print(1)"}, Env: []string{"A=1"}, Mounts: []Mount{{"/tmp/w", "/work"}}, Workdir: "/work", Stdin: strings.NewReader("")}
	tail := []string{"run", "--rm", "-i", "-w", "/work", "-e", "A=1", "-v", "/tmp/w:/work", "python:3.13", "python", "-c", "print(1)"}
	for name, binary := range map[string]string{Containerd: "nerdctl", Apple: "container", WSLC: "wslc"} {
		r, err := New(name)
		if err != nil {
			t.Fatal(err)
		}
		args, err := r.RunArgs(spec)
		if err != nil {
			t.Fatal(err)
		}
		want := tail
		if name == Containerd {
			want = append([]string{"--namespace", "mob"}, tail...)
		}
		if r.Binary != binary || !reflect.DeepEqual(args, want) {
			t.Errorf("%s: %s %q", name, r.Binary, args)
		}
	}
	r, _ := New(WSLC)
	limited := Spec{Image: "alpine", Command: []string{"ls"}, Workdir: "/w", Limits: Limits{Network: NoNetwork, CPUs: 2, MemoryMiB: 1536}}
	if args, err := r.RunArgs(limited); err != nil || strings.Join(args, " ") != "run --rm -w /w --network none --cpus 2 --memory 1536m alpine ls" {
		t.Errorf("limits: %q %v", args, err)
	}
	for _, bad := range []Spec{{}, {Image: "--privileged"}, {Image: "alpine", Env: []string{"=x"}}, {Image: "alpine", Mounts: []Mount{{"/a", "relative"}}},
		{Image: "alpine", Limits: Limits{Network: "host"}}, {Image: "alpine", Limits: Limits{CPUs: -1}}, {Image: "alpine", Limits: Limits{MemoryMiB: -1}}} {
		if _, err := r.RunArgs(bad); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

func TestParseMemory(t *testing.T) {
	for in, want := range map[string]int{"512m": 512, "512M": 512, "2g": 2048, "1.5GiB": 1536, " 3gb ": 3072, "1t": 1 << 20} {
		if got, err := ParseMemory(in); err != nil || got != want {
			t.Errorf("ParseMemory(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "512", "512k", "2x", "g", "-1g", "0m", "0.5m", "nanm", "infg", "2048t"} {
		if got, err := ParseMemory(bad); err == nil {
			t.Errorf("ParseMemory(%q) = %d, want an error", bad, got)
		}
	}
}

func TestExecAndCheck(t *testing.T) {
	r, _ := New(Apple)
	var calls [][]string
	r.Run = func(_ context.Context, name string, args []string, _ io.Reader, stdout, stderr io.Writer) (int, error) {
		calls = append(calls, append([]string{name}, args...))
		if args[0] == "system" {
			io.WriteString(stderr, "level=info msg=starting\napiserver is not running\n")
			return 1, nil
		}
		io.WriteString(stdout, "hi\n")
		return 3, nil
	}
	if err := r.Check(context.Background()); !errors.Is(err, ErrUnavailable) || !strings.HasSuffix(err.Error(), "apiserver is not running") {
		t.Fatalf("check: %v", err)
	}
	result, err := r.Exec(context.Background(), Spec{Image: "alpine", Command: []string{"echo", "hi"}})
	if err != nil || result.ExitCode != 3 || result.Stdout != "hi\n" {
		t.Fatalf("exec: %+v %v", result, err)
	}
	if got := strings.Join(calls[1], " "); got != "container run --rm alpine echo hi" {
		t.Fatalf("exec ran %q", got)
	}
}

func TestRunReportsMissingBinary(t *testing.T) {
	r, _ := New(Containerd)
	r.Binary = "mob-no-such-container-cli"
	if err := r.Check(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("missing CLI: %v", err)
	}
}
