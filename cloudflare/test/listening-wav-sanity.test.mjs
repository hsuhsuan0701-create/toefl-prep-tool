import test from "node:test";
import assert from "node:assert/strict";
import {inspectPcmWav,inspectExpectedDuration} from "../../scripts/lib/listening-audio-sanity.mjs";

function wav(seconds=3,rate=24000) {
  const frames=Math.round(seconds*rate);
  const data=Buffer.alloc(frames*2);
  for(let i=0;i<frames;i++) data.writeInt16LE(Math.round(9000*Math.sin(2*Math.PI*440*i/rate)),i*2);
  const b=Buffer.alloc(44+data.length);
  b.write("RIFF",0);b.writeUInt32LE(36+data.length,4);b.write("WAVE",8);
  b.write("fmt ",12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);
  b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);
  b.write("data",36);b.writeUInt32LE(data.length,40);data.copy(b,44);
  return b;
}
test("offline WAV audit accepts real PCM16, yields timing and rough WPM without any API",()=>{
 const result=inspectPcmWav(wav());
 assert.equal(result.format,"pcm16-wav");
 assert.equal(result.durationSec,3);
 assert.equal(result.longSilences.length,0);
 const verdict=inspectExpectedDuration(result,8,160);
 assert.equal(verdict.durationPlausible,true);
 assert.equal(verdict.roughWpm,160);
});
test("offline WAV audit rejects truncated or silent output",()=>{
 const a=wav();
 assert.throws(()=>inspectPcmWav(a.subarray(0,100)),/Truncated/);
 const silent=wav();
 silent.fill(0,44);
 assert.throws(()=>inspectPcmWav(silent),/Silent/);
});
test("offline WAV audit reports long silence only as advisory, not hallucinated overlap verdict",()=>{
 const a=wav(5);
 a.fill(0,44+24000*2,44+24000*2*4);
 const result=inspectPcmWav(a);
 assert.ok(result.longSilences.some(r=>r.endSec-r.startSec>=1.5));
 assert.ok(!("overlapDetected" in result));
});
