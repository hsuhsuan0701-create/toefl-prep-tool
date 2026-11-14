/**
 * Phase 0 Cloudflare adapter for jayin92/toefl-prep-tool.
 * No original TOEFL practice API has been migrated yet.
 * Do not show guessed scores or quietly drop attempts.
 * Protect with Cloudflare Access before storing personal practice data.
 */
import { generateScheduledDraft } from "./scheduledGeneration.js";
import { checkGeminiModel } from "./geminiModelCheck.js";

interface Env {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  AI_GENERATION_ENABLED?: string;
  DB: D1Database;
  ASSETS: Fetcher;
}

const jsonHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/health" && request.method === "GET") {
      return Response.json(
        { ok: true, service: "toefl-cloudflare-scaffold", phase: "foundation" },
        { headers: jsonHeaders },
      );
    }

    if (pathname === "/api/cloud/status" && request.method === "GET") {
      try {
        const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM attempts").first<{ count: number }>();
        return Response.json(
          { dbConnected: true, attempts: row?.count ?? 0, crossDeviceReady: false },
          { headers: jsonHeaders },
        );
      } catch {
        return Response.json(
          { dbConnected: false, error: "D1 database not initialized" },
          { status: 503, headers: jsonHeaders },
        );
      }
    }

    // Diagnostic only: metadata GET, never generation, never echoes the secret.
    // This must remain behind Cloudflare Access.
    if (pathname === "/api/cloud/gemini-check" && request.method === "GET") {
      const model = env.GEMINI_MODEL || "gemini-3.1-flash-lite";
      const result = await checkGeminiModel(env.GEMINI_API_KEY, model);
      return Response.json(result, { status: result.modelAccessible ? 200 : 503, headers: jsonHeaders });
    }

    if (pathname.startsWith("/api/")) {
      return Response.json(
        {
          error: "This endpoint has not been migrated. Practice/scoring is intentionally disabled to prevent losing answers or displaying incorrect results.",
        },
        { status: 501, headers: jsonHeaders },
      );
    }

    return env.ASSETS.fetch(request);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(generateScheduledDraft(env, controller.scheduledTime).then((result) => {
      console.log("Gemini draft generation result:", result);
    }));
  },
} satisfies ExportedHandler<Env>;
