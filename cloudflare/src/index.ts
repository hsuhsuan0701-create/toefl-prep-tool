/**
 * Phase 0 Cloudflare adapter for jayin92/toefl-prep-tool.
 * No original TOEFL practice API has been migrated yet.
 * Do not show guessed scores or quietly drop attempts.
 * Protect with Cloudflare Access before storing personal practice data.
 */
import { generateScheduledDraft } from "./scheduledGeneration.js";
import { checkGeminiModel } from "./geminiModelCheck.js";
import { geminiTestPage } from "./geminiTestPage.js";
import { geminiReviewPage } from "./geminiReviewPage.js";
import { handleAcademicApi } from "./academicPractice.js";
import { academicPracticePage } from "./academicPracticePage.js";
import { readingD1Api } from "./readingD1.js";
import { readingImportPage } from "./readingImportPage.js";

interface Env {
  GEMINI_API_KEY?: string;
  TOEFL_MANUAL_TEST_TOKEN?: string;
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

    if (pathname === "/api/cloud/gemini-test" && request.method === "GET") {
      return geminiTestPage();
    }

    if (pathname === "/api/cloud/gemini-review" && request.method === "GET") {
      return geminiReviewPage();
    }

    // Read-only draft review. Uses same Access + independent token as manual test.
    if (pathname === "/api/cloud/gemini-review-latest" && request.method === "POST") {
      const expected = env.TOEFL_MANUAL_TEST_TOKEN;
      const actual = request.headers.get("authorization");
      const bearer = actual?.startsWith("Bearer ") ? actual.slice(7) : "";
      const a = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer)));
      const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected ?? "")));
      let mismatch = 0;
      for (let i = 0; i < a.length; i++) mismatch |= a[i]! ^ b[i]!;
      if (!expected || expected.length < 32 || bearer.length < 32 || mismatch !== 0) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: jsonHeaders });
      }
      if (request.headers.get("origin") !== new URL(request.url).origin ||
          request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
        return Response.json({ error: "Origin and JSON content type required" }, { status: 403, headers: jsonHeaders });
      }
      try {
        const item = await env.DB.prepare(
          "SELECT id, title, status, created_at, content_json FROM generation_drafts WHERE status='pending_review' ORDER BY created_at DESC,id DESC LIMIT 1"
        ).first<{ id: string; title: string; status: string; created_at: string; content_json: string }>();
        if (!item) return Response.json({ error: "No pending draft found" }, { status: 404, headers: jsonHeaders });
        const content = JSON.parse(item.content_json);
        return Response.json({ draft: { ...content, id: item.id, status: item.status, createdAt: item.created_at } }, { headers: jsonHeaders });
      } catch {
        return Response.json({ error: "Unable to read draft" }, { status: 503, headers: jsonHeaders });
      }
    }

    // One-off test is intentionally not a public browsing endpoint.
    // Cloudflare Access must protect the entire Worker; a separate revocable
    // token is also required. Calls never include the API key in responses.
    if (pathname === "/api/cloud/gemini-generate-once" && request.method === "POST") {
      const expected = env.TOEFL_MANUAL_TEST_TOKEN;
      const actual = request.headers.get("authorization");
      const bearer = actual?.startsWith("Bearer ") ? actual.slice(7) : "";
      const a = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer)));
      const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected ?? "")));
      let mismatch = 0;
      for (let i = 0; i < a.length; i++) mismatch |= a[i]! ^ b[i]!;
      const accepted = !!expected && expected.length >= 32 && bearer.length >= 32 && mismatch === 0;
      if (!accepted) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: jsonHeaders });
      }
      if (request.headers.get("origin") !== new URL(request.url).origin ||
          request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
        return Response.json({ error: "Origin and JSON content type required" }, { status: 403, headers: jsonHeaders });
      }
      const payload = await request.json().catch(() => null);
      if (!payload || typeof payload !== "object" || !("confirm" in payload) || payload.confirm !== "GENERATE_ONCE") {
        return Response.json({ error: "Confirmation missing" }, { status: 400, headers: jsonHeaders });
      }
      const result = await generateScheduledDraft(env, Date.now(), fetch, true);
      const status = result === "pending_review" ? 201 : result === "already-attempted" ? 409 : 502;
      return Response.json({ result, published: false, cronEnabled: env.AI_GENERATION_ENABLED === "true" }, { status, headers: jsonHeaders });
    }

    if (pathname === "/api/cloud/academic-practice" && request.method === "GET") {
      return academicPracticePage();
    }

    if (pathname.startsWith("/api/cloud/academic")) {
      const academicResponse = await handleAcademicApi(request, env);
      if (academicResponse) return academicResponse;
    }

    if (pathname === "/api/cloud/reading-sets/import" && request.method === "GET") {
      return readingImportPage();
    }

    if (pathname === "/api/sets" || pathname.startsWith("/api/sets/") ||
        pathname === "/api/attempts" || pathname.startsWith("/api/attempts/") ||
        pathname === "/api/cloud/reading-sets/import") {
      const readingResponse = await readingD1Api(request, env);
      if (readingResponse) return readingResponse;
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
