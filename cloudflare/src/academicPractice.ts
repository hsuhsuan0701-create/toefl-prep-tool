/**
 * Standalone Academic Passage MVP: not a full adaptive TOEFL Reading Set.
 * Cloudflare Access must protect all routes. Never send answer keys before submission.
 */
import { validateDraft, type Draft } from "./geminiDraft.js";
import { scoreMcq, stripMcqQuestion } from "@toefl-prep/shared";

export interface AcademicEnv {
  DB: D1Database;
  TOEFL_MANUAL_TEST_TOKEN?: string;
}
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const idPattern = /^[A-Za-z0-9_-]{3,80}$/;
const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

export function stripAcademicAnswers(d: Draft) {
  return {
    title: d.title, discipline: d.discipline, passage: d.passage,
    questions: d.questions.map(stripMcqQuestion)
  };
}

export type Answers = Record<string, string>;
export function gradeAcademic(d: Draft, answers: unknown) {
  if (!isObject(answers) || Object.keys(answers).length !== d.questions.length) {
    throw new Error("Please answer all five questions");
  }
  for (const key of Object.keys(answers)) {
    if (!d.questions.some(q => q.id === key)) throw new Error("Unknown question ID");
  }
  const review = d.questions.map(q => {
    const selected = answers[q.id];
    if (typeof selected !== "string" || !q.options.some(o => o.id === selected)) {
      throw new Error("Unknown answer option");
    }
    return {
      id: q.id, stem: q.stem, skill: q.skill,
      selectedOptionId: selected, correctOptionId: q.correctOptionId,
      correct: scoreMcq(q, selected).correct,
      explanationZh: q.explanationZh,
      options: q.options.map(o => ({ id: o.id, text: o.text }))
    };
  });
  return {
    correctCount: review.filter(q => q.correct).length,
    totalCount: review.length,
    review
  };
}
async function authorizedAdmin(req: Request, token: string | undefined): Promise<boolean> {
  const authorization = req.headers.get("authorization");
  const given = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const encoded = new TextEncoder();
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded.encode(given)));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded.encode(token ?? "")));
  let delta = 0;
  for (let i = 0; i < 32; i++) delta |= a[i]! ^ b[i]!;
  return !!token && token.length >= 32 && given.length >= 32 && delta === 0;
}
function validPost(req: Request): boolean {
  const origin = req.headers.get("origin");
  const url = new URL(req.url);
  return origin === url.origin && req.headers.get("content-type")?.split(";")[0].trim() === "application/json";
}
async function postData(req: Request): Promise<unknown> {
  // Keep abuse/error responses small; this page only submits five letters or review notes.
  if (Number(req.headers.get("content-length") || 0) > 16000) return null;
  const body = await req.text().catch(() => "");
  if (body.length > 16000) return null;
  try { return JSON.parse(body); } catch { return null; }
}
async function approvedDraft(db: D1Database, id: string): Promise<Draft | null> {
  const row = await db.prepare(
    "SELECT content_json FROM generation_drafts WHERE id=? AND status='approved'"
  ).bind(id).first<{ content_json: string }>();
  if (!row) return null;
  return validateDraft(JSON.parse(row.content_json));
}
export async function handleAcademicApi(req: Request, env: AcademicEnv): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/api/cloud/academic")) return null;
  const method = req.method;

  if (path === "/api/cloud/academic" && method === "GET") {
    try {
      const rows = await env.DB.prepare(
        "SELECT id,title,created_at,content_json FROM generation_drafts WHERE status='approved' ORDER BY created_at DESC,id DESC LIMIT 50"
      ).all<{ id: string; title: string; created_at: string; content_json: string }>();
      const passages = rows.results.map(row => {
        const d = validateDraft(JSON.parse(row.content_json));
        return { id: row.id, title: row.title, discipline: d.discipline, createdAt: row.created_at, questionCount: d.questions.length };
      });
      return json({ passages });
    } catch { return json({ error: "Unable to load approved passages" }, 503); }
  }

  if (path === "/api/cloud/academic/attempts" && method === "GET") {
    try {
      const rows = await env.DB.prepare(
        "SELECT id,draft_id,title,correct_count,total_count,completed_at FROM academic_practice_attempts ORDER BY completed_at DESC, id DESC LIMIT 50"
      ).all<{ id: string; draft_id: string; title: string; correct_count: number; total_count: number; completed_at: string }>();
      return json({ attempts: rows.results.map(r => ({
        id: r.id, passageId: r.draft_id, title: r.title,
        correctCount: r.correct_count, totalCount: r.total_count, completedAt: r.completed_at
      })) });
    } catch { return json({ error: "Unable to load history" }, 503); }
  }

  const history = /^\/api\/cloud\/academic\/attempts\/([A-Za-z0-9_-]{3,80})$/.exec(path);
  if (history && method === "GET") {
    try {
      const row = await env.DB.prepare(
        "SELECT id,draft_id,title,correct_count,total_count,review_json,completed_at FROM academic_practice_attempts WHERE id=?"
      ).bind(history[1]).first<{ id: string; draft_id: string; title: string; correct_count: number; total_count: number; review_json: string; completed_at: string }>();
      if (!row) return json({ error: "Attempt not found" }, 404);
      return json({ attemptId: row.id, passageId: row.draft_id, title: row.title,
        correctCount: row.correct_count, totalCount: row.total_count,
        completedAt: row.completed_at, review: JSON.parse(row.review_json) });
    } catch { return json({ error: "Unable to load attempt" }, 503); }
  }

  if (path === "/api/cloud/academic/review/decision" && method === "POST") {
    if (!(await authorizedAdmin(req, env.TOEFL_MANUAL_TEST_TOKEN))) return json({ error: "Unauthorized" }, 401);
    if (!validPost(req)) return json({ error: "Same-origin JSON request required" }, 403);
    const data = await postData(req);
    if (!isObject(data) || typeof data.draftId !== "string" || !idPattern.test(data.draftId) ||
        (data.decision !== "approve" && data.decision !== "reject") ||
        typeof data.note !== "string" || data.note.trim().length < 12 || data.note.length > 2000 ||
        data.confirm !== "REVIEW_DECISION") {
      return json({ error: "Invalid review decision or missing review notes" }, 400);
    }
    if (data.decision === "approve") {
      const checks = data.checklist;
      if (!isObject(checks) || checks.factChecked !== true ||
          checks.answersChecked !== true || checks.originalityChecked !== true) {
        return json({ error: "Approval requires all editorial checks" }, 400);
      }
    }
    try {
      const status = data.decision === "approve" ? "approved" : "rejected";
      // Validate draft structure before approval. Human checklist is separate from structural checks.
      if (status === "approved") {
        const row = await env.DB.prepare("SELECT content_json FROM generation_drafts WHERE id=? AND status='pending_review'")
          .bind(data.draftId).first<{ content_json: string }>();
        if (!row) return json({ error: "Pending draft not found" }, 404);
        validateDraft(JSON.parse(row.content_json));
      }
      const checkJson = data.decision === "approve" ? JSON.stringify(data.checklist) : null;
      const change = await env.DB.prepare(
        "UPDATE generation_drafts SET status=?,reviewed_at=datetime('now'),review_note=?,review_checklist_json=? WHERE id=? AND status='pending_review'"
      ).bind(status, data.note.trim(), checkJson, data.draftId).run();
      if (change.meta.changes !== 1) return json({ error: "Draft was already reviewed or not found" }, 409);
      return json({ draftId: data.draftId, status });
    } catch { return json({ error: "Unable to save review" }, 503); }
  }

  const submit = /^\/api\/cloud\/academic\/([A-Za-z0-9_-]{3,80})\/submit$/.exec(path);
  if (submit && method === "POST") {
    if (!validPost(req)) return json({ error: "Same-origin JSON request required" }, 403);
    const body = await postData(req);
    if (!isObject(body)) return json({ error: "Invalid submission" }, 400);
    try {
      const d = await approvedDraft(env.DB, submit[1]);
      if (!d) return json({ error: "Passage not approved or unavailable" }, 404);
      const result = gradeAcademic(d, body.answers);
      const id = crypto.randomUUID();
      const saved = await env.DB.prepare(
        "INSERT INTO academic_practice_attempts(id,draft_id,title,answers_json,review_json,correct_count,total_count) VALUES(?,?,?,?,?,?,?)"
      ).bind(id, submit[1], d.title, JSON.stringify(body.answers), JSON.stringify(result.review),
        result.correctCount, result.totalCount).run();
      if (saved.meta.changes !== 1) return json({ error: "Attempt not saved" }, 503);
      return json({ attemptId: id, title: d.title, ...result }, 201);
    } catch (e) {
      if (e instanceof Error && /^(Please answer|Unknown question|Unknown answer)/.test(e.message))
        return json({ error: e.message }, 400);
      return json({ error: "Unable to save attempt; no result was issued" }, 503);
    }
  }

  const article = /^\/api\/cloud\/academic\/([A-Za-z0-9_-]{3,80})$/.exec(path);
  if (article && method === "GET") {
    try {
      const d = await approvedDraft(env.DB, article[1]);
      if (!d) return json({ error: "Passage not approved or unavailable" }, 404);
      return json({ passage: { id: article[1], ...stripAcademicAnswers(d) } });
    } catch { return json({ error: "Unable to load passage" }, 503); }
  }

  return json({ error: "Unknown Academic Practice endpoint" }, 404);
}
