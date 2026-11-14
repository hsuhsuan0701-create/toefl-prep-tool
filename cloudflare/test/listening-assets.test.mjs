import test from "node:test";
import assert from "node:assert/strict";
import {existsSync,readFileSync,readdirSync,statSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {ListeningSetSchema} from "../../shared/src/index.ts";
import {listeningClips} from "../src/listeningAudio.ts";
const data=fileURLToPath(new URL("../../data/",import.meta.url));
test("all canonical Listening Sets have every referenced MP3 in original bank",()=>{
 const bank=join(data,"question-sets","listening");
 const names=readdirSync(bank).filter(n=>/^lsn-.*\.json$/.test(n));
 assert.equal(names.length,14,"Expected 14 existing Listening Sets");
 let clips=0;
 for(const name of names){
  const set=ListeningSetSchema.parse(JSON.parse(readFileSync(join(bank,name),"utf8")));
  const paths=listeningClips(set);
  assert.ok(paths.length>=20,"Full Listening Set expected");
  for(const audio of paths){
   const filename=join(data,"audio",...audio.split("/"));
   assert.ok(existsSync(filename),"Missing original MP3: "+audio);
   assert.ok(statSync(filename).size>0,"Empty MP3: "+audio);
   clips++;
  }
 }
 assert.ok(clips>300);
});
