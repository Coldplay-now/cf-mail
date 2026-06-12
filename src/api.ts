import { type Env, json, snippetOf, threadKeyOf } from "./env";

// REST API under /api/*. Everything requires `Authorization: Bearer <AUTH_TOKEN>`.

const PER_PAGE = 20;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type MailRow = Record<string, unknown> & {
  id: string;
  message_id: string | null;
  refs: string | null;
  thread_key: string | null;
  read: number;
};

async function counts(env: Env) {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN direction='in' AND archived=0 AND spam=0 THEN 1 ELSE 0 END) AS inbox,
       SUM(CASE WHEN direction='in' AND archived=0 AND spam=0 AND read=0 THEN 1 ELSE 0 END) AS unread,
       SUM(CASE WHEN direction='out' AND status='sent' THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END) AS archived,
       SUM(CASE WHEN spam=1 THEN 1 ELSE 0 END) AS spam
     FROM mails`
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
  switch (folder) {
    case "sent":
      return "direction='out' AND status='sent'";
    case "archived":
      return "archived=1";
    case "spam":
      return "spam=1";
    default:
      return "direction='in' AND archived=0 AND spam=0";
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

  // ---- send ----
  if (path === "/send" && method === "POST") {
    if (!env.SEND_EMAIL) {
      return json(
        { error: "Sending not configured: enable Email Service in the dashboard, then REDEPLOY this worker (the binding attaches at deploy time)." },
        501
      );
    }
    // JSON for plain sends; multipart/form-data when attachments ride along
    // (fields + repeated "attachments" file parts, ≤5 MiB total per message).
    let body: { from: string; to: string; cc?: string; subject: string; text: string; inReplyToId?: string };
    let files: File[] = [];
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await request.formData();
      body = {
        from: String(form.get("from") ?? ""),
        to: String(form.get("to") ?? ""),
        cc: String(form.get("cc") ?? ""),
        subject: String(form.get("subject") ?? ""),
        text: String(form.get("text") ?? ""),
        inReplyToId: String(form.get("inReplyToId") ?? "") || undefined
      };
      // workers-types declares getAll(): string[]; at runtime file parts are File.
      files = (form.getAll("attachments") as unknown as (File | string)[]).filter(
        (f): f is File => typeof f !== "string" && f.size > 0
      );
      const total = files.reduce((n, f) => n + f.size, 0);
      if (total > 5 * 1024 * 1024) {
        return json({ error: "attachments exceed the 5 MiB per-message limit" }, 400);
      }
    } else {
      body = (await request.json()) as typeof body;
    }
    const box = await env.DB.prepare("SELECT * FROM addresses WHERE address = ? AND active = 1")
      .bind(body.from.toLowerCase())
      .first<{ address: string; display_name: string | null }>();
    if (!box) return json({ error: `sender ${body.from}@${env.MAIL_DOMAIN} does not exist or is inactive` }, 400);

    const fromAddr = `${box.address}@${env.MAIL_DOMAIN}`;
    const original = body.inReplyToId
      ? await env.DB.prepare("SELECT * FROM mails WHERE id = ?").bind(body.inReplyToId).first<MailRow>()
      : null;
    const ccList = (body.cc ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a && a !== body.to.toLowerCase() && a !== fromAddr);

    const html = `<div style="font-family:-apple-system,'Segoe UI',sans-serif;line-height:1.7;white-space:pre-wrap;">${escapeHtml(body.text)}</div>`;
    const id = crypto.randomUUID();
    const refs = original
      ? [original.refs, original.message_id].filter(Boolean).join(" ") || null
      : null;

    // Attachments: read once, send via the binding, and keep a copy in R2 so
    // the sent mail shows (and serves) them in the UI like received mail does.
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

    let status = "sent";
    let sendError: string | null = null;
    try {
      await env.SEND_EMAIL.send({
        to: body.to,
        from: fromAddr,
        ...(ccList.length ? { cc: ccList } : {}),
        subject: body.subject,
        html,
        text: body.text,
        ...(outAttachments.length ? { attachments: outAttachments } : {})
      });
    } catch (error) {
      status = "failed";
      sendError = error instanceof Error ? error.message : String(error);
    }

    await env.DB.prepare(
      `INSERT INTO mails (id, direction, status, in_reply_to, refs, thread_key,
         from_addr, from_name, to_addr, cc_addr, subject, text_body, html_body, snippet, attachments, read)
       VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
      .bind(
        id,
        status,
        original?.message_id ?? null,
        refs,
        original ? (original.thread_key ?? original.message_id) : null,
        fromAddr,
        box.display_name,
        body.to.toLowerCase(),
        ccList.length ? ccList.join(",") : null,
        body.subject,
        body.text,
        html,
        snippetOf(body.text, null),
        attachmentMeta.length ? JSON.stringify(attachmentMeta) : null
      )
      .run();

    if (original && !original.read) {
      await env.DB.prepare("UPDATE mails SET read = 1 WHERE id = ?").bind(original.id).run();
    }
    if (sendError) return json({ error: `send failed: ${sendError}` }, 502);
    return json({ ok: true, id });
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
    };
    const address = body.address.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(address)) return json({ error: "invalid local part" }, 400);
    await env.DB.prepare(
      "INSERT INTO addresses (id, address, display_name, forward_to, note) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), address, body.display_name ?? null, body.forward_to || null, body.note ?? null)
      .run();
    return json({ ok: true }, 201);
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
      for (const f of ["display_name", "forward_to", "note"] as const) {
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
