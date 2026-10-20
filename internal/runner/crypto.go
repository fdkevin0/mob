// Package runner connects a local Mob service to the account-scoped encrypted relay.
package runner

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
)

type Envelope struct {
	Version int    `json:"v"`
	Session string `json:"session"`
	ID      string `json:"id"`
	Seq     uint64 `json:"seq"`
	Final   bool   `json:"final"`
	Nonce   string `json:"nonce"`
	Data    string `json:"data"`
}

func aead(key string) (cipher.AEAD, error) {
	raw, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(raw) != 32 {
		return nil, errors.New("runner key must be 32 base64-encoded bytes")
	}
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func (e Envelope) aad(runnerID, direction string) []byte {
	raw, _ := json.Marshal([]any{e.Version, runnerID, e.Session, e.ID, direction, e.Seq, e.Final})
	return raw
}
func seal(key cipher.AEAD, runnerID, direction string, e Envelope, value any) (Envelope, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return e, err
	}
	nonce := make([]byte, key.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return e, err
	}
	e.Nonce = base64.StdEncoding.EncodeToString(nonce)
	e.Data = base64.StdEncoding.EncodeToString(key.Seal(nil, nonce, raw, e.aad(runnerID, direction)))
	return e, nil
}
func open(key cipher.AEAD, runnerID, direction string, e Envelope, value any) error {
	if e.Version != 1 {
		return errors.New("unsupported encryption version")
	}
	nonce, err := base64.StdEncoding.DecodeString(e.Nonce)
	if err != nil || len(nonce) != key.NonceSize() {
		return errors.New("invalid nonce")
	}
	data, err := base64.StdEncoding.DecodeString(e.Data)
	if err != nil {
		return err
	}
	raw, err := key.Open(nil, nonce, data, e.aad(runnerID, direction))
	if err != nil {
		return errors.New("encrypted frame authentication failed")
	}
	return json.Unmarshal(raw, value)
}
