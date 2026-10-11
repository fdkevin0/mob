// Package extension runs the long-lived parts of Mob that their configuration
// turns on and off, such as messaging channels: one lifecycle for all of
// them, so starting, replacing, reporting and stopping are written once.
package extension

import (
	"context"
	"errors"
	"slices"
	"sync"
)

// Serve runs an extension until ctx ends, reporting its state through status.
type Serve func(ctx context.Context, status func(string))

// Extension is one part of Mob that its configuration starts and stops.
type Extension struct {
	Name string
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
	mu     sync.Mutex
	units  []*unit
	closed bool
}

func (m *Manager) Register(extensions ...Extension) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range extensions {
		if e.Name == "" || e.Start == nil {
			panic("extension needs a name and Start: " + e.Name)
		}
		if m.find(e.Name) != nil {
			panic("extension registered twice: " + e.Name)
		}
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

// StartAll (re)starts every extension from its current configuration. Every
// extension is tried; the errors are joined.
func (m *Manager) StartAll() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrClosed
	}
	var errs []error
	for _, u := range m.units {
		errs = append(errs, m.restart(u))
	}
	return errors.Join(errs...)
}

// Reload restarts the named extension from its current configuration. A name
// no extension has is not an error: not every plugin runs in the background.
func (m *Manager) Reload(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrClosed
	}
	if u := m.find(name); u != nil {
		return m.restart(u)
	}
	return nil
}

// restart is called under m.mu. The replacement waits for the previous run to
// return, so it never shares a connection with it, and reports from an
// earlier run are dropped. A disabled extension keeps its last run's done, so
// the next run and Close still wait for it.
func (m *Manager) restart(u *unit) error {
	if u.cancel != nil {
		u.cancel()
		u.cancel = nil
	}
	previous := u.done
	u.generation++
	generation := u.generation
	u.status = Disabled
	serve, err := u.Start()
	if err != nil || serve == nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	u.cancel, u.done, u.status = cancel, done, Connecting
	go func() {
		defer close(done)
		// The previous run is already cancelled; waiting for it even when
		// this one is cancelled too lets Close join every run.
		if previous != nil {
			<-previous
		}
		if ctx.Err() != nil {
			return
		}
		serve(ctx, func(text string) {
			m.mu.Lock()
			defer m.mu.Unlock()
			if u.generation == generation {
				u.status = text
			}
		})
	}()
	return nil
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
	m.mu.Lock()
	m.closed = true
	var done []chan struct{}
	for _, u := range m.units {
		if u.cancel != nil {
			u.cancel()
		}
		if u.done != nil {
			done = append(done, u.done)
		}
	}
	m.mu.Unlock()
	for _, d := range done {
		<-d
	}
}
