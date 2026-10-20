package chat

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestUnversionedMigrationAndDeliveryRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mob.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(history.steps[0].SQL); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO settings VALUES('api_key','keep-secret'); INSERT INTO conversations VALUES('conversation','keep-title',1); INSERT INTO deliveries(id,state,reply) VALUES('email:old','sending','keep-reply');
INSERT INTO messages(id,conversation_id,role,parts,status) VALUES('message','conversation','assistant','[{"type":"text","text":"keep-history"}]','streaming');
INSERT INTO approvals VALUES('approval','conversation','message','call','{"fact":"keep-pending"}','pending',9999999999999);
INSERT INTO memories VALUES('memory','conversation','keep-fact');
INSERT INTO settings VALUES('plugins','{"telegram":{"token":"keep-bot-token"}}');
INSERT INTO deliveries(id,state) VALUES('tg:old','processing')`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	for range 2 {
		s, err := OpenStore(path)
		if err != nil {
			t.Fatal(err)
		}
		var key string
		if err := s.Setting("api_key", &key); err != nil || key != "" {
			t.Fatalf("legacy key kept in SQLite: %v", err)
		}
		list, err := s.List()
		if err != nil || len(list) != 1 || list[0].Title != "keep-title" {
			t.Fatalf("history lost: %v", err)
		}
		d, err := s.Delivery("email:old")
		if err != nil || d.State != "failed-or-unknown" || d.Reply != "keep-reply" {
			t.Fatalf("recovery: %+v %v", d, err)
		}
		accepted, err := s.AcceptDelivery(d.ID, "sending")
		if err != nil || accepted {
			t.Fatal("restart admitted duplicate")
		}
		history, err := s.History("conversation")
		if err != nil || len(history) != 1 || Text(history[0]) != "keep-history" || history[0].Metadata["status"] != "interrupted" {
			t.Fatalf("message recovery: %v", err)
		}
		facts, err := s.Memories("conversation", false)
		if err != nil || len(facts) != 1 || facts[0] != "keep-fact" {
			t.Fatal("memory lost")
		}
		var approval string
		if err = s.db.QueryRow("SELECT input FROM approvals WHERE id='approval' AND status='pending'").Scan(&approval); err != nil || approval != `{"fact":"keep-pending"}` {
			t.Fatal("approval lost")
		}
		var config struct{ Telegram struct{ Token string } }
		if err = s.Setting("plugins", &config); err != nil || config.Telegram.Token != "keep-bot-token" {
			t.Fatal("plugin secret lost")
		}
		interrupted, err := s.Delivery("tg:old")
		if err != nil || interrupted.State != "processing-failed" {
			t.Fatal("processing receipt not recovered")
		}
		s.Close()
	}
}
