-- Incremental migration: AMP agent mailboxes (docs/AGENT_MAIL_PROTOCOL.md).
-- For deployments created before agent support. Fresh installs get all of this
-- from schema.sql and should NOT run this file.
--
-- Apply with:
--   wrangler d1 execute cf-mail --remote --file=migrations/0001_agent_mailbox.sql

ALTER TABLE addresses ADD COLUMN kind TEXT NOT NULL DEFAULT 'human';
ALTER TABLE addresses ADD COLUMN agent_webhook_url TEXT;
ALTER TABLE addresses ADD COLUMN agent_purpose TEXT;
ALTER TABLE addresses ADD COLUMN agent_token_hash TEXT;

ALTER TABLE mails ADD COLUMN agent_state TEXT;
ALTER TABLE mails ADD COLUMN agent_result TEXT;
ALTER TABLE mails ADD COLUMN agent_trust TEXT;
ALTER TABLE mails ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mails ADD COLUMN correlation_id TEXT;
ALTER TABLE mails ADD COLUMN idempotency_key TEXT;

CREATE INDEX IF NOT EXISTS idx_mails_message_id ON mails(message_id);
CREATE INDEX IF NOT EXISTS idx_mails_folder ON mails(direction, archived, spam, created_at DESC);

CREATE TABLE IF NOT EXISTS mail_allow (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  pattern TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_allow_box ON mail_allow(mailbox_id, direction);

CREATE TABLE IF NOT EXISTS mail_grant (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  correspondent TEXT NOT NULL,
  correlation_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_grant_box ON mail_grant(mailbox_id, correspondent);

CREATE TABLE IF NOT EXISTS mail_event (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  mail_id TEXT,
  type TEXT NOT NULL,
  reason TEXT,
  correlation_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_event_box ON mail_event(mailbox_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_event_corr ON mail_event(correlation_id);
