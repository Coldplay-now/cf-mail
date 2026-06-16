import { type Env, json } from "./env";
import { SendError, parseSendRequest, sendMail } from "./send";
import { sha256Hex } from "./webhook";

// Operator REST API under /api/*. Everything requires `Authorization: Bearer
// <AUTH_TOKEN>` (the global token). The agent-facing surface is separate
// (/api/agent/*, per-mailbox token) and lives in agent-api.ts.

const PER_PAGE = 20;

type MailRow = Record<string, unknown> & {
  id: string;
  message_id: string | null;
  refs: string | null;
  thread_key: string | null;
  read: number;
};

async function counts(env: Env) {
  // agent_state IS NULL keeps agent mail out of every human folder/count.
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN direction='in' AND archived=0 AND spam=0 THEN 1 ELSE 0 END) AS inbox,
       SUM(CASE WHEN direction='in' AND archived=0 AND spam=0 AND read=0 THEN 1 ELSE 0 END) AS unread,
       SUM(CASE WHEN direction='out' AND status='sent' THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END) AS archived,
       SUM(CASE WHEN spam=1 THEN 1 ELSE 0 END) AS spam
     FROM mails WHERE agent_state IS NULL`
  ).first();
  return {
    inbox: Number(row?.inbox ?? 0),
    unread: Number(row?.unread ?? 0),
    sent: Number(row?.sent ?? 0),
    archived: Number(row?.archived ?? 0),
    spam: Number(row?.spam ?? 0)
  };
}

function folderWhere(folder: string): string {
  // Every human folder is scoped to agent_state IS NULL (agent mail is hidden).
  switch (folder) {
    case "sent":
      return "agent_state IS NULL AND direction='out' AND status='sent'";
    case "archived":
      return "agent_state IS NULL AND archived=1";
    case "spam":
      return "agent_state IS NULL AND spam=1";
    default:
      return "agent_state IS NULL AND direction='in' AND archived=0 AND spam=0";
  }
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;

  // ---- session probe ----
  if (path === "/me") {
    return json({ ok: true, domain: env.MAIL_DOMAIN, webPush: Boolean(env.VAPID_PUBLIC_KEY) });
  }

  // ---- mails ----
  if (path === "/mails" && method === "GET") {
    const folder = url.searchParams.get("folder") || "inbox";
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const q = url.searchParams.get("q")?.trim();
    let where = folderWhere(folder);
    const binds: unknown[] = [];
    if (q) {
      where += " AND (subject LIKE ? OR from_addr LIKE ? OR to_addr LIKE ? OR text_body LIKE ?)";
      const pattern = `%${q}%`;
      binds.push(pattern, pattern, pattern, pattern);
    }
    const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM mails WHERE ${where}`)
      .bind(...binds)
      .first<{ n: number }>();
    const total = Number(totalRow?.n ?? 0);
    const items = await env.DB.prepare(
      `SELECT id, direction, status, from_addr, from_name, to_addr, subject, snippet,
              attachments, read, created_at
       FROM mails WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
      .bind(...binds, PER_PAGE, (page - 1) * PER_PAGE)
      .all();
    return json({
      items: items.results,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / PER_PAGE)),
      counts: await counts(env)
    });
  }

  const mailMatch = path.match(/^\/mails\/([\w-]+)$/);
  if (mailMatch) {
    const id = mailMatch[1];
    if (method === "GET") {
      const mail = await env.DB.prepare("SELECT * FROM mails WHERE id = ?").bind(id).first<MailRow>();
      if (!mail) return json({ error: "not found" }, 404);
      if (!mail.read) await env.DB.prepare("UPDATE mails SET read = 1 WHERE id = ?").bind(id).run();
      const key = mail.thread_key ?? mail.message_id;
      const thread = key
        ? (
            await env.DB.prepare(
              `SELECT id, direction, subject, snippet, created_at FROM mails
               WHERE thread_key = ? OR message_id = ? ORDER BY created_at ASC`
            )
              .bind(key, key)
              .all()
          ).results
        : [];
      return json({ mail: { ...mail, read: 1 }, thread });
    }
    if (method === "PATCH") {
      const body = (await request.json()) as Record<string, unknown>;
      const sets: string[] = [];
      const binds: unknown[] = [];
      for (const f of ["read", "archived", "spam"] as const) {
        if (typeof body[f] === "boolean") {
          sets.push(`${f} = ?`);
          binds.push(body[f] ? 1 : 0);
        }
      }
      if (!sets.length) return json({ error: "no fields" }, 400);
      await env.DB.prepare(`UPDATE mails SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
      return json({ ok: true });
    }
    if (method === "DELETE") {
      const mail = await env.DB.prepare("SELECT attachments FROM mails WHERE id = ?")
        .bind(id)
        .first<{ attachments: string | null }>();
      if (mail?.attachments) {
        for (const att of JSON.parse(mail.attachments) as { key: string }[]) {
          await env.R2.delete(att.key).catch(() => {});
        }
      }
      await env.DB.prepare("DELETE FROM mails WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
  }

  // ---- send (shared path; agent mailboxes are allowlist-enforced in sendMail) ----
  if (path === "/send" && method === "POST") {
    try {
      const input = await parseSendRequest(request);
      const result = await sendMail(env, input);
      if (result.status === "failed") return json({ error: `send failed: ${result.error}`, id: result.id }, 502);
      return json({ ok: true, id: result.id, deduped: result.deduped ?? false });
    } catch (error) {
      if (error instanceof SendError) return json({ error: error.message, detail: error.detail }, error.status);
      throw error;
    }
  }

  // ---- attachments ----
  if (path === "/attachments" && method === "GET") {
    const key = url.searchParams.get("key") ?? "";
    if (!key.startsWith("mail/")) return json({ error: "bad key" }, 400);
    const object = await env.R2.get(key);
    if (!object) return json({ error: "not found" }, 404);
    return new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "cache-control": "private, max-age=3600"
      }
    });
  }

  // ---- addresses ----
  if (path === "/addresses" && method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM addresses ORDER BY created_at ASC").all();
    return json(rows.results);
  }
  if (path === "/addresses" && method === "POST") {
    const body = (await request.json()) as {
      address: string;
      display_name?: string;
      forward_to?: string;
      note?: string;
      kind?: string;
      agent_webhook_url?: string;
      agent_purpose?: string;
      agent_rules?: string;
    };
    const address = body.address.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(address)) return json({ error: "invalid local part" }, 400);
    const kind = body.kind === "agent" ? "agent" : "human";
    await env.DB.prepare(
      `INSERT INTO addresses (id, address, display_name, forward_to, note, kind, agent_webhook_url, agent_purpose, agent_rules)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        address,
        body.display_name ?? null,
        body.forward_to || null,
        body.note ?? null,
        kind,
        body.agent_webhook_url || null,
        body.agent_purpose || null,
        body.agent_rules || null
      )
      .run();
    return json({ ok: true }, 201);
  }

  // ---- agent allowlist (mailbox-scoped; default-deny, A2) ----
  const allowMatch = path.match(/^\/addresses\/([\w-]+)\/allow$/);
  if (allowMatch) {
    const mailboxId = allowMatch[1];
    if (method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id, direction, pattern, note, created_at FROM mail_allow WHERE mailbox_id = ? ORDER BY direction, created_at"
      )
        .bind(mailboxId)
        .all();
      return json(rows.results);
    }
    if (method === "POST") {
      const body = (await request.json()) as { direction?: string; pattern?: string; note?: string };
      const direction = body.direction === "out" ? "out" : body.direction === "in" ? "in" : null;
      const pattern = body.pattern?.trim().toLowerCase();
      if (!direction || !pattern) return json({ error: "direction (in|out) and pattern are required" }, 400);
      // pattern is a full address or "@domain"
      if (!/^@?[a-z0-9][a-z0-9._-]*(@[a-z0-9.-]+)?$/.test(pattern) && !pattern.startsWith("@")) {
        return json({ error: "pattern must be an address or @domain" }, 400);
      }
      await env.DB.prepare(
        "INSERT INTO mail_allow (id, mailbox_id, direction, pattern, note) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(crypto.randomUUID(), mailboxId, direction, pattern, body.note ?? null)
        .run();
      return json({ ok: true }, 201);
    }
  }
  const allowDelMatch = path.match(/^\/addresses\/([\w-]+)\/allow\/([\w-]+)$/);
  if (allowDelMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM mail_allow WHERE id = ? AND mailbox_id = ?")
      .bind(allowDelMatch[2], allowDelMatch[1])
      .run();
    return json({ ok: true });
  }

  // ---- mint a per-mailbox agent token (shown once; stored hashed) ----
  const tokenMatch = path.match(/^\/addresses\/([\w-]+)\/agent-token$/);
  if (tokenMatch && method === "POST") {
    const token = "cfmail_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    await env.DB.prepare("UPDATE addresses SET agent_token_hash = ? WHERE id = ?")
      .bind(await sha256Hex(token), tokenMatch[1])
      .run();
    return json({ token });
  }

  const addrMatch = path.match(/^\/addresses\/([\w-]+)$/);
  if (addrMatch) {
    const id = addrMatch[1];
    if (method === "PATCH") {
      const body = (await request.json()) as Record<string, unknown>;
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (typeof body.active === "boolean") {
        sets.push("active = ?");
        binds.push(body.active ? 1 : 0);
      }
      if (body.kind === "human" || body.kind === "agent") {
        sets.push("kind = ?");
        binds.push(body.kind);
      }
      for (const f of ["display_name", "forward_to", "note", "agent_webhook_url", "agent_purpose", "agent_rules"] as const) {
        if (typeof body[f] === "string" || body[f] === null) {
          sets.push(`${f} = ?`);
          binds.push((body[f] as string) || null);
        }
      }
      if (!sets.length) return json({ error: "no fields" }, 400);
      await env.DB.prepare(`UPDATE addresses SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM addresses WHERE id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM mail_allow WHERE mailbox_id = ?").bind(id).run();
      return json({ ok: true });
    }
  }

  // ---- contacts / blocklist ----
  if (path === "/contacts" && method === "GET") {
    // saved contacts + auto-aggregated correspondents
    const saved = await env.DB.prepare("SELECT address, name, blocked FROM contacts").all<{
      address: string;
      name: string | null;
      blocked: number;
    }>();
    const seen = await env.DB.prepare(
      `SELECT from_addr AS address, MAX(from_name) AS name FROM mails
       WHERE direction='in' AND spam=0 GROUP BY from_addr ORDER BY MAX(created_at) DESC LIMIT 200`
    ).all<{ address: string; name: string | null }>();
    const map = new Map<string, { address: string; name: string | null; blocked: boolean }>();
    for (const c of seen.results) map.set(c.address, { ...c, blocked: false });
    for (const c of saved.results) map.set(c.address, { address: c.address, name: c.name, blocked: Boolean(c.blocked) });
    return json([...map.values()]);
  }
  if (path === "/contacts" && method === "POST") {
    const body = (await request.json()) as { address: string; name?: string; blocked?: boolean };
    const address = body.address.trim().toLowerCase();
    await env.DB.prepare(
      `INSERT INTO contacts (address, name, blocked) VALUES (?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET name = COALESCE(excluded.name, name), blocked = excluded.blocked`
    )
      .bind(address, body.name ?? null, body.blocked ? 1 : 0)
      .run();
    if (body.blocked) {
      // retro-sweep: existing inbox mail from this sender goes to spam
      await env.DB.prepare("UPDATE mails SET spam = 1, read = 1 WHERE from_addr = ? AND direction = 'in'")
        .bind(address)
        .run();
    }
    return json({ ok: true });
  }
  const contactMatch = path.match(/^\/contacts\/(.+)$/);
  if (contactMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM contacts WHERE address = ?")
      .bind(decodeURIComponent(contactMatch[1]).toLowerCase())
      .run();
    return json({ ok: true });
  }

  // ---- push ----
  if (path === "/push/key" && method === "GET") {
    return json({ publicKey: env.VAPID_PUBLIC_KEY ?? null });
  }
  if (path === "/push" && method === "POST") {
    const body = (await request.json()) as {
      endpoint: string;
      keys?: { p256dh?: string; auth?: string };
      label?: string;
    };
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`
    )
      .bind(body.endpoint, body.keys?.p256dh ?? null, body.keys?.auth ?? null, body.label ?? null)
      .run();
    return json({ ok: true });
  }
  if (path === "/push" && method === "DELETE") {
    const body = (await request.json()) as { endpoint: string };
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(body.endpoint).run();
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}
