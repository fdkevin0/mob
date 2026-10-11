package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/container"
)

func TestContainerCommand(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("container_runtime: wslc\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MOB_CONFIG", path)
	t.Setenv("MOB_CONTAINER_RUNTIME", "")
	var calls []string
	var chosen string
	newRuntime = func(name string) (*container.Runtime, error) {
		chosen = name
		r, err := container.New(name)
		if err != nil {
			return nil, err
		}
		r.Run = func(_ context.Context, name string, args []string, _ io.Reader, stdout, _ io.Writer) (int, error) {
			calls = append(calls, name+" "+strings.Join(args, " "))
			io.WriteString(stdout, "out\n")
			if args[len(args)-1] == "fail" {
				return 2, nil
			}
			return 0, nil
		}
		return r, nil
	}
	t.Cleanup(func() { newRuntime = container.New })
	execute := func(args ...string) (string, error) {
		command := newRootCommand()
		var output bytes.Buffer
		command.SetOut(&output)
		command.SetErr(&output)
		command.SetArgs(args)
		err := command.Execute()
		return output.String(), err
	}

	output, err := execute("container", "status")
	if err != nil || chosen != "wslc" || !strings.Contains(output, "wslc (wslc)") || !strings.Contains(output, "Ready.") {
		t.Fatalf("status: %q %v", output, err)
	}
	output, err = execute("container", "run", "--container-runtime", "apple", "-e", "A=1", "-v", `C:\work:/work`, "-w", "/work", "alpine", "ls", "-la")
	if err != nil || output != "out\n" || calls[1] != `container run --rm -w /work -e A=1 -v C:\work:/work alpine ls -la` {
		t.Fatalf("run: %q %v %q", output, err, calls)
	}
	if _, err = execute("container", "run", "--container-runtime", "containerd", "alpine", "fail"); err == nil || !strings.Contains(err.Error(), "status 2") {
		t.Fatalf("nonzero exit not reported: %v", err)
	}
	if _, err = execute("container", "status", "--container-runtime", "docker"); err == nil {
		t.Fatal("unknown runtime accepted")
	}
}
