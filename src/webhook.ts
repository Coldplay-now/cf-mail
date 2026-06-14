// Crypto helpers: Standard Webhooks signing (https://www.standardwebhooks.com)
// and SHA-256 hashing for per-mailbox agent tokens. All Web Crypto, Workers-safe.

const enc = new TextEncoder();

async function hmacSha256(secret: string, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", key, enc.encode(message));
}

const toBase64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 hex of a string (used to store agent tokens hashed, never plaintext). */
export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

/**
 * Standard Webhooks signature headers. The signed content is
 * `${id}.${timestamp}.${body}`; the id + timestamp let receivers reject replays
 * and off-the-shelf verifiers (svix and friends) validate without custom code.
 */
export async function standardWebhookHeaders(
  secret: string,
  id: string,
  body: string,
  nowSeconds: number
): Promise<Record<string, string>> {
  const ts = String(nowSeconds);
  const sig = toBase64(await hmacSha256(secret, `${id}.${ts}.${body}`));
  return {
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${sig}`
  };
}
