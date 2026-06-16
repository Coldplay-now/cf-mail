# cf-mail

**English** | [简体中文](README.zh-CN.md)

A self-hosted mailbox for your own domain that runs **entirely on Cloudflare** — receiving, sending, storage, a web client, and push notifications. No VPS, no Postfix, no IP-reputation babysitting. One Worker, one D1 database, one R2 bucket.

> Running in production at **[xtxt.top](https://xtxt.top)**, where it handles all mail for the domain. Full build story: [I Moved My Email Onto Cloudflare Workers](https://xtxt.top/articles/email-on-cloudflare-workers) (English) · [把邮箱整个搬进 Cloudflare](https://xtxt.top/articles/self-hosted-email-on-cloudflare-workers) (中文).

![cf-mail inbox](docs/screenshots/inbox.png)

<table><tr>
<td width="33%"><a href="docs/screenshots/detail.png"><img src="docs/screenshots/detail.png" alt="Mail detail"></a></td>
<td width="33%"><a href="docs/screenshots/compose.png"><img src="docs/screenshots/compose.png" alt="Compose"></a></td>
<td width="33%"><a href="docs/screenshots/settings.png"><img src="docs/screenshots/settings.png" alt="Settings"></a></td>
</tr></table>

```
receive   MX → Cloudflare Email Routing (free)
            └─ catch-all → this Worker
                 ├─ unknown/inactive address → SMTP 550 reject
                 ├─ postal-mime parse → attachments to R2, message to D1
                 ├─ blocked sender → stored as spam, no forward/notification
                 └─ optional forward of a copy to an external address

send      web UI / API → Worker's send_email binding (Email Service, DKIM-signed)

read      built-in web client served by the same Worker
            inbox / sent / archived / spam · search · conversations ·
            contacts auto-aggregated · blocklist · attachments

notify    new mail → Web Push (browsers/PWA) and/or APNs (your own iOS app)
          — both optional, enabled by secrets
```

The point of this architecture: **your mail becomes ordinary rows in your own database.** Conversation grouping is a query, search is a `LIKE`, the blocklist is a table, and a "team mailbox" is one row with a forward field. Everything you'd wait for a mail provider to ship is a small commit.

## Features

- **Mailbox management is CRUD** — adding a row creates a live address; deactivating it makes the SMTP server reject with `550`. Spray spam dies at the door, and you never touch the Cloudflare dashboard for addresses.
- **Plus-addressing for free** — `you+newsletter@` delivers to `you@` with the original kept on the row, so you can trace who leaked your address.
- **Web client built in** — folders, search, conversation view, attachments, compose/reply with proper `In-Reply-To`/`References` threading, contact auto-aggregation, one-click blocklist. Dark mode, mobile-friendly, zero frontend dependencies.
- **Push, two channels** — Web Push (VAPID) for browsers/PWA, and APNs **directly from the Worker** for your own iOS client. Workers' outbound `fetch` negotiates the HTTP/2 APNs requires — verified in production, no relay needed.
- **Honest failure semantics** — if the Worker throws during receive, the sender's MTA retries per SMTP. Mail is delayed, not lost.
- **An API your scripts can use** — send a notification mail from CI or an AI agent with one `curl`.
- **Agent mailboxes** — a mailbox with `kind='agent'` is a bounded, observable inbox for an autonomous agent: default-deny correspondents (both directions), an address-scoped token, a `received → delivered → handled` ack queue, a per-message trust block, and a reason-coded event log — consumed via `GET/POST /api/agent/<box>/{manifest,inbox,ack,send,events}`. New mail is delivered to a per-mailbox webhook signed per [Standard Webhooks](https://www.standardwebhooks.com), with the pull API as the always-available fallback. See **[Agent mail](#agent-mail--designing-a-mailbox-for-an-ai-agent)** below and the **[protocol spec](docs/AGENT_MAIL_PROTOCOL.md)**. (A simpler global webhook — `AGENT_WEBHOOK_URL`, fired for every human mail — is also available.)

## Agent mail — designing a mailbox for an AI agent

Once you run agents, email stops being a human-to-human medium and becomes something else: an asynchronous, durable, universally-addressable **buffer** between an agent and the outside world. It's the one protocol every human and every service already speaks, so an agent with an address is reachable by anyone — without per-counterparty integration. cf-mail is built so an agent can own a mailbox *safely*. The design rests on three axioms (full model: **[Agent Mail Protocol](docs/AGENT_MAIL_PROTOCOL.md)**):

- **A mailbox is a data buffer, not a command channel.** Mail content is data, never a prompt. *Receiving* (writing to the buffer), *reading* (the agent pulling it in, with trust metadata attached), and *acting* (the agent's own, governable judgement) are three distinct steps — the buffer is never auto-executed. A message arriving is not the same as feeding it to a model, and feeding it to a model is not the same as obeying it.
- **Senders and recipients are explicit and bounded.** A purpose-built agent talks to a known, allowlisted set of correspondents — in *both* directions, default-deny. That boundary isn't a limitation; it's what makes the agent trustworthy enough to run unattended.
- **Mail is never, by itself, a command.** No property of a message — DKIM pass, a known sender, even "it looks like it's from the owner" — turns its content into an instruction. Trust signals decide *how warily to read*, never *whether to obey*. Anything consequential needs an out-of-band authorization that doesn't live in the mail body.

**Why it matters.** Email hands an agent the *lethal trifecta* (Simon Willison): access to private data, exposure to untrusted content, and the ability to communicate externally — all at once. That's exactly what makes naive "agent email" dangerous (see [EchoLeak / CVE-2025-32711](https://xtxt.top/articles/lethal-trifecta-en), a single zero-click email that walked Microsoft Copilot into exfiltrating internal files). cf-mail breaks the trifecta on two legs: the trusted-`meta` / untrusted-content split fences message content out of the instruction path, and bounded outbound caps the blast radius if an agent is ever hijacked — "email the secrets to attacker@evil.com" fails because that recipient was never allowlisted. Background read — **The Lethal Trifecta**: [English](https://xtxt.top/articles/lethal-trifecta-en) · [中文](https://xtxt.top/articles/lethal-trifecta).

**What ships today:** the security core runs in this repo. A mailbox with `kind='agent'` is **default-deny in both directions** — a fresh agent mailbox accepts no inbound and sends no outbound until you add allowlist patterns (`mail_allow`: an exact address or `@domain`). Inbound is enforced at SMTP time (`550` before anything is stored); outbound is refused in the shared send path *before* the Email Service binding fires, so "email the secrets to attacker@evil.com" can never leave. An agent send mints a time-boxed **reply-grant** so the reply is admitted without permanently widening the list. Each admitted mail gets a **trust block** (§6: `dkimPass`/`spfPass`/`knownContact`/`allowlisted`/`firstContact`/`isReplyToAgent` → `trustLevel`), is buffered with an `agent_state` (`received → delivered → handled`) that keeps it out of every human folder and off device push, and every consequential step is written to a reason-coded **event log**. Agents consume it over an **address-scoped token** (`POST /addresses/:id/agent-token`, shown once, stored hashed):

| Endpoint | What |
|---|---|
| `GET /api/agent/<box>/manifest` | self-describing tool surface + allowlists (§11.1) |
| `GET /api/agent/<box>/inbox?state=open` | pull unhandled mail in the `meta`/`untrusted` shape (§4.1) |
| `POST /api/agent/<box>/ack` | `{id, result: done\|escalated\|rejected}` — `escalated` re-surfaces to the human |
| `POST /api/agent/<box>/send` | send as the mailbox (allowlist-enforced, idempotent) |
| `GET /api/agent/<box>/events` | the reason-coded trace log, filterable by `correlationId` |

Per-mailbox webhook delivery (`addresses.agent_webhook_url`) is signed per **[Standard Webhooks](https://www.standardwebhooks.com)** (`webhook-id`/`webhook-timestamp`/`webhook-signature`) — a hint that new mail arrived; the pull API is the always-available fallback. Owner-declared **soft rules** (`addresses.agent_rules`, one per line) are surfaced in the manifest as advisory guidance — not enforced; the allowlist is the only hard boundary (§11.2). The pure decision helpers (`matchAllow`/`inboundAdmit`/`outboundAllowed`/`deriveTrust`) live in [`src/agent.ts`](src/agent.ts) and are unit-tested with no database. **Still deferred** (see [AGENT_MAIL_PROTOCOL.md](docs/AGENT_MAIL_PROTOCOL.md)): structured escalation-routing config, and `Reply-To` plus-address correlation (the Email Service binding exposes no `Reply-To` and returns no `Message-ID`, so correlation stays grant/reference-based). The protocol also runs as a second implementation on [xtxt.top](https://xtxt.top). Setup: **[docs/DEPLOY.md → Agent mailboxes](docs/DEPLOY.md#agent-mailboxes)**.

## Quick start

```bash
git clone https://github.com/Coldplay-now/cf-mail.git && cd cf-mail
npm install
npx wrangler d1 create cf-mail            # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create cf-mail
npx wrangler d1 execute cf-mail --remote --file=schema.sql
npx wrangler secret put AUTH_TOKEN        # any long random string — your login
npm run deploy
```

Then in the dashboard: enable **Email Routing** (catch-all → *Send to Worker: cf-mail*), enable **Email Service**, and — the gotcha everyone hits — **deploy once more** so the `send_email` binding attaches. Open the worker URL, sign in with your token, add your first address in Settings.

👉 **The complete step-by-step walkthrough — DNS records, dashboard screens, push setup, verification tests, troubleshooting — lives in [docs/DEPLOY.md](docs/DEPLOY.md).**

## API

Everything under `/api/*` takes `Authorization: Bearer <AUTH_TOKEN>`:

| Endpoint | Description |
|---|---|
| `GET /api/mails?folder=inbox\|sent\|archived\|spam&page=&q=` | paged list + counts |
| `GET /api/mails/:id` | full mail + conversation, marks read |
| `PATCH /api/mails/:id` | `{read?, archived?, spam?}` |
| `DELETE /api/mails/:id` | delete (and its R2 attachments) |
| `POST /api/send` | JSON `{from, to, cc?, subject, text, inReplyToId?}`, or multipart with `attachments` file parts (≤5 MiB) |
| `GET /api/attachments?key=` | stream an attachment |
| `GET/POST /api/addresses`, `PATCH/DELETE /api/addresses/:id` | mailbox CRUD |
| `GET/POST /api/contacts`, `DELETE /api/contacts/:address` | contacts + blocklist |
| `GET /api/push/key`, `POST/DELETE /api/push` | push subscriptions |
| `GET/POST /api/addresses/:id/allow`, `DELETE …/allow/:allowId` | agent in/out allowlist |
| `POST /api/addresses/:id/agent-token` | mint a mailbox-scoped agent token (shown once) |
| `GET/POST /api/agent/<box>/{manifest,inbox,ack,send,events}` | agent surface (per-mailbox token) |

The `/api/agent/*` surface authenticates with a **per-mailbox** token (or the global token as admin override); everything else uses the global `AUTH_TOKEN`. See **[docs/DEPLOY.md → Agent mailboxes](docs/DEPLOY.md#agent-mailboxes)** for the full setup.

**Global webhook** (optional, human mail): set `AGENT_WEBHOOK_URL` (+ `AGENT_WEBHOOK_SECRET`) and each inbound human mail POSTs `{event:"mail.received", id, from, to, subject, snippet, text, attachments, trust:{knownContact,dkimPass}, ...}`, signed per **[Standard Webhooks](https://www.standardwebhooks.com)** (`webhook-id`/`webhook-timestamp`/`webhook-signature: v1,<base64 hmac>` over `id.timestamp.body`). Agent mailboxes use their own per-mailbox webhook instead.

```bash
curl -X POST https://mail.yourdomain.com/api/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"from":"bot","to":"you@gmail.com","subject":"build failed","text":"..."}'
```

## Security notes

- The web UI is gated by one bearer token; put the worker behind your own custom domain and treat the token like a password. Rotate with `wrangler secret put AUTH_TOKEN`.
- HTML bodies render inside a **sandboxed iframe** (no scripts, no same-origin) — stored as-is, caged at display time. Remote images do load (tracking pixels work); strip upstream if that matters to you.
- Set a DMARC policy and send only through the DKIM-signed Email Service path; mixing in unsigned senders under `p=reject` gets them dropped.

## Costs & limits

- **Receiving: free** (Email Routing has no volume cap). D1/R2 usage for personal mail is negligible.
- **Sending: Workers Paid ($5/mo)** — 3,000 emails/month included at the time of writing. Email Service is in beta: ≤50 recipients per message; **attachments supported both ways** (outbound ≤5 MiB per message; inbound unlimited via R2).
- **No IMAP/POP** — third-party mail clients can't connect; the web client (or your own UI on the API) is the interface. For some that's the dealbreaker, for others the feature.
- Single-user by design. Multi-tenant auth is out of scope.

## Origin

Extracted from the mail subsystem of **[xtxt.top](https://xtxt.top)**, where it has been running in production since June 2026 alongside a Next.js blog — same pipeline, same schema, battle-tested on real mail. The Chinese write-up of the whole journey (including every pitfall in [docs/DEPLOY.md](docs/DEPLOY.md)'s troubleshooting table): [把邮箱整个搬进 Cloudflare](https://xtxt.top/articles/self-hosted-email-on-cloudflare-workers).

## License

MIT
