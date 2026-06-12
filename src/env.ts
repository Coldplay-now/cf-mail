/// <reference types="@cloudflare/workers-types" />

export interface SendEmailBinding {
  send(message: {
    to: string;
    from: string;
    cc?: string[];
    subject: string;
    html?: string;
    text?: string;
    // ≤5 MiB total per message (25 MiB only to verified destinations).
    attachments?: {
      filename: string;
      content: ArrayBuffer;
      type: string;
      disposition: "attachment" | "inline";
      contentId?: string;
    }[];
  }): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  ASSETS: Fetcher;
  /** Cloudflare Email Service binding — only present once the service is enabled. */
  SEND_EMAIL?: SendEmailBinding;

  /** Your email domain, e.g. "example.com" (wrangler var). */
  MAIL_DOMAIN: string;
  /** Bearer token for the API + web UI (wrangler secret). */
  AUTH_TOKEN?: string;

  // Optional: Web Push (generate a VAPID pair, see README)
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string; // e.g. "mailto:you@example.com"

  // Optional: APNs for a native iOS client
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string; // app bundle id
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY?: string; // .p8 PEM contents
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

/** Constant-time-ish Bearer check (compares SHA-256 digests). */
export async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.AUTH_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(env.AUTH_TOKEN))
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export const snippetOf = (text: string | undefined | null, html: string | undefined | null) => {
  const source = text || (html ? html.replace(/<[^>]+>/g, " ") : "");
  return source.replace(/\s+/g, " ").trim().slice(0, 140) || null;
};

/** Conversation root: first token of References, else own Message-ID. */
export const threadKeyOf = (refs: string | null | undefined, messageId: string | null | undefined) => {
  const first = refs?.trim().split(/\s+/)[0];
  return first || messageId || null;
};
