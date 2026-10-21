package chat

import "time"

// Schedule is a prompt Mob's model runs on its own at Next, in the
// conversation that scheduled it, and again after each run while it repeats.
type Schedule struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	Prompt         string `json:"prompt"`
	// Next is when it runs next, in Unix milliseconds.
	Next int64 `json:"next"`
	// Repeat is empty for one run, or hourly, daily, weekdays or weekly.
	Repeat string `json:"repeat,omitempty"`
	// Zone is the IANA time zone repeats keep their time of day in, and
	// Clock that time of day (15:04), which a day without it, such as one
	// that skips an hour for daylight saving, does not change.
	Zone      string `json:"zone,omitempty"`
	Clock     string `json:"clock,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

const scheduleColumns = "id,conversation_id,prompt,next,repeat,zone,clock,created_at"

// AddSchedule saves s with a new ID.
func (s *Store) AddSchedule(sc *Schedule) error {
	sc.ID, sc.CreatedAt = NewID(), time.Now().UnixMilli()
	_, err := s.db.Exec("INSERT INTO schedules("+scheduleColumns+") VALUES(?,?,?,?,?,?,?,?)", sc.ID, sc.ConversationID, sc.Prompt, sc.Next, sc.Repeat, sc.Zone, sc.Clock, sc.CreatedAt)
	return err
}

// Schedules lists the schedules due by before, or all of them when before is
// zero, soonest first.
func (s *Store) Schedules(before int64) ([]Schedule, error) {
	rows, err := s.db.Query("SELECT "+scheduleColumns+" FROM schedules WHERE ?=0 OR next<=? ORDER BY next,id", before, before)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Schedule{}
	for rows.Next() {
		var sc Schedule
		if err := rows.Scan(&sc.ID, &sc.ConversationID, &sc.Prompt, &sc.Next, &sc.Repeat, &sc.Zone, &sc.Clock, &sc.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, sc)
	}
	return list, rows.Err()
}

// Reschedule sets when schedule id runs next.
func (s *Store) Reschedule(id string, next int64) error {
	_, err := s.db.Exec("UPDATE schedules SET next=? WHERE id=?", next, id)
	return err
}

// Unschedule deletes schedule id, or every schedule when id is "all", and
// reports how many it deleted.
func (s *Store) Unschedule(id string) (int64, error) {
	query, args := "DELETE FROM schedules WHERE id=?", []any{id}
	if id == "all" {
		query, args = "DELETE FROM schedules", nil
	}
	result, err := s.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
