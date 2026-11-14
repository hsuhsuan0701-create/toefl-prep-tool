/**
 * D1 snapshot adapter for the EXISTING stats route. The original
 * buildStatsRoutes keeps the Dashboard's band, Overall, trends and target
 * computations; only persistence changes.
 */
import { Hono } from "hono";
import { buildStatsRoutes, type StatsStore } from "../../server/src/routes/stats.js";
import { persistedRowToEstimate, type EstimateItemRow } from "../../server/src/services/sectionEstimates.js";
import type { LatestEstimateRow, TrendRow } from "../../server/src/db/rows.js";
import { validPost } from "./academicPractice.js";

type DatabaseEnv = { DB: D1Database };
type EstimateRow = LatestEstimateRow & { rowSeq: number };
type ScoredRow = { attempt_id: string; task_type: string; score: number | null; scoring_status: string; score_json: string | null };
type TrendInput = TrendRow & { taskType: string };
type KV = { key: string; value: string };
const reply = (body: unknown, status: number) => Response.json(body,{status,headers:{"Cache-Control":"no-store"}});

async function snapshot(db:D1Database):Promise<{store:StatsStore; writes:Map<string,string>}> {
  const [targets,estimateRows,estimateItems,recentSkillRows,trends] = await Promise.all([
    db.prepare("SELECT key,value FROM settings WHERE key LIKE 'target.%'").all<KV>(),
    db.prepare(
      "SELECT se.rowid as rowSeq, se.attempt_id as attemptId,se.section,"+
      " se.raw_detail as rawDetail,se.estimated_band as estimatedBand,se.method,"+
      " a.mode,a.started_at as startedAt,a.completed_at as completedAt,a.module_path as modulePath"+
      " FROM section_estimates se JOIN attempts a ON a.id=se.attempt_id"+
      " WHERE a.status='completed' AND a.is_repeat=0"+
      " ORDER BY CASE WHEN a.mode='simulation' THEN 0 ELSE 1 END,a.completed_at DESC,se.rowid DESC"
    ).all<EstimateRow>(),
    db.prepare(
      "SELECT ir.attempt_id,ir.task_type,ir.score,ir.score_json,ir.scoring_status"+
      " FROM item_results ir JOIN section_estimates se ON se.attempt_id=ir.attempt_id"+
      " JOIN attempts a ON a.id=ir.attempt_id"+
      " WHERE a.status='completed' AND a.is_repeat=0"
    ).all<ScoredRow>(),
    db.prepare(
      "SELECT ir.score_json as scoreJson,ir.task_type as taskType"+
      " FROM item_results ir JOIN attempts a ON a.id=ir.attempt_id"+
      " WHERE ir.scoring_status='scored' AND ir.scored_at IS NOT NULL"+
      " AND ir.score_json IS NOT NULL"+
      " AND ir.task_type IN ('daily_life','academic_passage','listen_choose','conversation','announcement','academic_talk')"+
      " AND (a.mode='drill' OR a.status='completed')"+
      " ORDER BY ir.scored_at DESC,ir.rowid DESC LIMIT 300"
    ).all<{scoreJson:string;taskType:string}>(),
    db.prepare(
      "SELECT ir.task_type as taskType,ir.attempt_id as attemptId,"+
      " a.mode,a.is_repeat as isRepeat,a.started_at as startedAt,a.completed_at as completedAt,"+
      " AVG(ir.score) as avgScore FROM item_results ir JOIN attempts a ON a.id=ir.attempt_id"+
      " WHERE a.status='completed' GROUP BY ir.task_type,ir.attempt_id"+
      " HAVING SUM(ir.scoring_status <> 'scored' OR ir.score IS NULL)=0"+
      " ORDER BY COALESCE(a.completed_at,a.started_at),a.rowid"
    ).all<TrendInput>()
  ]);
  const values=new Map(targets.results.map(row=>[row.key,row.value]));
  const writes=new Map<string,string>();
  const itemsByAttempt=new Map<string,EstimateItemRow[]>();
  for(const item of estimateItems.results){
    const bucket=itemsByAttempt.get(item.attempt_id)??[];
    bucket.push({task_type:item.task_type,score:item.score,
      score_json:item.score_json,scoring_status:item.scoring_status});
    itemsByAttempt.set(item.attempt_id,bucket);
  }
  const eligible=estimateRows.results.filter(row=>persistedRowToEstimate({
    section:row.section,rawDetail:row.rawDetail,estimatedBand:row.estimatedBand,
    method:row.method,modulePath:row.modulePath,items:itemsByAttempt.get(row.attemptId)??[]
  })!==null);
  const store:StatsStore={
    getSetting:key=>values.get(key)??null,
    setSetting:(key,value)=>{values.set(key,value);writes.set(key,value);},
    getLatestEstimates:()=>{
      const selected:Partial<Record<"reading"|"listening"|"writing"|"speaking",LatestEstimateRow>>={};
      for(const kind of ["reading","listening","writing","speaking"] as const){
        const row=eligible.find(item=>item.section===kind);
        if(row)selected[kind]=row;
      }
      return selected;
    },
    recentSimulationBands:(kind,limit)=>eligible.filter(row=>row.section===kind&&row.mode==="simulation")
      .sort((a,b)=>String(b.completedAt).localeCompare(String(a.completedAt))||b.rowSeq-a.rowSeq)
      .slice(0,limit).map(row=>row.estimatedBand),
    recentScoredReadingListeningItemResults:limit=>recentSkillRows.results.slice(0,limit),
    recentScoredItemResults:()=>[], // Judge scoring not migrated
    listAllJudgeReports:()=>[],
    trendPoints:(taskType:string):TrendRow[]=>trends.results.filter(row=>row.taskType===taskType).map(({taskType:_,...row})=>row)
  };
  return {store,writes};
}
export async function statsD1Api(req:Request,env:DatabaseEnv):Promise<Response|null> {
  const pathname=new URL(req.url).pathname;
  if(!pathname.startsWith("/api/stats/")) return null;
  if(req.method==="PUT" && !validPost(new Request(req.url,{method:"POST",headers:req.headers})))
    return reply({error:"Same-origin JSON required"},403);
  try {
    const {store,writes}=await snapshot(env.DB);
    const app=new Hono().route("/api/stats",buildStatsRoutes({repo:store}));
    const res=await app.fetch(req);
    if(req.method==="PUT"&&res.ok&&writes.size){
      await env.DB.batch([...writes].map(([key,value])=>env.DB.prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).bind(key,value)));
    }
    const headers=new Headers(res.headers);
    headers.set("Cache-Control","no-store");
    return new Response(res.body,{status:res.status,headers});
  } catch {
    return reply({error:"Stats database unavailable"},503);
  }
}
