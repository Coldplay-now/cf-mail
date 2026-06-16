// Thin D1 helpers for agent mailboxes — the database side of src/agent.ts.
// Kept tiny and reused from receive / send / the agent API so the allowlist,
// grant and event semantics live in exactly one place.

import type { Env } from "./env";

export const GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AddressRow {
  id: string;
  address: string;
  display_name: string | null;
  active: number;
  forward_to: string | null;
  kind: string;
  agent_webhook_url: string | null;
  agent_purpose: string | null;
  agent_rules: string | null;
  agent_token_hash: string | null;
}

/** Split stored soft rules (one per line) into a trimmed, non-empty list. */
export function parseRules(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
}

/** Resolve a mailbox by local part (base, plus-addressing already folded). */
export async function getAddress(env: Env, local: string): Promise<AddressRow | null> {
  return env.DB.prepare("SELECT * FROM addresses WHERE address = ?")
    .bind(local.toLowerCase())
    .first<AddressRow>();
}

/** Allowlist patterns for one direction. */
export async function listAllow(env: Env, mailboxId: string, direction: "in" | "out"): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT pattern FROM mail_allow WHERE mailbox_id = ? AND direction = ?"
  )
    .bind(mailboxId, direction)
    .all<{ pattern: string }>();
  return rows.results.map((r) => r.pattern);
}

/** Correspondents of live (non-expired) reply-grants. */
export async function liveGrants(env: Env, mailboxId: string, nowMs: number): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT correspondent FROM mail_grant WHERE mailbox_id = ? AND expires_at > ?"
  )
    .bind(mailboxId, nowMs)
    .all<{ correspondent: string }>();
  return rows.results.map((r) => r.correspondent);
}

/** Mint a time-boxed inbound reply-grant for a correspondent. */
export async function mintGrant(
  env: Env,
  opts: { mailboxId: string; correspondent: string; correlationId: string | null; expiresAt: number }
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO mail_grant (id, mailbox_id, correspondent, correlation_id, expires_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), opts.mailboxId, opts.correspondent.toLowerCase(), opts.correlationId, opts.expiresAt)
    .run();
}

/** A stored mail row, snake_case as it comes back from D1 (SELECT *). */
export interface MailRecord {
  id: string;
  agent_state: string | null;
  from_addr: string;
  from_name: string | null;
  to_addr: string;
  cc_addr: string | null;
  subject: string | null;
  text_body: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  correlation_id: string | null;
  agent_trust: string | null;
  attachments: string | null;
  created_at: string;
}

/**
 * Shape a stored agent mail into the AMP §4.1 payload: `meta` is system-asserted
 * (trusted), `untrusted` is sender-controlled. The split is structural so an
 * agent can't confuse "what the system knows" with "what the sender said" (A3).
 */
export function payloadFromRow(row: MailRecord) {
  const local = row.to_addr.split("@")[0]?.split("+")[0] ?? null;
  const attachments = row.attachments
    ? (JSON.parse(row.attachments) as { key: string; filename: string; mime: string; size: number }[]).map(
        ({ key, filename, mime, size }) => ({ key, filename, mime, size })
      )
    : [];
  return {
    schemaVersion: 1 as const,
    id: row.id,
    mailbox: local,
    state: row.agent_state,
    meta: {
      from: row.from_addr,
      fromName: row.from_name,
      to: row.to_addr,
      cc: row.cc_addr,
      receivedAt: row.created_at,
      messageId: row.message_id,
      inReplyTo: row.in_reply_to,
      correlationId: row.correlation_id,
      trust: row.agent_trust ? JSON.parse(row.agent_trust) : null
    },
    untrusted: {
      subject: row.subject,
      body: row.text_body,
      attachments
    }
  };
}

/** Append a reason-coded event to the log. Best-effort; never throws to caller. */
export async function logEvent(
  env: Env,
  opts: {
    mailboxId: string;
    mailId?: string | null;
    type: string;
    reason?: string | null;
    correlationId?: string | null;
    detail?: unknown;
  }
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO mail_event (id, mailbox_id, mail_id, type, reason, correlation_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        opts.mailboxId,
        opts.mailId ?? null,
        opts.type,
        opts.reason ?? null,
        opts.correlationId ?? null,
        opts.detail === undefined ? null : JSON.stringify(opts.detail)
      )
      .run();
  } catch (error) {
    console.error("mail_event insert failed", error);
  }
}
