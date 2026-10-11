package extension

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fake serves until cancelled, recording overlapping runs.
type fake struct {
	mu      sync.Mutex
	on      bool
	running int
	overlap bool
	runs    int
	started chan func(string)
	err     error
}

func (f *fake) extension(name string) Extension {
	return Extension{Name: name, Start: func() (Serve, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.err != nil || !f.on {
			return nil, f.err
		}
		return func(ctx context.Context, status func(string)) {
			f.mu.Lock()
			f.running++
			f.runs++
			f.overlap = f.overlap || f.running > 1
			f.mu.Unlock()
			f.started <- status
			<-ctx.Done()
			time.Sleep(10 * time.Millisecond) // a slow shutdown, as a poller releasing its connection
			f.mu.Lock()
			f.running--
			f.mu.Unlock()
		}, nil
	}}
}

func (f *fake) set(on bool, err error) {
	f.mu.Lock()
	f.on, f.err = on, err
	f.mu.Unlock()
}

func newFake() *fake { return &fake{on: true, started: make(chan func(string), 8)} }

func wait(t *testing.T, f *fake) func(string) {
	t.Helper()
	select {
	case status := <-f.started:
		return status
	case <-time.After(5 * time.Second):
		t.Fatal("extension did not start")
		return nil
	}
}

func TestManagerLifecycle(t *testing.T) {
	f := newFake()
	var m Manager
	m.Register(f.extension("chat"))
	if m.Status("chat") != "" || m.Status("other") != "" {
		t.Fatal("status before start")
	}
	if err := m.StartAll(); err != nil {
		t.Fatal(err)
	}
	if m.Status("chat") != Connecting {
		t.Fatalf("status: %q", m.Status("chat"))
	}
	first := wait(t, f)
	first("Connected")
	if m.Status("chat") != "Connected" {
		t.Fatalf("reported status: %q", m.Status("chat"))
	}
	if err := m.Reload("chat"); err != nil {
		t.Fatal(err)
	}
	wait(t, f)
	first("stale")
	if m.Status("chat") != Connecting {
		t.Fatalf("an earlier run's report replaced the status: %q", m.Status("chat"))
	}
	f.set(false, nil)
	if err := m.Reload("chat"); err != nil || m.Status("chat") != Disabled {
		t.Fatalf("disable: %v %q", err, m.Status("chat"))
	}
	f.set(true, nil)
	if err := m.Reload("chat"); err != nil {
		t.Fatal(err)
	}
	wait(t, f)
	if err := m.Reload("email"); err != nil {
		t.Fatalf("plugin without a background run: %v", err)
	}
	m.Close()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.running != 0 || f.overlap || f.runs != 3 {
		t.Fatalf("running %d, overlap %v, runs %d", f.running, f.overlap, f.runs)
	}
	if !m.Closed() || !errors.Is(m.Reload("chat"), ErrClosed) || !errors.Is(m.StartAll(), ErrClosed) {
		t.Fatal("restarted after Close")
	}
}

func TestManagerReportsStartErrors(t *testing.T) {
	broken, working := newFake(), newFake()
	failure := errors.New("unreadable configuration")
	broken.set(true, failure)
	var m Manager
	m.Register(broken.extension("broken"), working.extension("working"))
	if err := m.StartAll(); !errors.Is(err, failure) {
		t.Fatalf("start error: %v", err)
	}
	wait(t, working)
	if m.Status("broken") != Disabled {
		t.Fatalf("broken status: %q", m.Status("broken"))
	}
	m.Close()
}

func TestRegisterRejectsDuplicates(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("registered twice")
		}
	}()
	f := newFake()
	var m Manager
	m.Register(f.extension("chat"), f.extension("chat"))
}
