// Package container runs OCI images through the host's native container
// runtime: containerd on Linux, Apple's container on macOS and WSL
// containers (wslc) on Windows. Each runtime is driven through its CLI, so
// Mob carries no runtime client libraries and needs no build tags.
package container

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

const (
	Containerd = "containerd"
	Apple      = "apple"
	WSLC       = "wslc"
)

// Names are the runtimes a configuration may choose.
var Names = []string{Containerd, Apple, WSLC}

// ErrUnavailable means the runtime's CLI is missing or its service is not running.
var ErrUnavailable = errors.New("container runtime unavailable")

// Mount binds a host path into the container.
type Mount struct {
	Source, Target string
}

// NoNetwork is the Network that gives a container only its loopback interface.
const NoNetwork = "none"

// Limits bound what a container may use; zero values keep the runtime's
// defaults. All three CLIs accept --network none, --cpus N and --memory
// SIZE with the same meaning, so one setting serves every platform.
type Limits struct {
	// Network is "" for the runtime's default network or NoNetwork.
	Network string
	// CPUs is whole CPUs, since Apple's CLI takes no fractions.
	CPUs int
	// MemoryMiB is the memory ceiling in MiB.
	MemoryMiB int
}

// Spec describes one container run. The container is removed when it exits.
type Spec struct {
	// Name lets Remove stop the container if its CLI is interrupted.
	Name    string
	Image   string
	Command []string
	Env     []string // KEY=VALUE
	Mounts  []Mount
	Workdir string
	Stdin   io.Reader
	Limits  Limits
}

// Result is what a finished container produced. A nonzero ExitCode is not an error.
type Result struct {
	ExitCode       int
	Stdout, Stderr string
}

// Runner runs a CLI to completion and reports its exit code; tests replace it.
type Runner func(ctx context.Context, name string, args []string, stdin io.Reader, stdout, stderr io.Writer) (int, error)

// Runtime is one container runtime driven through its CLI.
type Runtime struct {
	Name, Binary string
	// prefix precedes every subcommand, e.g. nerdctl's namespace.
	prefix []string
	// probe checks that the CLI can reach its service; remove force-deletes a container.
	probe, remove []string
	Run           Runner
}

// Default is the runtime native to goos, or "" when there is none.
func Default(goos string) string {
	switch goos {
	case "linux":
		return Containerd
	case "darwin":
		return Apple
	case "windows":
		return WSLC
	}
	return ""
}

// New returns the named runtime; an empty name picks this platform's default.
func New(name string) (*Runtime, error) {
	if name == "" {
		name = Default(runtime.GOOS)
	}
	r := &Runtime{Name: name, Run: run}
	switch name {
	case Containerd:
		// nerdctl is containerd's own Docker-compatible CLI; a dedicated
		// namespace keeps Mob's images and containers apart from others.
		r.Binary, r.prefix, r.probe, r.remove = "nerdctl", []string{"--namespace", "mob"}, []string{"info"}, []string{"rm", "-f"}
	case Apple:
		r.Binary, r.probe, r.remove = "container", []string{"system", "status"}, []string{"delete", "--force"}
	case WSLC:
		r.Binary, r.probe, r.remove = "wslc", []string{"image", "ls"}, []string{"rm", "-f"}
	case "":
		return nil, fmt.Errorf("%w: no native container runtime for %s", ErrUnavailable, runtime.GOOS)
	default:
		return nil, fmt.Errorf("unknown container runtime %q (want %s)", name, strings.Join(Names, ", "))
	}
	return r, nil
}

// Check reports whether the runtime can run containers now.
func (r *Runtime) Check(ctx context.Context) error {
	var stderr bytes.Buffer
	code, err := r.Run(ctx, r.Binary, r.args(r.probe...), nil, io.Discard, &stderr)
	if err != nil {
		return fmt.Errorf("%w: %s: %v", ErrUnavailable, r.Binary, err)
	}
	if code != 0 {
		return fmt.Errorf("%w: %s %s: %s", ErrUnavailable, r.Binary, strings.Join(r.probe, " "), lastLine(stderr.String()))
	}
	return nil
}

// Pull fetches an image ahead of its first run.
func (r *Runtime) Pull(ctx context.Context, image string) error {
	if image == "" || strings.HasPrefix(image, "-") {
		return errors.New("image is required and must not start with -")
	}
	var stderr bytes.Buffer
	code, err := r.Run(ctx, r.Binary, r.args("image", "pull", image), nil, io.Discard, &stderr)
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("pull %s: %s", image, lastLine(stderr.String()))
	}
	return nil
}

// Remove force-deletes a named container. Interrupting a CLI does not
// always stop the container it started, so callers remove it themselves.
func (r *Runtime) Remove(ctx context.Context, name string) error {
	if name == "" || strings.HasPrefix(name, "-") {
		return errors.New("container name is required and must not start with -")
	}
	var stderr bytes.Buffer
	code, err := r.Run(ctx, r.Binary, r.args(append(r.remove, name)...), nil, io.Discard, &stderr)
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("remove %s: %s", name, lastLine(stderr.String()))
	}
	return nil
}

// Exec runs spec in a fresh container and collects its output.
func (r *Runtime) Exec(ctx context.Context, spec Spec) (Result, error) {
	var stdout, stderr bytes.Buffer
	code, err := r.Stream(ctx, spec, &stdout, &stderr)
	return Result{ExitCode: code, Stdout: stdout.String(), Stderr: stderr.String()}, err
}

// Stream runs spec in a fresh container, copying its output as it arrives,
// and returns the container's exit code.
func (r *Runtime) Stream(ctx context.Context, spec Spec, stdout, stderr io.Writer) (int, error) {
	args, err := r.RunArgs(spec)
	if err != nil {
		return -1, err
	}
	return r.Run(ctx, r.Binary, args, spec.Stdin, stdout, stderr)
}

// RunArgs is the CLI invocation for spec. The three CLIs share Docker's
// run flags, so only the binary and its prefix differ.
func (r *Runtime) RunArgs(spec Spec) ([]string, error) {
	// The CLIs stop reading options at the image, so the command passes
	// through untouched; an image that looks like an option would not.
	if spec.Image == "" || strings.HasPrefix(spec.Image, "-") {
		return nil, errors.New("image is required and must not start with -")
	}
	args := []string{"run", "--rm"}
	if spec.Name != "" {
		args = append(args, "--name", spec.Name)
	}
	if spec.Stdin != nil {
		args = append(args, "-i")
	}
	if spec.Workdir != "" {
		args = append(args, "-w", spec.Workdir)
	}
	limits, err := spec.Limits.args()
	if err != nil {
		return nil, err
	}
	args = append(args, limits...)
	for _, e := range spec.Env {
		if key, _, ok := strings.Cut(e, "="); !ok || key == "" {
			return nil, fmt.Errorf("environment entry %q must be KEY=VALUE", e)
		}
		args = append(args, "-e", e)
	}
	for _, m := range spec.Mounts {
		if m.Source == "" || !strings.HasPrefix(m.Target, "/") {
			return nil, fmt.Errorf("mount %q:%q needs a source and an absolute target", m.Source, m.Target)
		}
		args = append(args, "-v", m.Source+":"+m.Target)
	}
	args = append(args, spec.Image)
	return r.args(append(args, spec.Command...)...), nil
}

func (l Limits) args() ([]string, error) {
	var args []string
	switch l.Network {
	case "":
	case NoNetwork:
		args = append(args, "--network", NoNetwork)
	default:
		return nil, fmt.Errorf("network %q must be empty or %q", l.Network, NoNetwork)
	}
	if l.CPUs < 0 || l.MemoryMiB < 0 {
		return nil, errors.New("CPU and memory limits must not be negative")
	}
	if l.CPUs > 0 {
		args = append(args, "--cpus", strconv.Itoa(l.CPUs))
	}
	if l.MemoryMiB > 0 {
		// A lowercase m means MiB to all three CLIs.
		args = append(args, "--memory", strconv.Itoa(l.MemoryMiB)+"m")
	}
	return args, nil
}

// ParseMemory reads a size such as 512m, 2g or 1.5GiB as whole MiB. A unit is
// required: the CLIs disagree on what a bare number means.
func ParseMemory(s string) (int, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	number := strings.TrimRight(s, "kmgtib")
	unit := strings.TrimSuffix(strings.TrimSuffix(s[len(number):], "b"), "i")
	shift := map[string]uint{"m": 0, "g": 10, "t": 20}
	n, err := strconv.ParseFloat(number, 64)
	bits, ok := shift[unit]
	mib := n * float64(uint64(1)<<bits)
	if err != nil || !ok || !(mib >= 1 && mib <= 1<<30) {
		return 0, errors.New("memory must be a size with a unit, such as 512m or 2g")
	}
	return int(mib), nil
}

func (r *Runtime) args(rest ...string) []string {
	return append(append([]string(nil), r.prefix...), rest...)
}

func run(ctx context.Context, name string, args []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) && ctx.Err() == nil {
		return exit.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

// lastLine is the last line a CLI printed, usually its error after any logging.
func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "no output"
	}
	return s[strings.LastIndex(s, "\n")+1:]
}
