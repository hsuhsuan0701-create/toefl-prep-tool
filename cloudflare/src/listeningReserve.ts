/** Private, opt-in Listening reserve. Never synthesize audio or publish on a GET.
 * The public bank has only rows in listening_sets; fully approved drafts remain hidden.
 * Trigger after a completed listening attempt and on the existing daily cron.
 */
import { ListeningSetSchema } from "@toefl-prep/shared";
import { indexDeterministicItems } from "../../server/src/services/deterministicScoring.js";
import { listeningClips } from "./listeningAudio.js";

export interface ListeningReserveEnv {
  DB: D1Database;
  LISTENING_AUDIO?: R2Bucket;
}
const KEY = "listening_reserve_auto_release_enabled";
const LIMIT = 3;
const UNUSED_SQL = "SELECT COUNT(*) AS n FROM listening_sets s WHERE NOT EXISTS ("+
  "SELECT 1 FROM attempts a WHERE a.kind='listening' AND a.set_id=s.id AND EXISTS ("+
  "SELECT 1 FROM item_results i WHERE i.attempt_id=a.id AND i.scoring_status='scored'))";
const COMPLETE_SQL = "SELECT d.id,d.content_json FROM listening_refill_drafts d "+
  "WHERE d.state IN ('rendering','ready') "+
  "AND NOT EXISTS (SELECT 1 FROM listening_sets s WHERE s.id=d.id) "+
  "AND (SELECT COUNT(*) FROM listening_refill_clips c WHERE c.set_id=d.id)=36 "+
  "AND NOT EXISTS (SELECT 1 FROM listening_refill_clips c WHERE c.set_id=d.id "+
  "AND (c.status<>'uploaded' OR c.object_key IS NULL OR c.bytes<1024))";

export async function reserveAutoReleaseEnabled(db:D1Database):Promise<boolean>{
  const row=await db.prepare("SELECT value FROM settings WHERE key=?").bind(KEY)
    .first<{value:string}>();
  return row?.value==="true";
}
export async function reserveStatus(db:D1Database){
  const count=await db.prepare(UNUSED_SQL).first<{n:number}>();
  const available=await db.prepare("SELECT COUNT(*) AS n FROM ("+COMPLETE_SQL+")")
    .first<{n:number}>();
  return {enabled:await reserveAutoReleaseEnabled(db),unattemptedListeningSets:count?.n??0,
    completeReservedSets:available?.n??0,threshold:LIMIT};
}
export async function setReserveAutoRelease(db:D1Database,enabled:boolean){
  await db.prepare("INSERT INTO settings(key,value) VALUES(?,?) "+
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(KEY,enabled?"true":"false").run();
  return {enabled};
}
type Row={id:string;content_json:string};
type Clip={stimulus_id:string;object_key:string|null;bytes:number|null;status:string};
export async function releaseOneReservedListeningSet(env:ListeningReserveEnv):Promise<{
  result:string;setId?:string;unused?:number;
}>{
  if(!await reserveAutoReleaseEnabled(env.DB))return {result:"disabled"};
  if(!env.LISTENING_AUDIO)return {result:"r2-unavailable"};
  const status=await reserveStatus(env.DB);
  if(status.unattemptedListeningSets>LIMIT)
    return {result:"bank-not-low",unused:status.unattemptedListeningSets};
  // SQLite RANDOM() orders candidate drafts, not individual clips. With one draft
  // this is deterministic; with multiple eligible drafts it is randomized.
  const candidate=await env.DB.prepare(COMPLETE_SQL+" ORDER BY RANDOM() LIMIT 1")
    .first<Row>();
  if(!candidate)return {result:"no-complete-reserve",unused:status.unattemptedListeningSets};
  const parsed=ListeningSetSchema.parse(JSON.parse(candidate.content_json));
  if(parsed.id!==candidate.id||listeningClips(parsed).length!==36)
    return {result:"invalid-draft"};
  indexDeterministicItems(parsed);
  const clips=await env.DB.prepare(
    "SELECT stimulus_id,object_key,bytes,status FROM listening_refill_clips "+
    "WHERE set_id=? ORDER BY ordinal").bind(candidate.id).all<Clip>();
  if(clips.results.length!==36)return {result:"missing-clips"};
  for(const clip of clips.results){
    const expected="stimuli/"+candidate.id+"/"+clip.stimulus_id+".mp3";
    if(clip.status!=="uploaded"||clip.object_key!==expected||
       !Number.isSafeInteger(clip.bytes)||clip.bytes===null||clip.bytes<1024)
      return {result:"invalid-clip-record"};
    const remote=await env.LISTENING_AUDIO.head(expected);
    if(!remote||remote.size!==clip.bytes)return {result:"r2-mismatch"};
  }
  // The threshold and completed-draft preconditions are rechecked inside the
  // same D1 transaction; parallel cron/scoring callbacks cannot publish twice.
  const inserted=env.DB.prepare(
    "INSERT OR IGNORE INTO listening_sets(id,content_json) "+
    "SELECT d.id,d.content_json FROM listening_refill_drafts d WHERE d.id=? "+
    "AND d.state IN ('rendering','ready') "+
    "AND NOT EXISTS (SELECT 1 FROM listening_sets s WHERE s.id=d.id) "+
    "AND (SELECT COUNT(*) FROM listening_refill_clips c WHERE c.set_id=d.id)=36 "+
    "AND NOT EXISTS (SELECT 1 FROM listening_refill_clips c WHERE c.set_id=d.id "+
    "AND (c.status<>'uploaded' OR c.object_key IS NULL OR c.bytes<1024)) "+
    "AND ("+UNUSED_SQL+")<=?"
  ).bind(candidate.id,LIMIT);
  const marked=env.DB.prepare(
    "UPDATE listening_refill_drafts SET state='published',updated_at=datetime('now') "+
    "WHERE id=? AND state IN ('rendering','ready') "+
    "AND EXISTS (SELECT 1 FROM listening_sets s WHERE s.id=?)"
  ).bind(candidate.id,candidate.id);
  const changes=await env.DB.batch([inserted,marked]);
  return changes[0]?.meta?.changes===1&&changes[1]?.meta?.changes===1?
    {result:"published-from-reserve",setId:candidate.id,
      unused:status.unattemptedListeningSets}:
    {result:"concurrent-or-threshold-changed"};
}
