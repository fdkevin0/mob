package chat

import (
	"database/sql"
	"errors"
	"time"
)

type Delivery struct {
	ID        string `json:"id"`
	State     string `json:"state"`
	Reply     string `json:"reply"`
	Error     string `json:"error"`
	UpdatedAt int64  `json:"updatedAt"`
}

// AcceptDelivery must commit before acknowledging an external update or sending.
func (s *Store) AcceptDelivery(id, state string) (bool, error) {
	result, err := s.db.Exec("INSERT OR IGNORE INTO deliveries(id,state,updated_at) VALUES(?,?,?)", id, state, time.Now().UnixMilli())
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}
func (s *Store) Delivery(id string) (Delivery, error) {
	d := Delivery{ID: id}
	err := s.db.QueryRow("SELECT state,reply,error,updated_at FROM deliveries WHERE id=?", id).Scan(&d.State, &d.Reply, &d.Error, &d.UpdatedAt)
	return d, err
}
func (s *Store) UpdateDelivery(id, state, reply string, failure error) error {
	text := ""
	if failure != nil {
		text = failure.Error()
	}
	result, err := s.db.Exec("UPDATE deliveries SET state=?,reply=?,error=?,updated_at=? WHERE id=?", state, reply, text, time.Now().UnixMilli(), id)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n != 1 {
		return sql.ErrNoRows
	}
	return err
}
func (s *Store) Deliveries() ([]Delivery, error) {
	rows, err := s.db.Query("SELECT id,state,reply,error,updated_at FROM deliveries ORDER BY updated_at DESC,rowid DESC LIMIT 100")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Delivery{}
	for rows.Next() {
		var d Delivery
		if err := rows.Scan(&d.ID, &d.State, &d.Reply, &d.Error, &d.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, d)
	}
	return result, rows.Err()
}

// A receipt is durable even when processing or sending fails. Missing receipts
// must never advance a poller's offset.
func (s *Store) DeliveryAccepted(id string) (bool, error) {
	_, err := s.Delivery(id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
