package configuration

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watch uses the directory so an editor's atomic rename does not lose the watch.
// fsnotify is owned explicitly so Close can join the watcher before closing SQLite.
func (l *Loader) Watch(ctx context.Context, apply func(Environment) error, report func(error)) (func(), error) {
	dir := filepath.Dir(l.path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, errors.New("cannot create configuration directory")
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, errors.New("cannot start configuration watcher")
	}
	if err = watcher.Add(dir); err != nil {
		watcher.Close()
		return nil, errors.New("cannot watch configuration directory")
	}
	ctx, cancel := context.WithCancel(ctx)
	seen := l.required
	if _, err := os.Lstat(l.path); err == nil {
		seen = true
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer watcher.Close()
		timer := time.NewTimer(150 * time.Millisecond)
		defer timer.Stop()
		// Reconcile after registering the watch, covering writes during startup.
		pending := timer.C
		reload := func() {
			next, err := l.read(true)
			if err == nil {
				err = apply(next)
			}
			report(err)
		}
		for {
			select {
			case <-ctx.Done():
				return
			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				if err != nil {
					report(errors.New("configuration watch failed; current configuration retained"))
				}
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				if filepath.Clean(event.Name) == dir && event.Has(fsnotify.Remove|fsnotify.Rename) {
					report(errors.New("configuration directory removed; restart required to resume watching"))
					return
				}
				if filepath.Clean(event.Name) != l.path {
					continue
				}
				if event.Has(fsnotify.Write | fsnotify.Create | fsnotify.Rename | fsnotify.Remove | fsnotify.Chmod) {
					timer.Reset(150 * time.Millisecond)
					pending = timer.C
				}
			case <-pending:
				pending = nil
				// An absent optional file is fine only before it has ever been loaded.
				if _, err := os.Lstat(l.path); errors.Is(err, os.ErrNotExist) && !seen {
					continue
				}
				seen = true
				reload()
			}
		}
	}()
	return func() { cancel(); <-done }, nil
}
