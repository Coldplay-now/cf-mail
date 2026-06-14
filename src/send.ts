// Shared outbound send path, used by both the operator API (/api/send) and the
// agent API (/api/agent/<box>/send). Outbound enforcement lives here so the A2
// egress guarantee holds at one boundary: if the sending mailbox is an agent,
// every recipient must be allowlisted (or the address being replied to) BEFORE
// the Email Service binding ever fires.

import { type Env, snippetOf } from "./env";
import { AGENT_LIMITS, outboundAllowed } from "./agent";
import { GRANT_TTL_MS, listAllow, logEvent, mintGrant } from "./agent-db";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export class SendError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: unknown) {
    super(message);
  }
}

export interface SendInput {
  from: string; // local part
  to: string;
  cc?: string;
  subject: string;
  text: string;
  inReplyToId?: string;
  files?: File[];
  correlationId?: string;
  idempotencyKey?: string;
}

interface MailRow {
  id: string;
  message_id: string | null;
  refs: string | null;
  thread_key: string | null;
  from_addr: string;
  read: number;
}

/** Parse a /send request: JSON for plain sends, multipart when attachments ride along. */
export async function parseSendRequest(request: Request): Promise<SendInput> {
  if (request.headers.get("content-type")?.includes("multipart/form-data")) {
    const form = await request.formData();
    const files = (form.getAll("attachments") as unknown as (File | string)[]).filter(
      (f): f is File => typeof f !== "string" && f.size > 0
    );
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > AGENT_LIMITS.maxAttachmentBytes) {
      throw new SendError("attachments exceed the 5 MiB per-message limit", 400);
    }
    return {
      from: String(form.get("from") ?? ""),
      to: String(form.get("to") ?? ""),
      cc: String(form.get("cc") ?? ""),
      subject: String(form.get("subject") ?? ""),
      text: String(form.get("text") ?? ""),
      inReplyToId: String(form.get("inReplyToId") ?? "") || undefined,
      correlationId: String(form.get("correlationId") ?? "") || undefined,
      idempotencyKey: String(form.get("idempotencyKey") ?? "") || undefined,
      files
    };
  }
  const body = (await request.json()) as SendInput;
  return body;
}

export interface SendResult {
  id: string;
  status: "sent" | "failed";
  error?: string;
  deduped?: boolean;
}

/**
 * Persist + send one outbound message. `from` is a local part; the mailbox must
 * exist and be active. For agent mailboxes this enforces the outbound allowlist
 * (A2), dedups on idempotencyKey, mints reply-grants and writes events.
 */
export async function sendMail(env: Env, input: SendInput): Promise<SendResult> {
  if (!env.SEND_EMAIL) {
    throw new SendError(
      "Sending not configured: enable Email Service in the dashboard, then REDEPLOY this worker (the binding attaches at deploy time).",
      501
    );
  }

  const box = await env.DB.prepare(
    "SELECT id, address, display_name, kind FROM addresses WHERE address = ? AND active = 1"
  )
    .bind(input.from.toLowerCase())
    .first<{ id: string; address: string; display_name: string | null; kind: string }>();
  if (!box) throw new SendError(`sender ${input.from}@${env.MAIL_DOMAIN} does not exist or is inactive`, 400);

  const fromAddr = `${box.address}@${env.MAIL_DOMAIN}`;
  const isAgent = box.kind === "agent";

  const original = input.inReplyToId
    ? await env.DB.prepare("SELECT * FROM mails WHERE id = ?").bind(input.inReplyToId).first<MailRow>()
    : null;

  const to = input.to.trim().toLowerCase();
  const ccList = (input.cc ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a && a !== to && a !== fromAddr);
  const recipients = [to, ...ccList];

  // ---- A2 egress: agent mailboxes are default-deny outbound ----
  if (isAgent) {
    const outAllow = await listAllow(env, box.id, "out");
    const replyTargets = original ? [original.from_addr] : [];
    const { ok, refused } = outboundAllowed({ recipients, outAllow, replyTargets });
    if (!ok) {
      await logEvent(env, {
        mailboxId: box.id,
        type: "send_refused",
        reason: "recipient_not_allowed",
        correlationId: input.correlationId ?? null,
        detail: { refused }
      });
      throw new SendError(`recipient(s) not allowed: ${refused.join(", ")}`, 403, { refused });
    }
    // Idempotency: an earlier send with the same key is returned, not resent.
    if (input.idempotencyKey) {
      const dup = await env.DB.prepare(
        "SELECT id FROM mails WHERE from_addr = ? AND idempotency_key = ? LIMIT 1"
      )
        .bind(fromAddr, input.idempotencyKey)
        .first<{ id: string }>();
      if (dup) return { id: dup.id, status: "sent", deduped: true };
    }
  }

  const html = `<div style="font-family:-apple-system,'Segoe UI',sans-serif;line-height:1.7;white-space:pre-wrap;">${escapeHtml(
    input.text
  )}</div>`;
  const id = crypto.randomUUID();
  const refs = original ? [original.refs, original.message_id].filter(Boolean).join(" ") || null : null;

  // Attachments: read once, send via the binding, keep a copy in R2 for the UI.
  const files = input.files ?? [];
  const attachmentMeta: { key: string; filename: string; mime: string; size: number }[] = [];
  const outAttachments: NonNullable<Parameters<NonNullable<Env["SEND_EMAIL"]>["send"]>[0]["attachments"]> = [];
  for (const [i, file] of files.entries()) {
    const buf = await file.arrayBuffer();
    const mime = file.type || "application/octet-stream";
    const filename = file.name || `attachment-${i + 1}`;
    outAttachments.push({ filename, content: buf, type: mime, disposition: "attachment" });
    const key = `mail/${id}/${i + 1}-${filename.replace(/[^\w.\-]+/g, "_").slice(0, 80)}`;
    await env.R2.put(key, buf, { httpMetadata: { contentType: mime } });
    attachmentMeta.push({ key, filename, mime, size: file.size });
  }

  let status: "sent" | "failed" = "sent";
  let sendError: string | null = null;
  try {
    await env.SEND_EMAIL.send({
      to: input.to,
      from: fromAddr,
      ...(ccList.length ? { cc: ccList } : {}),
      subject: input.subject,
      html,
      text: input.text,
      ...(outAttachments.length ? { attachments: outAttachments } : {})
    });
  } catch (error) {
    status = "failed";
    sendError = error instanceof Error ? error.message : String(error);
  }

  await env.DB.prepare(
    `INSERT INTO mails (id, direction, status, in_reply_to, refs, thread_key,
       from_addr, from_name, to_addr, cc_addr, subject, text_body, html_body, snippet, attachments,
       read, agent_state, correlation_id, idempotency_key)
     VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  )
    .bind(
      id,
      status,
      original?.message_id ?? null,
      refs,
      original ? original.thread_key ?? original.message_id : null,
      fromAddr,
      box.display_name,
      to,
      ccList.length ? ccList.join(",") : null,
      input.subject,
      input.text,
      html,
      snippetOf(input.text, null),
      attachmentMeta.length ? JSON.stringify(attachmentMeta) : null,
      // agent outbound carries a non-null agent_state so it stays out of human folders
      isAgent ? "sent" : null,
      input.correlationId ?? null,
      input.idempotencyKey ?? null
    )
    .run();

  if (original && !original.read) {
    await env.DB.prepare("UPDATE mails SET read = 1 WHERE id = ?").bind(original.id).run();
  }

  if (isAgent && status === "sent") {
    // Mint reply-grants so each recipient can reply without widening the list.
    const expiresAt = Date.now() + GRANT_TTL_MS;
    for (const r of recipients) {
      await mintGrant(env, { mailboxId: box.id, correspondent: r, correlationId: input.correlationId ?? null, expiresAt });
    }
    await logEvent(env, {
      mailboxId: box.id,
      mailId: id,
      type: "sent",
      correlationId: input.correlationId ?? null,
      detail: { to, cc: ccList }
    });
  }

  return { id, status, error: sendError ?? undefined };
}
