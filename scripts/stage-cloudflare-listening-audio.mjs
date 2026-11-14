/**
 * Stage ONLY MP3 clips for Cloudflare static assets. No audio-manifest.json,
 * question JSON, transcripts or answer keys can enter the public bundle.
 * Must run AFTER "npm run build -w client", BEFORE wrangler deploy.
 */
import { cpSync,existsSync,mkdirSync,readdirSync,statSync } from "node:fs";
import { resolve,join } from "node:path";
const root=resolve(import.meta.dirname,"..");
const bank=join(root,"data","question-sets","listening");
const audio=join(root,"data","audio","stimuli");
const output=join(root,"client","dist","listening-audio");
if(!existsSync(bank)||!existsSync(audio)||!existsSync(join(root,"client","dist","index.html")))
 throw Error("Run npm run build -w client first, and ensure original Listening data is present.");
let sets=0,clips=0;
for(const filename of readdirSync(bank)){
 if(!/^lsn-[A-Za-z0-9_-]{1,60}\.json$/.test(filename))continue;
 const id=filename.slice(0,-5);
 const src=join(audio,id);
 if(!existsSync(src)||!statSync(src).isDirectory())
  throw Error("Missing original MP3 folder for "+id);
 const files=readdirSync(src).filter(x=>/^[A-Za-z0-9_-]+\.mp3$/.test(x));
 if(!files.length)throw Error("No MP3s found for "+id);
 mkdirSync(join(output,id),{recursive:true});
 for(const file of files){cpSync(join(src,file),join(output,id,file));clips++;}
 sets++;
}
if(!sets)throw Error("No Listening Sets found.");
process.stdout.write("Staged "+clips+" MP3 files across "+sets+" Listening Sets. No JSON or manifest staged.\n");
