# cf-mail

**English** | [简体中文](README.zh-CN.md)

A self-hosted mailbox for your own domain that runs **entirely on Cloudflare** — receiving, sending, storage, a web client, and push notifications. No VPS, no Postfix, no IP-reputation babysitting. One Worker, one D1 database, one R2 bucket.

> Running in production at **[xtxt.top](https://xtxt.top)**, where it handles all mail for the domain. Full build story: [I Moved My Email Onto Cloudflare Workers](https://xtxt.top/articles/email-on-cloudflare-workers) (English) · [把邮箱整个搬进 Cloudflare](https://xtxt.top/articles/self-hosted-email-on-cloudflare-workers) (中文).

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
| `POST /api/send` | `{from, to, cc?, subject, text, inReplyToId?}` |
| `GET /api/attachments?key=` | stream an attachment |
| `GET/POST /api/addresses`, `PATCH/DELETE /api/addresses/:id` | mailbox CRUD |
| `GET/POST /api/contacts`, `DELETE /api/contacts/:address` | contacts + blocklist |
| `GET /api/push/key`, `POST/DELETE /api/push` | push subscriptions |

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
- **Sending: Workers Paid ($5/mo)** — 3,000 emails/month included at the time of writing. Email Service is in beta: ≤50 recipients per message, **no outbound attachments yet** (inbound attachments are unlimited via R2).
- **No IMAP/POP** — third-party mail clients can't connect; the web client (or your own UI on the API) is the interface. For some that's the dealbreaker, for others the feature.
- Single-user by design. Multi-tenant auth is out of scope.

## Origin

Extracted from the mail subsystem of **[xtxt.top](https://xtxt.top)**, where it has been running in production since June 2026 alongside a Next.js blog — same pipeline, same schema, battle-tested on real mail. The Chinese write-up of the whole journey (including every pitfall in [docs/DEPLOY.md](docs/DEPLOY.md)'s troubleshooting table): [把邮箱整个搬进 Cloudflare](https://xtxt.top/articles/self-hosted-email-on-cloudflare-workers).

## License

MIT
