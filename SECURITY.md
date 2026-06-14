# Security

## Reporting a vulnerability

Please report security issues privately — open a [GitHub security advisory](https://github.com/Coldplay-now/cf-mail/security/advisories/new)
(preferred) or email the maintainer at the address in the repo profile. Don't
file a public issue for anything exploitable. Expect an acknowledgement within a
few days.

## Threat model

cf-mail is a single-tenant mailbox you self-host. Its trust boundaries:

- **The internet → the receive worker.** Anyone can send mail to your domain.
  Unknown/inactive local parts are rejected at SMTP (`550`) before storage.
  Inbound HTML is rendered only inside a **sandboxed iframe** (no scripts, no
  same-origin); the list/detail UI escapes all sender-controlled strings. Stored
  attachments are served behind auth, never executed.
- **The API.** Everything under `/api/*` requires the global bearer
  `AUTH_TOKEN` (constant-time compared). `/api/agent/*` requires a **mailbox-scoped**
  token that can only reach its own mailbox (the global token works as admin
  override). Tokens are stored hashed (SHA-256); plaintext is shown once. Put a
  Cloudflare Rate Limiting rule in front of `/api/*` (see DEPLOY).

## Agent mailboxes & the lethal trifecta

An agent with an email address has the *lethal trifecta* (Simon Willison):
private-data access, exposure to untrusted content, and external communication.
cf-mail's agent mailboxes are designed to break it:

- **Mail is data, never a command (A3).** The webhook/pull payload structurally
  splits system-asserted `meta` (trusted) from sender-controlled `untrusted`. The
  `trust` block only tells an agent *how warily to read* — it never authorizes an
  action. Do not feed `untrusted.*` into a tool-calling context as instructions.
- **Bounded correspondents (A2), default-deny both ways.** A fresh agent mailbox
  accepts no inbound and sends no outbound. Outbound is refused **before** the
  send binding fires, so a hijacked agent can't exfiltrate to a non-allowlisted
  address. Keep the outbound allowlist tight.
- **Observability.** Every consequential step is in the reason-coded event log;
  watch it (Agent panel / `GET /api/agent/<box>/events`).

These guarantees are enforced by the mail system, not left to the agent's
discretion — see [docs/AGENT_MAIL_PROTOCOL.md](docs/AGENT_MAIL_PROTOCOL.md).

## Operational notes

- Set `AGENT_WEBHOOK_SECRET` so webhook deliveries are signed (Standard
  Webhooks). Receivers MUST verify the signature and reject stale timestamps.
- Rotate `AUTH_TOKEN` and re-mint agent tokens if you suspect exposure.
- D1 has 30-day point-in-time recovery; the event log self-prunes at 30 days.
