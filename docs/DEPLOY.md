# Deployment guide

**English** | [简体中文](DEPLOY.zh-CN.md)

This walks you from an empty Cloudflare account to a working mailbox at your own domain, the exact way it runs in production at [xtxt.top](https://xtxt.top). Budget ~30 minutes for the first deploy.

## 0. Prerequisites

| What | Why |
|---|---|
| A domain whose DNS is on Cloudflare (zone active) | Email Routing and Email Service operate at the zone level |
| Node.js ≥ 18 and `npx wrangler login` completed | deploys, D1/R2 creation, secrets |
| Workers **Paid** plan ($5/mo) — *only if you want to send* | Email Service (outbound) is part of Paid; receiving alone works on Free |
| The domain must **not** have another mail provider's MX you still need | enabling Email Routing replaces the MX records |

> **Migrating from another provider?** Decide what happens to history first. Email Routing only handles *future* mail; old messages stay wherever they are. cf-mail starts with an empty database by design.

## 1. Clone, create resources, apply schema

```bash
git clone https://github.com/Coldplay-now/cf-mail.git && cd cf-mail
npm install

npx wrangler d1 create cf-mail
# → copy the printed database_id into wrangler.jsonc ("d1_databases")

npx wrangler r2 bucket create cf-mail

npx wrangler d1 execute cf-mail --remote --file=schema.sql
```

Edit `wrangler.jsonc`:

- `vars.MAIL_DOMAIN` → your domain, e.g. `"example.com"`
- `d1_databases[0].database_id` → the id from above

## 2. Set the admin token and deploy

```bash
# Generate something long; this is the password for the web UI and the API.
openssl rand -hex 32 | npx wrangler secret put AUTH_TOKEN
npm run deploy
```

The deploy prints your worker URL (`https://cf-mail.<account>.workers.dev`). You can attach a nicer custom domain later (step 6).

## 3. Enable Email Routing (receiving)

Dashboard → your zone → **Email → Email Routing**:

1. Click **Enable Email Routing** — it will offer to add the MX + SPF records. Accept. (If it warns about existing MX records from an old provider, you must remove those — that's the cut-over moment.)
2. Go to **Routing rules** → **Catch-all address** → set the action to **Send to a Worker** → pick **cf-mail** → enable the catch-all.
3. Optional, only needed if you'll use per-address `forward_to`: under **Destination addresses**, add and verify the external mailbox(es) you want copies forwarded to. Forwards to unverified destinations fail silently (they're logged, ingestion is unaffected).

**Receiving now works.** Any address you create in the web UI is live; everything else is rejected with `550 5.1.1 mailbox unavailable`.

## 4. Enable Email Service (sending) — mind the trap

Dashboard → your zone → **Email → Email Service** (may appear as "Send email" / Beta):

1. Enable it for your domain. It adds the DKIM records it needs.
2. **⚠️ Redeploy the worker now:**

```bash
npm run deploy
```

The `send_email` binding attaches to the service **at deploy time**. Skip this and sends take a legacy unsigned path: mail lands in recipients' spam folders and the dashboard's send counter stays at **0** — that frozen counter is your diagnostic signal.

3. Check your SPF record (DNS → Records, the `TXT` at the zone apex). You want exactly **one** SPF record, containing Cloudflare's include:

```
v=spf1 include:_spf.mx.cloudflare.net ~all
```

If an old provider's `include:` is still in there and you no longer send through them, remove it. Two separate SPF records = validation failures.

4. Recommended DMARC (`TXT` at `_dmarc`):

```
v=DMARC1; p=quarantine; rua=mailto:you@yourdomain.com
```

Tighten to `p=reject` once you've confirmed everything you send goes through the DKIM-signed path — under `reject`, any unsigned channel pretending to be your domain gets dropped.

## 5. First mailbox + smoke test

1. Open the worker URL → sign in with your `AUTH_TOKEN`.
2. **Settings → Addresses** → add `hello` (display name optional). That's `hello@yourdomain.com`, live.
3. **From a mailbox at an unrelated provider** (Gmail, Outlook…), send a test to `hello@yourdomain.com`. It should appear in the inbox within seconds.
   - *Why unrelated?* Testing from another mailbox at the same provider often never leaves their network — it "passes" while proving nothing about your MX.
4. Reply from the web UI. Check the recipient side: it should arrive in the **inbox** (not spam) and show DKIM `pass` in the message headers (`d=yourdomain.com`).
5. Send to a non-existent address at your domain from outside — you should get a bounce quoting `550 5.1.1`.

## 6. Custom domain (recommended)

Dashboard → **Workers & Pages → cf-mail → Settings → Domains & Routes → Add → Custom domain**, e.g. `mail.yourdomain.com`. Cloudflare provisions DNS + TLS automatically. The bearer token now rides over your own TLS-terminated hostname, and the URL is memorable.

## 7. Optional: Web Push notifications

```bash
npx web-push generate-vapid-keys
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT     # mailto:you@yourdomain.com
npm run deploy
```

Then **Settings → Enable browser notifications** in the web UI (on iOS Safari, add the page to the Home Screen first — push requires the PWA context there).

## 8. Optional: APNs (your own iOS client)

If you build a native client, the worker can push to it **directly** — Workers' outbound `fetch` negotiates the HTTP/2 APNs requires (verified in production; no relay).

1. In the Apple Developer portal, create a **dedicated APNs key** (.p8). An App Store Connect API key will *not* work — APNs answers `403 InvalidProviderToken`.
2. Set the secrets:

```bash
npx wrangler secret put APNS_TEAM_ID      # e.g. AB12CD34EF
npx wrangler secret put APNS_TOPIC       # your app bundle id
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_PRIVATE_KEY  # paste the .p8 file contents
npm run deploy
```

3. Have the app register its device token:

```
POST /api/push   {"endpoint": "apns:<device-token-hex>", "label": "iPhone"}
```

Endpoints answering `400`/`410` are pruned automatically.

## 9. Agent mailboxes

An agent mailbox (`kind='agent'`) is a bounded, observable inbox for an autonomous agent — **default-deny in both directions**, kept out of the human folders, consumed over a mailbox-scoped token. Full model: [AGENT_MAIL_PROTOCOL.md](AGENT_MAIL_PROTOCOL.md).

**Already running an older deploy?** Apply each migration once, in order (fresh installs get all of this from `schema.sql`):

```bash
npx wrangler d1 execute cf-mail --remote --file=migrations/0001_agent_mailbox.sql
npx wrangler d1 execute cf-mail --remote --file=migrations/0002_agent_rules.sql
```

Then set up an agent mailbox (the global `AUTH_TOKEN` authorizes these admin calls):

```bash
BASE=https://mail.yourdomain.com; H="Authorization: Bearer $AUTH_TOKEN"

# 1. create the agent mailbox
curl -X POST $BASE/api/addresses -H "$H" -H 'content-type: application/json' \
  -d '{"address":"agent","kind":"agent","agent_purpose":"my assistant",
       "agent_webhook_url":"https://my-agent.example.com/hook"}'   # webhook optional

# 2. allowlist correspondents — DEFAULT-DENY until you do (id = addresses.id)
curl -X POST $BASE/api/addresses/<id>/allow -H "$H" -H 'content-type: application/json' \
  -d '{"direction":"in","pattern":"@yourcompany.com"}'
curl -X POST $BASE/api/addresses/<id>/allow -H "$H" -H 'content-type: application/json' \
  -d '{"direction":"out","pattern":"you@yourcompany.com"}'

# 3. mint the mailbox-scoped agent token (printed ONCE, stored hashed)
curl -X POST $BASE/api/addresses/<id>/agent-token -H "$H"     # → {"token":"cfmail_…"}
```

The agent then uses *its* token (not the global one):

```bash
AH="Authorization: Bearer cfmail_…"
curl $BASE/api/agent/agent/manifest -H "$AH"            # self-describing surface
curl "$BASE/api/agent/agent/inbox?state=open" -H "$AH"  # pull unhandled mail
curl -X POST $BASE/api/agent/agent/ack  -H "$AH" -d '{"id":"…","result":"done"}'
curl -X POST $BASE/api/agent/agent/send -H "$AH" -d '{"to":"you@yourcompany.com","subject":"…","text":"…"}'
curl "$BASE/api/agent/agent/events" -H "$AH"            # reason-coded trace log
```

Notes:
- A send to a non-allowlisted recipient is refused (`403`) *before* mail leaves; an agent send mints a 7-day reply-grant so the reply is admitted.
- `AGENT_WEBHOOK_SECRET` (a `wrangler secret`) signs per-mailbox webhook deliveries per [Standard Webhooks](https://www.standardwebhooks.com). Without it, deliveries are unsigned — set it in production.
- Agent mail never pushes to your devices and never appears in the inbox/sent folders; observe it via `events` (and `ack {result:"escalated"}` re-surfaces a message to you with a push).
- **Soft rules** (`agent_rules`, optional): owner-declared, *advisory* guidance shown in the manifest — set via `PATCH /api/addresses/<id>` `{"agent_rules":"line 1\nline 2"}` or the web UI's Agent panel. NOT enforced (the allowlist is the hard boundary); they just shape how a well-behaved agent acts.
- Inbound is hardened: delivery runs after the SMTP accept (`ctx.waitUntil`), retried deliveries dedup on Message-ID, and attachments are capped at 10 MiB/message.

## 10. Operations

| Task | How |
|---|---|
| Rotate the admin token | `openssl rand -hex 32 \| npx wrangler secret put AUTH_TOKEN` (sessions sign in again) |
| Logs / errors | Dashboard → Workers → cf-mail → **Logs** (observability is enabled in `wrangler.jsonc`) |
| Backup | D1 has 30-day point-in-time recovery (`wrangler d1 time-travel`); for cold copies, `wrangler d1 export cf-mail --remote --output backup.sql` on a schedule |
| Update cf-mail | `git pull && npm install && npm run deploy` — apply any new `migrations/*.sql` (or `schema.sql` on a fresh DB) **before** deploying |
| Rate-limit login/API | The Bearer token is the only gate. Add a Cloudflare **Rate Limiting** rule on `/api/*` (e.g. >20 req / 10s per IP → block) so a leaked-token guesser or scraper is throttled at the edge |
| Uninstall | Disable the catch-all rule first (mail starts bouncing), then delete the worker; D1/R2 keep your archive until you delete them |

> Security headers (CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options`) are set by the worker on every response; the email-preview iframe is `sandbox`ed (no scripts, no same-origin). No extra config needed.

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Sent mail lands in spam, dashboard send counter stays 0 | Email Service enabled *after* the last deploy — binding still on the legacy path | `npm run deploy` again |
| `POST /api/send` → 501 | No `SEND_EMAIL` binding at all | Enable Email Service, then redeploy |
| Test mail "works" but DNS was never right | You tested from the same provider as the old mailbox | Test from an unrelated provider |
| Forward copies never arrive | `forward_to` destination not verified in Email Routing | Verify it under Destination addresses |
| API calls return Cloudflare error 1010 | Default library User-Agent blocked | Send a custom `User-Agent` header |
| All sends rejected at recipients with DMARC failures | You send through a second, unsigned channel under `p=reject` | Route all outbound through Email Service, or relax to `p=quarantine` while migrating |
| Push silent on iOS Safari | Web Push needs the Home-Screen PWA context | Add to Home Screen, subscribe from there |
| APNs `403 InvalidProviderToken` | Using an App Store Connect key | Create a dedicated APNs key |
| Inbound mail delayed after a bad deploy | Worker threw; sender MTAs are retrying per SMTP | Fix the worker; queued mail arrives on the next retry |
| Agent mail bounces / inbox stays empty | Sender not on the agent's inbound allowlist (default-deny) | Add a `direction:"in"` allow pattern; check `events` for `rejected/not_allowlisted` |
| Agent `send` → 403 | Recipient not on the outbound allowlist and not a reply target | Add a `direction:"out"` allow pattern |
| Agent endpoints → 401 | Wrong token, or `no such column: kind`/`agent_rules` after upgrade | Use the mailbox token from `agent-token`; apply `migrations/0001` + `0002` |
