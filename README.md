# cf-mail

A self-hosted mailbox for your own domain that runs **entirely on Cloudflare** — receiving, sending, storage, a web client, and push notifications. No VPS, no Postfix, no IP-reputation babysitting. One Worker, one D1 database, one R2 bucket.

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

## Prerequisites

- A domain on Cloudflare (the zone must be active on your account)
- `wrangler` ≥ 4 logged in (`npx wrangler login`)
- Workers Paid plan ($5/mo) if you want **sending** — receiving is free

## Setup

```bash
git clone https://github.com/Coldplay-now/cf-mail.git
cd cf-mail
npm install
```

**1. Create the database and bucket**

```bash
npx wrangler d1 create cf-mail        # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create cf-mail
npx wrangler d1 execute cf-mail --remote --file=schema.sql
```

**2. Configure**

- In `wrangler.jsonc`, set `MAIL_DOMAIN` to your domain and the D1 `database_id`.
- Set the admin token (any long random string — it is the login for the web UI):

```bash
npx wrangler secret put AUTH_TOKEN
```

**3. Deploy, then wire up the dashboard**

```bash
npm run deploy
```

In the Cloudflare dashboard, on your zone:

1. **Email → Email Routing**: enable it (this sets the MX records). Under **Routing rules**, set the **catch-all** action to **Send to Worker: cf-mail**.
2. **Email → Email Service** (for sending): enable it for your domain.

**4. ⚠️ Redeploy after enabling Email Service**

```bash
npm run deploy
```

This is the gotcha everyone hits: the `send_email` binding attaches to the service **at deploy time**. If you skip this, sends silently use a legacy unsigned path — mail lands in spam and the dashboard send counter stays at zero.

**5. Create your first address**

Open `https://cf-mail.<your-subdomain>.workers.dev` (or a custom domain you attach to the worker), sign in with your `AUTH_TOKEN`, go to **Settings → Addresses**, and add e.g. `hello`. That's a live mailbox: `hello@yourdomain.com`. Anything not in the table is rejected at SMTP time with a 550.

Send yourself a test mail **from an unrelated provider** (Gmail etc.) — testing from another mailbox at the same provider often never leaves their network and proves nothing.

## Optional: push notifications

**Web Push (browsers / PWA):** generate a VAPID key pair, e.g.

```bash
npx web-push generate-vapid-keys
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT      # mailto:you@yourdomain.com
npm run deploy
```

Then click **Enable browser notifications** in Settings.

**APNs (your own iOS client):** set `APNS_TEAM_ID`, `APNS_TOPIC` (bundle id), `APNS_KEY_ID`, `APNS_PRIVATE_KEY` (the .p8 contents). Devices register by POSTing `{"endpoint": "apns:<device-token-hex>"}` to `/api/push`. Two field notes baked into this repo:

- Workers **can** reach APNs directly — outbound `fetch` negotiates the HTTP/2 that APNs requires. No relay needed (verified in production).
- An App Store Connect API key will **not** work for APNs (`InvalidProviderToken`) — create a dedicated APNs key.

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

So your scripts and agents can send mail with a one-liner:

```bash
curl -X POST https://mail.yourdomain.com/api/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"from":"bot","to":"you@gmail.com","subject":"build failed","text":"..."}'
```

## Security notes

- The web UI is gated by one bearer token; put the worker behind your own custom domain and treat the token like a password. Rotate it with `wrangler secret put AUTH_TOKEN`.
- HTML bodies are rendered inside a **sandboxed iframe** (no scripts, no same-origin) — stored as-is, caged at display time. Remote images do load (sender tracking pixels work); strip them upstream if that matters to you.
- If the worker throws during receive, the sender's MTA retries per SMTP — mail is delayed, not lost.
- Set a DMARC policy on your domain and send only through the DKIM-signed Email Service path; mixing in unsigned senders under `p=reject` will get them dropped.

## Costs & limits

- Receiving: free (Email Routing has no volume cap).
- Sending: included in Workers Paid — 3,000 emails/month at the time of writing; Email Service is in beta, ≤50 recipients per message, **no outbound attachments yet** (inbound attachments are unlimited via R2).
- No IMAP/POP — third-party mail clients can't connect; the web client (or your own UI on the API) is the interface. For some that's the dealbreaker, for others the feature.
- Single-user by design. Multi-tenant auth is out of scope.

## Origin

Extracted from the mail subsystem of [xtxt.top](https://xtxt.top), where it runs in production alongside a Next.js blog (the full write-up of the build, in Chinese: [把邮箱整个搬进 Cloudflare](https://xtxt.top/articles/self-hosted-email-on-cloudflare-workers)).

## License

MIT
