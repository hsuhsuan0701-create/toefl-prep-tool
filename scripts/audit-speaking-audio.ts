// Reports the pace of one published Speaking Set's clips, measured the way the renderer measured
// them: the speech span of each file the Set references, judged against the band the renderer
// planned for that clip from the Set's own recorded profile. Reads files from the data directory
// (TOEFL_DATA_DIR, or data/) and needs ffmpeg on PATH; makes no paid call.
//
//   npx tsx scripts/audit-speaking-audio.ts --set <speaking-set-id>
//
// Prints JSON: one entry per clip with measurements and provenance only, never clip text.
import path from "node:path";
import { config } from "../server/src/lib/config.js";
import { createSetStore } from "../server/src/services/setStore.js";
import { auditSpeakingSetAudio } from "../server/src/services/speakingAudioAudit.js";
import { probeSpeechDurationSec } from "../server/src/services/transcode.js";

const flag = process.argv.indexOf("--set");
const setId = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!setId || !/^[A-Za-z0-9_-]+$/.test(setId)) throw new Error("usage: --set <speaking-set-id>");
const set = createSetStore(config.dataDir).readSet(setId);
if (!set || set.kind !== "speaking") throw new Error(`no readable speaking set ${setId} in ${config.dataDir}`);

const clips = await auditSpeakingSetAudio(set, path.join(config.dataDir, "audio"), probeSpeechDurationSec);
console.log(JSON.stringify({ setId, clips }, null, 2));
