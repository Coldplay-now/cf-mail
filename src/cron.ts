import type { Env } from "./env";
import { type MailRecord, getAddress, logEvent, payloadFromRow } from "./agent-db";
import { postSignedWebhook } from "./webhook";
import { escalateToHuman } from "./escalate";

// Scheduled sweep (AMP §4.4): redeliver agent mail whose webhook push hasn't
// landed yet, dead-letter (→ escalate to the human) once attempts are exhausted,
// and keep the event log / grant table from growing without bound. The pull API
// is always the fallback, so this only matters for push-driven agents.

const MAX_DELIVERY_ATTEMPTS = 5;
const REDELIVER_BATCH = 50;
const EVENT_RETENTION_DAYS = 30;

type UndeliveredRow = MailRecord & { delivery_attempts: number };

export async function runScheduled(env: Env): Promise<void> {
  await redeliverAgentMail(env);
  await expireGrants(env);
  await pruneEvents(env);
}

async function redeliverAgentMail(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT * FROM mails
     WHERE direction='in' AND agent_state='received' AND delivery_attempts < ?
     ORDER BY created_at ASC LIMIT ?`
  )
    .bind(MAX_DELIVERY_ATTEMPTS, REDELIVER_BATCH)
    .all<UndeliveredRow>();
  if (!rows.results.length) return;

  const boxCache = new Map<string, Awaited<ReturnType<typeof getAddress>>>();
  const now = Math.floor(Date.now() / 1000);

  for (const row of rows.results) {
    const baseLocal = row.to_addr.split("@")[0]?.split("+")[0] ?? "";
    if (!boxCache.has(baseLocal)) boxCache.set(baseLocal, await getAddress(env, baseLocal));
    const box = boxCache.get(baseLocal);
    if (!box || box.kind !== "agent") continue;
    // No webhook configured → pull-only mailbox; leave it for the agent to fetch.
    if (!box.agent_webhook_url) continue;

    const ok = await postSignedWebhook(
      box.agent_webhook_url,
      row.id,
      { event: "mail.received", ...payloadFromRow(row) },
      env.AGENT_WEBHOOK_SECRET,
      now
    );
    const attempts = (row.delivery_attempts ?? 0) + 1;

    if (ok) {
      await env.DB.prepare("UPDATE mails SET agent_state='delivered', delivery_attempts=? WHERE id=?")
        .bind(attempts, row.id)
        .run();
      await logEvent(env, {
        mailboxId: box.id,
        mailId: row.id,
        type: "delivered",
        correlationId: row.correlation_id,
        detail: { redelivered: true, attempts }
      });
      continue;
    }

    await env.DB.prepare("UPDATE mails SET delivery_attempts=? WHERE id=?").bind(attempts, row.id).run();
    await logEvent(env, {
      mailboxId: box.id,
      mailId: row.id,
      type: "delivery_failed",
      correlationId: row.correlation_id,
      detail: { attempts }
    });

    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      // Dead-letter: stop retrying, escalate to the human owner.
      await env.DB.prepare("UPDATE mails SET agent_state='failed', agent_result='escalated' WHERE id=?")
        .bind(row.id)
        .run();
      await logEvent(env, {
        mailboxId: box.id,
        mailId: row.id,
        type: "dead_letter",
        reason: "max_delivery_attempts",
        correlationId: row.correlation_id
      });
      await escalateToHuman(env, {
        mailboxId: box.id,
        mail: row,
        note: `Agent webhook was undeliverable after ${attempts} attempts.`
      });
    }
  }
}

async function expireGrants(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM mail_grant WHERE expires_at < ?").bind(Date.now()).run();
}

async function pruneEvents(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM mail_event WHERE created_at < datetime('now', ?)`)
    .bind(`-${EVENT_RETENTION_DAYS} days`)
    .run();
}
