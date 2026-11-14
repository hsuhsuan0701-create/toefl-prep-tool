/**
 * Offline WAV inspection & optional MP3 conversion; no API calls at all.
 *
 * node scripts/check-listening-wav.mjs <WAV file>
 * node scripts/check-listening-wav.mjs <WAV file> --mp3
 */
import {existsSync,readFileSync} from "node:fs";
import {resolve,extname} from "node:path";
import {spawnSync} from "node:child_process";
import {inspectPcmWav} from "./lib/listening-audio-sanity.mjs";

const input=process.argv[2];
if (!input || extname(input).toLowerCase()!==".wav") {
  console.error("Usage: node scripts/check-listening-wav.mjs <filename.wav> [--mp3]");
  process.exitCode=2;
} else {
  const wav=resolve(input);
  try {
    if (!existsSync(wav)) throw new Error("WAV file does not exist");
    const analysis=inspectPcmWav(readFileSync(wav));
    console.log(JSON.stringify({
      offline:true,aiApiCalls:0, ...analysis,
      possibleLongSilences:analysis.longSilences.length>0,
      warning:"Waveform checks cannot reliably detect overlapping speakers, repeated or missing words. Listen before publishing."
    },null,2));
    if (process.argv.includes("--mp3")) {
      const mp3=wav.replace(/\.wav$/i,".mp3");
      if (existsSync(mp3)) throw new Error("MP3 exists; refusing to overwrite");
      const result=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-n","-i",wav,
        "-codec:a","libmp3lame","-qscale:a","3",mp3],
      {encoding:"utf8",timeout:60000});
      if (result.error || result.status!==0)
        throw new Error("ffmpeg failed. Install ffmpeg, then run again without any Gemini API call.");
      console.log("MP3 created: "+mp3);
    }
  }catch(e){
    console.error(e instanceof Error?e.message:"Offline audio check failed");
    process.exitCode=1;
  }
}
