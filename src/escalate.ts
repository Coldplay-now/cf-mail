import { type Env, snippetOf } from "./env";
import { notifyDevices } from "./push";
import { type MailRecord, logEvent } from "./agent-db";

// Escalation (AMP §9): re-surface an agent mail to the human owner. Agent mail
// is normally hidden from the human folders (agent_state IS NOT NULL), so we
// insert a fresh HUMAN-visible row (agent_state NULL) carrying the original
// sender/subject/body plus the agent's note, and fire a device push. The
// agent row itself is left handled/failed; this copy is what the human sees.
export async function escalateToHuman(
  env: Env,
  opts: { mailboxId: string; mail: MailRecord; note?: string | null }
): Promise<void> {
  const { mailboxId, mail, note } = opts;
  const subject = `[escalated] ${mail.subject ?? "(no subject)"}`;
  const body =
    (note ? `${note}\n\n— escalated by the agent —\n\n` : "") + (mail.text_body ?? "");
  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO mails (id, direction, status, message_id, in_reply_to, from_addr, from_name,
       to_addr, cc_addr, subject, text_body, snippet, read)
     VALUES (?, 'in', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  )
    .bind(
      id,
      mail.message_id,
      mail.in_reply_to,
      mail.from_addr,
      mail.from_name,
      mail.to_addr,
      mail.cc_addr,
      subject,
      body,
      snippetOf(body, null)
    )
    .run();

  await logEvent(env, {
    mailboxId,
    mailId: mail.id,
    type: "escalated",
    correlationId: mail.correlation_id,
    detail: { humanMailId: id, note: note ?? null }
  });

  await notifyDevices(env, {
    id,
    fromName: mail.from_name,
    fromAddr: mail.from_addr,
    subject,
    snippet: note ?? mail.text_body
  });
}
