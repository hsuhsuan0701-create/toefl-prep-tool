/**
 * Free, deterministic WAV envelope checks for Gemini TTS output.
 * Deliberately NO speech-to-text, AI listening judge, API request or re-synthesis.
 * Can identify malformed/truncated WAV, large silent gaps and implausible duration.
 * CANNOT reliably detect speaker overlap, repeated words, pronunciation or omissions.
 */
export function inspectPcmWav(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length < 44 || bytes.toString("ascii",0,4) !== "RIFF" ||
      bytes.toString("ascii",8,12) !== "WAVE") {
    throw new Error("Invalid WAV RIFF/WAVE header");
  }
  const declaredSize = bytes.readUInt32LE(4) + 8;
  if (declaredSize > bytes.length) throw new Error("Truncated WAV RIFF data");
  let fmt, data;
  for (let pos=12; pos+8<=declaredSize;) {
    const id=bytes.toString("ascii",pos,pos+4), size=bytes.readUInt32LE(pos+4);
    const start=pos+8, end=start+size;
    if (end>declaredSize || end>bytes.length) throw new Error("Truncated WAV chunk "+id);
    if (id==="fmt " && !fmt) {
      if (size<16) throw new Error("Invalid WAV fmt chunk");
      fmt={
        encoding:bytes.readUInt16LE(start),
        channels:bytes.readUInt16LE(start+2),
        sampleRate:bytes.readUInt32LE(start+4),
        byteRate:bytes.readUInt32LE(start+8),
        blockAlign:bytes.readUInt16LE(start+12),
        bitsPerSample:bytes.readUInt16LE(start+14),
      };
    }
    if (id==="data" && !data) data={start,size};
    pos=end+(size%2);
  }
  if (!fmt || !data) throw new Error("WAV is missing fmt or data");
  if (fmt.encoding!==1 || fmt.bitsPerSample!==16 || fmt.channels<1 || fmt.channels>2 ||
      fmt.sampleRate<8000 || fmt.sampleRate>96000 ||
      fmt.blockAlign!==fmt.channels*2 || fmt.byteRate!==fmt.sampleRate*fmt.blockAlign) {
    throw new Error("Unsupported WAV encoding; expected PCM16 at a valid sample rate");
  }
  if (data.size<fmt.blockAlign || data.size%fmt.blockAlign!==0)
    throw new Error("Invalid WAV sample data length");
  const frames=data.size/fmt.blockAlign;
  const durationSec=frames/fmt.sampleRate;
  if (!Number.isFinite(durationSec) || durationSec<=0) throw new Error("Empty WAV audio");

  // Probe waveform levels in 100-ms windows; skip samples to cap CPU time on long talks.
  // Silence warnings are advisory only; pauses are normal speech phenomena.
  const framePerWindow=Math.max(1,Math.round(fmt.sampleRate/10));
  const windowSilence=[];
  let maxAbs=0, sumSquares=0, inspected=0;
  for(let start=0;start<frames;start+=framePerWindow){
    const end=Math.min(frames,start+framePerWindow);
    let windowPeak=0;
    for(let frame=start;frame<end;frame+=4){
      let peak=0;
      for(let channel=0;channel<fmt.channels;channel++){
        const amplitude=Math.abs(bytes.readInt16LE(data.start+frame*fmt.blockAlign+channel*2));
        peak=Math.max(peak,amplitude);
      }
      maxAbs=Math.max(maxAbs,peak);
      windowPeak=Math.max(windowPeak,peak);
      sumSquares+=peak*peak;inspected++;
    }
    windowSilence.push(windowPeak<328); // approximately -40 dBFS
  }
  if(maxAbs===0)throw new Error("Silent WAV: all probed samples are zero");
  const longSilences=[];
  let silentStart=-1;
  for(let i=0;i<=windowSilence.length;i++){
    if(i<windowSilence.length&&windowSilence[i]){
      if(silentStart<0)silentStart=i;
    }else if(silentStart>=0){
      if(i-silentStart>=15)longSilences.push({
        startSec:+(silentStart/10).toFixed(1),
        endSec:+(Math.min(durationSec,i/10)).toFixed(1)
      });
      silentStart=-1;
    }
  }
  return {
    durationSec:+durationSec.toFixed(3),
    sampleRate:fmt.sampleRate,
    channels:fmt.channels,
    peakDbfs:+(20*Math.log10(maxAbs/32768)).toFixed(1),
    rmsDbfs:+(20*Math.log10(Math.sqrt(sumSquares/inspected)/32768)).toFixed(1),
    longSilences, // >=1.5s quiet runs; hints only
    format:"pcm16-wav",
  };
}

export function inspectExpectedDuration(wav, wordCount, targetWpm) {
  if(!Number.isFinite(wordCount)||wordCount<=0||!Number.isFinite(targetWpm)||targetWpm<=0)
    throw new Error("Invalid speech rate inputs");
  const expectedSec=wordCount/targetWpm*60;
  return {
    expectedSec:+expectedSec.toFixed(2),
    roughWpm:+(wordCount/wav.durationSec*60).toFixed(1),
    durationPlausible:wav.durationSec>=expectedSec*0.3 && wav.durationSec<=expectedSec*3,
    // WPM is rough because WAV duration INCLUDES intro/outro silence.
  };
}
