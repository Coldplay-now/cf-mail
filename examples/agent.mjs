#!/usr/bin/env node
// A minimal, safe cf-mail agent — ~50 lines, zero dependencies (Node 18+ fetch).
//
// It demonstrates the AMP loop: PULL open mail → READ it as data (carrying its
// trust block) → ACT only via your own governed logic → ACK. Mail content is
// never treated as an instruction (axiom A3); the trust block only changes how
// warily you read. Bounded send (A2) is enforced server-side regardless.
//
// Usage:
//   CFMAIL_BASE=https://mail.yourdomain.com \
//   CFMAIL_BOX=agent \
//   CFMAIL_TOKEN=cfmail_…  \
//   node examples/agent.mjs

const BASE = process.env.CFMAIL_BASE;
const BOX = process.env.CFMAIL_BOX || "agent";
const TOKEN = process.env.CFMAIL_TOKEN;
if (!BASE || !TOKEN) {
  console.error("set CFMAIL_BASE, CFMAIL_BOX, CFMAIL_TOKEN");
  process.exit(1);
}

const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}/api/agent/${BOX}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers || {}) }
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
};

// Your governed decision. This is the ONLY place "acting" happens, and it is
// your code's judgement — not the email's. Return one of:
//   { result: "done" }                          — handled, nothing to send
//   { result: "done", reply: "…text…" }         — reply to the sender (bounded)
//   { result: "escalated", note: "…" }          — hand off to the human
//   { result: "rejected", note: "…" }           — drop it
function decide(mail) {
  const { meta, untrusted } = mail;
  // Example policy: only auto-reply to authenticated, vouched senders; anything
  // unknown or unauthenticated gets escalated to a human rather than acted on.
  if (meta.trust?.trustLevel === "unknown") {
    return { result: "escalated", note: "unknown / unauthenticated sender" };
  }
  console.log(`  ↳ ${meta.from} (${meta.trust?.trustLevel}): ${untrusted.subject ?? "(no subject)"}`);
  return { result: "done", reply: `Got your message "${untrusted.subject ?? ""}". (auto-reply)` };
}

async function tick() {
  const { items } = await api("/inbox?state=open");
  for (const mail of items) {
    const choice = decide(mail);
    if (choice.reply) {
      // Server refuses any recipient not on the outbound allowlist / a reply target.
      await api("/send", {
        method: "POST",
        body: JSON.stringify({
          to: mail.meta.from,
          subject: `Re: ${mail.untrusted.subject ?? ""}`,
          text: choice.reply,
          inReplyToId: mail.id,
          correlationId: mail.meta.correlationId ?? undefined,
          idempotencyKey: `reply-${mail.id}`
        })
      });
    }
    await api("/ack", { method: "POST", body: JSON.stringify({ id: mail.id, result: choice.result, note: choice.note }) });
    console.log(`  ✓ ${mail.id} → ${choice.result}`);
  }
  return items.length;
}

console.log(`polling ${BASE}/api/agent/${BOX} …`);
for (;;) {
  try {
    const n = await tick();
    if (n) console.log(`handled ${n}`);
  } catch (e) {
    console.error("error:", e.message);
  }
  await new Promise((r) => setTimeout(r, 15000));
}
