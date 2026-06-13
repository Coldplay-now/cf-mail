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
- **Agent webhook** — set `AGENT_WEBHOOK_URL` and every inbound (non-spam) mail is POSTed to it as a signed JSON summary (HMAC in `X-CF-Mail-Signature`), so an agent is *triggered* by new mail instead of polling. The payload carries a `trust` block (`knownContact`, `dkimPass`) so an agent can treat unknown-sender mail as untrusted data, not instructions. This is one piece of a larger design — see the **[Agent Mail Protocol spec](docs/AGENT_MAIL_PROTOCOL.md)** for the full model (mailbox kinds, delivery/ack queue, correlation, the trust boundary).

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

**Agent webhook** (optional): set the `AGENT_WEBHOOK_URL` (and `AGENT_WEBHOOK_SECRET`) secrets and each inbound mail POSTs `{event:"mail.received", id, from, to, subject, snippet, text, attachments, trust:{knownContact,dkimPass}, ...}` to your agent. Verify `X-CF-Mail-Signature: sha256=<hmac>` against the raw body.

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
