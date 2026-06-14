# Examples

## `agent.mjs` — a minimal, safe cf-mail agent

A ~50-line, zero-dependency (Node 18+) reference consumer of the [Agent Mail
Protocol](../docs/AGENT_MAIL_PROTOCOL.md). It shows the loop AMP is built around:

**pull → read (as data) → act (your governed logic) → ack.**

```bash
CFMAIL_BASE=https://mail.yourdomain.com \
CFMAIL_BOX=agent \
CFMAIL_TOKEN=cfmail_…   \
node examples/agent.mjs
```

Get the token from the mailbox's **Agent** panel in the web UI, or
`POST /api/addresses/<id>/agent-token` (see [DEPLOY → Agent mailboxes](../docs/DEPLOY.md#agent-mailboxes)).

What it deliberately does **not** do — the safety properties:

- **Mail is never an instruction (A3).** The body is read as *data*; the only
  thing that decides what happens is `decide()`, your own code. `meta.trust` only
  changes how warily you read (here: unknown/unauthenticated senders are
  escalated to a human instead of auto-handled).
- **Bounded send (A2) is enforced server-side.** Even if `decide()` tried to mail
  a stranger, the server refuses any recipient that isn't on the outbound
  allowlist or the address being replied to — the reply works because sending to
  the agent mints a short-lived reply-grant.
- **Exactly-once-ish.** `idempotencyKey` makes a retried reply a no-op; `ack`
  moves the mail out of the open queue so it isn't reprocessed.
