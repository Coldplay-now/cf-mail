# Changelog

All notable changes to cf-mail are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com); versions track `package.json`.

## [0.2.0] — Agent Mail Protocol core

The headline: cf-mail now **implements** the [Agent Mail Protocol](docs/AGENT_MAIL_PROTOCOL.md)
security core, not just specifies it. A mailbox can be a bounded, observable
inbox for an autonomous agent.

### Added
- **Agent mailboxes** (`kind='agent'`): default-deny in both directions
  (`mail_allow` allowlist + time-boxed reply-grants), enforced at the SMTP
  boundary inbound (`550` before storage) and in the send path outbound (refused
  before the Email Service binding fires).
- Per-message **trust block** (§6) persisted; `agent_state` queue
  (`received → delivered → handled/failed`) that keeps agent mail out of the
  human folders and off device push; append-only reason-coded **event log**.
- **Agent API** `GET/POST /api/agent/<box>/{manifest,inbox,ack,send,events}`,
  authenticated by a mailbox-scoped token (`POST /addresses/:id/agent-token`,
  shown once, stored hashed). The operator's global token works as admin override.
- Per-mailbox webhook delivery (`addresses.agent_webhook_url`).
- **Escalation** (`ack {result:"escalated"}` and dead-letter) re-surfaces a
  message as a human-visible inbox row plus a device push.
- **Scheduled sweep** (cron, every 5 min): redeliver undelivered agent mail,
  dead-letter → escalate at the attempt cap, expire grants, prune the event log.
- Admin allowlist CRUD + an **Agent panel** in the web UI (purpose, webhook,
  in/out allowlist, token mint, recent events, open inbox).
- `examples/agent.mjs` — a ~50-line zero-dependency reference agent.
- Unit tests (`vitest`) for the pure decision helpers; GitHub Actions CI;
  `migrations/0001_agent_mailbox.sql` for existing deployments.

### Changed
- **Webhook signing migrated to [Standard Webhooks](https://www.standardwebhooks.com)**
  (`webhook-id` / `webhook-timestamp` / `webhook-signature`) for both the
  per-mailbox and the legacy global hook — replay-resistant, off-the-shelf
  verifiable. **Breaking** for anyone verifying the old `X-CF-Mail-Signature`.
- Security headers on every response (CSP for HTML, `nosniff`, `Referrer-Policy`,
  `X-Frame-Options`); the email-preview iframe gains `allow-popups` so links open.
- Human folder queries scoped to `agent_state IS NULL`; added folder /
  `message_id` indexes.

### Migration
Existing deployments: apply `migrations/0001_agent_mailbox.sql` **before**
deploying. Set the `AGENT_WEBHOOK_SECRET` secret to sign webhook deliveries.

## [0.1.0] — Initial release
- Self-hosted mailbox on Cloudflare (Email Routing + Workers + D1 + R2): receive,
  store, forward, send (Email Service), attachments, plus-addressing, built-in
  web client, Web Push + APNs, contacts/blocklist, a global agent webhook.
