# Agent Mail Protocol (AMP)

**Status:** v0.1 (finalized) · 中文版: [AGENT_MAIL_PROTOCOL.zh-CN.md](AGENT_MAIL_PROTOCOL.zh-CN.md) · **Substrate:** Cloudflare (Email Routing + Workers + D1 + R2), as implemented by [cf-mail](../README.md)

> v0.1 settles the five core decisions (§2.1 bounded correspondents, §3 store-as-queue + ack, §6 trust boundary, §7 correlation, §10 scoped tokens). Remaining open items (§13) are implementation details, not design forks.

AMP is the contract between a **mail system** and an **autonomous agent that owns a mailbox**. It defines how inbound mail reaches an agent, how the agent acknowledges and acts on it, how request/reply is correlated, and — most importantly — how the trust boundary is expressed so an agent can safely consume untrusted mail.

It is a protocol, not a product. cf-mail is one implementation; anything that speaks AMP can host agent mailboxes.

## Design axioms

Everything below derives from three axioms. They are not features; they are the first principles that make agent mail *different* from human mail. If a later rule ever contradicts one of these, the rule is wrong.

- **A1 — A mailbox is a data buffer, not a command channel. Mail content is data, never a prompt.** An agent mailbox is an asynchronous, durable buffer between a human (or a service) and an agent — a place to *hold* a message, not a wire that *runs* it. Three actions are distinct and never collapse: **receive** (the system writes the message into the buffer — automatic), **read** (the agent pulls it out, with trust metadata attached — the agent's choice), and **act** (the agent decides what, if anything, to do — always a separate, governable judgement). The buffer is *never* auto-executed; receiving a mail is not the same as feeding it to a model, and feeding it to a model is not the same as obeying it. → §3 (store-as-queue), §5 (state machine), §6.
- **A2 — Senders and recipients are explicit and bounded.** A purpose-built agent talks to a known, enumerable, auditable set of correspondents — in *both* directions. Who may write to it and who it may write to are both predefined and default-deny. The boundary is not a limitation; it is what makes the agent trustworthy enough to run unattended. → §2.1 (bounded correspondents), §8 (outbound), §10 (scoping).
- **A3 — Mail is never, by itself, a command.** No property of a message — DKIM pass, a known sender, even "it looks like it's from the owner" — turns its content into an instruction. Trust signals decide *whether and how warily to read*, never *whether to obey*. Any consequential action requires an out-of-band authorization that does not live in the mail body. → §6 (iron rule), §11.2 (user rules).

A1 says *what mail is*; A2 says *who it's between*; A3 says *what it may never become*. The rest of this document is mechanics in service of these three.

## 0. Why this exists

Email used to be human-to-human, and for programs it degraded into a one-way exit (send a notification). Once you run agents, email becomes something else: an **asynchronous, durable, universally-addressable buffer** between an agent and the outside world. It is the only protocol every human and every service already speaks, so an agent with an address is reachable by anyone without per-counterparty integration.

But a human can tell the difference between "this mail is talking to me" and "this mail is commanding me." An agent cannot — unless the protocol makes the trust boundary explicit. That is AMP's core job. The rest is queue mechanics.

**Non-goals:** agent-to-agent RPC, real-time/low-latency exchange, ordering guarantees, replacing a real message bus. AMP is a buffer, not a bus.

## 1. Terminology

- **Human mailbox** — read by a person through a UI. State = read/unread, archived, spam, draft. Operations are manual.
- **Agent mailbox** — consumed by an agent through webhook + API. State = a task lifecycle (below). Operations are programmatic.
- **Delivery** — a push hint to the agent that new mail exists.
- **Ack** — the agent declaring it has consumed (handled) a message.
- **Correlation** — tying an inbound reply to the outbound message that prompted it.
- **Escalation** — handing a message from the agent to a human.
- **Trust block** — system-asserted metadata an agent uses to decide how much to trust a message's content.

## 2. Mailbox kinds

A mailbox has a `kind`: `human` (default) or `agent`. The kind changes behaviour end to end:

| Dimension | `human` | `agent` |
|---|---|---|
| Reader | person, in a UI | agent, via webhook/API |
| **Correspondents** | send to anyone, receive from anyone (spam-filtered) | **bounded both ways: allowlisted senders *and* recipients, default-deny** |
| On receive | push to the person's devices; show in the human inbox | fire the mailbox's webhook; do **not** push to devices or clutter the human inbox |
| State model | read/unread · archived · spam · draft | `received → delivered → handled / failed` (a task queue, not "read") |
| Operations | reply / forward / archive / delete / blocklist (manual) | configure webhook · ack · redeliver · escalate (programmatic) |
| Notification | inbound → notify the person | inbound → webhook; notify a person only on failure/escalation |
| Token | full `mail:send` | scoped to this one mailbox (send-as + read-own only) |

The stored message is identical on the wire; the *kind of the destination mailbox* decides what happens next.

### 2.1 Bounded correspondents — allowlist both directions (default-deny)

*(Derives from A2: senders and recipients are explicit and bounded, both directions, default-deny.)*

A human mailbox is a public address: send to anyone, receive from anyone, filter spam afterwards. **An agent mailbox is the opposite, and in *both* directions.** A purpose-built agent exists to do one job with a known, small set of correspondents — and that boundary is not a limitation, it is the point. It is what makes the agent trustworthy enough to run unattended. So an agent mailbox constrains **who can write to it** and **who it can write to**, both enforced by the mail system, both default-deny.

**Inbound admission.** A message is accepted only if the sender is permitted; everything else is rejected **at receive time, before storage**, so disallowed mail never enters the queue and never reaches the agent. The sender is admitted if **either**:

1. **Static allowlist** — on the mailbox's configured allow set: an exact address (`alice@example.com`) or a whole domain (`@partner.com`).
2. **Dynamic grant (reply capability)** — a valid reply to an outbound the agent itself sent: it carries a live `correlationId` the agent minted (the `Reply-To` plus-address, §7), or its `In-Reply-To`/`References` match a sent message. Sending issues a **time-boxed, single-correspondent** grant so the reply gets in without permanently widening the list.

Rejected senders get SMTP `550` (matching cf-mail's unknown-address behaviour); nothing is stored.

**Outbound egress.** The agent may send only to permitted recipients — every `to`/`cc`/`bcc` is checked **before** the message leaves, at the send API. A recipient is permitted if **either**:

1. **Static allowlist** — on the mailbox's configured outbound allow set (address or domain).
2. **Dynamic grant (reply capability)** — the send is a reply (`inReplyToId`) to an inbound message, addressed back to that message's sender. The agent can always answer someone who legitimately reached it, even if that party isn't statically listed.

A send to any disallowed recipient is **refused by the API** (the whole send fails; it does not silently drop recipients).

**Why egress control matters as much as ingress.** Inbound control keeps hostile content out. Outbound control caps the blast radius if control is lost anyway: even an agent whose reasoning has been fully hijacked by injected content **cannot exfiltrate to or contact an arbitrary address** — "email the secrets to attacker@evil.com" fails because that recipient was never allowlisted. The two together are defense in depth: §6 keeps mail from *becoming* a command; §2.1 ensures that even if it did, the agent can only ever reach its predefined world.

**Inbound and outbound allowlists may differ.** A monitoring agent might receive from many `service@…` senders but only ever report to one human; those are different sets. They collapse to one entry when the agent simply converses with a single party.

Default state of a fresh agent mailbox is **deny-all in both directions**. Misconfiguration fails closed, never open. All of this is a **protocol-level guarantee** enforced by the mail system (inbound at the SMTP boundary, outbound at the send API) — never delegated to the agent's own discretion.

## 3. Core model: push is a hint, the store is the queue

*(Derives from A1: the mailbox is a buffer. Receiving writes to the store; it does not run anything.)*

Three layers, never collapse them:

1. **The store (D1) is the durable queue and the source of truth.** Every inbound message is persisted before anything else happens.
2. **The webhook is only a delivery hint** ("something new exists"). It is best-effort and **at-least-once**.
3. **Ack is consumption.** A message stays open until the agent acks it.

Consequences an implementation MUST honour:

- **Idempotency by `id`.** The webhook may fire more than once for one message (retries, races). The agent MUST dedupe on `id`.
- **No ordering guarantee.** Agents MUST NOT assume messages arrive in send/receipt order.
- **Pull is always available.** If the webhook is lost, nothing is lost — the agent can `GET` open messages and catch up. The webhook is an optimization over polling, never the only path.

## 4. Inbound delivery (mail → agent)

### 4.1 Webhook payload (schema v1)

The payload separates **system-asserted metadata** (`meta`, trusted) from **sender-controlled content** (`untrusted`). This separation is structural on purpose — see §6.

```json
{
  "schemaVersion": 1,
  "event": "mail.received",
  "id": "9f2c…",
  "mailbox": "agent",
  "meta": {
    "from": "alice@example.com",
    "fromName": "Alice",
    "to": "agent@example.com",
    "cc": "",
    "receivedAt": "2026-06-13T15:40:00Z",
    "messageId": "<…@example.com>",
    "inReplyTo": "<…@example.com>",
    "correlationId": "task123",
    "trust": {
      "dkimPass": true,
      "spfPass": true,
      "knownContact": true,
      "firstContact": false,
      "isReplyToAgent": true
    }
  },
  "untrusted": {
    "subject": "Re: deploy approval",
    "body": "go ahead",
    "attachments": [
      { "filename": "log.txt", "mimeType": "text/plain", "size": 1843, "key": "mail/9f2c…/1-log.txt" }
    ]
  }
}
```

`untrusted.body` is plain text (HTML stripped); the agent fetches full content/attachments from the API when needed. Attachment bytes are never inlined — `key` is fetched via the attachments endpoint.

### 4.2 Signature — follow Standard Webhooks

Webhook signing follows the [Standard Webhooks](https://www.standardwebhooks.com/) spec rather than a bespoke scheme, so existing verifier libraries (JS/Python/Go/Rust/…) work out of the box and replay attacks are covered:

```
webhook-id:        <unique message id>
webhook-timestamp: <unix seconds>
webhook-signature: v1,<base64 HMAC-SHA256( "{id}.{timestamp}.{rawBody}", secret )>
```

The receiver MUST: (a) verify the HMAC against the **raw** body, (b) reject if `webhook-timestamp` is outside a tolerance window (e.g. ±5 min) to stop replays, and (c) treat `webhook-id` as the idempotency key (§3). cf-mail signs both its per-mailbox and legacy global webhooks this way (`AGENT_WEBHOOK_SECRET`).

### 4.3 Delivery semantics

At-least-once, unordered, idempotent by `id`. The webhook handler should be fast and return 2xx on accept; do real work asynchronously.

### 4.4 Retry, dead-letter, escalation

- Non-2xx or timeout → retry with backoff, up to `maxAttempts`.
- After `maxAttempts`, the message is marked `failed` and **escalated to a human** (notify a configured human mailbox/device) so a lost agent never silently drops mail.
- Retries do not block ingestion or other messages.

### 4.5 Pull API (catch-up / fallback)

```
GET /api/agent/<mailbox>/inbox?state=open&since=<cursor>
```

Returns open (unacked) messages in the same payload shape, with a cursor for incremental polling. This is the safety net under the webhook.

### 4.6 Transport

AMP defines the *event and its semantics* (`mail.received`, the payload, the trust split, idempotency) at the protocol layer. The canonical transport is the **signed webhook** (§4.2) with the **pull API** (§4.5) as its always-available fallback. That pair is the whole protocol-level surface.

How a specific agent prefers to *consume* the event — a held WebSocket, or the mailbox exposed as MCP tools — is an **application-layer binding, out of scope for v0.1**. Those can be specified later if a real need appears; they would reuse the same payload, ack, idempotency, and trust rules unchanged. The protocol does not depend on them.

## 5. Acknowledgement & state machine

```
received ──webhook──▶ delivered ──ack──▶ handled
   │                     │                  ├─ done
   │                     │                  ├─ escalated  (handed to a human)
   │                     │                  └─ rejected   (ignored on purpose)
   │                     └─ unacked past T ──▶ redeliver (bounded) ─▶ failed
   └─ webhook failed maxAttempts ──────────────────────────────────▶ failed ──▶ escalate
```

Ack:

```
POST /api/agent/<mailbox>/ack
{ "id": "9f2c…", "result": "done" | "escalated" | "rejected", "note": "…optional…" }
```

- An unacked message past timeout `T` is redelivered (bounded count); this is why the agent MUST be idempotent.
- Agent state is **separate from human read/archived state**, so a human and an agent can share visibility of the same store without trampling each other. (For an `agent` mailbox there is no human reader, but the separation matters when mail is escalated into a human mailbox.)

## 6. Trust & safety (the agent-specific core)

*(Derives from A1 and A3: mail is buffered data and is never, by itself, a command. This section is where those two axioms become enforceable structure.)*

**Threat model: the lethal trifecta.** Simon Willison's framing (June 2025) is that an agent is exploitable when three things coexist: *access to private data*, *exposure to untrusted content*, and *the ability to communicate externally*. Email hands an agent all three at once, which is exactly why naive "agent email" is dangerous — EchoLeak (CVE-2025-32711) was a single email that walked Microsoft Copilot into exfiltrating internal files, zero-click. AMP is designed to **break the trifecta on two of its three legs**: §6 fences untrusted content so it can't become instructions, and §2.1's outbound allowlist bounds external communication so a hijacked agent has nowhere to send. (The consensus defense in the literature is precisely this — *allowlists, not blocklists*, and constraining the exfiltration channel.)

A human reading mail applies judgement automatically. An agent will treat whatever it reads as input to its reasoning — so mail body is a **prompt-injection vector** by definition. AMP makes the boundary structural rather than advisory:

1. **`meta` is system-asserted and trustworthy** (who/when, DKIM/SPF results, known-contact, correlation). It is computed by the mail system, not the sender.
2. **`untrusted` is sender-controlled and is DATA, never instructions.** Subject, body, attachments live here. The name is the contract.
3. **Iron rule: mail content MUST NOT be able to trigger a privileged action.** Anything consequential (spending, deleting, sending on the user's behalf, changing config) requires an out-of-band authorization — an allowlist of senders **plus** a separately verified signal — not merely a sentence in an email body.

**Receive ≠ read ≠ act (the A1 separation).** These are three distinct steps and a safe implementation keeps them distinct: **receiving** writes the message to the buffer (automatic, no reasoning involved); **reading** is the agent choosing to pull a message in as input, carrying its `meta.trust` with it; **acting** is the agent deciding what — if anything — to do, and is *always* a separate judgement that user rules (§11.2) can gate. The buffer is never auto-executed: a message arriving does not feed a model, and a message read does not authorize an action. The trust signals below modulate *reading*; they never authorize *acting*.

Trust signals an implementation SHOULD surface in `meta.trust`:

- `dkimPass`, `spfPass` — was the sender domain authenticated.
- `knownContact` — is the sender a saved (non-blocked) contact.
- `firstContact` — first time this address has written to this mailbox.
- `isReplyToAgent` — is this a reply to a message the agent itself sent (high-trust, because the agent initiated the thread).

An agent SHOULD downgrade its handling as trust drops: a reply to its own request from a known contact with DKIM pass is the strongest; a first-contact, DKIM-fail, unknown sender is to be treated as pure untrusted data and never as a directive.

## 7. Correlation (request / reply)

To tie a reply back to the request that caused it, AMP uses **`Reply-To` plus-addressing** as the spine:

- When an agent sends, it MAY mint a correlation id and set `Reply-To: <mailbox>+<corrId>@<domain>`.
- A human or service replying naturally sends to that address. The receive layer folds the plus-address to the base mailbox, extracts `<corrId>`, and surfaces it as `meta.correlationId`.

This is chosen over custom headers (humans' clients strip them) and over bare `References` threading (breaks on forward/compose-new). The `Reply-To` address survives the human in the loop because it *is* where the reply goes.

`meta.isReplyToAgent` is set when `inReplyTo`/`references` match a message the agent sent, even when no `correlationId` is present.

## 8. Outbound (agent → world)

```
POST /api/agent/<mailbox>/send
{ "to": "alice@example.com", "subject": "deploy approval",
  "text": "Reply 'go ahead' to approve.", "correlationId": "task123",
  "idempotencyKey": "send-task123-1", "attachments": [...] }
```

- `from` is fixed to the agent's own mailbox; the system signs DKIM.
- **Every recipient (`to`/`cc`/`bcc`) is checked against the outbound allowlist (§2.1) before the message leaves.** A disallowed recipient fails the whole send — this is the egress half of the agent's bounded-correspondents guarantee.
- `idempotencyKey` dedupes retries so a flaky agent never double-sends.
- `correlationId` (optional, default on) sets the `Reply-To` plus-address per §7.
- Attachments (≤5 MiB total) double as a structured data channel — an agent can exchange a JSON document by attaching it.

## 9. Human ↔ agent handoff

Both directions are first-class:

- **Human → agent (delegate):** a person forwards a message to the agent's address. It arrives as normal inbound; `meta.knownContact` will be true for the forwarder.
- **Agent → human (escalate):** the agent acks with `result: "escalated"`, which re-routes the message (with the agent's context note) into a configured human mailbox and notifies the person — "your agent needs you."

## 10. Identity & scoping

One agent = one mailbox = one webhook + one **address-scoped token**. The token can only send-as and read its own mailbox — a leaked agent token cannot read other mailboxes, cannot send as other addresses, and cannot mint new tokens. Least privilege is the default, not an option.

## 11. Using the mailbox as a tool

The wire protocol above is how mail moves. This section is how an agent *uses* the mailbox as a tool it reasons with — three things that the protocol layer does not cover but that decide whether the mailbox is usable and safe in practice.

### 11.1 Self-describing tool surface

When the mailbox is handed to an agent, each operation MUST carry an explicit, effective description: what it does, when to use it, its parameters, and — crucially — the constraints baked in. *"Send: delivers a message; recipients are restricted to this mailbox's allowlist; a disallowed recipient fails the whole call"* is a better tool description than *"send an email,"* because it shapes the agent's behaviour up front instead of only failing it after the fact.

The mailbox SHOULD expose a manifest the agent can read to understand its own boundaries:

```
GET /api/agent/<mailbox>/manifest
{
  "address": "agent@example.com",
  "purpose": "deploy approvals and status digests for the owner",
  "operations": [ { "name": "send", "description": "…", "constraints": ["recipients allowlisted", "≤5MiB attachments"] }, … ],
  "outboundAllowed": ["owner@example.com"],          // or a redacted hint when the list is private
  "scopes": ["mail:send@self", "mail:read@self"],
  "rules": [ … see 11.2 … ],
  "limits": { "perMessageRecipients": 50, "monthlyQuota": 3000 }
}
```

Two principles, both required, neither replacing the other: the tool **declares its constraints** (so a well-behaved agent never even attempts what would be refused), and the system **enforces them anyway** (so a misbehaving or hijacked agent cannot cross them).

### 11.2 User rules (the owner's policy)

The owner declares rules that govern how the agent uses the mailbox. They come in two kinds, and the distinction is load-bearing:

- **Hard rules — system-enforced, never trusted to the agent.** The recipient allowlist (§2.1), scopes (§10), quotas. Checked at the boundary; the agent literally cannot violate them.
- **Soft rules — declared policy the agent is expected to follow.** e.g. "summarise before forwarding," "ask me before replying to a first-time sender," "auto-handle service receipts but escalate anything from a person," tone, quiet hours. Behavioural; surfaced to the agent (via the manifest / its context) so they shape its judgement.

Both live in one place — a per-mailbox policy the owner edits — and the manifest exposes them to the agent. The security-relevant subset is *also* compiled into hard enforcement. A soft rule that turns out to be security-critical should be promoted to a hard rule over time.

### 11.3 Agent-friendly observability

Human mail observability answers "did I read it." Agent observability must answer "what did the agent (and the system) **do**, and **why**" — for the agent itself, for the supervising human, and for another agent watching. It must be **structured and efficient**, not a UI to eyeball.

The mailbox exposes an append-only **event log**, queryable by cursor / filter / correlation:

```
GET /api/agent/<mailbox>/events?since=<cursor>&correlationId=<id>
```

Every consequential moment is one structured event with a **reason code**:

- `received` · `rejected{reason: not_allowlisted | blocked | mailbox_inactive}`
- `delivered` · `delivery_failed{attempt, reason}`
- `handled{result: done | escalated | rejected}`
- `sent` · `send_refused{reason: recipient_not_allowed | over_quota | bad_request}`
- `escalated{to}`

Two properties make it agent-friendly. **Reason codes close the loop:** when a hard rule blocks something — a send refused, an inbound rejected — the agent and the user get a machine-readable *why*, never silence. **Correlation tags** let you pull a whole task's mail activity in one query. Efficiency is first-class: compact JSON, cursors, server-side filtering, so a supervising loop can poll the trail cheaply. The same events, rendered, are the human's "what is my agent doing" view.

## 12. Versioning

Every payload carries `schemaVersion`. Evolution is **additive only** within a major version; consumers ignore unknown fields. The mail system and the agent iterate independently, so the wire format must tolerate version skew in both directions.

## 13. Open questions (v0.1)

1. **Redelivery on unacked timeout** — bounded auto-redeliver (requires agent idempotency, which AMP already mandates) vs. pull-only recovery. Leaning auto-redeliver.
2. **Trust granularity** — expose the four booleans and let the agent combine them, vs. also precomputing a single `trustLevel: trusted|known|unknown`. Leaning "both: booleans + a derived convenience level."
3. **Escalation routing** — a single configured human mailbox per agent, vs. a policy (different escalation targets per task type).
4. **Rejection mode for disallowed senders** (§2.1) — SMTP `550` bounce (informative, but confirms the address exists) vs. silent drop (stealthier, but a legit-unlisted sender gets no signal). Leaning `550` to match cf-mail's existing behaviour, with silent-drop as a per-mailbox option.
5. **Dynamic reply-grant TTL & scope** (§2.1) — how long an outbound keeps the reply door open, and whether one outbound admits only the addressed recipient or anyone replying on that thread. Leaning short TTL (days) + single-correspondent.

**Settled in v0.1** (confirmed): correlation via `Reply-To` plus-addressing (§7); the `meta`/`untrusted` trust split with the "content is data, never commands" rule (§6); push-hint + durable-store-queue + ack with agent-side idempotency (§3); per-agent address-scoped tokens (§10); **agent mailboxes are bounded-correspondent / default-deny in both directions — allowlisted senders *and* recipients (§2.1)**.

## Appendix A — canonical flows

**Notification (fire-and-forget):** agent `send` → done. No correlation needed.

**Approval loop (human in the loop):** agent `send` with `correlationId` and `Reply-To: bot+task@` → human replies "go ahead" → inbound webhook carries `meta.correlationId=task`, `meta.isReplyToAgent=true` → agent matches, acts, acks `done`.

**Inbound service event:** a service emails a receipt/alert to the agent address → webhook with `meta.knownContact` (if the service is saved) → agent parses `untrusted.body` as data, never as a command → acks `done`.

## Appendix B — implementation status in cf-mail (v0.1)

| AMP feature | cf-mail today |
|---|---|
| Persisted store as queue (D1) | ✅ |
| `meta` / `untrusted` split, full `trust` block (§6) persisted per message | ✅ |
| `kind: human \| agent` per mailbox | ✅ |
| Bounded correspondents — inbound **and** outbound allowlist + dynamic reply-grants, default-deny | ✅ (inbound enforced at SMTP `550`; outbound refused before the send binding fires) |
| Per-mailbox webhook + address-scoped token | ✅ (`addresses.agent_webhook_url`; `agent-token` shown once, stored hashed) |
| Webhook signature | ✅ Standard Webhooks (`webhook-id`/`webhook-timestamp`/`webhook-signature`) on both the per-mailbox and the legacy global hook |
| Ack + state machine (`received → delivered → handled/failed`) | ✅ |
| Pull API (`/api/agent/<box>/inbox?state=open`) | ✅ |
| Self-describing manifest (§11.1) | ✅ (`/api/agent/<box>/manifest`) |
| Escalation (`agent → human`) | ✅ (`ack {result:"escalated"}` → device push; structured routing config deferred) |
| Agent observability — event log + reason codes (§11.3) | ✅ (`mail_event` + `/api/agent/<box>/events`) |
| User rules — hard (enforced) + soft (declared) (§11.2) | ⚠️ hard rules = the allowlist/scopes; declared soft rules deferred |
| Correlation via `Reply-To` plus-addressing (§7) | ⚠️ plus-addr corrId folds on receive; reply-grants + reference matching admit replies. Blocked: the send binding exposes no `Reply-To` / `Message-ID` |
| Cron redelivery + dead-letter sweep (§4.4) | ⛔ deferred (the pull API is the fallback) |

The security core (§2.1 / §3 / §6 / §10) ships in this repo; the remaining ⚠️/⛔ rows are additive and don't change the wire contract. The pure decision functions live in [`src/agent.ts`](../src/agent.ts) and are unit-tested ([`test/agent.test.ts`](../test/agent.test.ts)).

**Second implementation.** [xtblog](https://xtxt.top) (the author's site, same Cloudflare substrate but on Drizzle/D1) implements nearly the whole protocol as of 2026-06. The v0.1 core: `kind:agent` mailboxes, bounded correspondents in both directions with dynamic reply-grants (default-deny, enforced at the SMTP boundary inbound and the send API outbound), per-mailbox address-scoped tokens, the full trust block persisted per message, the `received→delivered→handled/failed` ack state machine, a pull API, and an append-only event log with reason codes. Then v0.2 added the tool layer and hardening: the self-describing manifest (§11.1), hard+soft user rules (§11.2), human-mailbox escalation routing (§9), `trustLevel` (§13.2), per-mailbox reject mode (§13.4), a cron-driven redelivery + dead-letter sweep (§4.4), and Standard Webhooks signing (§4.2). The **one part it cannot do** is §7 `Reply-To` plus-addressing: Cloudflare's Email Service send binding exposes no `Reply-To` and returns no `Message-ID`, so correlation stays reference/grant-based until raw-MIME sending is viable. Two independent implementations converging on the same wire contract is the point of writing it as a protocol.

## Appendix C — prior art & influences

AMP is not invented in a vacuum. What we looked at and what we took:

- **[AgentMail](https://www.agentmail.to/)** (YC S25) — the closest prior art: API-first inboxes for agents, webhooks **and** websockets, threading/labels/search/drafts, an MCP server, auto DKIM/SPF/DMARC, webhook signing. Validates the category. Its WebSocket/MCP transports are noted as future application-layer bindings (§4.6), deliberately out of v0.1. We diverge on two things: AgentMail is a hosted SaaS, AMP/cf-mail is **self-hosted on your own Cloudflare** (data sovereignty); and AgentMail uses a *suppression list* (blocklist), whereas AMP makes **bounded correspondents / default-deny both directions** the defining property of an agent mailbox (§2.1) — a stronger posture for the single-purpose agent.
- **The Lethal Trifecta** (Simon Willison, 2025) + **OWASP LLM Top 10** (prompt injection #1) + **EchoLeak / CVE-2025-32711** — the threat model §6 and §2.1 are built to counter; "allowlists, not blocklists" is taken directly from this body of work.
- **[Standard Webhooks](https://www.standardwebhooks.com/)** — adopted wholesale for webhook signing (§4.2): id + timestamp + body HMAC, replay protection, off-the-shelf verifiers.
- **Google A2A** (agent-to-agent) — adjacent, not overlapping: A2A is how agents talk to *each other*; AMP is how an agent talks to the *outside world* through email. Complementary.
- **LangChain Agent Inbox** — a human-in-the-loop UX where a person approves agent actions; informs AMP's human↔agent handoff/escalation (§9), though AMP's "inbox" is real email, not an action queue.
