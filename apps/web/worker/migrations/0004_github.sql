-- Installations of the Mob GitHub App. The webhook records each one with the
-- account it is on and the GitHub user who installed it; a signed-in visitor
-- whose GitHub account is either may bind it to one of their runners, which
-- then receives its events and may ask for its tokens.
CREATE TABLE github_installation (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  sender_id INTEGER NOT NULL,
  suspended INTEGER NOT NULL DEFAULT 0,
  user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  runner_id TEXT REFERENCES runner(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX github_installation_runner ON github_installation(runner_id);
CREATE INDEX github_installation_account ON github_installation(account_id);
CREATE INDEX github_installation_sender ON github_installation(sender_id);

-- Webhook deliveries already handled, so a redelivery is not run twice.
CREATE TABLE github_delivery (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
