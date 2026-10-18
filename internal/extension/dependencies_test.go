package extension

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDependenciesOrderReloadAndCleanup(t *testing.T) {
	var m Manager
	defer m.Close()
	var mu sync.Mutex
	var events []string
	record := func(event string) { mu.Lock(); defer mu.Unlock(); events = append(events, event) }
	makeExtension := func(name string, requires ...string) Extension {
		return Extension{Name: name, Requires: requires, Start: func() (Serve, error) {
			record("start " + name)
			return func(ctx context.Context, report func(string)) {
				<-ctx.Done()
				report("releasing") // shutdown can still report without deadlocking
				record("stop " + name)
			}, nil
		}}
	}
	m.Register(makeExtension("leaf", "middle"), makeExtension("middle", "base"), makeExtension("base"), makeExtension("other"))
	if err := m.StartAll(); err != nil {
		t.Fatal(err)
	}
	if err := m.Reload("base"); err != nil {
		t.Fatal(err)
	}
	m.Close()
	want := []string{"start base", "start middle", "start leaf", "start other", "stop leaf", "stop middle", "stop base", "start base", "start middle", "start leaf", "stop other", "stop leaf", "stop middle", "stop base"}
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("lifecycle:\n%v\nwant:\n%v", events, want)
	}
}

func TestDependenciesValidateBeforeStarting(t *testing.T) {
	for _, test := range []struct {
		name         string
		dependencies map[string][]string
		want         string
	}{
		{"missing", map[string][]string{"a": {"missing"}}, "unknown extension missing"},
		{"self", map[string][]string{"a": {"a"}}, "cycle"},
		{"cycle", map[string][]string{"a": {"b"}, "b": {"a"}}, "cycle"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var m Manager
			defer m.Close()
			for name, requires := range test.dependencies {
				m.Register(Extension{Name: name, Requires: requires, Start: func() (Serve, error) {
					t.Error("invalid graph started a plugin")
					return nil, nil
				}})
			}
			if err := m.StartAll(); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("validation: %v", err)
			}
		})
	}
}

func TestDisabledAndFailedDependenciesRecoverOnReload(t *testing.T) {
	provider, consumer, other := newFake(), newFake(), newFake()
	provider.set(false, nil)
	var m Manager
	defer m.Close()
	dependent := consumer.extension("consumer")
	dependent.Requires = []string{"provider"}
	m.Register(dependent, provider.extension("provider"), other.extension("other"))
	if err := m.StartAll(); err != nil {
		t.Fatal(err)
	}
	wait(t, other)
	if m.Status("consumer") != "Waiting for provider" {
		t.Fatal(m.Status("consumer"))
	}
	failure := errors.New("could not connect")
	provider.set(true, failure)
	if err := m.Reload("provider"); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	select {
	case <-consumer.started:
		t.Fatal("started without its dependency")
	default:
	}
	provider.set(true, nil)
	if err := m.Reload("provider"); err != nil {
		t.Fatal(err)
	}
	wait(t, provider)
	wait(t, consumer)
	provider.set(false, nil)
	if err := m.Reload("provider"); err != nil {
		t.Fatal(err)
	}
	if m.Status("consumer") != "Waiting for provider" {
		t.Fatal(m.Status("consumer"))
	}
	other.mu.Lock()
	defer other.mu.Unlock()
	if other.runs != 1 || other.running != 1 {
		t.Fatal("unrelated plugin restarted")
	}
}

func TestUnexpectedExitStopsDependents(t *testing.T) {
	var m Manager
	defer m.Close()
	finish := make(chan struct{})
	consumer := newFake()
	dependent := consumer.extension("consumer")
	dependent.Requires = []string{"provider"}
	m.Register(dependent, Extension{Name: "provider", Start: func() (Serve, error) {
		return func(ctx context.Context, _ func(string)) {
			select {
			case <-finish:
			case <-ctx.Done():
			}
		}, nil
	}})
	if err := m.StartAll(); err != nil {
		t.Fatal(err)
	}
	wait(t, consumer)
	close(finish)
	deadline := time.Now().Add(5 * time.Second)
	for m.Status("provider") != "Stopped" {
		if time.Now().After(deadline) {
			t.Fatal("provider exit did not withdraw dependents")
		}
		time.Sleep(time.Millisecond)
	}
	consumer.mu.Lock()
	defer consumer.mu.Unlock()
	if consumer.running != 0 || m.Status("consumer") != Disabled {
		t.Fatal("dependent survived provider shutdown")
	}
}

func TestConcurrentReloadAndClose(t *testing.T) {
	var m Manager
	var active atomic.Int32
	m.Register(Extension{Name: "one", Start: func() (Serve, error) {
		if active.Load() != 0 {
			t.Error("Start ran before old Serve released its resource")
		}
		return func(ctx context.Context, _ func(string)) {
			if active.Add(1) != 1 {
				t.Error("overlapping runs")
			}
			<-ctx.Done()
			active.Add(-1)
		}, nil
	}})
	if err := m.StartAll(); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			if err := m.Reload("one"); err != nil && !errors.Is(err, ErrClosed) {
				t.Error(err)
			}
		})
	}
	wg.Go(m.Close)
	wg.Wait()
	if active.Load() != 0 {
		t.Fatal("Close returned while running")
	}
}
