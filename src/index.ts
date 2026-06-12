import { type Env, authorized, json } from "./env";
import { handleApi } from "./api";
import { receiveEmail } from "./receive";

export default {
  // Inbound mail (Email Routing catch-all → this worker).
  async email(message: Parameters<typeof receiveEmail>[0], env: Env): Promise<void> {
    await receiveEmail(message, env);
  },

  // Web UI (static assets) + JSON API.
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!(await authorized(request, env))) {
        return json({ error: "unauthorized" }, 401);
      }
      try {
        return await handleApi(request, env);
      } catch (error) {
        console.error("api error", error);
        return json({ error: error instanceof Error ? error.message : "internal error" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
