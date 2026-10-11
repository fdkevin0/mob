package chat

import (
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/version"
)

func openDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func schemaOf(t *testing.T, db *sql.DB) (schema int, opened string) {
	t.Helper()
	if err := db.QueryRow("PRAGMA user_version").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT value FROM meta WHERE key='service_version'").Scan(&opened); err != nil {
		t.Fatal(err)
	}
	return schema, opened
}

func exec(t *testing.T, db *sql.DB, statements string) {
	t.Helper()
	if _, err := db.Exec(statements); err != nil {
		t.Fatal(err)
	}
}

func TestStoreRecordsSchemaAndRelease(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if schema, opened := schemaOf(t, s.db); schema != history.latest() || opened != version.Current {
		t.Fatalf("schema %d by %q, want %d by %q", schema, opened, history.latest(), version.Current)
	}
}

func TestSchemaHistoryRules(t *testing.T) {
	for i, m := range history.steps {
		if _, err := time.Parse("20060102", m.Added); err != nil {
			t.Errorf("migration %d: Added %q is not a YYYYMMDD date", history.first+i, m.Added)
		}
	}
	if (history.first > 0) != (history.baseline != "") {
		t.Error("a baseline creates schema first, and only when older migrations were retired")
	}
	below := 0
	for _, w := range history.retired {
		if w.Below <= below || w.Below > history.first || !version.Stable(w.Release) {
			t.Errorf("retired windows must rise, end at schema %d and name stable releases: %+v", history.first, w)
		}
		below = w.Below
	}
	if below != history.first {
		t.Errorf("the last retired window must end at schema %d, not %d", history.first, below)
	}
}

func TestMigrationWindows(t *testing.T) {
	retired := schemaHistory{
		baseline: "CREATE TABLE notes(id TEXT, body TEXT)",
		first:    2,
		steps:    []migration{{"20261020", "ALTER TABLE notes ADD COLUMN tag TEXT"}},
		retired:  []retiredWindow{{1, "20260901.aaaaaaa"}, {2, "20261011.bbbbbbb"}},
	}

	fresh := openDB(t)
	if err := retired.apply(fresh, "20261101.ddddddd"); err != nil {
		t.Fatal(err)
	}
	exec(t, fresh, "INSERT INTO notes(id,body,tag) VALUES('1','kept','x')")
	if schema, opened := schemaOf(t, fresh); schema != 3 || opened != "20261101.ddddddd" {
		t.Fatalf("fresh database: schema %d by %q", schema, opened)
	}
	if err := retired.apply(fresh, "20261102.eeeeeee"); err != nil {
		t.Fatal(err)
	}
	if _, opened := schemaOf(t, fresh); opened != "20261102.eeeeeee" {
		t.Fatalf("reopening did not record the release: %q", opened)
	}

	for schema, release := range map[int]string{0: "20260901.aaaaaaa", 1: "20261011.bbbbbbb"} {
		old := openDB(t)
		exec(t, old, "CREATE TABLE notes(id TEXT)")
		exec(t, old, fmt.Sprintf("PRAGMA user_version=%d", schema))
		err := retired.apply(old, "20261101.ddddddd")
		var schemaErr *SchemaError
		if !errors.As(err, &schemaErr) || !strings.Contains(err.Error(), "Install Mob "+release+" from "+version.DownloadURL(release)) || !strings.Contains(err.Error(), "unknown release") {
			t.Fatalf("schema %d: %v", schema, err)
		}
		var created int
		if err := old.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='meta'").Scan(&created); err != nil || created != 0 {
			t.Fatalf("a refused database was changed: %v", err)
		}
	}

	newer := openDB(t)
	exec(t, newer, "CREATE TABLE notes(id TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('service_version','20991231.fffffff'); PRAGMA user_version=9")
	if err := retired.apply(newer, "20261101.ddddddd"); err == nil || !strings.Contains(err.Error(), "install Mob 20991231.fffffff or newer") {
		t.Fatalf("newer database: %v", err)
	}
	if schema, _ := schemaOf(t, newer); schema != 9 {
		t.Fatal("a refused database was changed")
	}
}

func TestUnversionedDatabaseUpgrades(t *testing.T) {
	// Installations from before migrations existed have tables but schema 0.
	db := openDB(t)
	exec(t, db, "CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO conversations VALUES('c','kept',1)")
	if err := history.apply(db, "20261101.ddddddd"); err != nil {
		t.Fatal(err)
	}
	var title, model string
	if err := db.QueryRow("SELECT title, model FROM conversations").Scan(&title, &model); err != nil || title != "kept" {
		t.Fatalf("conversation lost: %v", err)
	}
	if schema, _ := schemaOf(t, db); schema != history.latest() {
		t.Fatalf("schema %d", schema)
	}
}
