// Package extension runs the long-lived parts of Mob that their configuration
// turns on and off, such as messaging channels: one lifecycle for all of
// them, so starting, replacing, reporting and stopping are written once.
package extension

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
)

// Serve runs an extension until ctx ends, reporting its state through status.
type Serve func(ctx context.Context, status func(string))

// Extension is one part of Mob that its configuration starts and stops.
type Extension struct {
	Name string
	// Requires names extensions that must be enabled before this one starts.
	// Start prepares shared resources; Serve owns their cleanup before returning.
	Requires []string
	// Start reads the extension's current configuration and returns what
	// serves it, or nil when the configuration leaves it off.
	Start func() (Serve, error)
}

// Status values the manager sets itself; a running extension reports its own.
const (
	Disabled   = "Disabled"
	Connecting = "Connecting…"
)

// ErrClosed is returned once the manager has stopped.
var ErrClosed = errors.New("extensions are stopped")

type unit struct {
	Extension
	cancel     context.CancelFunc
	done       chan struct{}
	status     string
	generation uint64
}

// Manager owns registered extensions' lifecycles. Register all extensions
// before starting any.
type Manager struct {
	operation sync.Mutex
	mu        sync.Mutex
	units     []*unit
	closed    bool
	started   bool
}

func (m *Manager) Register(extensions ...Extension) {
	m.operation.Lock()
	defer m.operation.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.started || m.closed {
		panic("register extensions before starting the manager")
	}
	for _, e := range extensions {
		if e.Name == "" || e.Start == nil {
			panic("extension needs a name and Start: " + e.Name)
		}
		if m.find(e.Name) != nil {
			panic("extension registered twice: " + e.Name)
		}
		e.Requires = slices.Clone(e.Requires)
		m.units = append(m.units, &unit{Extension: e})
	}
}

func (m *Manager) find(name string) *unit {
	i := slices.IndexFunc(m.units, func(u *unit) bool { return u.Name == name })
	if i < 0 {
		return nil
	}
	return m.units[i]
}

// StartAll validates dependencies, then restarts in dependency order. Independent
// extensions still start when another fails; dependents wait for a later reload.
func (m *Manager) StartAll() error {
	m.operation.Lock()
	defer m.operation.Unlock()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ErrClosed
	}
	order, err := m.order()
	if err == nil {
		m.started = true
	}
	m.mu.Unlock()
	if err != nil {
		return err
	}
	m.stop(order)
	return m.start(order)
}

// Reload restarts the named extension from its current configuration. A name
// no extension has is not an error: not every plugin runs in the background.
func (m *Manager) Reload(name string) error {
	m.operation.Lock()
	defer m.operation.Unlock()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ErrClosed
	}
	order, err := m.order()
	if err == nil {
		m.started = true
		order = dependents(order, name)
	}
	m.mu.Unlock()
	if err != nil {
		return err
	}
	m.stop(order)
	return m.start(order)
}

// order validates the entire graph before any running extension is disturbed.
func (m *Manager) order() ([]*unit, error) {
	var order []*unit
	state := map[string]int{}
	var visit func(*unit) error
	visit = func(u *unit) error {
		if state[u.Name] == 1 {
			return fmt.Errorf("extension dependency cycle at %s", u.Name)
		}
		if state[u.Name] == 2 {
			return nil
		}
		state[u.Name] = 1
		for _, name := range u.Requires {
			dependency := m.find(name)
			if dependency == nil {
				return fmt.Errorf("extension %s requires unknown extension %s", u.Name, name)
			}
			if err := visit(dependency); err != nil {
				return err
			}
		}
		state[u.Name] = 2
		order = append(order, u)
		return nil
	}
	for _, u := range m.units {
		if err := visit(u); err != nil {
			return nil, err
		}
	}
	return order, nil
}

// dependents includes name and its transitive dependents, preserving order.
func dependents(order []*unit, name string) []*unit {
	selected := map[string]bool{name: true}
	var result []*unit
	for _, u := range order {
		if selected[u.Name] || slices.ContainsFunc(u.Requires, func(dep string) bool { return selected[dep] }) {
			selected[u.Name] = true
			result = append(result, u)
		}
	}
	return result
}

// stop waits for dependents to release resources before stopping providers.
// operation serializes lifecycle work; mu remains free for status reports.
func (m *Manager) stop(order []*unit) {
	for _, u := range slices.Backward(order) {
		m.mu.Lock()
		u.generation++
		if u.cancel != nil {
			u.cancel()
			u.cancel = nil
		}
		u.status = Disabled
		done := u.done
		m.mu.Unlock()
		if done != nil {
			<-done
		}
	}
}

func (m *Manager) start(order []*unit) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var errs []error
	for _, u := range order {
		ready := true
		for _, name := range u.Requires {
			if m.find(name).cancel == nil {
				u.status = "Waiting for " + name
				ready = false
				break
			}
		}
		if !ready {
			continue
		}
		serve, err := u.Start()
		if err != nil || serve == nil {
			if err != nil {
				errs = append(errs, fmt.Errorf("extension %s: %w", u.Name, err))
			}
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		generation := u.generation
		u.cancel, u.done, u.status = cancel, done, Connecting
		go func() {
			defer func() {
				close(done)
				m.exited(u, generation)
			}()
			serve(ctx, func(text string) {
				m.mu.Lock()
				defer m.mu.Unlock()
				if u.generation == generation {
					u.status = text
				}
			})
		}()
	}
	return errors.Join(errs...)
}

// A run returning unexpectedly withdraws its dependents until a reload.
func (m *Manager) exited(u *unit, generation uint64) {
	m.operation.Lock()
	defer m.operation.Unlock()
	m.mu.Lock()
	if m.closed || u.generation != generation {
		m.mu.Unlock()
		return
	}
	order, _ := m.order() // validated before this run started
	m.mu.Unlock()
	m.stop(dependents(order, u.Name))
	m.mu.Lock()
	u.status = "Stopped"
	m.mu.Unlock()
}

// Status is the named extension's state, or "" before it has started.
func (m *Manager) Status(name string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if u := m.find(name); u != nil {
		return u.status
	}
	return ""
}

// Closed reports whether Close has been called.
func (m *Manager) Closed() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.closed
}

// Close stops every extension and waits for them to return.
func (m *Manager) Close() {
	m.operation.Lock()
	defer m.operation.Unlock()
	m.mu.Lock()
	m.closed = true
	order, err := m.order()
	if err != nil {
		order = m.units
	}
	m.mu.Unlock()
	m.stop(order)
}
