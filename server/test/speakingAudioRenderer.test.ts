import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeholderSpeakingSet } from "./helpers/setFixtures.js";
import { MAX_SET_ADVISORY_NOTES, SpeakingSetSchema, type SetAdvisoryNote, type SpeakingSet } from "@toefl-prep/shared";
import {
  AUDIO_ROLE_POLICY,
  buildSpeakingRenderPlan,
  deliveryNotes,
  listenAndRepeatClipCeilingSec,
  listenAndRepeatItemBand,
  LR_ITEM_BAND_FAST_MARGIN_WPM,
  renderSpeakingAudio,
  type SpeakingAudioRendererDeps,
} from "../src/services/speakingAudioRenderer.js";
import {
  LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM,
  LISTEN_AND_REPEAT_ITEM_TARGET_WPM,
  LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
  SpeakingAudioProfileSchema,
} from "@toefl-prep/shared";
import { median } from "../src/services/speakingAudioAudit.js";
import { profileForSetId } from "../src/services/speakingAudioProfile.js";
import { ACCENT_DIRECTION, buildDeliveryPrompt, TRANSCRIPT_DELIMITER } from "../src/services/audioPrompt.js";
import { config } from "../src/lib/config.js";
import { setTtsConcurrencyForTests } from "../src/services/ttsQueue.js";
import { collectClipTakes } from "./helpers/clipMeasurementSink.js";
import {
  resetClipMeasurementSink,
  setClipMeasurementSink,
} from "../src/services/clipMeasurementLog.js";

let dirs: string[] = [];
afterEach(() => { dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })); dirs = []; });
const dir = () => { const result = fs.mkdtempSync(path.join(os.tmpdir(), "speaking-render-")); dirs.push(result); return result; };
// `deps` carries synthesize and probeDuration and nothing else; the "no model guard" test below
// relies on that, and the type enforces it here.
// Durations are per clip, in clip order: assigned on the first probe of each clip and reused for any
// later take of the same clip. A serial render probes clips in plan order, so `durations[i]` is clip
// i's, and a retake measures the same as the take it corrects, which is what lets a test express
// "corrected and still out of band". A stub indexed by probe call would hand every clip after a
// retake its predecessor's duration.
function fake(durations: number[], calls: any[] = []): SpeakingAudioRendererDeps {
  let next = 0;
  const byClip = new Map<string, number>();
  const clipKey = (file: string): string =>
    path.basename(file).replace(/^\./u, "").replace(/(?:\.retake)?\.tmp$/u, "");
  return {
    synthesize: vi.fn(async (request, file) => { calls.push({ request, file }); fs.writeFileSync(file, "audio"); }),
    probeDuration: vi.fn(async (file: string) => {
      const key = clipKey(file);
      if (!byClip.has(key)) byClip.set(key, durations[next++]!);
      return byClip.get(key)!;
    }),
  };
}
// Word counts, per role, of placeholderSpeakingSet: briefing 5, each lr-item 7, intro 6, each question 8.
// Durations chosen so every clip lands on its own band's target: briefing 166.7 WPM (145-195), intro
// 163.6 (145-195), questions 154.8 (130-180), and each Listen and Repeat item at its own per-item
// target from LISTEN_AND_REPEAT_ITEM_TARGET_WPM (226 for items 1-3, 184 for items 4-7).
const LR_GOOD = LISTEN_AND_REPEAT_ITEM_TARGET_WPM.map((targetWpm) =>
  Number(((7 / targetWpm) * 60).toFixed(3)),
);
const good = [1.8, ...LR_GOOD, 2.2, ...Array(4).fill(3.1)];
const output = () => path.join(dir(), "target");
const target = (outputDir = output()) => ({ setId: "spk-001", outputDir, audioPathPrefix: "stimuli/spk-001" });

/** The clip's own text, recovered from the prompt the renderer actually sent. */
function transcriptOf(request: { text: string }): string {
  const marker = request.text.indexOf(TRANSCRIPT_DELIMITER);
  expect(marker, "prompt must carry the transcript delimiter").toBeGreaterThan(-1);
  return request.text.slice(marker + TRANSCRIPT_DELIMITER.length + 1);
}

describe("utilities", () => {
  it("finds defensive medians", () => {
    expect(median([3,1,2])).toBe(2); expect(median([4,1,3,2])).toBe(2.5); expect(() => median([])).toThrow();
  });
});
// The seven Listen and Repeat items share a role but not a band, so a clip's pace comes from the
// profile rather than from `role`.
describe("listenAndRepeatItemBand", () => {
  // The two edges come from different places. The slow edge is one floor for every item, derived
  // from the clip ceiling (the rate at which the longest permitted sentence exactly fills 5.0 s),
  // because that is the edge an over-length clip falls out of; the fast edge is a margin above the
  // item's own target. The band is asymmetric on purpose.
  it("bands each item between one derived floor and its own target plus the fast margin", () => {
    const profile = profileForSetId("spk-001");
    const bands = LISTEN_AND_REPEAT_ITEM_TARGET_WPM.map((_, index) =>
      listenAndRepeatItemBand(profile, index),
    );
    expect(bands.map((band) => band.targetWpm)).toEqual([...LISTEN_AND_REPEAT_ITEM_TARGET_WPM]);
    expect(bands).toEqual([
      { targetWpm: 226, minWpm: 156, maxWpm: 251 },
      { targetWpm: 226, minWpm: 156, maxWpm: 251 },
      { targetWpm: 226, minWpm: 156, maxWpm: 251 },
      // -28/+25 around 184: close to the spread a pilot measured for clips of these lengths.
      { targetWpm: 184, minWpm: 156, maxWpm: 209 },
      { targetWpm: 184, minWpm: 156, maxWpm: 209 },
      { targetWpm: 184, minWpm: 156, maxWpm: 209 },
      { targetWpm: 184, minWpm: 156, maxWpm: 209 },
    ]);
    for (const band of bands) {
      expect(band.maxWpm - band.targetWpm).toBe(LR_ITEM_BAND_FAST_MARGIN_WPM);
      expect(band.minWpm).toBe(LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM);
    }
    // Items 1-3 are paced strictly faster than items 4-7 — the whole shape, read off a real profile.
    expect(Math.min(...bands.slice(0, 3).map((band) => band.targetWpm)))
      .toBeGreaterThan(Math.max(...bands.slice(3).map((band) => band.targetWpm)));
  });

  it("reads the band off the profile, so a v1/v2/v3 Set keeps the flat band it was rendered under", () => {
    const legacy = SpeakingAudioProfileSchema.parse({
      version: "ets-2026-v3", provider: "gemini", model: "gemini-3.1-flash-tts-preview",
      listenAndRepeat: { accent: "british", voice: "Gacrux", briefingTargetWpm: 165, itemTargetWpm: 180 },
      interview: { accent: "australian", voice: "Despina", introTargetWpm: 165, questionTargetWpm: 155 },
    });
    for (const index of [0, 3, 6]) {
      expect(listenAndRepeatItemBand(legacy, index)).toEqual(AUDIO_ROLE_POLICY["lr-item"]);
    }
  });

  it("gives an out-of-range index the seventh item's band rather than nothing", () => {
    const profile = profileForSetId("spk-001");
    expect(listenAndRepeatItemBand(profile, 7)).toEqual(listenAndRepeatItemBand(profile, 6));
    expect(listenAndRepeatItemBand(profile, -1)).toEqual(listenAndRepeatItemBand(profile, 0));
  });
});

describe("AUDIO_ROLE_POLICY", () => {
  it("keeps all four roles' bands, unchanged, with min <= target <= max and no speed of any kind", () => {
    expect(Object.keys(AUDIO_ROLE_POLICY).sort()).toEqual([
      "interview-intro", "interview-question", "lr-briefing", "lr-item",
    ]);
    expect(AUDIO_ROLE_POLICY["lr-briefing"]).toEqual({ targetWpm: 165, minWpm: 145, maxWpm: 195 });
    expect(AUDIO_ROLE_POLICY["lr-item"]).toEqual({ targetWpm: 180, minWpm: 150, maxWpm: 225 });
    expect(AUDIO_ROLE_POLICY["interview-intro"]).toEqual({ targetWpm: 165, minWpm: 145, maxWpm: 195 });
    expect(AUDIO_ROLE_POLICY["interview-question"]).toEqual({ targetWpm: 155, minWpm: 130, maxWpm: 180 });
    for (const band of Object.values(AUDIO_ROLE_POLICY)) {
      expect(band.minWpm).toBeLessThanOrEqual(band.targetWpm);
      expect(band.targetWpm).toBeLessThanOrEqual(band.maxWpm);
      // Gemini has no rate parameter, so a speed on a band would direct nothing.
      expect(band).not.toHaveProperty("initialSpeed");
    }
  });
});

describe("renderSpeakingAudio", () => {
  it("builds the canonical thirteen-clip plan used by validation and rendering", () => {
    const set = placeholderSpeakingSet();
    const plan = buildSpeakingRenderPlan(set, profileForSetId(set.id));

    expect(plan.map((clip) => clip.file)).toEqual([
      "briefing.mp3",
      "lr-1.mp3", "lr-2.mp3", "lr-3.mp3", "lr-4.mp3", "lr-5.mp3", "lr-6.mp3", "lr-7.mp3",
      "int-intro.mp3",
      "q-1.mp3", "q-2.mp3", "q-3.mp3", "q-4.mp3",
    ]);
    expect(plan.map((clip) => clip.text)).toEqual([
      set.listenAndRepeat.scenarioDescription,
      ...set.listenAndRepeat.items.map((item) => item.sentence),
      set.interview.intro,
      ...set.interview.questions.map((question) => question.question),
    ]);
    // The plan gives each clip its own band: each Listen and Repeat item the one its profile target
    // defines, the other three roles the per-role policy.
    expect(plan.map((clip) => clip.band)).toEqual([
      AUDIO_ROLE_POLICY["lr-briefing"],
      ...LISTEN_AND_REPEAT_ITEM_TARGET_WPM.map((_, index) =>
        listenAndRepeatItemBand(profileForSetId(set.id), index),
      ),
      AUDIO_ROLE_POLICY["interview-intro"],
      ...Array(4).fill(AUDIO_ROLE_POLICY["interview-question"]),
    ]);
    // Two distinct targets across the seven items, one for each pacingDirection line they select
    // (audioPrompt.ts): Gemini is paced by prose, and a target that selects no line of its own
    // changes nothing the model hears.
    expect(new Set(plan.slice(1, 8).map((clip) => clip.band.targetWpm)).size).toBe(2);
  });

  it("emits the set-ID checkpoint before creating any output directory", async () => {
    const parent = dir();
    const outputParent = path.join(parent, "new-parent");
    const outputDir = path.join(outputParent, "target");
    const deps = fake(good);

    await expect(renderSpeakingAudio(placeholderSpeakingSet(), target(outputDir), deps, (progress) => {
      expect(progress).toEqual({ done: 0, total: 13, setId: "spk-001" });
      expect(fs.existsSync(outputParent)).toBe(false);
      throw new Error("stop after durable set-ID checkpoint");
    })).rejects.toThrow("stop after durable set-ID checkpoint");

    expect(deps.synthesize).not.toHaveBeenCalled();
    expect(fs.existsSync(outputParent)).toBe(false);
  });

  it("rejects a pre-existing output directory before a paid call and preserves its sentinel", async () => {
    const parent=dir(); const outputDir=path.join(parent,"owned-target"); fs.mkdirSync(outputDir); const sentinel=path.join(outputDir,"sentinel.txt"); fs.writeFileSync(sentinel,"keep"); const deps=fake(good);
    await expect(renderSpeakingAudio(placeholderSpeakingSet(),target(outputDir),deps)).rejects.toThrow(); expect(deps.synthesize).not.toHaveBeenCalled(); expect(fs.readFileSync(sentinel,"utf8")).toBe("keep");
  });
  it("gives concurrent renderers exclusive output ownership without cross-cleanup", async () => {
    const parent=dir(); const outputDir=path.join(parent,"owned-target"); let release!: () => void; const started=new Promise<void>(resolve => { release=resolve; }); let entered!: () => void; const enteredSynthesis=new Promise<void>(resolve => { entered=resolve; });
    const first=fake(good); first.synthesize=vi.fn(async (_request,file) => { entered(); await started; fs.writeFileSync(file,"audio"); }); const second=fake(good);
    const owner=renderSpeakingAudio(placeholderSpeakingSet(),target(outputDir),first); await enteredSynthesis; await expect(renderSpeakingAudio(placeholderSpeakingSet(),target(outputDir),second)).rejects.toThrow(); expect(second.synthesize).not.toHaveBeenCalled(); release(); await owner; expect(fs.existsSync(path.join(outputDir,"audio-manifest.json"))).toBe(true); expect(fs.readdirSync(parent)).toEqual(["owned-target"]);
  });
  it("rejects invalid item IDs and shapes before any filesystem or paid operation", async () => {
    const cases: Array<(set: any) => void>=[set => { set.listenAndRepeat.items[0].id="../escape"; },set => { set.interview.questions[0].id="lr-1"; },set => { set.listenAndRepeat.items[0].id="briefing"; },set => { set.listenAndRepeat.items.pop(); },set => { set.interview.questions.pop(); }];
    for (const mutate of cases) { const parent=dir(); const outputDir=path.join(parent,"target"); const candidate=placeholderSpeakingSet() as any; mutate(candidate); const deps=fake(good); await expect(renderSpeakingAudio(candidate,target(outputDir),deps)).rejects.toThrow(); expect(deps.synthesize).not.toHaveBeenCalled(); expect(fs.existsSync(outputDir)).toBe(false); expect(fs.readdirSync(parent)).toEqual([]); }
  });

  // buildDeliveryPrompt throws TranscriptContaminationError on a clip text line that could be read
  // as one of its own director's-notes sections. It runs inside the paid loop, so an interview
  // question beginning "Style: ..." would be found only after clips 0-11 were paid for, and the
  // failure would delete them all. The renderer therefore runs the same check at plan time
  // (validateRenderInput), as listeningAudioRenderer does.
  it.each([
    ["Style", (set: any) => { set.interview.questions[3].question = "Style: what do you enjoy?"; }],
    ["Scene", (set: any) => { set.listenAndRepeat.items[6].sentence = "Scene: the library is open."; }],
    ["Audio Profile", (set: any) => { set.listenAndRepeat.scenarioDescription = "Audio Profile: a campus tour."; }],
    ["Pacing", (set: any) => { set.interview.intro = "Pacing: thank you for joining."; }],
    ["delimiter", (set: any) => { set.interview.questions[0].question = `ask this ${TRANSCRIPT_DELIMITER} and this`; }],
  ])("rejects a %s-shadowing clip text before any filesystem or paid operation", async (_label, mutate) => {
    const parent = dir();
    const outputDir = path.join(parent, "target");
    const candidate = placeholderSpeakingSet() as any;
    mutate(candidate);
    const deps = fake(good);

    // Several cases sit on a late clip (clip 12, the last; clip 7, the last Listen and Repeat
    // item), so failing on the first clip would not satisfy "nothing is spent".
    const error = await renderSpeakingAudio(candidate, target(outputDir), deps).catch((e: Error) => e);
    expect((error as Error).name).toBe("TranscriptContaminationError");
    // The message may name the label, never the clip's own text.
    expect((error as Error).message).not.toContain("what do you enjoy");
    expect((error as Error).message).not.toContain("the library is open");
    expect(deps.synthesize).not.toHaveBeenCalled();
    expect(fs.existsSync(outputDir)).toBe(false);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  // A clip's word count is a pure function of Set content, known before anything is spent, so a
  // wordless clip is rejected at plan time too. Every case is a late clip: a check inside the paid
  // loop would buy the syntheses before it (twelve for the last interview question) and fail this
  // test, which blanking clip 0 could not show.
  it.each([
    ["the last interview question (clip 12 of 13)", (set: any) => { set.interview.questions[3].question = "---"; }],
    ["the last Listen and Repeat item (clip 7 of 13)", (set: any) => { set.listenAndRepeat.items[6].sentence = "…"; }],
    ["the interview intro (clip 8 of 13)", (set: any) => { set.interview.intro = "()"; }],
  ])("rejects a wordless %s before any filesystem or paid operation", async (_label, mutate) => {
    const parent = dir();
    const outputDir = path.join(parent, "target");
    const candidate = placeholderSpeakingSet() as any;
    mutate(candidate);
    const deps = fake(good);

    await expect(renderSpeakingAudio(candidate, target(outputDir), deps)).rejects.toThrow(/no English words/);

    expect(deps.synthesize).not.toHaveBeenCalled();
    expect(fs.existsSync(outputDir)).toBe(false);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it("renders exactly thirteen clips, one synthesis each, through Gemini with the profile's own voices", async () => {
    const calls: any[] = [], progress: any[] = [];
    const set = placeholderSpeakingSet();
    const result = await renderSpeakingAudio(set, target(), fake(good, calls), p => progress.push(p));

    expect(result.measurements.map(x => x.file)).toEqual(["briefing.mp3","lr-1.mp3","lr-2.mp3","lr-3.mp3","lr-4.mp3","lr-5.mp3","lr-6.mp3","lr-7.mp3","int-intro.mp3","q-1.mp3","q-2.mp3","q-3.mp3","q-4.mp3"]);
    // One synthesis per clip: every clip lands in its band, and only a miss buys a corrective
    // re-render.
    expect(calls).toHaveLength(13);

    // Provider and voice are read off the profile, never written a second time as a literal, so a
    // request cannot pair one provider with another provider's voice name.
    const profile = profileForSetId("spk-001");
    expect(profile.provider).toBe("gemini");
    expect(profile.listenAndRepeat.voice).not.toBe(profile.interview.voice);
    expect(calls.every(x => x.request.provider === "gemini")).toBe(true);
    expect(calls.slice(0,8).every(x => x.request.voice === profile.listenAndRepeat.voice)).toBe(true);
    expect(calls.slice(8).every(x => x.request.voice === profile.interview.voice)).toBe(true);
    // The transport is deliberately dumb about prompt structure: everything is in `text`. And
    // Gemini has no rate parameter, so no `speed` is sent at all; nor is `speakers` — Speaking
    // clips are single-speaker.
    expect(calls.every(x => x.request.instructions === undefined && x.request.speed === undefined && x.request.speakers === undefined)).toBe(true);

    expect(result.set.listenAndRepeat.introAudio).toBe("stimuli/spk-001/briefing.mp3");
    expect(result.set.listenAndRepeat.items[0].audio).toBe("stimuli/spk-001/lr-1.mp3");
    expect(result.set.interview.introAudio).toBe("stimuli/spk-001/int-intro.mp3");
    expect(result.set.interview.questions[3].audio).toBe("stimuli/spk-001/q-4.mp3");
    expect(result.set.audioProfile).toEqual(result.profile);
    expect(progress.map(x=>x.done)).toEqual(Array.from({length:14},(_,i)=>i));
    expect(progress.every(x => x.total === 13 && x.setId === "spk-001")).toBe(true);
  });

  it("sends the built delivery prompt, with the clip's own text after the delimiter and nothing else", async () => {
    const calls: any[] = [];
    const set = placeholderSpeakingSet();
    await renderSpeakingAudio(set, target(), fake(good, calls));
    const profile = profileForSetId("spk-001");

    // Byte-for-byte the prompt audioPrompt.ts builds from this role's director's notes.
    expect(calls[0].request.text).toBe(buildDeliveryPrompt(
      deliveryNotes({ role: "lr-briefing", accent: profile.listenAndRepeat.accent, band: AUDIO_ROLE_POLICY["lr-briefing"] }),
      set.listenAndRepeat.scenarioDescription,
    ));
    expect(calls[1].request.text).toBe(buildDeliveryPrompt(
      deliveryNotes({ role: "lr-item", accent: profile.listenAndRepeat.accent, band: listenAndRepeatItemBand(profile, 0) }),
      set.listenAndRepeat.items[0].sentence,
    ));
    expect(calls[9].request.text).toBe(buildDeliveryPrompt(
      deliveryNotes({ role: "interview-question", accent: profile.interview.accent, band: AUDIO_ROLE_POLICY["interview-question"] }),
      set.interview.questions[0].question,
    ));

    // The per-item targets must reach the model as different direction, or nothing acts on them.
    // Items 1-3 (226 WPM) get the fast line; items 4-7 (184) the ordinary-talk one.
    const pacingOf = (index: number): string =>
      /^Pacing: .*$/mu.exec(calls[index].request.text)![0];
    expect(pacingOf(1)).toContain("quickly");
    expect(pacingOf(3)).toBe(pacingOf(1));
    // 184 must select its own "one continuous phrase" line, not either neighbour: paid pilots
    // measured the "easy, conversational" line at about 160 WPM of speech and the "brisk, fluent"
    // one at about 200, either side of ETS's 184.
    expect(pacingOf(7)).toContain("continuous");
    expect(pacingOf(7)).not.toContain("conversational");
    expect(pacingOf(7)).not.toContain("brisk");
    expect(pacingOf(7)).not.toBe(pacingOf(1));

    // Whatever the header says, the material after the delimiter is exactly the clip's own text.
    expect(transcriptOf(calls[0].request)).toBe(set.listenAndRepeat.scenarioDescription);
    set.listenAndRepeat.items.forEach((item, i) => expect(transcriptOf(calls[1 + i].request)).toBe(item.sentence));
    expect(transcriptOf(calls[8].request)).toBe(set.interview.intro);
    set.interview.questions.forEach((question, i) => expect(transcriptOf(calls[9 + i].request)).toBe(question.question));

    // Each task's accent reaches the model as audioPrompt's named-region direction, not a bare enum.
    expect(calls[0].request.text).toContain(ACCENT_DIRECTION[profile.listenAndRepeat.accent]);
    expect(calls[9].request.text).toContain(ACCENT_DIRECTION[profile.interview.accent]);
    // The role-specific direction is real prose and reaches the prompt.
    expect(calls[1].request.text).toContain("one sentence a test taker will hear once and repeat");
    expect(calls[9].request.text).toContain("an interviewer asking a question");
  });

  it("publishes the current (v6) profile and a manifest whose seven Listen and Repeat clips land on their per-item targets", async () => {
    const outputDir = output();
    const result = await renderSpeakingAudio(placeholderSpeakingSet(), target(outputDir), fake(good));
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "audio-manifest.json"), "utf8"));

    expect(result.profile).toEqual(profileForSetId("spk-001"));
    expect(result.profile.version).toBe("ets-2026-v6");
    expect(result.profile.model).toBe(config.geminiTtsModel);
    // Exhaustive, so a manifest field cannot appear or go without this test changing too.
    expect(manifest).toEqual({
      profile: result.profile,
      clips: result.measurements,
      baseClipCount: 13,
      setId: "spk-001",
      renderedAt: expect.any(String),
      takes: expect.any(Array),
    });
    expect(Number.isNaN(Date.parse(manifest.renderedAt))).toBe(false);

    // On the artifact a render leaves behind: the manifest carries the per-item targets, and the
    // seven measured clips land on them, items 1-3 faster than items 6-7. Both are speech rates,
    // not rates over the file's duration.
    expect(manifest.profile.listenAndRepeat.itemTargetWpms).toEqual([226, 226, 226, 184, 184, 184, 184]);
    expect(manifest.profile.listenAndRepeat.itemMaxClipSec).toBe(5);
    expect(manifest.profile.listenAndRepeat).not.toHaveProperty("itemTargetWpm");
    const measuredItems = manifest.clips
      .filter((clip: { role: string }) => clip.role === "lr-item")
      .map((clip: { wpm: number }) => Math.round(clip.wpm));
    expect(measuredItems).toEqual([226, 226, 226, 184, 184, 184, 184]);
    expect(Math.min(...measuredItems.slice(0, 3))).toBeGreaterThan(Math.max(...measuredItems.slice(5)));
    // No clip needed a corrective re-render, and none carries an advisory: every one of the seven
    // landed inside the band its own target defines.
    expect(result.set.advisoryNotes).toBeUndefined();
    // A published clip's measurement carries no per-take column: `correctionCount` lives on
    // `takes`, and `speed` only on clip_measurements rows.
    expect(manifest.clips.every((clip: object) => !("speed" in clip) && !("correctionCount" in clip))).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain("Welcome to the campus");
    expect(fs.readdirSync(outputDir).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("renders without any model guard at all", async () => {
    // deps is exactly {synthesize, probeDuration}. The profile records whichever model rendered the
    // Set, so there is no model literal for a guard to check against.
    const deps: SpeakingAudioRendererDeps = fake(good);
    expect(Object.keys(deps).sort()).toEqual(["probeDuration", "synthesize"]);
    await expect(renderSpeakingAudio(placeholderSpeakingSet(), target(), deps)).resolves.toBeTruthy();
  });

  // A clip still out of band after its corrective re-render publishes, whatever its role. Gemini has
  // no speed parameter, so a pace gate could only reject, after every clip was paid for, a render it
  // cannot repair.
  it.each([
    ["lr-briefing", 0, "briefing.mp3"],
    ["lr-item", 1, "lr-1.mp3"],
    ["interview-intro", 8, "int-intro.mp3"],
    ["interview-question", 9, "q-1.mp3"],
  ])("keeps and publishes an out-of-band %s clip", async (_role, index, file) => {
    // Each out-of-band duration is far outside its band and outside the 0.4s absolute tolerance,
    // yet still inside the wide 0.3x-3.0x sanity window, so it is pace variance rather than chaos.
    const durations = [...good]; durations[index] = [3.0, 4.0, 4.0, 5.0][[0, 1, 8, 9].indexOf(index)]!;
    const outputDir = output();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await renderSpeakingAudio(placeholderSpeakingSet(), target(outputDir), fake(durations));

    // The band the plan gave this clip: for lr-item, item 1's own band, not AUDIO_ROLE_POLICY's
    // flat one.
    const band = buildSpeakingRenderPlan(placeholderSpeakingSet(), profileForSetId("spk-001"))
      .find((clip) => clip.file === file)!.band;
    const measurement = result.measurements.find((m) => m.file === file)!;
    expect(measurement.wpm).toBeLessThan(band.minWpm);
    // Published: the file exists under its final name and the Set references it.
    expect(fs.existsSync(path.join(outputDir, file))).toBe(true);
    expect(fs.readdirSync(outputDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, "audio-manifest.json"), "utf8")).clips)
      .toContainEqual(expect.objectContaining({ file, wpm: measurement.wpm }));
    // One warning, saying plainly that the clip was kept.
    expect(warn.mock.calls.flat().join(" ")).toContain("pace out-of-band, clip kept and published");
    warn.mockRestore();
  });

  // The correction loop is audioPaceCorrection.ts's and is unit-tested there; this pins that the
  // Speaking renderer drives it, on a full thirteen-clip render.
  it("re-renders an out-of-band clip once with a corrective direction, then publishes it with a note", async () => {
    const durations = [...good];
    durations[1] = 4.0; // lr-1: 7 words / 4.0s = 105 WPM against item 1's 156-251 band
    const outputDir = output();
    const calls: { request: { text: string }; file: string }[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await renderSpeakingAudio(placeholderSpeakingSet(), target(outputDir), fake(durations, calls));

    // Fourteen syntheses for thirteen clips: exactly one clip was corrected, exactly once.
    expect(calls).toHaveLength(14);
    const corrective = calls.filter(({ request }) => request.text.includes("came out too slow"));
    expect(corrective).toHaveLength(1);
    // Both takes measured the same here, so the correction did not land and the miss is disclosed,
    // against item 1's own band, which is what the plan gave this clip.
    expect(result.set.advisoryNotes).toEqual([
      expect.objectContaining({ check: "speech-rate", detail: "lr-item", targetWpm: 226, minWpm: 156, maxWpm: 251 }),
    ]);
    expect(fs.readdirSync(outputDir).filter((name) => name.includes(".tmp"))).toEqual([]);
    warn.mockRestore();
  });

  it("leaves no note on a render where every clip landed in band", async () => {
    const result = await renderSpeakingAudio(placeholderSpeakingSet(), target(output()), fake([...good]));
    expect(result.set.advisoryNotes).toBeUndefined();
  });

  // This renderer is the last producer of advisory notes before publishSet's schema parse, after
  // generation has attached its own. Its notes go through the ledger (setAdvisoryLedger.ts), which
  // caps the list at the schema's maximum: past that bound the parse would throw away thirteen paid
  // clips at the last step. The cap itself is asserted in setAdvisoryNotes.test.ts; this pins that
  // the renderer goes through the ledger.
  it("keeps a Set that arrived at the note cap publishable when a clip still misses its band", async () => {
    const durations = [...good];
    durations[1] = 4.0; // lr-1 out of band, so the renderer has a pace note to append
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const minted: SetAdvisoryNote = { check: "catalog-novelty", detail: "containment", taskType: "listen_repeat" };
    const atCap: SpeakingSet = {
      ...placeholderSpeakingSet(),
      advisoryNotes: Array.from({ length: MAX_SET_ADVISORY_NOTES }, () => minted),
    };

    const result = await renderSpeakingAudio(atCap, target(output()), fake(durations));

    expect(result.set.advisoryNotes).toHaveLength(MAX_SET_ADVISORY_NOTES);
    expect(() => SpeakingSetSchema.parse(result.set)).not.toThrow();
    warn.mockRestore();
  });

  it("fails the render and removes the output directory when a clip is past the sanity ratio", async () => {
    // 7 words in 8 s is 52.5 WPM: 4.3x item 1's 1.86 s target duration, past the 3.0x sanity
    // ceiling. That is not a slow take; it is a truncated, empty or stuck synthesis.
    const durations = [...good]; durations[1] = 8;
    const outputDir = output();

    await expect(renderSpeakingAudio(placeholderSpeakingSet(), target(outputDir), fake(durations)))
      .rejects.toThrow(/wildly outside its plausible duration/);
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it("persists every synthesis, including the one that failed the render, with vestigial neutral columns", async () => {
    const collected = collectClipTakes();
    const rows: any[] = collected.rows;
    setClipMeasurementSink(collected.sink);
    try {
      const durations = [...good]; durations[1] = 8;
      await expect(renderSpeakingAudio(placeholderSpeakingSet(), target(), fake(durations))).rejects.toThrow();

      expect(rows.map((r) => [r.file, Number(r.wpm.toFixed(1)), r.inBand])).toEqual([
        ["briefing.mp3", 166.7, true],
        ["lr-1.mp3", 52.5, false],
      ]);
      // `speed` is always 1, since Gemini has no rate parameter, and both rows are first takes, so
      // `correctionCount` is 0.
      expect(rows.every((r) => r.speed === 1 && r.correctionCount === 0)).toBe(true);
      expect(rows.every((r) => r.setId === "spk-001" && r.profileVersion === "ets-2026-v6")).toBe(true);
      // The invariant: measurements only, never a syllable of the clip text or the built prompt.
      expect(JSON.stringify(rows)).not.toContain("Welcome to the campus");
      expect(JSON.stringify(rows)).not.toContain("listen repeat sentence");
      expect(JSON.stringify(rows)).not.toContain("TRANSCRIPT");
    } finally {
      resetClipMeasurementSink();
    }
  });

  // The two failures that happen mid-render. A wordless clip fails before anything is created, in
  // its own it.each above.
  it("cleans up invalid-duration and manifest errors", async () => {
    // A non-finite or non-positive probe resolves to "malfunction" inside assessPace rather than
    // leaking NaN into the message, and still fails the render.
    let outputDir=output(); await expect(renderSpeakingAudio(placeholderSpeakingSet(),target(outputDir),fake([0]))).rejects.toThrow(); expect(fs.existsSync(outputDir)).toBe(false);
    outputDir=output(); const original=fs.writeFileSync; const spy=vi.spyOn(fs,"writeFileSync").mockImplementation(((file:any,...args:any[])=>{ if(String(file).includes("audio-manifest")) throw new Error("disk full"); return (original as any)(file,...args); }) as any); await expect(renderSpeakingAudio(placeholderSpeakingSet(),target(outputDir),fake(good))).rejects.toThrow("disk full"); expect(fs.existsSync(outputDir)).toBe(false); spy.mockRestore();
  });

  it("leaves no temporary files and never logs supplied source text, an accent aside", async () => {
    const outputDir=output(); const logs=[vi.spyOn(console,"log"),vi.spyOn(console,"warn"),vi.spyOn(console,"error")]; await renderSpeakingAudio(placeholderSpeakingSet(),target(outputDir),fake(good));
    expect(fs.readdirSync(outputDir).filter(name => name.startsWith("."))).toEqual([]); const logOutput=logs.flatMap(log => log.mock.calls).flat().join(" ");
    expect(logOutput).not.toContain("Welcome to the campus library.");
    expect(logOutput).not.toContain("This is listen repeat sentence number 1.");
    expect(logOutput).not.toContain("What is your opinion about topic number 1?");
    // The prompt is new text this render constructs; none of it may reach a log either.
    expect(logOutput).not.toContain(TRANSCRIPT_DELIMITER);
    expect(logOutput).not.toContain("You are a speech-synthesis voice");
    logs.forEach(log => log.mockRestore());
  });
});

// Every test above runs at the default TTS bound of 1, a serial loop, so none of them can see what
// concurrency breaks. These raise the process-wide bound and pin what holds only because the
// renderer holds it: the manifest's clip order, which take each clip publishes, and what a failure
// leaves on disk.
describe("renderSpeakingAudio under a raised TTS bound", () => {
  afterEach(() => setTtsConcurrencyForTests());

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const planFiles = (): string[] =>
    buildSpeakingRenderPlan(placeholderSpeakingSet(), profileForSetId("spk-001")).map((clip) => clip.file);

  /** `.lr-1.mp3.tmp` and `.lr-1.mp3.retake.tmp` both name the clip `lr-1.mp3`. */
  const clipKey = (filePath: string): string =>
    path.basename(filePath).replace(/^\./u, "").replace(/(?:\.retake)?\.tmp$/u, "");

  type ClipPlan = {
    /** Duration this clip's Nth take probes at. The last entry repeats for any further take. */
    takes: number[];
    delayMs: number;
    /** Finish only once this other clip has, instead of after `delayMs`: an order load cannot change. */
    finishAfter?: string;
    fail?: boolean;
  };

  /** Every clip at its own band's target, on a delay that makes later clips finish first. */
  function clipPlans(overrides: Record<string, Partial<ClipPlan>> = {}): Record<string, ClipPlan> {
    const files = planFiles();
    const plans: Record<string, ClipPlan> = {};
    files.forEach((file, index) => {
      plans[file] = { takes: [good[index]!], delayMs: (files.length - index) * 5 };
    });
    for (const [file, override] of Object.entries(overrides)) {
      plans[file] = { ...plans[file]!, ...override };
    }
    return plans;
  }

  /**
   * A stub that survives concurrency, unlike `fake` above, whose durations follow the order clips
   * are first probed in: which take is being measured is written into the artifact and read back
   * off it by the probe, so nothing depends on the order the calls arrive in.
   */
  function concurrentDeps(plans: Record<string, ClipPlan>) {
    const takeIndex = new Map<string, number>();
    const started: string[] = [];
    const finished: string[] = [];
    const markFinished = new Map<string, () => void>();
    const hasFinished = new Map(
      Object.keys(plans).map((key) => [key, new Promise<void>((resolve) => markFinished.set(key, resolve))]),
    );
    let inFlight = 0;
    let peakInFlight = 0;
    const deps: SpeakingAudioRendererDeps = {
      synthesize: vi.fn(async (_request, outPath: string) => {
        const key = clipKey(outPath);
        const take = takeIndex.get(key) ?? 0;
        takeIndex.set(key, take + 1);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        started.push(`${key}#${take}`);
        try {
          // The delay applies to a failing clip too, so a test can choose which clip fails first in
          // wall-clock terms independently of which one is first in the plan.
          const after = plans[key]!.finishAfter;
          await (after === undefined ? sleep(plans[key]!.delayMs) : hasFinished.get(after));
          if (plans[key]!.fail) throw new Error(`synthesis failed for ${key}`);
          fs.writeFileSync(outPath, String(take));
          finished.push(key);
          markFinished.get(key)!();
        } finally {
          inFlight -= 1;
        }
      }),
      probeDuration: vi.fn(async (filePath: string) => {
        const key = clipKey(filePath);
        const take = Number(fs.readFileSync(filePath, "utf8"));
        const takes = plans[key]!.takes;
        return takes[Math.min(take, takes.length - 1)]!;
      }),
    };
    return { deps, started, finished, peak: () => peakInFlight };
  }

  // `lr-1`…`lr-7` are a difficulty ramp and the manifest's order is read downstream, so completion
  // order must never reach it. Each clip finishes only after the one behind it in the plan, so the
  // thirteenth finishes first and the whole order is reversed, the scrambling a renderer that pushed
  // results as they arrived would record. A chain rather than staggered delays: under machine load,
  // 5 ms of stagger is smaller than the skew between clip starts.
  it("keeps the manifest in CLIP order when the clips finish in the opposite one", async () => {
    setTtsConcurrencyForTests(13);
    const outputDir = output();
    const files = planFiles();
    const { deps, finished, peak } = concurrentDeps(clipPlans(Object.fromEntries(
      files.slice(0, -1).map((file, index) => [file, { finishAfter: files[index + 1] }]),
    )));

    const result = await renderSpeakingAudio(placeholderSpeakingSet(), target(outputDir), deps);

    // The premise: this render really did have clips in flight together, finishing backwards.
    expect(peak()).toBe(13);
    expect(finished).toEqual([...planFiles()].reverse());

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "audio-manifest.json"), "utf8"));
    expect(manifest.clips.map((clip: { file: string }) => clip.file)).toEqual(planFiles());
    expect(result.measurements.map((clip) => clip.file)).toEqual(planFiles());
    expect(manifest.takes.map((take: { file: string }) => take.file)).toEqual(planFiles());
    // And the Set's own audio paths still line up with the ramp they name.
    expect(result.set.listenAndRepeat.items.map((item) => item.audio)).toEqual(
      Array.from({ length: 7 }, (_, i) => `stimuli/spk-001/lr-${i + 1}.mp3`),
    );
  });

  // Take selection, run concurrently. Two clips are corrected at the same time and disagree about
  // which take wins: `lr-1`'s retake lands in band and ships, `q-1`'s comes back worse and its first
  // take ships. Interleaved correction state would show up here as one clip publishing the other's
  // take.
  it("gives each concurrently-corrected clip its own winning take", async () => {
    setTtsConcurrencyForTests(13);
    const outputDir = output();
    const collected = collectClipTakes();
    setClipMeasurementSink(collected.sink);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // lr-1: 7 words at 4.0s is 105 WPM against a 156-251 band; the retake lands on target.
    // q-1: 8 words at 2.0s is 240 WPM against a 130-180 band; the retake at 8.0s is 60 WPM, further
    // outside the band than the take it was meant to repair, so audioPaceCorrection keeps the first.
    const { deps, peak } = concurrentDeps(clipPlans({
      "lr-1.mp3": { takes: [4.0, good[1]!] },
      "q-1.mp3": { takes: [2.0, 8.0] },
    }));

    try {
      const result = await renderSpeakingAudio(placeholderSpeakingSet(), target(outputDir), deps);

      expect(peak()).toBeGreaterThan(1);
      // The audio on disk is the winning take: the stub writes its take index into the file.
      expect(fs.readFileSync(path.join(outputDir, "lr-1.mp3"), "utf8")).toBe("1");
      expect(fs.readFileSync(path.join(outputDir, "q-1.mp3"), "utf8")).toBe("0");
      // …and the measurement rows say the same thing, per clip, for both takes of each.
      const dispositions = collected
        .settled()
        .filter((row) => row.file === "lr-1.mp3" || row.file === "q-1.mp3")
        .map((row) => [row.file, row.correctionCount, row.takeDisposition]);
      expect(dispositions).toEqual(
        expect.arrayContaining([
          ["lr-1.mp3", 0, "discarded"],
          ["lr-1.mp3", 1, "published"],
          ["q-1.mp3", 0, "published"],
          ["q-1.mp3", 1, "discarded"],
        ]),
      );
      expect(collected.publishedFiles().sort()).toEqual([...planFiles()].sort());
      // Only the clip whose correction failed leaves a note, and it names the take that shipped.
      expect(result.set.advisoryNotes).toEqual([
        expect.objectContaining({ check: "speech-rate", detail: "interview-question", take: "first" }),
      ]);
      expect(fs.readdirSync(outputDir).filter((name) => name.includes(".tmp"))).toEqual([]);
    } finally {
      resetClipMeasurementSink();
      warn.mockRestore();
    }
  });

  // The renderer answers a throw by deleting its whole output directory. A sibling synthesis still
  // running at that moment would recreate it (synthesizeToFile creates its parent directory),
  // leaving an orphan file where a Set's audio should be, and every later re-render would then fail
  // on the output-collision guard. So the failure may not propagate until every clip in flight has
  // settled.
  it("waits for every in-flight clip before failing, and leaves nothing behind", async () => {
    setTtsConcurrencyForTests(4);
    const outputDir = output();
    // The first clip fails at once while three siblings are 40ms into their own syntheses.
    const { deps, started } = concurrentDeps(clipPlans({
      "briefing.mp3": { fail: true, delayMs: 0 },
      "lr-1.mp3": { delayMs: 40 },
      "lr-2.mp3": { delayMs: 40 },
      "lr-3.mp3": { delayMs: 40 },
    }));

    await expect(renderSpeakingAudio(placeholderSpeakingSet(), target(outputDir), deps))
      .rejects.toThrow("synthesis failed for briefing.mp3");

    expect(fs.existsSync(outputDir)).toBe(false);
    // The straggler window: the three siblings finish well after the throw would have happened had
    // it propagated early. The directory must still be gone.
    await sleep(120);
    expect(fs.existsSync(outputDir)).toBe(false);
    // And nothing past the first window was ever bought — the nine clips behind it were skipped.
    expect(started).toEqual(["briefing.mp3#0", "lr-1.mp3#0", "lr-2.mp3#0", "lr-3.mp3#0"]);
  });

  // The error a caller sees must not depend on which clip lost the race: it is the earliest failed
  // clip in plan order, the one a serial render would have reported.
  it("reports the earliest failed clip when several fail at once", async () => {
    setTtsConcurrencyForTests(13);
    const { deps } = concurrentDeps(clipPlans({
      "lr-2.mp3": { fail: true, delayMs: 0 },
      "lr-1.mp3": { fail: true, delayMs: 30 },
    }));

    await expect(renderSpeakingAudio(placeholderSpeakingSet(), target(output()), deps))
      .rejects.toThrow("synthesis failed for lr-1.mp3");
  });
});

// The Listen and Repeat clip ceiling, checked on the clip as delivered. The pace invariant in
// speakingConformance.ts is about the policy: a sentence at the word cap, read at the band floor,
// fits in 5.0 s. A take that comes back below the floor can still run past the ceiling, and only a
// measurement of it can tell. These tests drive the renderer rather than the pure check
// (speakingConformance.test.ts covers that), because the property is about what ships.
describe("the published-clip ceiling", () => {
  // 7-word items: 5.2 s is 80.8 WPM, far below any band floor but inside assessPace's 0.3x-3.0x
  // sanity window against lr-1's 1.858 s target, so it is an out-of-band clip, not a malfunction. A
  // malfunction fails the render; an out-of-band clip publishes.
  const OVER_CEILING_SEC = 5.2;

  // The notes that tell an over-ceiling clip apart; a slow clip also carries a pace note either way.
  const ceilingNotes = (set: { advisoryNotes?: { detail?: string }[] }) =>
    (set.advisoryNotes ?? []).filter((note) => note.detail === "lr-clip-over-ceiling");

  // The corrective re-render is the repair; a clip still past the ceiling after it is a harder
  // item, not an unusable one, so the Set publishes with a note naming which item (ADR-0006).
  it("publishes a delivered Listen and Repeat clip that runs past the ceiling, with a note naming the item", async () => {
    const outputDir = output();
    const durations = [...good];
    durations[1] = OVER_CEILING_SEC;

    const result = await renderSpeakingAudio(placeholderSpeakingSet(), target(outputDir), fake(durations));

    expect(fs.existsSync(path.join(outputDir, "lr-1.mp3"))).toBe(true);
    expect(result.set.advisoryNotes).toContainEqual({
      check: "content-gate", detail: "lr-clip-over-ceiling", taskType: "listen_repeat", itemPosition: 0,
    });
  });

  // A log line is an output channel too: the renderer's carry measurements, never Set content.
  it("warns with the file and the numbers, and never the sentence", async () => {
    const durations = [...good];
    durations[1] = OVER_CEILING_SEC;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await renderSpeakingAudio(placeholderSpeakingSet(), target(), fake(durations));
      const line = warn.mock.calls.map((call) => String(call[0])).find((text) => text.includes("clip ceiling"));
      expect(line).toBeDefined();
      expect(line).toContain("lr-1.mp3");
      expect(line).toContain("5.200");
      expect(line).toContain("5.0s clip ceiling");
      expect(line).not.toContain("listen repeat sentence");
    } finally {
      warn.mockRestore();
    }
  });

  // A breach is strictly `>` the ceiling, with no grace margin. A tolerance here would reopen the
  // hole speakingConformance's `tolerance-covers-ceiling` check closes: audioPace's 0.4 s absolute
  // tolerance passing an over-ceiling clip as in band.
  it("publishes a clip that sits exactly ON the ceiling with no ceiling note", async () => {
    const outputDir = output();
    const durations = [...good];
    durations[1] = 5;

    const result = await renderSpeakingAudio(placeholderSpeakingSet(), target(outputDir), fake(durations));

    expect(fs.existsSync(path.join(outputDir, "lr-1.mp3"))).toBe(true);
    expect(result.measurements[1]!.durationSec).toBe(5);
    // Far below the band floor, so the clip carries a pace note; what it must not carry is the
    // ceiling note an over-ceiling clip gets.
    expect(ceilingNotes(result.set)).toEqual([]);
  });

  // Only Listen and Repeat items carry the ceiling: it budgets the speech the User holds in working
  // memory and repeats back verbatim, which is what makes the task hard. A briefing is listened to
  // and an interview question answered; neither is repeated.
  it.each([
    ["briefing", 0, "briefing.mp3"],
    ["interview intro", 8, "int-intro.mp3"],
    ["interview question", 9, "q-1.mp3"],
  ])("holds a long %s clip to no ceiling — only Listen and Repeat items carry one", async (_label, index, file) => {
    const outputDir = output();
    const durations = [...good];
    durations[index] = OVER_CEILING_SEC;

    const result = await renderSpeakingAudio(placeholderSpeakingSet(), target(outputDir), fake(durations));

    expect(fs.existsSync(path.join(outputDir, file))).toBe(true);
    expect(result.measurements[index]!.durationSec).toBe(OVER_CEILING_SEC);
    expect(ceilingNotes(result.set)).toEqual([]);
  });

  // The ceiling is read off the Set's recorded profile, as its band is, so a re-render of an older
  // Set is held to the policy that Set was made under.
  it("takes the ceiling from the profile that records one, and the live constant from one that does not", () => {
    expect(listenAndRepeatClipCeilingSec(profileForSetId("spk-001"))).toBe(LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC);
    const legacy = SpeakingAudioProfileSchema.parse({
      version: "ets-2026-v3", provider: "gemini", model: "gemini-3.1-flash-tts-preview",
      listenAndRepeat: { accent: "british", voice: "Gacrux", briefingTargetWpm: 165, itemTargetWpm: 180 },
      interview: { accent: "australian", voice: "Despina", introTargetWpm: 165, questionTargetWpm: 155 },
    });
    // v1-v3 profiles record no ceiling and get the current constant, the strict choice: nothing
    // should ship over the ceiling because its profile does not name one.
    expect(listenAndRepeatClipCeilingSec(legacy)).toBe(LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC);
  });
});
