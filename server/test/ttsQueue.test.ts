import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeholderSpeakingSet } from "./helpers/setFixtures.js";
import {
  renderClipsBounded,
  setTtsConcurrencyForTests,
  ttsConcurrencyLimit,
  withTtsSlot,
} from "../src/services/ttsQueue.js";
import { renderSpeakingAudio } from "../src/services/speakingAudioRenderer.js";
import { buildRenderPlan, renderListeningAudio, spokenWordCount } from "../src/services/listeningAudioRenderer.js";
import { TRANSCRIPT_DELIMITER } from "../src/services/audioPrompt.js";
import type { TtsRequest } from "../src/services/tts.js";
import { LISTENING_FIXTURE } from "./fixtures/listening-set.fixture.js";

let dirs: string[] = [];
afterEach(() => {
  setTtsConcurrencyForTests();
  dirs.forEach((entry) => fs.rmSync(entry, { recursive: true, force: true }));
  dirs = [];
});
const tmpDir = (): string => {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "tts-queue-"));
  dirs.push(result);
  return result;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts concurrent entries into a region and remembers the high-water mark. */
function inFlightMeter() {
  let current = 0;
  let peak = 0;
  return {
    enter(): void {
      current += 1;
      peak = Math.max(peak, current);
    },
    leave(): void {
      current -= 1;
    },
    get peak(): number {
      return peak;
    },
  };
}

describe("the process-wide TTS bound", () => {
  it("defaults to 1, one clip at a time across both renderers", () => {
    // Unset, TTS_CONCURRENCY renders one clip at a time. Moving the default changes the call rate of
    // every render on a machine that never set it.
    expect(ttsConcurrencyLimit()).toBe(1);
  });

  it("never has more than `limit` tasks in flight, and admits waiters in submission order", async () => {
    setTtsConcurrencyForTests(3);
    const meter = inFlightMeter();
    const starts: number[] = [];

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        withTtsSlot(async () => {
          meter.enter();
          starts.push(index);
          // Later submissions finish sooner, so a slot is always freed out of submission order —
          // without FIFO admission the `starts` order below would drift.
          await sleep(1 + (12 - index));
          meter.leave();
        }),
      ),
    );

    expect(meter.peak).toBe(3);
    expect(starts).toEqual([...Array(12).keys()]);
  });

  it("is one queue for the whole process, not one per caller", async () => {
    setTtsConcurrencyForTests(2);
    const meter = inFlightMeter();
    const task = async (): Promise<void> => {
      await withTtsSlot(async () => {
        meter.enter();
        await sleep(5);
        meter.leave();
      });
    };

    // Three independent fan-outs, exactly as three Sets rendering at once would be.
    await Promise.all([
      Promise.all(Array.from({ length: 4 }, task)),
      Promise.all(Array.from({ length: 4 }, task)),
      Promise.all(Array.from({ length: 4 }, task)),
    ]);

    expect(meter.peak).toBe(2);
  });
});

describe("renderClipsBounded", () => {
  it("returns results in CLIP order even when the clips finish backwards", async () => {
    setTtsConcurrencyForTests(8);
    const finished: string[] = [];
    const clips = ["a", "b", "c", "d", "e", "f"];

    const results = await renderClipsBounded(clips, async (clip, index) => {
      await sleep(1 + (clips.length - index) * 3);
      finished.push(clip);
      return clip.toUpperCase();
    });

    // The premise: completion order really is not clip order here.
    expect(finished).not.toEqual(clips);
    expect(results).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("buys nothing more once a clip has failed", async () => {
    setTtsConcurrencyForTests(2);
    const started: number[] = [];

    await expect(
      renderClipsBounded(Array.from({ length: 10 }, (_, i) => i), async (_clip, index) => {
        started.push(index);
        if (index === 0) throw new Error("clip 0 exploded");
        await sleep(20);
        return index;
      }),
    ).rejects.toThrow("clip 0 exploded");

    // Clips 0 and 1 were admitted together; clip 0's slot then came free with the failure already
    // recorded, so the eight clips behind it were skipped rather than synthesized. Without that,
    // every failure would cost a whole Set of paid calls. (A clip admitted in the window between a
    // sibling's last await and its throw does start: the guarantee is about the recorded failure.)
    expect(started).toEqual([0, 1]);
  });

  it("settles every in-flight clip before the failure propagates", async () => {
    setTtsConcurrencyForTests(4);
    let settled = 0;
    let observedAtThrow = -1;

    const rendering = renderClipsBounded([0, 1, 2, 3], async (_clip, index) => {
      // Index 0 fails immediately; its three siblings are still mid-render. If the rejection
      // escaped now, a renderer's catch would delete the output directory while three syntheses
      // were still writing into it — the straggler that recreates the directory and makes every
      // later re-render collide.
      if (index === 0) throw new Error("first clip exploded");
      await sleep(20);
      settled += 1;
      return index;
    });

    await rendering.catch(() => {
      observedAtThrow = settled;
    });

    expect(observedAtThrow).toBe(3);
  });

  it("propagates the LOWEST-INDEXED failure, not the first one to happen", async () => {
    setTtsConcurrencyForTests(4);

    await expect(
      renderClipsBounded([0, 1, 2, 3], async (_clip, index) => {
        if (index === 3) throw new Error("clip 3 exploded");
        if (index === 1) {
          await sleep(10);
          throw new Error("clip 1 exploded");
        }
        await sleep(20);
        return index;
      }),
    ).rejects.toThrow("clip 1 exploded");
  });

  it("at limit 1 is exactly the serial loop: one clip at a time, in clip order", async () => {
    setTtsConcurrencyForTests(1);
    const meter = inFlightMeter();
    const order: number[] = [];

    await renderClipsBounded([0, 1, 2, 3, 4], async (_clip, index) => {
      meter.enter();
      order.push(index);
      await sleep(1);
      meter.leave();
      return index;
    });

    expect(meter.peak).toBe(1);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

// What makes the bound process-wide rather than per render: the Speaking and Listening renderers
// submit to the same queue. A per-renderer limiter would satisfy every test above and still let two
// Sets rendering at once double the call rate.
describe("both renderers share one bound", () => {
  // The clip's own spoken word count, written into the stub's output file so probeDuration can read
  // it back off the artifact — path-stable and concurrency-proof, unlike a call-indexed queue.
  const synthesizeWordCount = async (request: TtsRequest, outPath: string): Promise<void> => {
    const marker = request.text.indexOf(TRANSCRIPT_DELIMITER);
    expect(marker, "prompt must carry the transcript delimiter").toBeGreaterThan(-1);
    const transcript = request.text.slice(marker + TRANSCRIPT_DELIMITER.length);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, String(spokenWordCount(transcript, request.speakers)));
  };
  /** A probe that reports whatever duration puts this clip at `wpm`. */
  const probeAt = (wpm: number) => async (filePath: string): Promise<number> =>
    (Number(fs.readFileSync(filePath, "utf8")) / wpm) * 60;

  it("counts a Speaking render and a Listening render against the SAME limit", async () => {
    setTtsConcurrencyForTests(3);
    const meter = inFlightMeter();
    const synthesize = vi.fn(async (request: TtsRequest, outPath: string) => {
      meter.enter();
      await sleep(4);
      await synthesizeWordCount(request, outPath);
      meter.leave();
    });

    const speakingOut = path.join(tmpDir(), "spk");
    await Promise.all([
      // 165 WPM is inside every Speaking band and 155 inside all four Listening ones, so no clip
      // buys a corrective re-render and the call counts stay a function of the plans alone.
      renderSpeakingAudio(
        placeholderSpeakingSet("spk-queue"),
        { setId: "spk-queue", outputDir: speakingOut, audioPathPrefix: "stimuli/spk-queue" },
        { synthesize, probeDuration: probeAt(165) },
      ),
      renderListeningAudio(LISTENING_FIXTURE, {
        synthesize,
        probeDuration: probeAt(155),
        dataDir: tmpDir(),
      }),
    ]);

    // Both renders together, never more than the one configured bound in flight.
    expect(meter.peak).toBe(3);
    // And the bound was actually exercised rather than never reached: both Sets rendered in full,
    // one call per clip, with far more clips than slots.
    const clipCount = 13 + buildRenderPlan(LISTENING_FIXTURE).length;
    expect(synthesize).toHaveBeenCalledTimes(clipCount);
    expect(clipCount).toBeGreaterThan(3);
  });
});
