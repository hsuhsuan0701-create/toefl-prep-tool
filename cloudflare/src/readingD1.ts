/**
 * Cloudflare D1 adapter for the ORIGINAL Reading Set / Attempt REST contract.
 * Only persistence and HTTP belong here. Schema, stripping, scoring, routing,
 * title and band rules are imported from the original repository unchanged.
 *
 * Reading-only. Full-test, Listening, Writing and Speaking are intentionally
 * still 501. Cloudflare Access must protect the entire Worker.
 */
import {
  ReadingSetSchema, ScoreRequestSchema, stripAnswers, decidePath,
  type ReadingSet, type SectionEstimateVM,
} from "@toefl-prep/shared";
import { setTitleFor } from "../../server/src/services/setTitle.js";
import {
  prepareDeterministicScore, censusRouterItems, indexDeterministicItems,
  AlreadyScoredError, UnknownItemError, KindMismatchError, ModuleLockedError,
  DuplicateItemIdError, type AttemptWithItems,
} from "../../server/src/services/deterministicScoring.js";
import { NotFound } from "../../server/src/services/scoringErrors.js";
import { computeSectionEstimate, type EstimateItemRow } from "../../server/src/services/sectionEstimates.js";
import { authorizedAdmin, validPost } from "./academicPractice.js";

export interface ReadingEnv {
  DB: D1Database;
  TOEFL_MANUAL_TEST_TOKEN?: string;
}
const jsonHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: jsonHeaders });
const setIdRe = /^[A-Za-z0-9_-]{1,64}$/;
const attemptIdRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const asJson = (text: string | null): unknown => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
const iso = (value: string | null): string | null => value ? (value.includes("T") ? value : value.replace(" ", "T") + "Z") : null;
type Module = "router" | "lower" | "upper";
type Row = {
  id: string; kind: string; mode: "drill" | "simulation"; set_id: string;
  status: "in_progress" | "completed" | "aborted"; is_repeat: number;
  module_path: "lower" | "upper" | null; router_raw: number | null;
  started_at: string; completed_at: string | null; flagged: number;
};
type ItemRow = {
  attempt_id: string; item_id: string; task_type: string; response_text: string | null;
  score: number | null; score_json: string | null; scoring_status: string; created_at: string;
};
async function readSet(db: D1Database, id: string): Promise<ReadingSet | null> {
  if (!setIdRe.test(id)) return null;
  const row = await db.prepare("SELECT content_json FROM reading_sets WHERE id=?").bind(id).first<{content_json:string}>();
  if (!row) return null;
  return ReadingSetSchema.parse(JSON.parse(row.content_json));
}
async function readAttempt(db: D1Database, id: string): Promise<{ row: Row; items: ItemRow[] } | null> {
  if (!attemptIdRe.test(id)) return null;
  const row = await db.prepare("SELECT * FROM attempts WHERE id=? AND kind='reading'").bind(id).first<Row>();
  if (!row) return null;
  const rows = await db.prepare(
    "SELECT attempt_id,item_id,task_type,response_text,score,score_json,scoring_status,created_at FROM item_results WHERE attempt_id=? ORDER BY created_at,item_id"
  ).bind(id).all<ItemRow>();
  return { row, items: rows.results };
}
async function storedEstimate(db: D1Database, id: string): Promise<SectionEstimateVM | null> {
  const r = await db.prepare("SELECT raw_detail,estimated_band,method FROM section_estimates WHERE attempt_id=? AND section='reading'").bind(id)
    .first<{raw_detail:string;estimated_band:number;method:string}>();
  if (!r) return null;
  const details = asJson(r.raw_detail) as { raw?: number; coverage?: SectionEstimateVM["coverage"] } | null;
  if (!details || typeof details.raw !== "number" || !Array.isArray(details.coverage)) return null;
  return { section:"reading",band:r.estimated_band,raw:details.raw,method:r.method,coverage:details.coverage };
}
function attemptVM(a: Row, title: string | null, withheld = false) {
  return {
    id:a.id,kind:"reading" as const,mode:a.mode,setId:a.set_id,setTitle:title,
    isRepeat:a.is_repeat===1,status:a.status,
    startedAt:iso(a.started_at),completedAt:iso(a.completed_at),
    captureFinishedAt:null,flagged:a.flagged===1,modulePath:a.module_path,
    routerRaw:withheld?null:a.router_raw,
  };
}
function neededItems(set: ReadingSet, mode: Row["mode"], path: Row["module_path"]): Set<string> {
  const index=indexDeterministicItems(set);
  return new Set([...index].filter(([,v])=>mode==="drill"?v.module==="router":
    v.module==="router" || v.module===path).map(([id])=>id));
}
function completeCoverage(set: ReadingSet, a: Row, items: ItemRow[]): boolean {
  if (a.mode==="simulation" && !a.module_path) return false;
  const needed=neededItems(set,a.mode,a.module_path);
  const scored=new Set(items.filter(x=>x.scoring_status==="scored").map(x=>x.item_id));
  return needed.size>0 && needed.size===scored.size && [...needed].every(id=>scored.has(id));
}
function estimateFromRows(a: Row, items: ItemRow[]): SectionEstimateVM | null {
  const result = computeSectionEstimate({
    kind: "reading", mode:a.mode,module_path:a.module_path,
    items:items.map(x=>({task_type:x.task_type,score:x.score,score_json:x.score_json,
      scoring_status:x.scoring_status} satisfies EstimateItemRow))
  });
  return result.status==="estimated" ? result.estimate : null;
}
async function saveEstimate(db:D1Database, attemptId:string, estimate:SectionEstimateVM):Promise<void> {
  await db.prepare(
    "INSERT INTO section_estimates(attempt_id,section,raw_detail,estimated_band,method) VALUES(?,'reading',?,?,?) ON CONFLICT(attempt_id,section) DO UPDATE SET raw_detail=excluded.raw_detail,estimated_band=excluded.estimated_band,method=excluded.method"
  ).bind(attemptId,JSON.stringify({raw:estimate.raw,coverage:estimate.coverage}),estimate.band,estimate.method).run();
}
function mapError(e:unknown):Response {
  if (e instanceof UnknownItemError || e instanceof NotFound) return respond({error:e.message},404);
  if (e instanceof AlreadyScoredError) return respond({error:e.message,alreadyScored:true},409);
  if (e instanceof KindMismatchError || e instanceof ModuleLockedError) return respond({error:e.message},409);
  if (e instanceof DuplicateItemIdError) return respond({error:"Set contains duplicate item IDs"},503);
  return respond({error:"Reading storage operation failed; no score can be assumed"},503);
}
async function jsonBody(req:Request,maxBytes=100_000):Promise<unknown> {
  const stated=Number(req.headers.get("content-length")||0);
  if (!Number.isFinite(stated) || stated>maxBytes) return null;
  const data=await req.text();
  if (data.length>maxBytes) return null;
  return asJson(data);
}
function isRecord(x:unknown):x is Record<string,unknown> {
  return x!==null && typeof x==="object" && !Array.isArray(x);
}

export async function readingD1Api(request:Request,env:ReadingEnv):Promise<Response|null> {
  const url=new URL(request.url),path=url.pathname,method=request.method,db=env.DB;
  if (!(path==="/api/sets" || path.startsWith("/api/sets/") ||
        path==="/api/attempts" || path.startsWith("/api/attempts/") ||
        path==="/api/cloud/reading-sets/import")) return null;

  if (path==="/api/cloud/reading-sets/import" && method==="POST") {
    if (!await authorizedAdmin(request,env.TOEFL_MANUAL_TEST_TOKEN)) return respond({error:"Unauthorized"},401);
    if (!validPost(request)) return respond({error:"Same-origin JSON required"},403);
    const raw=await jsonBody(request,450_000);
    const parsed=ReadingSetSchema.safeParse(raw);
    if (!parsed.success) return respond({error:"Not a valid original Reading Set (ReadingSetSchema)"},400);
    const set=parsed.data;
    try {
      indexDeterministicItems(set); // refuse colliding scoreable item IDs
      const result=await db.prepare("INSERT OR IGNORE INTO reading_sets(id,content_json) VALUES(?,?)")
        .bind(set.id,JSON.stringify(set)).run();
      if (result.meta.changes===0) return respond({error:"Reading Set already imported; existing immutable Set was not replaced"},409);
      return respond({id:set.id,status:"imported",kind:"reading"},201);
    } catch {return respond({error:"Unable to import Reading Set"},503);}
  }
  if (path==="/api/sets/unloadable" && method==="GET") {
    return respond({count:0,failures:[]});
  }
  if (path==="/api/sets" && method==="GET") {
    const kind=url.searchParams.get("kind");
    if (kind && kind!=="reading") return respond([]);
    try {
      const rows=await db.prepare("SELECT id,content_json FROM reading_sets ORDER BY created_at DESC,id DESC LIMIT 150").all<{id:string;content_json:string}>();
      const used=await db.prepare(
        "SELECT DISTINCT a.set_id FROM attempts a WHERE a.kind='reading' AND EXISTS (SELECT 1 FROM item_results i WHERE i.attempt_id=a.id AND i.scoring_status='scored')"
      ).all<{set_id:string}>();
      const attempted=new Set(used.results.map(x=>x.set_id));
      const listing=rows.results.map(row=>{
        const set=ReadingSetSchema.parse(JSON.parse(row.content_json));
        return {id:set.id,kind:"reading",source:set.source,createdAt:set.createdAt,
          ...setTitleFor(set),attempted:attempted.has(set.id),
          ...(set.advisoryNotes?.length?{advisoryNotes:set.advisoryNotes}:{})};
      });
      listing.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      return respond(listing);
    } catch {return respond({error:"Unable to list Reading Sets"},503);}
  }
  const setMatch=/^\/api\/sets\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (setMatch && method==="GET") {
    try {
      const set=await readSet(db,setMatch[1]);
      return set?respond(stripAnswers(set)):respond({error:"not found"},404);
    } catch {return respond({error:"Stored Reading Set invalid"},503);}
  }

  if (path==="/api/attempts" && method==="POST") {
    if (!validPost(request)) return respond({error:"Same-origin JSON required"},403);
    const data=await jsonBody(request);
    if (!isRecord(data)||data.kind!=="reading"||!["drill","simulation"].includes(String(data.mode))||
       typeof data.setId!=="string"||!setIdRe.test(data.setId)||data.fullTestRunId!==undefined)
       return respond({error:"Reading drill/simulation only; Full-Test Run is not migrated"},400);
    try {
      const set=await readSet(db,data.setId);
      if (!set) return respond({error:"unknown Reading Set"},404);
      const prev=await db.prepare(
        "SELECT 1 AS used FROM attempts a WHERE a.set_id=? AND a.kind='reading' AND EXISTS (SELECT 1 FROM item_results i WHERE i.attempt_id=a.id AND i.scoring_status='scored') LIMIT 1"
      ).bind(data.setId).first<{used:number}>();
      const isRepeat=!!prev,id=crypto.randomUUID();
      await db.prepare("INSERT INTO attempts(id,kind,mode,set_id,is_repeat) VALUES(?,'reading',?,?,?)")
        .bind(id,data.mode,data.setId,isRepeat?1:0).run();
      return respond({attemptId:id,isRepeat},201);
    } catch {return respond({error:"Unable to start Reading Attempt"},503);}
  }
  if (path==="/api/attempts" && method==="GET") {
    try {
      const kind=url.searchParams.get("kind");
      if (kind&&kind!=="reading") return respond({items:[],total:0});
      const setId=url.searchParams.get("setId");
      if (setId&&!setIdRe.test(setId)) return respond({error:"Invalid setId"},400);
      const limit=Math.max(1,Math.min(100,Number(url.searchParams.get("limit")||25)||25));
      const offset=Math.max(0,Math.min(100000,Number(url.searchParams.get("offset")||0)||0));
      const where="WHERE kind='reading'"+(setId?" AND set_id=?":"");
      const params=setId?[setId]:[];
      const count=await db.prepare("SELECT COUNT(*) as n FROM attempts "+where).bind(...params).first<{n:number}>();
      const rows=await db.prepare("SELECT * FROM attempts "+where+" ORDER BY started_at DESC,rowid DESC LIMIT ? OFFSET ?")
        .bind(...params,limit,offset).all<Row>();
      const result=await Promise.all(rows.results.map(async a=>{
        const set=await readSet(db,a.set_id);
        const estimate=await storedEstimate(db,a.id);
        return {...attemptVM(a,set?setTitleFor(set).title:null),estimate:estimate?{band:estimate.band,method:estimate.method}:null,
          missingBand:a.mode==="simulation"&&a.status==="completed"&&!estimate&&!a.is_repeat?"incomplete":null,
          fullTestRun:null};
      }));
      return respond({items:result,total:count?.n??0});
    } catch {return respond({error:"Unable to list Reading Attempts"},503);}
  }

  const match=/^\/api\/attempts\/([0-9a-f-]{36})(?:\/(score|route|complete|abort|flag))?$/.exec(path);
  if (!match||!attemptIdRe.test(match[1])) return respond({error:"Reading endpoint not found"},404);
  const id=match[1],action=match[2]??"";
  if (method==="POST" && request.headers.get("origin")!==url.origin)
    return respond({error:"Same-origin request required"},403);
  const snapshot=await readAttempt(db,id).catch(()=>null);
  if (!snapshot) return respond({error:"unknown Reading Attempt"},404);
  const {row,items}=snapshot;
  const set=await readSet(db,row.set_id).catch(()=>null);
  if (!set) return respond({error:"Reading Set unavailable"},503);

  if (action==="score" && method==="POST") {
    if (!validPost(request)) return respond({error:"Same-origin JSON required"},403);
    if (row.status!=="in_progress") return respond({error:"attempt is already "+row.status},409);
    const data=await jsonBody(request);
    const parsed=ScoreRequestSchema.safeParse(data);
    if (!parsed.success||!["complete_words","daily_life","academic_passage"].includes(parsed.data.taskType))
      return respond({error:"Invalid Reading score request"},400);
    try {
      const plan=prepareDeterministicScore({
        attempt:{...row,items} as AttemptWithItems,set,request:parsed.data
      });
      // SQLite D1.batch commits the full Task-Type submission as a transaction.
      // The migration's trigger enforces still-in-progress and the right module
      // at insertion, including against concurrent completion or routing.
      const batch=plan.writes.map(w=>{
        const data=asJson(w.scoreJson) as {answer?:string}|null;
        return db.prepare(
          "INSERT INTO item_results(attempt_id,item_id,task_type,response_text,score,score_json,scoring_status,scored_at) VALUES(?,?,?,?,?,?,'scored',datetime('now'))"
        ).bind(w.attemptId,w.itemId,w.taskType,data?.answer??null,w.score,w.scoreJson);
      });
      await db.batch(batch);
      return respond({taskType:plan.taskType,items:plan.items});
    } catch(e) {
      // A replay when the first response was lost is idempotently acknowledged
      // only if *all* requested item IDs have been scored, never for a partial commit.
      const saved=await readAttempt(db,id).catch(()=>null);
      const ids=parsed.data.items.map(i=>i.itemId);
      const allPersisted=ids.length>0&&!!saved&&ids.every(w=>saved.items.some(i=>i.item_id===w&&i.scoring_status==="scored"));
      if (allPersisted) return respond({error:"already scored: complete request persisted",alreadyScored:true},409);
      if (e instanceof AlreadyScoredError) return respond({error:"Request overlaps an earlier submission; not every item was scored"},409);
      return mapError(e);
    }
  }
  if (action==="route" && method==="POST") {
    if (row.mode!=="simulation") return respond({error:"routing is simulation-only"},409);
    if (row.module_path) return respond({path:row.module_path,routerRaw:row.router_raw});
    if (row.status!=="in_progress") return respond({error:"attempt is already "+row.status},409);
    try {
      const census=censusRouterItems(set,{...row,items} as AttemptWithItems);
      if (census.missing>0) return respond({error:"router module incomplete: "+census.missing+" item(s) not scored"},409);
      const decision=decidePath(census.correctCount,census.total);
      const result=await db.prepare(
        "UPDATE attempts SET module_path=?,router_raw=? WHERE id=? AND kind='reading' AND mode='simulation' AND status='in_progress' AND module_path IS NULL"
      ).bind(decision.path,decision.routerRaw,id).run();
      if (result.meta.changes===1) return respond(decision);
      const current=await readAttempt(db,id);
      if (current?.row.module_path) return respond({path:current.row.module_path,routerRaw:current.row.router_raw});
      return respond({error:"Attempt state changed; route not saved"},409);
    } catch(e){return mapError(e);}
  }
  if (action==="flag" && method==="POST") {
    try {
      await db.prepare("UPDATE attempts SET flagged=1 WHERE id=? AND status='in_progress'").bind(id).run();
      return respond({status:"flagged"});
    } catch {return respond({error:"Unable to flag Reading Attempt"},503);}
  }
  if (action==="abort" && method==="POST") {
    try {
      const res=await db.prepare("UPDATE attempts SET status='aborted' WHERE id=? AND status='in_progress'").bind(id).run();
      return res.meta.changes?respond({status:"aborted"}):respond({error:"attempt is already "+row.status},409);
    } catch {return respond({error:"Unable to abort Reading Attempt"},503);}
  }
  if (action==="complete" && method==="POST") {
    if (row.status==="completed") {
      let estimate=await storedEstimate(db,id);
      if (!estimate && row.mode==="simulation" && completeCoverage(set,row,items)) {
        estimate=estimateFromRows(row,items);
        if (estimate) await saveEstimate(db,id,estimate);
      }
      return respond({status:"completed",estimate});
    }
    if (row.status!=="in_progress") return respond({error:"attempt is already "+row.status},409);
    try {
      // Original route permits ending an incomplete simulation, but grants no band.
      // If fully scored, use the DB count guard to avoid a concurrent stale estimate.
      const complete=row.mode==="simulation" && completeCoverage(set,row,items);
      const total=complete?neededItems(set,row.mode,row.module_path).size:0;
      const guard=complete ?
        " AND (SELECT COUNT(*) FROM item_results WHERE attempt_id=? AND scoring_status='scored')=?" : "";
      const update=await db.prepare(
        "UPDATE attempts SET status='completed',completed_at=datetime('now') WHERE id=? AND status='in_progress'"+guard
      ).bind(...(complete?[id,id,total]:[id])).run();
      if (update.meta.changes===0) return respond({error:"Attempt changed; retry completion"},409);
      const completed=await readAttempt(db,id);
      if (!completed) return respond({error:"Attempt could not be read back"},503);
      const estimate=row.mode==="simulation" && completeCoverage(set,completed.row,completed.items)
        ? estimateFromRows(completed.row,completed.items):null;
      if (estimate) await saveEstimate(db,id,estimate);
      return respond({status:"completed",estimate});
    } catch(e){return mapError(e);}
  }
  if (action==="" && method==="GET") {
    try {
      const withheld=row.mode==="simulation"&&row.status==="in_progress";
      const index=indexDeterministicItems(set);
      let estimate=await storedEstimate(db,id);
      if (!estimate && row.status==="completed"&&row.mode==="simulation"&&completeCoverage(set,row,items)) {
        estimate=estimateFromRows(row,items);
        if (estimate) await saveEstimate(db,id,estimate); // recover an interrupted estimate write
      }
      const itemVM=items.map(item=>{
        const payload=asJson(item.score_json);
        const scoreJson=withheld&&payload&&typeof payload==="object"
          ? Object.fromEntries(Object.entries(payload).filter(([key])=>key!=="correct"))
          : payload;
        return {
          attemptId:id,itemId:item.item_id,taskType:item.task_type,responseText:item.response_text,
          responseAudioPath:null,transcript:null,score:withheld?null:item.score,scoreJson,
          scoringStatus:item.scoring_status,deliveryReport:null,createdAt:iso(item.created_at)
        };
      });
      const reviews=(row.status==="completed" || row.mode==="drill") ? items.filter(i=>i.scoring_status==="scored").map(item=>{
        const ref=index.get(item.item_id);
        if (!ref) return null;
        return {itemId:item.item_id,taskType:item.task_type,correct:item.score===1,
          key:ref.taskType==="complete_words"?ref.completion:ref.question.correctOptionId,
          explanationZh:ref.taskType==="complete_words"?ref.explanationZh:ref.question.explanationZh};
      }).filter(Boolean):undefined;
      const bandStatus=estimate?{status:"estimated"}:
        row.status==="aborted"?{status:"discarded"}:
        row.status==="in_progress"?{status:"unfinished"}:
        row.mode==="drill"?{status:"not-applicable",reason:"drill"}:
        !row.module_path?{status:"not-applicable",reason:"not-routed"}:
        {status:"incomplete",unscored:[],absent:[]};
      return respond({
        attempt:attemptVM(row,setTitleFor(set).title,withheld),items:itemVM,
        judgeReports:[],estimate,bandStatus,activeJobs:[],
        ...(reviews?.length?{deterministicReview:reviews}:{}),
        ...(withheld?{marksWithheld:"attempt-in-progress"}:{})
      });
    } catch(e){return mapError(e);}
  }
  return respond({error:"Unsupported Reading request"},405);
}
