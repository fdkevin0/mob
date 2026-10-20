CREATE TABLE runner (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  code_hash TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  token_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX runner_user ON runner(user_id);
