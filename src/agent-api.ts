// Agent-facing API: /api/agent/<mailbox>/{manifest,inbox,ack,send,events}.
// Authenticated PER MAILBOX — a bound agent token (addresses.agent_token_hash)
// can only ever reach its own mailbox; the operator's global AUTH_TOKEN is also
// accepted (admin override). This is the AMP consumer surface; the pull API
// (inbox/events) is always available even when no webhook is configured.

import { type Env, authorized, json } from "./env";
import { sha256Hex } from "./webhook";
import { buildManifest, canAck, isAckResult } from "./agent";
import { type AddressRow, getAddress, listAllow, logEvent, payloadFromRow } from "./agent-db";
import { type MailRecord } from "./agent-db";
import { SendError, parseSendRequest, sendMail } from "./send";
import { escalateToHuman } from "./escalate";

const PER_PAGE = 50;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Resolve + authorize the mailbox named in the path. Returns the agent address
// row, or a ready Response (401/403/404) to short-circuit.
async function requireAgentMailbox(
  request: Request,
  env: Env,
  local: string
): Promise<{ box: AddressRow } | { response: Response }> {
  const box = await getAddress(env, local);
  if (!box || box.kind !== "agent" || !box.active) {
    return { response: json({ error: "agent mailbox not found" }, 404) };
  }
  // operator global token → full access
  if (await authorized(request, env)) return { box };
  // otherwise require the mailbox-bound agent token
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!given || !box.agent_token_hash) return { response: json({ error: "unauthorized" }, 401) };
  if (!constantTimeEqual(await sha256Hex(given), box.agent_token_hash)) {
    return { response: json({ error: "unauthorized" }, 401) };
  }
  return { box };
}

// LIKE patterns matching this mailbox's addresses (base@ and base+plus@).
const mailboxLikes = (local: string, domain: string): [string, string] => [
  `${local}@${domain}`,
  `${local}+%@${domain}`
];

export async function handleAgentApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // /api/agent/<mailbox>/<op>
  const m = url.pathname.match(/^\/api\/agent\/([^/]+)\/([^/]+)$/);
  if (!m) return json({ error: "not found" }, 404);
  const local = decodeURIComponent(m[1]).toLowerCase();
  const op = m[2];
  const method = request.method;

  const auth = await requireAgentMailbox(request, env, local);
  if ("response" in auth) return auth.response;
  const { box } = auth;

  // ---- manifest (§11.1) ----
  if (op === "manifest" && method === "GET") {
    const [inAllow, outAllow] = await Promise.all([listAllow(env, box.id, "in"), listAllow(env, box.id, "out")]);
    return json(
      buildManifest({
        address: `${box.address}@${env.MAIL_DOMAIN}`,
        purpose: box.agent_purpose,
        inAllow,
        outAllow
      })
    );
  }

  // ---- inbox (pull API, §4.5) ----
  if (op === "inbox" && method === "GET") {
    const state = url.searchParams.get("state") === "all" ? "all" : "open";
    const since = url.searchParams.get("since");
    const [likeBase, likePlus] = mailboxLikes(box.address, env.MAIL_DOMAIN);
    let where =
      "direction='in' AND (to_addr = ? OR to_addr LIKE ?) AND agent_state IS NOT NULL";
    const binds: unknown[] = [likeBase, likePlus];
    if (state === "open") where += " AND agent_state IN ('received','delivered')";
    if (since) {
      where += " AND created_at > ?";
      binds.push(since);
    }
    const rows = await env.DB.prepare(
      `SELECT * FROM mails WHERE ${where} ORDER BY created_at ASC LIMIT ?`
    )
      .bind(...binds, PER_PAGE)
      .all<MailRecord>();
    const items = rows.results.map(payloadFromRow);
    const cursor = rows.results.length ? rows.results[rows.results.length - 1].created_at : since ?? null;
    return json({ items, cursor });
  }

  // ---- ack (§5) ----
  if (op === "ack" && method === "POST") {
    const body = (await request.json()) as { id?: string; result?: string; note?: string };
    if (!body.id || !isAckResult(body.result)) return json({ error: "id and a valid result are required" }, 400);
    const [likeBase, likePlus] = mailboxLikes(box.address, env.MAIL_DOMAIN);
    const mail = await env.DB.prepare(
      "SELECT * FROM mails WHERE id = ? AND (to_addr = ? OR to_addr LIKE ?)"
    )
      .bind(body.id, likeBase, likePlus)
      .first<MailRecord>();
    if (!mail) return json({ error: "mail not found in this mailbox" }, 404);
    if (!canAck(mail.agent_state)) return json({ error: `mail is not open (state=${mail.agent_state})` }, 409);

    await env.DB.prepare("UPDATE mails SET agent_state = 'handled', agent_result = ? WHERE id = ?")
      .bind(body.result, body.id)
      .run();
    await logEvent(env, {
      mailboxId: box.id,
      mailId: body.id,
      type: "handled",
      reason: body.result,
      correlationId: mail.correlation_id,
      detail: body.note ? { note: body.note } : undefined
    });

    // Escalation re-surfaces the mail to the human owner (inbox row + push).
    if (body.result === "escalated") {
      await escalateToHuman(env, { mailboxId: box.id, mail, note: body.note ?? null });
    }
    return json({ ok: true });
  }

  // ---- send (enforced; A2 egress lives in sendMail) ----
  if (op === "send" && method === "POST") {
    try {
      const input = await parseSendRequest(request);
      input.from = box.address; // force sender to this mailbox
      const result = await sendMail(env, input);
      if (result.status === "failed") return json({ error: `send failed: ${result.error}`, id: result.id }, 502);
      return json({ ok: true, id: result.id, deduped: result.deduped ?? false });
    } catch (error) {
      if (error instanceof SendError) return json({ error: error.message, detail: error.detail }, error.status);
      throw error;
    }
  }

  // ---- events (the trace log) ----
  if (op === "events" && method === "GET") {
    const since = url.searchParams.get("since");
    const correlationId = url.searchParams.get("correlationId");
    const type = url.searchParams.get("type");
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    let where = "mailbox_id = ?";
    const binds: unknown[] = [box.id];
    if (correlationId) {
      where += " AND correlation_id = ?";
      binds.push(correlationId);
    }
    if (type) {
      where += " AND type = ?";
      binds.push(type);
    }
    if (since) {
      where += " AND created_at < ?";
      binds.push(since);
    }
    interface EventRow {
      id: string;
      mail_id: string | null;
      type: string;
      reason: string | null;
      correlation_id: string | null;
      detail: string | null;
      created_at: string;
    }
    const rows = await env.DB.prepare(
      `SELECT id, mail_id, type, reason, correlation_id, detail, created_at
       FROM mail_event WHERE ${where} ORDER BY created_at DESC LIMIT ?`
    )
      .bind(...binds, limit)
      .all<EventRow>();
    const items = rows.results.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
    const cursor = items.length ? items[items.length - 1].created_at : since ?? null;
    return json({ items, cursor });
  }

  return json({ error: "not found" }, 404);
}
