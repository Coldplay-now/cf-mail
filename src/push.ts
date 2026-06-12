import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { Env } from "./env";

// New-mail notifications, best-effort and entirely optional:
//   - Web Push when VAPID_* secrets are set (browsers / PWA)
//   - APNs when APNS_* secrets are set (a native iOS client), endpoints
//     stored as "apns:<device token hex>" and routed by prefix.
// Stale endpoints reported gone by the push service are pruned.

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

let apnsJwtCache: { token: string; iat: number } | null = null;

// ES256-signed APNs provider token, cached ~45 min (Apple allows 20–60).
async function apnsJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (apnsJwtCache && now - apnsJwtCache.iat < 2700) return apnsJwtCache.token;
  const pem = env.APNS_PRIVATE_KEY!;
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) =>
    c.charCodeAt(0)
  );
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign"
  ]);
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID })));
  const payload = b64url(enc.encode(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${payload}`));
  const token = `${header}.${payload}.${b64url(sig)}`;
  apnsJwtCache = { token, iat: now };
  return token;
}

// Workers CAN reach APNs directly — outbound fetch negotiates HTTP/2,
// which APNs requires. Verified in production; no relay needed.
async function sendApns(env: Env, deviceToken: string, note: { title: string; body: string; mailId: string }) {
  const res = await fetch(`https://api.push.apple.com/3/device/${deviceToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await apnsJwt(env)}`,
      "apns-topic": env.APNS_TOPIC!,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      aps: { alert: { title: note.title, body: note.body }, sound: "default" },
      mailId: note.mailId
    })
  });
  return res.status;
}

export async function notifyDevices(
  env: Env,
  mail: { id: string; fromName: string | null; fromAddr: string; subject: string | null; snippet: string | null }
) {
  const subs = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all<{
    endpoint: string;
    p256dh: string | null;
    auth: string | null;
  }>();
  if (!subs.results.length) return;

  const title = mail.fromName || mail.fromAddr;
  const body = mail.subject || mail.snippet || "(no subject)";
  const webMessage = {
    data: { title, body, url: `/#mail/${mail.id}`, tag: mail.id },
    options: { ttl: 86400, urgency: "normal" as const }
  };

  await Promise.all(
    subs.results.map(async (sub) => {
      try {
        if (sub.endpoint.startsWith("apns:")) {
          if (!env.APNS_PRIVATE_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) return;
          const status = await sendApns(env, sub.endpoint.slice(5), { title, body, mailId: mail.id });
          if (status === 410 || status === 400) {
            await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
          }
          return;
        }
        if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return;
        const payload = await buildPushPayload(
          webMessage,
          {
            endpoint: sub.endpoint,
            expirationTime: null,
            keys: { p256dh: sub.p256dh ?? "", auth: sub.auth ?? "" }
          },
          {
            subject: env.VAPID_SUBJECT || `mailto:admin@${env.MAIL_DOMAIN}`,
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY
          }
        );
        const res = await fetch(sub.endpoint, payload as unknown as RequestInit);
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
        }
      } catch (error) {
        console.error("push failed", sub.endpoint, error);
      }
    })
  );
}
