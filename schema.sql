-- cf-mail D1 schema. Apply with:
--   wrangler d1 execute cf-mail --remote --file=schema.sql
--
-- Already deployed an earlier version? Don't re-run this (CREATE TABLE IF NOT
-- EXISTS won't add the new agent columns). Apply the incremental migration
-- instead: migrations/0001_agent_mailbox.sql

CREATE TABLE IF NOT EXISTS addresses (
  id TEXT PRIMARY KEY,
  -- local part only: "dev" means dev@yourdomain.com
  address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  -- inactive addresses are rejected at SMTP time (550)
  active INTEGER NOT NULL DEFAULT 1,
  -- optional: relay a copy to this external address (must be a verified
  -- Email Routing destination, or the forward silently fails)
  forward_to TEXT,
  note TEXT,
  -- AMP agent mailbox (docs/AGENT_MAIL_PROTOCOL.md): 'human' (default) | 'agent'.
  -- An 'agent' mailbox is default-deny in both directions (see mail_allow),
  -- never pushes to humans, and is consumed via /api/agent/<local>/*.
  kind TEXT NOT NULL DEFAULT 'human',
  -- where to POST the §4.1 payload on new agent mail (signed Standard Webhooks);
  -- the pull API is the always-available fallback.
  agent_webhook_url TEXT,
  -- short self-description surfaced in the manifest (§11.1)
  agent_purpose TEXT,
  -- SHA-256 (hex) of the per-mailbox agent bearer token; shown once at creation
  agent_token_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mails (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,                    -- in | out
  status TEXT NOT NULL DEFAULT 'received',    -- received | sent | failed
  message_id TEXT,
  in_reply_to TEXT,
  refs TEXT,                                  -- References header
  thread_key TEXT,                            -- root message-id of the conversation
  from_addr TEXT NOT NULL,
  from_name TEXT,
  to_addr TEXT NOT NULL,
  cc_addr TEXT,                               -- comma-separated other recipients
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  snippet TEXT,
  attachments TEXT,                           -- JSON [{key,filename,mime,size}]
  read INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  spam INTEGER NOT NULL DEFAULT 0,
  -- AMP: NULL on human mail (the human/agent split). On agent mail this carries
  -- the lifecycle: received -> delivered -> handled | failed. Agent mail is
  -- filtered OUT of the human folders and never triggers device push.
  agent_state TEXT,
  agent_result TEXT,                          -- done | escalated | rejected
  agent_trust TEXT,                           -- JSON trust block (§6), computed at receipt
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT,                        -- task/thread correlation (§7)
  idempotency_key TEXT,                       -- outbound dedup
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mails_created ON mails(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mails_thread ON mails(thread_key);
CREATE INDEX IF NOT EXISTS idx_mails_message_id ON mails(message_id);
-- agent inbox / human folder filters both lead with these columns
CREATE INDEX IF NOT EXISTS idx_mails_folder ON mails(direction, archived, spam, created_at DESC);

-- Address book + spam blocklist in one table.
CREATE TABLE IF NOT EXISTS contacts (
  address TEXT PRIMARY KEY,                   -- full lowercase email
  name TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Web Push / APNs subscriptions. APNs devices use endpoint "apns:<hex token>".
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT,
  auth TEXT,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- AMP agent mailbox tables (docs/AGENT_MAIL_PROTOCOL.md) ----

-- Default-deny allowlist, both directions (A2). A fresh agent mailbox has no
-- rows here, so it accepts no inbound and sends no outbound until the owner
-- adds patterns. `pattern` is a lowercase exact address or "@domain".
CREATE TABLE IF NOT EXISTS mail_allow (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,                   -- addresses.id
  direction TEXT NOT NULL,                    -- in | out
  pattern TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_allow_box ON mail_allow(mailbox_id, direction);

-- Time-boxed inbound reply-grant minted when the agent sends, so the reply is
-- admitted without permanently widening the allowlist.
CREATE TABLE IF NOT EXISTS mail_grant (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  correspondent TEXT NOT NULL,               -- lowercase address allowed to reply
  correlation_id TEXT,
  expires_at INTEGER NOT NULL,               -- epoch ms
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_grant_box ON mail_grant(mailbox_id, correspondent);

-- Append-only, reason-coded event log: every consequential step (received,
-- rejected, delivered, delivery_failed, handled, escalated, sent, send_refused).
CREATE TABLE IF NOT EXISTS mail_event (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  mail_id TEXT,
  type TEXT NOT NULL,
  reason TEXT,
  correlation_id TEXT,
  detail TEXT,                               -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_event_box ON mail_event(mailbox_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_event_corr ON mail_event(correlation_id);
