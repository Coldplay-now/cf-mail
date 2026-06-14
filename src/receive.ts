import PostalMime from "postal-mime";
import { type Env, snippetOf, threadKeyOf } from "./env";
import { notifyDevices } from "./push";
import { standardWebhookHeaders } from "./webhook";
import {
  correlationFromLocalPart,
  deriveTrust,
  inboundAdmit,
  matchAllow
} from "./agent";
import {
  type MailRecord,
  type AddressRow,
  liveGrants,
  listAllow,
  logEvent,
  payloadFromRow
} from "./agent-db";

// Receiving pipeline. Email Routing's catch-all hands every message for the
// domain to this worker:
//   1. look up the local part in `addresses` — unknown/inactive → SMTP reject
//      (550), so mailbox management is pure CRUD and spray spam dies at the
//      door; plus-addressing folds (dev+x@ delivers to dev@);
//   2. AGENT mailboxes (kind='agent') are default-deny (A2): the sender must be
//      on the inbound allowlist, hold a live reply-grant, or be replying to the
//      agent — else 550 before anything is stored. Admitted agent mail is
//      buffered with agent_state='received', a trust block (§6), and delivered
//      to the mailbox webhook; it never pushes to humans or forwards.
//   3. HUMAN mailboxes keep the original behavior: store, optional forward,
//      device push, optional legacy global agent webhook.
// If anything throws, the sender's MTA gets a transient failure and retries —
// mail is delayed, not lost.

interface InboundEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string): Promise<void>;
}

const safeName = (name: string) => name.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "attachment";

export async function receiveEmail(message: InboundEmailMessage, env: Env): Promise<void> {
  const toAddr = message.to.toLowerCase();
  const localPart = toAddr.split("@")[0] ?? "";
  const baseLocal = localPart.split("+")[0];

  const box = await env.DB.prepare("SELECT * FROM addresses WHERE address = ?")
    .bind(baseLocal)
    .first<AddressRow>();
  if (!box || !box.active) {
    message.setReject("550 5.1.1 mailbox unavailable");
    return;
  }

  const parsed = await PostalMime.parse(message.raw);
  const id = crypto.randomUUID();
  const fromAddr = (parsed.from?.address || message.from).toLowerCase();
  const authResults =
    parsed.headers?.find((h) => h.key.toLowerCase() === "authentication-results")?.value ?? "";

  // ---------- AGENT mailbox: default-deny admission, buffer, deliver ----------
  if (box.kind === "agent") {
    await receiveAgentMail(message, env, { box, parsed, id, fromAddr, toAddr, baseLocal, localPart, authResults });
    return;
  }

  // ---------------------------- HUMAN mailbox --------------------------------
  const blocked = await env.DB.prepare("SELECT 1 FROM contacts WHERE address = ? AND blocked = 1")
    .bind(fromAddr)
    .first();

  const ccAddr = otherRecipients(parsed, toAddr);
  const attachments = await storeAttachments(env, parsed, id);

  await env.DB.prepare(
    `INSERT INTO mails (id, direction, status, message_id, in_reply_to, refs, thread_key,
       from_addr, from_name, to_addr, cc_addr, subject, text_body, html_body, snippet,
       attachments, read, spam)
     VALUES (?, 'in', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      parsed.messageId ?? null,
      parsed.inReplyTo ?? null,
      parsed.references ?? null,
      threadKeyOf(parsed.references, parsed.messageId),
      fromAddr,
      parsed.from?.name || null,
      toAddr,
      ccAddr,
      parsed.subject ?? null,
      parsed.text ?? null,
      parsed.html ?? null,
      snippetOf(parsed.text, parsed.html),
      attachments.length ? JSON.stringify(attachments) : null,
      blocked ? 1 : 0,
      blocked ? 1 : 0
    )
    .run();

  if (box.forward_to && !blocked) {
    try {
      await message.forward(box.forward_to);
    } catch (error) {
      // Unverified destination or transient relay error — the message is
      // already stored; never bounce over the courtesy copy.
      console.error(`forward to ${box.forward_to} failed`, error);
    }
  }

  if (!blocked) {
    await notifyDevices(env, {
      id,
      fromName: parsed.from?.name || null,
      fromAddr,
      subject: parsed.subject ?? null,
      snippet: snippetOf(parsed.text, parsed.html)
    });
    await notifyGlobalWebhook(env, {
      id,
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references: parsed.references ?? null,
      from: { address: fromAddr, name: parsed.from?.name || null },
      to: toAddr,
      cc: ccAddr,
      subject: parsed.subject ?? null,
      snippet: snippetOf(parsed.text, parsed.html),
      authResults
    });
  }
}

// ---------------------------------------------------------------------------

interface AgentCtx {
  box: AddressRow;
  parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  id: string;
  fromAddr: string;
  toAddr: string;
  baseLocal: string;
  localPart: string;
  authResults: string;
}

async function receiveAgentMail(message: InboundEmailMessage, env: Env, ctx: AgentCtx): Promise<void> {
  const { box, parsed, id, fromAddr, toAddr, baseLocal, localPart, authResults } = ctx;
  const now = Date.now();

  const inAllow = await listAllow(env, box.id, "in");
  const grants = await liveGrants(env, box.id, now);
  const isReplyToAgent = await replyToAgent(env, `${baseLocal}@${env.MAIL_DOMAIN}`, parsed);

  // A2: default-deny inbound — reject BEFORE storing anything.
  if (!inboundAdmit({ sender: fromAddr, inAllow, grants, isReplyToAgent })) {
    message.setReject("550 5.7.1 sender not permitted");
    await logEvent(env, {
      mailboxId: box.id,
      type: "rejected",
      reason: "not_allowlisted",
      detail: { from: fromAddr }
    });
    return;
  }

  // Admitted. Compute the trust block (§6) — read-modulation only, never authz.
  const known = await env.DB.prepare("SELECT 1 FROM contacts WHERE address = ?").bind(fromAddr).first();
  const prior = await env.DB
    .prepare("SELECT 1 FROM mails WHERE direction='in' AND from_addr = ? AND to_addr LIKE ? LIMIT 1")
    .bind(fromAddr, `${baseLocal}%`)
    .first();
  const trust = deriveTrust({
    authResults,
    knownContact: Boolean(known),
    allowlisted: matchAllow(fromAddr, inAllow),
    firstContact: !prior,
    isReplyToAgent
  });

  const correlationId = correlationFromLocalPart(localPart);
  const ccAddr = otherRecipients(parsed, toAddr);
  const attachments = await storeAttachments(env, parsed, id);

  await env.DB.prepare(
    `INSERT INTO mails (id, direction, status, message_id, in_reply_to, refs, thread_key,
       from_addr, from_name, to_addr, cc_addr, subject, text_body, html_body, snippet,
       attachments, read, agent_state, agent_trust, correlation_id)
     VALUES (?, 'in', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'received', ?, ?)`
  )
    .bind(
      id,
      parsed.messageId ?? null,
      parsed.inReplyTo ?? null,
      parsed.references ?? null,
      threadKeyOf(parsed.references, parsed.messageId),
      fromAddr,
      parsed.from?.name || null,
      toAddr,
      ccAddr,
      parsed.subject ?? null,
      parsed.text ?? null,
      parsed.html ?? null,
      snippetOf(parsed.text, parsed.html),
      attachments.length ? JSON.stringify(attachments) : null,
      JSON.stringify(trust),
      correlationId
    )
    .run();

  await logEvent(env, {
    mailboxId: box.id,
    mailId: id,
    type: "received",
    correlationId,
    detail: { from: fromAddr, trustLevel: trust.trustLevel }
  });

  // Deliver to the mailbox webhook (best-effort; the pull API is the fallback).
  if (box.agent_webhook_url) {
    const row: MailRecord = {
      id,
      agent_state: "received",
      from_addr: fromAddr,
      from_name: parsed.from?.name || null,
      to_addr: toAddr,
      cc_addr: ccAddr,
      subject: parsed.subject ?? null,
      text_body: parsed.text ?? null,
      message_id: parsed.messageId ?? null,
      in_reply_to: parsed.inReplyTo ?? null,
      correlation_id: correlationId,
      agent_trust: JSON.stringify(trust),
      attachments: attachments.length ? JSON.stringify(attachments) : null,
      created_at: new Date(now).toISOString()
    };
    const delivered = await postAgentWebhook(env, box.agent_webhook_url, id, {
      event: "mail.received",
      ...payloadFromRow(row)
    });
    await env.DB.prepare("UPDATE mails SET agent_state = ?, delivery_attempts = delivery_attempts + 1 WHERE id = ?")
      .bind(delivered ? "delivered" : "received", id)
      .run();
    await logEvent(env, {
      mailboxId: box.id,
      mailId: id,
      type: delivered ? "delivered" : "delivery_failed",
      correlationId
    });
  }
  // No device push, no forward: agent mail is not human mail.
}

// Other recipients (for reply-all): to + cc minus the receiving address.
function otherRecipients(parsed: Awaited<ReturnType<typeof PostalMime.parse>>, toAddr: string): string | null {
  return (
    [...(parsed.to ?? []), ...(parsed.cc ?? [])]
      .map((r) => r.address?.toLowerCase())
      .filter((a): a is string => Boolean(a) && a !== toAddr)
      .join(",") || null
  );
}

async function storeAttachments(
  env: Env,
  parsed: Awaited<ReturnType<typeof PostalMime.parse>>,
  id: string
): Promise<{ key: string; filename: string; mime: string; size: number }[]> {
  const attachments: { key: string; filename: string; mime: string; size: number }[] = [];
  for (const [i, att] of (parsed.attachments ?? []).entries()) {
    const filename = safeName(att.filename || `attachment-${i + 1}`);
    const key = `mail/${id}/${i + 1}-${filename}`;
    const body = att.content; // ArrayBuffer | string
    await env.R2.put(key, body, { httpMetadata: { contentType: att.mimeType || "application/octet-stream" } });
    const size = typeof body === "string" ? body.length : body.byteLength;
    attachments.push({ key, filename, mime: att.mimeType || "application/octet-stream", size });
  }
  return attachments;
}

// Is this message a reply to something the agent itself sent? (Reference-based;
// note that Email Service returns no Message-ID for sent mail, so in practice
// replies are admitted via reply-grants — this stays correct if that changes.)
async function replyToAgent(
  env: Env,
  agentAddr: string,
  parsed: Awaited<ReturnType<typeof PostalMime.parse>>
): Promise<boolean> {
  const refIds = `${parsed.inReplyTo ?? ""} ${parsed.references ?? ""}`.split(/\s+/).filter(Boolean);
  if (!refIds.length) return false;
  const placeholders = refIds.map(() => "?").join(",");
  const hit = await env.DB.prepare(
    `SELECT 1 FROM mails WHERE direction='out' AND from_addr = ? AND message_id IN (${placeholders}) LIMIT 1`
  )
    .bind(agentAddr, ...refIds)
    .first();
  return Boolean(hit);
}

// Per-mailbox agent webhook, signed per Standard Webhooks (id + timestamp + body
// HMAC) so off-the-shelf verifiers work and replays are covered.
async function postAgentWebhook(env: Env, url: string, id: string, payload: unknown): Promise<boolean> {
  try {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (env.AGENT_WEBHOOK_SECRET) {
      Object.assign(headers, await standardWebhookHeaders(env.AGENT_WEBHOOK_SECRET, id, body, Math.floor(Date.now() / 1000)));
    }
    const res = await fetch(url, { method: "POST", headers, body });
    return res.ok;
  } catch (error) {
    console.error("agent webhook delivery failed", error);
    return false;
  }
}

// Optional LEGACY global webhook for human mail: a generic "new mail" trigger
// fired for every non-spam human message. Now signed per Standard Webhooks too.
// Per-mailbox agent webhooks (above) are the recommended mechanism for agents.
async function notifyGlobalWebhook(env: Env, p: Record<string, unknown> & { authResults: string }) {
  if (!env.AGENT_WEBHOOK_URL) return;
  try {
    const from = p.from as { address: string };
    const known = await env.DB.prepare("SELECT 1 FROM contacts WHERE address = ?").bind(from.address).first();
    const { authResults, ...rest } = p;
    const id = String(rest.id ?? crypto.randomUUID());
    const body = JSON.stringify({
      event: "mail.received",
      ...rest,
      receivedAt: new Date().toISOString(),
      trust: { knownContact: Boolean(known), dkimPass: /dkim=pass/i.test(authResults) }
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (env.AGENT_WEBHOOK_SECRET) {
      Object.assign(headers, await standardWebhookHeaders(env.AGENT_WEBHOOK_SECRET, id, body, Math.floor(Date.now() / 1000)));
    }
    await fetch(env.AGENT_WEBHOOK_URL, { method: "POST", headers, body });
  } catch (error) {
    console.error("global webhook failed", error);
  }
}
