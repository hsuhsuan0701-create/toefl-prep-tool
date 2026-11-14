/**
 * One-clip Gemini 3.8 TTS audition from an EXISTING canonical Listening Set.
 * Reuses the original buildRenderPlan, voices, scene and pace policy. Not a
 * duplicate Listening generator, and NEVER publishes or overwrites existing MP3s.
 *
 * Dry-run by default:
 * node --import tsx scripts/pilot-gemini38-tts.mjs --set lsn-03948a55 --role conversation
 *
 * One paid request maximum, when explicitly asked:
 * node --import tsx scripts/pilot-gemini38-tts.mjs --set lsn-03948a55 --role conversation --execute
 */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {ListeningSetSchema} from "../shared/src/index.ts";
import {buildRenderPlan,deliveryNotes,spokenWordCount} from "../server/src/services/listeningAudioRenderer.ts";
import {ACCENT_DIRECTION,pacingDirection} from "../server/src/services/audioPrompt.ts";
import {assessPace} from "../server/src/services/audioPace.ts";
import {inspectPcmWav,inspectExpectedDuration} from "./lib/listening-audio-sanity.mjs";

const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const argv=process.argv.slice(2);
function opt(flag,defaultValue){
 const index=argv.indexOf("--"+flag);
 return index<0?defaultValue:argv[index+1];
}
function fail(message){process.stderr.write(message+"\n");process.exitCode=1;}
const setId=opt("set","lsn-03948a55");
const role=opt("role","conversation");
const model=opt("model","gemini-3.8-flash-lite-tts");
const execute=argv.includes("--execute");
const allowed=new Set(["lcr-utterance","conversation","announcement","academic-talk"]);
if(!/^lsn-[A-Za-z0-9_-]{1,60}$/.test(setId))throw Error("Invalid Set ID");
if(!allowed.has(role))throw Error("Invalid Listening role");
if(!["gemini-3.8-flash-lite-tts","gemini-3.8-flash-tts"].includes(model))throw Error("Unsupported pilot TTS model");
const source=join(root,"data","question-sets","listening",setId+".json");
const set=ListeningSetSchema.parse(JSON.parse(readFileSync(source,"utf8")));
const clip=buildRenderPlan(set).find(item=>item.role===role);
if(!clip)throw Error("No matching clip in this existing Listening Set");
const notes=deliveryNotes(clip);
const style=[notes.audioProfile,notes.scene,notes.style,
 ACCENT_DIRECTION[notes.accent],pacingDirection(notes.band),
 "Do not insert words, omit words or speak stage directions."].join(". ");
function buildParts(){
 if(!clip.speakers?.length)return [{text:clip.text,speechMetadata:{style}}];
 // The new 3.8 endpoint requires each turn in a separate Part, not
 // the legacy "Speaker: text" verbal transcript.
 return clip.text.split("\n").map(line=>{
  const speaker=clip.speakers.find(s=>line.startsWith(s.speaker+": "));
  if(!speaker)throw Error("Invalid conversation speaker label");
  return {text:line.slice(speaker.speaker.length+2),speechMetadata:{speaker:speaker.speaker,style}};
 });
}
const requestBody={
 contents:[{role:"user",parts:buildParts()}],
 generationConfig:{
  responseModalities:["AUDIO"],
  speechConfig:clip.speakers?.length?{
   multiSpeakerVoiceConfig:{speakerVoiceConfigs:clip.speakers.map(s=>({
    speaker:s.speaker,voiceConfig:{voice:s.voice}
   }))}
  }:{voiceConfig:{voice:clip.voice}}
 }
};
const estimateMinutes=spokenWordCount(clip.text,clip.speakers)/notes.band.targetWpm;
process.stdout.write(JSON.stringify({
 phase:execute?"one paid request":"dry-run (no API calls)",
 setId,stimulusId:clip.stimulusId,role,model,
 speakerCount:clip.speakers?.length??1,
 wordCount:spokenWordCount(clip.text,clip.speakers),
 targetWpm:notes.band.targetWpm,
 estimatedMinutes:+estimateMinutes.toFixed(3),
 output:"tmp/tts-trials/"+setId+"/"+clip.stimulusId,
 },null,2)+"\n");
if(!execute){
 process.stdout.write("Dry-run complete. Nothing was generated, charged, uploaded or published.\n");
 process.exit(0);
}
const outputDir=join(root,"tmp","tts-trials",setId);
const outputWav=join(outputDir,clip.stimulusId+"-"+model+".wav");
const outputMp3=join(outputDir,clip.stimulusId+"-"+model+".mp3");
if(existsSync(outputWav)||existsSync(outputMp3))
 throw Error("Trial already exists; refusing paid regeneration or overwrite. Choose another clip.");
const key=process.env.GEMINI_API_KEY;
if(!key){fail("GEMINI_API_KEY is not set locally. Never paste your key into chat, Git or a command argument.");}
else {
 const url="https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent";
 let res;
 try{
  // Deliberately no API-level retries for this first quality/cost trial.
  res=await fetch(url,{method:"POST",
   headers:{"Content-Type":"application/json","x-goog-api-key":key},
   body:JSON.stringify(requestBody),signal:AbortSignal.timeout(120000)});
 }catch(e){fail("TTS request failed before receiving a response: "+(e.name||"network"));}
 if(res){
  if(!res.ok)fail("Gemini TTS HTTP "+res.status+" (no automatic retry)");
  else{
   const json=await res.json();
   const audio=json.candidates?.[0]?.content?.parts?.find(p=>p.inlineData?.data)?.inlineData;
   if(!audio?.data)fail("TTS returned no audio");
   else {
    const bytes=Buffer.from(audio.data,"base64");
    if(bytes.length<1000||bytes.subarray(0,4).toString("ascii")!=="RIFF"||
       bytes.subarray(8,12).toString("ascii")!=="WAVE") {
      fail("Unexpected audio format: Gemini 3.8 unary output must be a WAV with RIFF header");
    } else {
      mkdirSync(outputDir,{recursive:true});
      const wav=outputWav;
      const mp3=outputMp3;
      writeFileSync(wav,bytes,{flag:"wx"});
      let sanity;
      try {
        sanity=inspectPcmWav(bytes);
        const duration=inspectExpectedDuration(sanity,spokenWordCount(clip.text,clip.speakers),notes.band.targetWpm);
        process.stdout.write(JSON.stringify({
          check:"offline WAV sanity (no API usage)",
          ...sanity,...duration,
          warnings:[
            ...(!duration.durationPlausible?["implausible duration"]:[]),
            ...(sanity.longSilences.length?["long silence requires listening review"]:[])
          ],
          caveat:"Cannot detect repeated or overlapping speech or omitted words without listening or transcription"
        },null,2)+"\n");
        if(!duration.durationPlausible){
          fail("WAV duration implausible: retaining original file for manual inspection; conversion skipped");
        }
      } catch(e) {
        fail("WAV inspection failed; keeping original file and skipping conversion: "+(e instanceof Error?e.message:"unknown"));
      }
      if (!sanity || !inspectExpectedDuration(sanity,spokenWordCount(clip.text,clip.speakers),notes.band.targetWpm).durationPlausible) {
        // Explicitly no automatic Gemini retry, paid transcription, or publication.
      } else {
      const conversion=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-y",
       "-i",wav,"-codec:a","libmp3lame","-qscale:a","3",mp3],{timeout:60000,encoding:"utf8"});
      if(conversion.status!==0)fail("WAV saved, but ffmpeg could not convert it to MP3.");
      else{
       const probe=spawnSync("ffprobe",["-v","error","-show_entries","format=duration",
        "-of","default=noprint_wrappers=1:nokey=1",mp3],{encoding:"utf8",timeout:15000});
       const duration=Number(probe.stdout.trim());
       const assessment=assessPace({wordCount:spokenWordCount(clip.text,clip.speakers),
        durationSec:duration,band:notes.band});
       process.stdout.write(JSON.stringify({
        status:"saved for manual listening only",wav,mp3,
        durationSec:Number.isFinite(duration)?+duration.toFixed(2):null,
        pace:assessment.verdict,approxWpm:+assessment.wpm.toFixed(1),
        published:false,r2Uploaded:false
       },null,2)+"\n");
      }
      }
    }
   }
  }
 }
}
