/**
 * One-at-a-time import of an EXISTING locally synthesized MP3 after human
 * listening approval. This is explicitly not a Gemini call and is NOT the
 * /claim -> /upload TTS workflow. Provenance is recorded in its own D1 table.
 *
 * This endpoint is for PRIVATE, administrator-only import. It NEVER publishes.
 * Old published audio, existing R2 objects and claimed clips are not targets.
 */
import { authorizedAdmin } from "./academicPractice.js";

const ID = "lsn-a97620b2c800";
const CANONICAL_SHA = "4a070707e2c0781ad0939dfceff7d4610fc562bc80341c34062dbf644c1deabe";
const ROUTE = "/api/cloud/listening-refill/import-reviewed";
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_SHA = /^[0-9a-f]{64}$/;
const MAX_BYTES = 8 * 1024 * 1024;
const LITE = "gemini-3.8-flash-lite-tts";
const FLASH = "gemini-3.8-flash-tts";
const NO_CACHE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: NO_CACHE });

type ImportEnv = {
  DB: D1Database;
  LISTENING_AUDIO?: R2Bucket;
  TOEFL_MANUAL_TEST_TOKEN?: string;
};
type Draft = {state: string; content_json: string};
type Clip = {
  status: string; ordinal: number; claim_day: string | null;
  claimed_at: string | null; uploaded_at: string | null;
  object_key: string | null; bytes: number | null;
};
const objectKey = (stimulusId: string) => "stimuli/" + ID + "/" + stimulusId + ".mp3";
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,"0")).join("");
async function sha256(bytes: BufferSource): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}
function expectedModel(set: any, stimulusId: string): string | null {
  for (const module of [set.router, set.lowerModule, set.upperModule]) {
    if (module.listenChoose?.some((x: any) => x.id===stimulusId) ||
        module.announcements?.some((x: any) => x.id===stimulusId)) return LITE;
    if (module.conversations?.some((x: any) => x.id===stimulusId) ||
        module.academicTalks?.some((x: any) => x.id===stimulusId)) return FLASH;
  }
  return null;
}
async function state(db: D1Database, stimulusId: string) {
  const draft = await db.prepare(
    "SELECT state,content_json FROM listening_refill_drafts WHERE id=?"
  ).bind(ID).first<Draft>();
  const clip = await db.prepare(
    "SELECT status,ordinal,claim_day,claimed_at,uploaded_at,object_key,bytes FROM listening_refill_clips WHERE set_id=? AND stimulus_id=?"
  ).bind(ID, stimulusId).first<Clip>();
  const settings = await db.prepare(
    "SELECT value FROM settings WHERE key='listening_refill_enabled'"
  ).first<{value:string}>();
  const published = await db.prepare(
    "SELECT COUNT(*) AS n FROM listening_sets WHERE id=?"
  ).bind(ID).first<{n:number}>();
  const modelAttempts = await db.prepare(
    "SELECT COUNT(*) AS n FROM listening_refill_model_attempts WHERE set_id=? AND stimulus_id=?"
  ).bind(ID,stimulusId).first<{n:number}>();
  const legacyAttempts = await db.prepare(
    "SELECT COUNT(*) AS n FROM listening_refill_daily_attempts WHERE set_id=? AND stimulus_id=?"
  ).bind(ID,stimulusId).first<{n:number}>();
  // Also confirms migration 0010 has been applied.
  const imports = await db.prepare(
    "SELECT COUNT(*) AS n FROM listening_refill_audio_imports WHERE set_id=? AND stimulus_id=?"
  ).bind(ID,stimulusId).first<{n:number}>();
  if (!draft || !clip) return { ready:false, reason:"draft-or-clip-missing", sourceHash:null,
    model:null, draft, clip, settings, published, modelAttempts, legacyAttempts, imports };
  const parsed = JSON.parse(draft.content_json);
  const sourceHash = await sha256(new TextEncoder().encode(JSON.stringify(parsed)));
  const model = expectedModel(parsed, stimulusId);
  const ready = draft.state === "draft" && clip.status === "pending" &&
    clip.claim_day === null && clip.claimed_at === null &&
    clip.uploaded_at === null && clip.object_key === null && clip.bytes === null &&
    (settings?.value ?? "false") === "false" && published?.n === 0 &&
    modelAttempts?.n === 0 && legacyAttempts?.n === 0 && imports?.n === 0 &&
    sourceHash === CANONICAL_SHA && parsed.id === ID && model !== null;
  return {ready,reason:ready?"ready":"safety-guard-failed",sourceHash,model,
    draft,clip,settings,published,modelAttempts,legacyAttempts,imports};
}
function isMp3(data: Uint8Array) {
  return data.length > 1024 &&
    ((data[0]===73 && data[1]===68 && data[2]===51) ||
     (data[0]===255 && (data[1]&0xe0)===0xe0));
}
export async function handleReviewedAudioImport(request: Request, env: ImportEnv): Promise<Response|null> {
  const url = new URL(request.url);
  if (url.pathname !== ROUTE) return null;
  if (!await authorizedAdmin(request, env.TOEFL_MANUAL_TEST_TOKEN))
    return reply({error:"Unauthorized"},401);
  if (request.method !== "GET" && request.method !== "POST")
    return reply({error:"Method not allowed"},405);
  if (!env.LISTENING_AUDIO) return reply({error:"Private R2 binding not configured"},503);
  const id = url.searchParams.get("setId") ?? "";
  const stimulusId = url.searchParams.get("stimulusId") ?? "";
  if (id !== ID || !SAFE_ID.test(stimulusId)) return reply({error:"Invalid target"},400);
  const key = objectKey(stimulusId);
  let s: Awaited<ReturnType<typeof state>>;
  try { s = await state(env.DB,stimulusId); }
  catch { return reply({error:"Import audit migration missing or database inspection failed. No upload."},503); }
  let objectExists: boolean;
  try { objectExists = !!await env.LISTENING_AUDIO.head(key); }
  catch { return reply({error:"R2 availability uncertain. No upload."},503); }
  if (request.method === "GET") {
    return reply({result:"reviewed-import-read-only-check",setId:ID,stimulusId,
      draftState:s.draft?.state??null,clipStatus:s.clip?.status??null,
      expectedModel:s.model,sourceHashMatches:s.sourceHash===CANONICAL_SHA,
      priorModelAttempts:s.modelAttempts?.n??null,priorLegacyAttempts:s.legacyAttempts?.n??null,
      priorImports:s.imports?.n??null,autoRefill:s.settings?.value??"false",
      publishedCollision:s.published?.n??null,r2ObjectExists:objectExists,
      readyForImport:s.ready && !objectExists,databaseWrites:0,geminiRequests:0});
  }
  // POST: Only a manual, reviewed LOCAL MP3 can enter this path. No Gemini API.
  if (request.headers.get("origin")!==url.origin ||
      request.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="audio/mpeg" ||
      request.headers.get("x-listening-review-confirm")!=="I_LISTENED_AND_APPROVED_LOCAL_MP3" ||
      request.headers.get("x-listening-source-sha256")!==CANONICAL_SHA ||
      !SAFE_SHA.test(request.headers.get("x-listening-mp3-sha256")??""))
    return reply({error:"Explicit human review, same-origin audio/mpeg, and matching hashes required"},403);
  const model = request.headers.get("x-listening-tts-model");
  if (model !== s.model || !s.ready || objectExists)
    return reply({error:"Import preconditions failed; no upload"},409);
  const len = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(len) || len < 1025 || len > MAX_BYTES)
    return reply({error:"Invalid MP3 length"},413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length !== len || !isMp3(bytes)) return reply({error:"Malformed MP3"},400);
  const mp3Hash = await sha256(bytes);
  if (mp3Hash !== request.headers.get("x-listening-mp3-sha256"))
    return reply({error:"MP3 SHA-256 mismatch"},400);
  // Recheck D1 before conditional R2 write. Fail closed on concurrent claims.
  try { s = await state(env.DB,stimulusId); }
  catch { return reply({error:"D1 recheck failed; no upload"},503); }
  if (!s.ready || s.model!==model) return reply({error:"D1 state changed; no upload"},409);
  try {
    // Atomic create-if-absent, unlike Wrangler's unconditional r2 object put.
    // If another uploader has already created this key, put() returns null.
    const put = await env.LISTENING_AUDIO.put(key,bytes,{
      // Explicit HTTP conditional header: create only if no object exists.
      // Worker R2 put() accepts Headers as onlyIf; a failed condition returns null.
      onlyIf: new Headers({"If-None-Match":"*"}),
      httpMetadata:{contentType:"audio/mpeg"},
      customMetadata:{source:"human-reviewed-local-import",ttsModel:model!,mp3Sha256:mp3Hash}
    });
    if (!put) return reply({error:"R2 key already exists; never overwrite"},409);
  } catch { return reply({error:"R2 upload outcome uncertain; inspect before any retry"},503); }
  // The R2 object now exists. Any D1 failure must be investigated manually;
  // NEVER delete or retry automatically or synthesize another copy.
  try {
    const result = await env.DB.batch([
      env.DB.prepare(
        "UPDATE listening_refill_clips SET status='uploaded',object_key=?,bytes=?,uploaded_at=datetime('now') " +
        "WHERE set_id=? AND stimulus_id=? AND status='pending' AND claim_day IS NULL " +
        "AND claimed_at IS NULL AND uploaded_at IS NULL AND object_key IS NULL AND bytes IS NULL " +
        "AND EXISTS(SELECT 1 FROM listening_refill_drafts WHERE id=? AND state='draft') " +
        "AND NOT EXISTS(SELECT 1 FROM listening_sets WHERE id=?) " +
        "AND COALESCE((SELECT value FROM settings WHERE key='listening_refill_enabled'),'false')='false' " +
        "AND NOT EXISTS(SELECT 1 FROM listening_refill_model_attempts WHERE set_id=? AND stimulus_id=?) " +
        "AND NOT EXISTS(SELECT 1 FROM listening_refill_daily_attempts WHERE set_id=? AND stimulus_id=?)"
      ).bind(key,bytes.length,ID,stimulusId,ID,ID,ID,stimulusId,ID,stimulusId),
      env.DB.prepare(
        "INSERT INTO listening_refill_audio_imports(set_id,stimulus_id,content_sha256,mp3_sha256,tts_model,review_method,bytes,object_key) " +
        "SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(" +
        "SELECT 1 FROM listening_refill_clips WHERE set_id=? AND stimulus_id=? AND status='uploaded' AND object_key=? AND bytes=?) " +
        "AND NOT EXISTS(SELECT 1 FROM listening_refill_audio_imports WHERE set_id=? AND stimulus_id=?)"
      ).bind(ID,stimulusId,CANONICAL_SHA,mp3Hash,model,"human-listened-local-mp3",bytes.length,key,
        ID,stimulusId,key,bytes.length,ID,stimulusId)
    ]);
    if (result[0]?.meta?.changes!==1 || result[1]?.meta?.changes!==1)
      return reply({error:"R2 saved but D1 changes uncertain; inspect manually, no retry"},503);
    const saved = await env.DB.prepare(
      "SELECT c.status,c.object_key,c.bytes,a.mp3_sha256 FROM listening_refill_clips c " +
      "JOIN listening_refill_audio_imports a ON a.set_id=c.set_id AND a.stimulus_id=c.stimulus_id " +
      "WHERE c.set_id=? AND c.stimulus_id=?"
    ).bind(ID,stimulusId).first<{status:string;object_key:string;bytes:number;mp3_sha256:string}>();
    const remoteHead=await env.LISTENING_AUDIO.head(key);
    if (saved?.status!=="uploaded" || saved.object_key!==key || saved.bytes!==bytes.length ||
        saved.mp3_sha256!==mp3Hash || remoteHead?.size!==bytes.length)
      return reply({error:"Post-upload verification uncertain; inspect manually"},503);
    return reply({result:"reviewed-local-mp3-import-verified",setId:ID,stimulusId,
      model,mp3Sha256:mp3Hash,bytes:bytes.length,status:"uploaded",published:false,
      geminiRequests:0,claimCreated:false,quotaConsumedByImport:0},201);
  } catch { return reply({error:"R2 object may exist but D1 update failed; inspect, do not retry"},503); }
}
