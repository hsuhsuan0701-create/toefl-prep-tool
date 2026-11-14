/**
 * Serve only allowlisted, previously staged .mp3 Listening clips.
 * Cloudflare Access should protect the Worker. Never stage audio-manifest.json.
 */
import type { ListeningSet } from "@toefl-prep/shared";
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE = /^[A-Za-z0-9_-]+\.mp3$/;
export type AudioAssets = { fetch(req: Request): Promise<Response> };
export function listeningClips(set:ListeningSet):string[]{
 const items=[set.router,set.lowerModule,set.upperModule].flatMap(m=>[
   ...m.listenChoose,...m.conversations,...m.announcements,...m.academicTalks
 ]);
 const all=new Set<string>();
 for(const item of items) {
   const expected=new RegExp("^stimuli/"+set.id.replace(/[.*+?^$\{\}()|[\]\\]/g,"\\$&")+"/([A-Za-z0-9_-]+\\.mp3)$");
   const match=expected.exec(item.audio);
   if(!match || !SAFE.test(set.id) || !FILE.test(match[1]))
     throw new Error("Listening Set contains an unsupported audio path");
   all.add(item.audio);
 }
 if(all.size!==items.length)throw new Error("Listening Set reuses an audio filename");
 return [...all];
}
export function assetUrl(origin:string,audioPath:string):string {
 return origin+"/listening-audio/"+audioPath.slice("stimuli/".length);
}
export async function allAudioReady(assets:AudioAssets,set:ListeningSet,origin:string):Promise<boolean> {
 const clips=listeningClips(set);
 for(const path of clips) {
   const r=await assets.fetch(new Request(assetUrl(origin,path),{method:"HEAD"}));
   if(!r.ok || !r.headers.get("content-type")?.toLowerCase().includes("audio/mpeg"))
     return false;
 }
 return true;
}
export async function serveListeningAudio(req:Request,assets:AudioAssets):Promise<Response|null>{
 const m=/^\/api\/audio\/stimuli\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]+\.mp3)$/.exec(new URL(req.url).pathname);
 if(!m)return null;
 if(req.method!=="GET"&&req.method!=="HEAD")return new Response(null,{status:405});
 const origin=new URL(req.url).origin;
 const upstream=await assets.fetch(new Request(origin+"/listening-audio/"+m[1]+"/"+m[2],{method:req.method}));
 if(!upstream.ok||!upstream.headers.get("content-type")?.toLowerCase().includes("audio/mpeg"))
   return new Response(null,{status:404,headers:{"Cache-Control":"no-store"}});
 const hdr=new Headers(upstream.headers);
 hdr.set("Cache-Control","private, max-age=1800");
 hdr.set("X-Content-Type-Options","nosniff");
 return new Response(upstream.body,{status:upstream.status,headers:hdr});
}
