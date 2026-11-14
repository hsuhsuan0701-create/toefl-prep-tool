import { draftHash, geminiDraft, nearDuplicate, validateDraft, type Draft } from "./geminiDraft.js";

export type GenerationEnv = {
  DB: D1Database;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  AI_GENERATION_ENABLED?: string;
};

/**
 * Cost guard: one attempted request per UTC day. Default disabled.
 * A valid draft is NOT a full adaptive TOEFL set; it is quarantined.
 */
export async function generateScheduledDraft(env: GenerationEnv, timestamp: number, doFetch: typeof fetch = fetch, manualTest = false): Promise<string> {
  // Scheduled calls remain disabled; only the separately authenticated one-off test can bypass the cron flag.
  if (env.AI_GENERATION_ENABLED !== "true" && !manualTest) return "disabled";
  if (!env.GEMINI_API_KEY) return "missing-key";
  const day = new Date(timestamp).toISOString().slice(0, 10);
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO generation_runs(day,status) VALUES (?,'started')").bind(day).run();
  if (claim.meta.changes !== 1) return "already-attempted";
  try {
    const rows = await env.DB.prepare("SELECT content_json FROM generation_drafts ORDER BY created_at DESC LIMIT 50").all<{ content_json: string }>();
    const previous: Draft[] = [];
    for (const row of rows.results) {
      try { previous.push(validateDraft(JSON.parse(row.content_json))); } catch { /* ignore legacy invalid drafts */ }
    }
    const model = env.GEMINI_MODEL || "gemini-3.1-flash-lite";
    const draft = await geminiDraft(env.GEMINI_API_KEY, model, previous.map(d => d.title), doFetch);
    if (nearDuplicate(draft, previous)) throw new Error("Near-duplicate draft");
    const sha = await draftHash(draft);
    const insert = await env.DB.prepare(
      "INSERT OR IGNORE INTO generation_drafts(id,kind,title,fingerprint,content_json,model,status) VALUES (?,'reading_academic_draft',?,?,?,?,'pending_review')"
    ).bind("draft-" + day, draft.title, sha, JSON.stringify(draft), model).run();
    if (insert.meta.changes !== 1) throw new Error("Duplicate draft hash or identifier");
    await env.DB.prepare("UPDATE generation_runs SET status='pending_review' WHERE day=?").bind(day).run();
    return "pending_review";
  } catch (e) {
    const reason = (e instanceof Error ? e.message : "Unknown").slice(0,120);
    await env.DB.prepare("UPDATE generation_runs SET status='failed',failure_reason=? WHERE day=?").bind(reason,day).run();
    return "failed:" + reason;
  }
}
