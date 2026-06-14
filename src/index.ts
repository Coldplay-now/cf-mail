import { type Env, authorized, json } from "./env";
import { handleApi } from "./api";
import { handleAgentApi } from "./agent-api";
import { receiveEmail } from "./receive";
import { runScheduled } from "./cron";

// Baseline hardening for every response; CSP is added for HTML documents only
// (the web app shell). The email-preview iframe is sandboxed separately, and
// CSP here keeps remote images / inline styles working inside it.
const CSP =
  "default-src 'self'; img-src 'self' data: https: http:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'";

function harden(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  if ((h.get("content-type") ?? "").includes("text/html")) h.set("Content-Security-Policy", CSP);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  // Inbound mail (Email Routing catch-all → this worker).
  async email(message: Parameters<typeof receiveEmail>[0], env: Env): Promise<void> {
    await receiveEmail(message, env);
  },

  // Cron (wrangler.jsonc triggers.crons): agent redelivery / dead-letter / GC.
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },

  // Web UI (static assets) + JSON API.
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Agent API authenticates per-mailbox (bound token), not via the global token.
    if (url.pathname.startsWith("/api/agent/")) {
      try {
        return harden(await handleAgentApi(request, env));
      } catch (error) {
        console.error("agent api error", error);
        return harden(json({ error: error instanceof Error ? error.message : "internal error" }, 500));
      }
    }

    if (url.pathname.startsWith("/api/")) {
      if (!(await authorized(request, env))) {
        return harden(json({ error: "unauthorized" }, 401));
      }
      try {
        return harden(await handleApi(request, env));
      } catch (error) {
        console.error("api error", error);
        return harden(json({ error: error instanceof Error ? error.message : "internal error" }, 500));
      }
    }
    return harden(await env.ASSETS.fetch(request));
  }
};
