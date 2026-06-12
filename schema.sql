-- cf-mail D1 schema. Apply with:
--   wrangler d1 execute cf-mail --remote --file=schema.sql

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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mails_created ON mails(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mails_thread ON mails(thread_key);

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
