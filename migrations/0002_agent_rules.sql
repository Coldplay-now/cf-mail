-- Incremental migration: soft user rules for agent mailboxes (AMP §11.2).
-- Owner-declared, advisory guidance surfaced in the manifest — NOT enforced
-- (the hard guarantee is the allowlist). Fresh installs get this from schema.sql.
--
-- Apply with:
--   wrangler d1 execute cf-mail --remote --file=migrations/0002_agent_rules.sql

ALTER TABLE addresses ADD COLUMN agent_rules TEXT;
