import PostalMime from "postal-mime";
import { type Env, snippetOf, threadKeyOf } from "./env";
import { notifyDevices } from "./push";

// Receiving pipeline. Email Routing's catch-all hands every message for the
// domain to this worker:
//   1. look up the local part in `addresses` — unknown/inactive → SMTP reject
//      (550), so mailbox management is pure CRUD and spray spam dies at the
//      door; plus-addressing folds (dev+x@ delivers to dev@);
//   2. parse the MIME (postal-mime — pure JS, Workers-safe), store attachments
//      in R2 under mail/<id>/, insert the message row;
//   3. blocked senders (contacts.blocked) are stored as spam and skipped from
//      forwarding/notifications;
//   4. optionally relay a copy via message.forward(forward_to).
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
    .first<{ active: number; forward_to: string | null }>();
  if (!box || !box.active) {
    message.setReject("550 5.1.1 mailbox unavailable");
    return;
  }

  const parsed = await PostalMime.parse(message.raw);
  const id = crypto.randomUUID();
  const fromAddr = (parsed.from?.address || message.from).toLowerCase();

  const blocked = await env.DB.prepare("SELECT 1 FROM contacts WHERE address = ? AND blocked = 1")
    .bind(fromAddr)
    .first();

  // Other recipients (for reply-all): to + cc minus the receiving address.
  const ccAddr =
    [...(parsed.to ?? []), ...(parsed.cc ?? [])]
      .map((r) => r.address?.toLowerCase())
      .filter((a): a is string => Boolean(a) && a !== toAddr)
      .join(",") || null;

  const attachments: { key: string; filename: string; mime: string; size: number }[] = [];
  for (const [i, att] of (parsed.attachments ?? []).entries()) {
    const filename = safeName(att.filename || `attachment-${i + 1}`);
    const key = `mail/${id}/${i + 1}-${filename}`;
    const body = att.content; // ArrayBuffer | string
    await env.R2.put(key, body, {
      httpMetadata: { contentType: att.mimeType || "application/octet-stream" }
    });
    const size = typeof body === "string" ? body.length : body.byteLength;
    attachments.push({ key, filename, mime: att.mimeType || "application/octet-stream", size });
  }

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
    await notifyAgentWebhook(env, {
      id,
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references: parsed.references ?? null,
      from: { address: fromAddr, name: parsed.from?.name || null },
      to: toAddr,
      cc: ccAddr,
      subject: parsed.subject ?? null,
      snippet: snippetOf(parsed.text, parsed.html),
      text: parsed.text ?? null,
      attachments: attachments.map(({ filename, mime, size }) => ({ filename, mime, size })),
      authResults: parsed.headers?.find((h) => h.key.toLowerCase() === "authentication-results")?.value ?? ""
    });
  }
}

// POST a signed JSON summary of new inbound mail to the agent webhook (if
// configured). Best-effort. `trust.knownContact` lets an agent treat
// unknown-sender mail as untrusted data rather than instructions
// (prompt-injection hygiene); `trust.dkimPass` reflects Cloudflare's
// Authentication-Results header.
async function notifyAgentWebhook(env: Env, p: Record<string, unknown> & { authResults: string }) {
  if (!env.AGENT_WEBHOOK_URL) return;
  try {
    const from = p.from as { address: string };
    const known = await env.DB.prepare("SELECT 1 FROM contacts WHERE address = ?").bind(from.address).first();
    const { authResults, ...rest } = p;
    const body = JSON.stringify({
      event: "mail.received",
      ...rest,
      receivedAt: new Date().toISOString(),
      trust: { knownContact: Boolean(known), dkimPass: /dkim=pass/i.test(authResults) }
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (env.AGENT_WEBHOOK_SECRET) {
      const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(env.AGENT_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      );
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
      headers["X-CF-Mail-Signature"] = "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    await fetch(env.AGENT_WEBHOOK_URL, { method: "POST", headers, body });
  } catch (error) {
    console.error("agent webhook failed", error);
  }
}
