import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { toProviderJsonSchema } from "./reasoning/jsonSchema.js";
import {
  AnySetSchema,
  parseSentenceFrame,
  toPersistedWritingSet,
  type AnySet,
  type SceneGenerationOutcome,
  type SpeakingSet,
  type WritingSet,
} from "@toefl-prep/shared";
import { config } from "../lib/config.js";
import { synthesizeToFile as realTts, type TtsRequest } from "./tts.js";
import { probeSpeechDurationSec } from "./transcode.js";
import { renderSpeakingAudio, SpeakingAudioOutputCollisionError } from "./speakingAudioRenderer.js";
import {
  renderListeningAudio,
  ListeningAudioOutputCollisionError,
} from "./listeningAudioRenderer.js";
import { isTileSubset } from "./sentenceScorer.js";
import { cleanupUnpublishedSetArtifacts } from "./setArtifacts.js";
import { setStore } from "./setStore.js";
import { recordAdvisoryNotes } from "./setAdvisoryLedger.js";
import {
  applyScene,
  generateSceneImage as realGenerateSceneImage,
  locateFocusRegions as realLocateFocusRegions,
} from "./sceneImage.js";
import {
  runSkillTask as realRunSkillTask,
} from "./reasoning/router.js";
import {
  callGenerationSkillTask,
  callVerifySkillTask,
  type GenerationProgress,
  type GenerationStage,
  type OnGenerationProgress,
  type SkillTaskRunner,
} from "./generationReasoning.js";
import {
  productionGenerationPlanner,
  type GenerationKind,
  type GenerationPlanner,
  type ReservedGenerationPlan,
} from "./generationPlanner.js";
import { JobCancelledError, throwIfCancelled } from "./jobCancellation.js";
import { blocksGeneration } from "./generationCheckPolicy.js";
import {
  compareListeningModuleDifficulty,
  compareReadingModuleDifficulty,
  moduleDifficultyDetail,
} from "./moduleDifficulty.js";
// The four section adapters, and the loop that drives whichever one this run picks. The import
// direction is one-way: generator.ts names each section generator, and no section generator names
// generator.ts.
import {
  runCandidateLoop,
  validateItemIds,
  type PlannedCandidate,
} from "./generationCandidateLoop.js";
import { assertVerdictCoverage } from "./generationVerifyLoop.js";
import { candidateSchema } from "./speakingWritingCandidate.js";
import { readingCandidateAdapter, verifyReadingSet } from "./readingGenerator.js";
import { listeningCandidateAdapter, verifyListeningSet } from "./listeningGenerator.js";
import { speakingCandidateAdapter } from "./speakingGenerator.js";
import { writingCandidateAdapter } from "./writingGenerator.js";

export type {
  GenerationProgress,
  GenerationStage,
  OnGenerationProgress,
} from "./generationReasoning.js";

export type Deps = {
  runSkillTask?: SkillTaskRunner;
  planner?: GenerationPlanner;
  generationOwnerId?: string;
  // The Set this run replaces (any kind but Writing; validated at the route). Per-run input rather
  // than a dependency, like `generationOwnerId`: it leaves that Set out of the Catalog for the whole
  // run, so a replacement is never measured against what it replaces. Recording the supersession is
  // the job runner's (generationJobs.ts), once the replacement has published.
  supersedesSetId?: string;
  tts?: (req: TtsRequest, outPath: string) => Promise<void>;
  probeDuration?: (filePath: string) => Promise<number>;
  // The two paid scene calls, injectable for the same reason tts is: every test that exercises the
  // speaking pipeline must be able to run them without touching the network.
  sceneImage?: typeof realGenerateSceneImage;
  focusRegions?: typeof realLocateFocusRegions;
  abortSignal?: AbortSignal;
  finalizationAdmission?: <T>(run: () => Promise<T>) => Promise<T>;
  commitPublication?: (input: {
    setId: string;
    kind: GenerationKind;
    stagingPath: string;
    canonicalPath: string;
    contentHash: string;
  }) => boolean | Promise<boolean>;
  // Listening's render takes the same `tts` and `probeDuration` as Speaking's; a Conversation is one
  // native multi-speaker call producing one file, so there is nothing else to inject.
};

/** The Build a Sentence Verifier's answer: per Item, `ok`, or `fix` with the full replacement key. */
export const VerifierSchema = z.object({
  items: z.array(z.union([
    z.object({
      id: z.string(),
      verdict: z.literal("ok"),
      answers: z.null(),
    }),
    z.object({
      id: z.string(),
      verdict: z.literal("fix"),
      answers: z.array(z.array(z.string())).min(1),
    }),
  ])),
});

/**
 * The dispatcher, and nothing else: one adapter per section, picked by kind, handed to the one
 * candidate loop. Four calls rather than one call on a picked adapter because the four adapters are
 * four different instantiations of the generic — a union of them would ask TypeScript to reconcile
 * four unrelated rejection types.
 */
function runSectionCandidateLoop(input: {
  kind: GenerationKind;
  run: SkillTaskRunner;
  reservation: ReservedGenerationPlan;
  onProgress?: OnGenerationProgress;
}): Promise<PlannedCandidate> {
  const { kind, ...loop } = input;
  const plan = input.reservation.plan;
  if (kind === "reading") {
    return runCandidateLoop({ adapter: readingCandidateAdapter(plan), ...loop });
  }
  if (kind === "listening") {
    return runCandidateLoop({ adapter: listeningCandidateAdapter(plan), ...loop });
  }
  if (kind === "speaking") {
    return runCandidateLoop({ adapter: speakingCandidateAdapter(plan), ...loop });
  }
  return runCandidateLoop({ adapter: writingCandidateAdapter(plan), ...loop });
}

/**
 * Plans, generates, verifies, renders and publishes one Set of `kind`, resolving with its id. The
 * Plan's Catalog reservation is released however the run ends. A failure before publication removes
 * the artifacts the run wrote: finalizeAndPublishSet does it, or the job runner for a cancelled job.
 */
export async function generateSet(
  kind: GenerationKind,
  deps: Deps = {},
  onProgress?: OnGenerationProgress,
): Promise<{ setId: string }> {
  throwIfCancelled(deps.abortSignal);
  const rawRun = deps.runSkillTask ?? realRunSkillTask;
  const run: SkillTaskRunner = async (request) => {
    throwIfCancelled(deps.abortSignal);
    const result = await rawRun({
      ...request,
      ...(deps.abortSignal ? { signal: deps.abortSignal } : {}),
    });
    throwIfCancelled(deps.abortSignal);
    return result;
  };
  const planner = deps.planner ?? productionGenerationPlanner;
  const ownerId = deps.generationOwnerId ?? crypto.randomUUID();
  const reservation = await planner.reserve({
    kind,
    ownerId,
    runSkillTask: run,
    onProgress,
    ...(deps.supersedesSetId ? { supersedesSetId: deps.supersedesSetId } : {}),
  });
  try {
    const accepted = await runSectionCandidateLoop({
      kind,
      run,
      reservation,
      onProgress,
    });
    throwIfCancelled(deps.abortSignal);
    return await finalizeAndPublishGeneratedSet({ accepted, run, deps, onProgress });
  } finally {
    planner.release(reservation.reservationId);
  }
}

/**
 * Turns material the User supplies into a Speaking or Writing Set with `source: "imported"`, then
 * publishes it through the same path as a generated Set. Reading and Listening have no import path.
 * No Plan, no novelty check and no conformance gate: the material is the User's own.
 */
export async function importSet(kind: "speaking" | "writing", sourceText: string, deps: Deps = {}, onProgress?: OnGenerationProgress): Promise<{ setId: string }> {
  const prompt = `/toefl-${kind === "speaking" ? "speaking" : "writing"}\nIMPORT ${kind}\n\nParse the following material into one ${kind} set JSON, preserving original wording exactly. Set "source" to "imported".\n\n---\n${sourceText}`;
  return produceImportedSet(kind, prompt, deps, onProgress);
}

/**
 * The one publication path for generated and imported Sets alike. They differ only in how the
 * candidate is obtained; verification, the paid renders, the scene, the atomic publish and the
 * cleanup on failure live here once, so a change to any of them reaches both.
 */
async function finalizeAndPublishSet(input: {
  kind: GenerationKind;
  setId: string;
  set: AnySet;
  run: SkillTaskRunner;
  deps: Deps;
  onProgress?: OnGenerationProgress;
}): Promise<{ setId: string }> {
  const { kind, setId } = input;
  // Whether the durable publication intent committed. Once it has, the bytes on disk decide whether
  // the Set published, and the job runner settles that by reconciling the intent; nothing here may
  // delete what the reconciliation is about to read.
  let publicationCommitted = false;
  const commitPublication: Deps["commitPublication"] = input.deps.commitPublication
    ? async (publication) => {
      publicationCommitted = await input.deps.commitPublication!(publication);
      return publicationCommitted;
    }
    : undefined;
  const synthesize = async (request: TtsRequest, outPath: string) => {
    throwIfCancelled(input.deps.abortSignal);
    await (input.deps.tts ?? realTts)(request, outPath);
    throwIfCancelled(input.deps.abortSignal);
  };
  try {
    throwIfCancelled(input.deps.abortSignal);
    let set = input.set;
    validateItemIds(set);
    if (set.kind === "writing") {
      set = await verifyBuildASentence(set, input.run, input.onProgress, setId);
    }
    if (set.kind === "reading") {
      set = await verifyReadingSet(set, input.run, input.onProgress, setId);
    }
    if (set.kind === "listening") {
      set = await verifyListeningSet(set, input.run, input.onProgress, setId);
    }
    // Item ids again, on the content that will publish: verification can replace whole Items and
    // Stimuli, and a Response is stored under its Item id, so a duplicate would let one Response
    // overwrite another. Fatal (ADR 0006).
    validateItemIds(set);
    // Re-checked after verification: a passage or transcript regenerated to repair a content-gate
    // violation can be written plainer than what it replaced and invert the ordering the candidate
    // gate guaranteed.
    assertUpperModuleHarder(set);
    // Of everything below, only the publish runs inside the batch's finalization gate. Verification
    // (up to five rounds plus remediations) stays outside it, or a child would wait out every
    // sibling's verify loop; that wait sits upstream of the provider scheduler, so no queue time in
    // the diagnostics would show it. The renders stay outside too: ttsQueue.ts bounds synthesis
    // process-wide (TTS_CONCURRENCY), and the batch window bounds how many children reach this tail.
    // The publish has no bound of its own and is local filesystem work, so serializing it costs
    // milliseconds.
    {
      // Re-checked here because verification is long enough to be cancelled during, and a child
      // cancelled mid-verify must not go on to spend a Set's worth of TTS calls.
      throwIfCancelled(input.deps.abortSignal);
      let scene: SceneGenerationOutcome | undefined;
      if (set.kind === "speaking") {
        const rendered = await renderSpeakingAudio(
          set,
          {
            setId,
            outputDir: path.join(config.dataDir, "audio/stimuli", setId),
            audioPathPrefix: `stimuli/${setId}`,
          },
          {
            synthesize,
            // Speech duration, not file duration: a Gemini clip carries about 0.67s of edge silence
            // against ETS's 0.14s (docs/research/2026-08-23-ets-reference-audio-padding.md), which
            // would make every short clip read slow. Both sections pass this probe, so every pace
            // band in audioPace.ts is stated in speech rate.
            probeDuration: input.deps.probeDuration ?? probeSpeechDurationSec,
          },
          (detail) =>
            input.onProgress?.({ stage: "rendering-audio", detail }),
        );
        set = rendered.set;
        // After the audio, so a TTS failure throws before the paid image call is made.
        const result = await attachSceneImage(
          set,
          setId,
          input.deps,
          input.onProgress,
        );
        set = result.set;
        scene = result.outcome;
      }
      if (set.kind === "listening") {
        // The Listening renderer reports no per-clip progress and derives its own output directory,
        // so one coarse checkpoint is fired before the call.
        input.onProgress?.({ stage: "rendering-audio", detail: { setId } });
        set = await renderListeningAudio(set, {
          synthesize,
          // Speech duration, as for Speaking. The edge silence is a far larger share of a short Listen
          // and Choose a Response utterance than of a Conversation. LISTENING_ROLE_POLICY's bands are
          // calibrated to speech rate, so this probe and those bands change together
          // (docs/research/2026-08-23-listening-role-band-recentring.md).
          probeDuration: input.deps.probeDuration ?? probeSpeechDurationSec,
        });
      }
      throwIfCancelled(input.deps.abortSignal);
      // The finalization gate covers this call alone. `set` is the outer `let`, so the closure
      // publishes what the renders above produced, not a stale copy.
      const publish = (): Promise<void> =>
        publishSet(set, kind, setId, commitPublication, input.onProgress, scene);
      await (input.deps.finalizationAdmission
        ? input.deps.finalizationAdmission(publish)
        : publish());
    }
    return { setId };
  } catch (err) {
    // The deepest boundary shared by durable jobs and the direct generate/import scripts: until the
    // Set JSON publishes, every artifact under setId belongs to this run, so a failure removes them.
    // The cleanup is idempotent, and the job runner repeats it after recording the failure. Two
    // durable cases are the runner's alone. A cancelled job: its runner records cleanup debt first,
    // then deletes. A committed publication intent (the rename after it threw): the runner reconciles
    // the intent by its bytes first, and removes the artifacts only if the Set did not publish.
    if (!publicationCommitted && !(input.deps.abortSignal?.aborted && input.deps.commitPublication)) {
      cleanupUnpublishedSetArtifacts(kind, setId, { preserveAudio: failureKeepsAudioDirectory(err) });
    }
    throw err;
  }
}

/**
 * The Upper/Lower ordering, re-asserted on the final content of a Reading or Listening Set; a
 * no-op for Speaking and Writing.
 *
 * Throws when generationCheckPolicy.ts says the check blocks, which it does: a Set whose Upper
 * Module is not harder makes ADR 0005's Module Path, Promotion Threshold and lower-path band cap
 * dishonest, and no note on the Set repairs a Band Estimate the User is shown (ADR 0006).
 */
function assertUpperModuleHarder(set: AnySet): void {
  if (set.kind !== "reading" && set.kind !== "listening") return;
  const comparison = set.kind === "reading"
    ? compareReadingModuleDifficulty(set)
    : compareListeningModuleDifficulty(set);
  if (!comparison.upperIsHarder && blocksGeneration({ family: "module-difficulty", section: set.kind })) {
    throw new Error(
      `set validation failed: verification left the upper module no harder than the lower module\n${
        moduleDifficultyDetail(comparison)
      }`,
    );
  }
}

/**
 * Whether a failed run must leave its Set's audio directory where it is: the render refused because
 * that directory already existed, so nothing in it is this run's. The generator's own cleanup and the
 * job runner's (generationJobs.ts) both ask this one predicate, so a collision one of them keeps is
 * never deleted by the other.
 */
export function failureKeepsAudioDirectory(err: unknown): boolean {
  return err instanceof SpeakingAudioOutputCollisionError || err instanceof ListeningAudioOutputCollisionError;
}

function mintSetId(kind: GenerationKind): string {
  const prefix = kind === "speaking" ? "spk" : kind === "writing" ? "wri" : kind === "reading" ? "rd" : "lsn";
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function finalizeAndPublishGeneratedSet(input: {
  accepted: PlannedCandidate;
  run: SkillTaskRunner;
  deps: Deps;
  onProgress?: OnGenerationProgress;
}): Promise<{ setId: string }> {
  const kind = input.accepted.kind;
  const setId = mintSetId(kind);
  // The candidate's advisory notes are written where the Set comes into existence. Verification and
  // the audio renderers append theirs later, before publishSet writes the Set, through the same
  // ledger, which keeps the combined list within what the schema accepts.
  const minted = {
    ...input.accepted.candidate,
    id: setId,
    source: "generated",
    createdAt: new Date().toISOString(),
    generationPlan: input.accepted.plan,
  };
  const set = AnySetSchema.parse(recordAdvisoryNotes(
    minted,
    input.accepted.advisoryNotes ?? [],
    `${kind} set`,
  ));
  return finalizeAndPublishSet({
    kind,
    setId,
    set,
    run: input.run,
    deps: input.deps,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
}

async function produceImportedSet(
  kind: "speaking" | "writing",
  prompt: string,
  deps: Deps,
  onProgress?: OnGenerationProgress,
): Promise<{ setId: string }> {
  const run = deps.runSkillTask ?? realRunSkillTask;
  const schema = candidateSchema(kind);

  const res = await callGenerationSkillTask({
    run,
    task: { task: "import", context: kind },
    prompt,
    jsonSchema: toProviderJsonSchema(schema),
    parse: (value) => schema.parse(value),
    stage: "generating",
    onProgress,
  });
  if (!res.ok) throw new Error(res.error);

  const setId = mintSetId(kind);
  const parsed = schema.safeParse({
    ...(res.value as object),
    id: setId,
    source: "imported",
    createdAt: new Date().toISOString(),
  });
  if (!parsed.success) {
    throw new Error(`set validation failed: ${parsed.error.message}`);
  }
  // An imported Writing candidate gets the same frame conversion a generated one does: `frame: null`
  // exists only in the generation schema, and WritingSetSchema rejects it. A Speaking candidate is
  // already in its persisted shape: the parse above dropped any server-owned field. Import runs no
  // conformance gate: the material is the User's own, and judging it against a format ETS publishes
  // one sample of would second-guess a transcription the app was handed on purpose.
  const set: AnySet = parsed.data.kind === "speaking"
    ? parsed.data
    : toPersistedWritingSet(parsed.data);

  return finalizeAndPublishSet({
    kind,
    setId,
    set,
    run,
    deps,
    ...(onProgress ? { onProgress } : {}),
  });
}

async function publishSet(
  set: AnySet,
  kind: GenerationKind,
  setId: string,
  commitPublication?: Deps["commitPublication"],
  onProgress?: OnGenerationProgress,
  scene?: SceneGenerationOutcome,
): Promise<void> {
  onProgress?.({
    stage: "saving",
    detail: { setId, ...(scene ? { scene } : {}) },
  });
  // The staging write, the durable commit hook and the atomic rename are setStore.publish's. This
  // function owns the progress checkpoint and what a refused commit means to a generation run: the
  // job was cancelled.
  const published = await setStore.publish({
    kind,
    setId,
    set,
    ...(commitPublication ? { commit: commitPublication } : {}),
  });
  if (!published) throw new JobCancelledError("user");
}

/**
 * How many blanks a frame draws, or `undefined` when there is no usable count: no frame at all, or
 * one that does not parse.
 *
 * The unparseable arm is reachable. A generated candidate cannot get here with one, because
 * `frame-unparseable` is one of BUILD_A_SENTENCE_UNUSABLE_KINDS and the conformance gate runs before
 * verification. An import can: `produceImportedSet` validates with `WritingGenerationInputSchema`,
 * whose `frame` has no frame-parse refinement, and runs no conformance gate. An imported frame with
 * its blanks transcribed as a two-underscore run, or written out as the finished sentence, arrives
 * here unchecked.
 *
 * Throwing would end a paid import with a raw SentenceFrameError. Returning `undefined` skips the
 * blank-count check for that Item, and the Set then fails where every malformed Set fails: the
 * `AnySetSchema.parse` in setStore.publish, where `BuildASentenceItemSchema` rejects the frame.
 */
function frameBlankCount(frame: string | undefined): number | undefined {
  if (frame === undefined) return undefined;
  try {
    return parseSentenceFrame(frame).filter((segment) => segment.type === "blank").length;
  } catch {
    return undefined;
  }
}

async function verifyBuildASentence(
  set: WritingSet,
  run: SkillTaskRunner,
  onProgress: OnGenerationProgress | undefined,
  setId: string,
): Promise<WritingSet> {
  // `frame` is in the payload because tiles alone cannot say whether the sentence reads naturally:
  // "were fantastic" is only correct against "The ___ ... fantastic.". Omitted, not null, for a
  // frameless Item, matching how the Item is persisted.
  const payload = set.buildASentence.items.map((i) => ({
    id: i.id,
    prompt: i.prompt,
    ...(i.frame !== undefined ? { frame: i.frame } : {}),
    tiles: i.tiles,
    answers: i.answers,
  }));
  // Three questions only. The counting checks (blank/tile arithmetic, a tile carrying a capital or a
  // final period, answers drawn from the Item's own tiles) run deterministically in
  // buildASentenceConformance.ts before a candidate is accepted; a model is slower and less reliable
  // at them than an equality check.
  const prompt = `/toefl-writing\nVERIFY build_sentence\n\nFor each item, drop its answer tiles into the frame's blanks in order and ask exactly three questions: (1) does the completed sentence read naturally, (2) is there a legitimate alternate order the answer key misses, (3) does the unused distractor tile genuinely discriminate. Do not rewrite frames, tiles or prompts.\n\nReturn {"items":[{"id","verdict":"ok","answers":null}|{"id","verdict":"fix","answers":[[...]]}]} with one item for every payload item. For "fix", "answers" must be the non-empty full replacement list.\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
  const res = await callVerifySkillTask({
    run,
    logPrefix: "[generator]",
    task: { task: "verify", context: "build_sentence" },
    prompt,
    jsonSchema: toProviderJsonSchema(VerifierSchema),
    parse: (value) => {
      const verdict = VerifierSchema.parse(value);
      assertVerdictCoverage("build_sentence", payload.map((item) => item.id), verdict.items.map((item) => item.id));
      return verdict;
    },
    stage: "verifying",
    onProgress,
    setId,
  });
  if (!res.ok) throw new Error(res.error);
  const verdicts = res.value;
  return {
    ...set,
    buildASentence: {
      items: set.buildASentence.items.map((item) => {
        const v = verdicts.items.find((x) => x.id === item.id);
        if (v?.verdict === "fix") {
          // `undefined` for a frameless Item or an unparseable frame: the blank count is unknown, not
          // zero, so the check below is skipped.
          const blanks = frameBlankCount(item.frame);
          for (const order of v.answers) {
            if (!isTileSubset(order, item.tiles)) {
              throw new Error(`verifier answers not a subset of tiles for item ${item.id}`);
            }
            // The conformance gate ran before this call, so a Verifier miscount here would bring back
            // an answer key no arrangement of tiles can equal, after the last check for it. Thrown,
            // like the subset failure above: an impossible answer key is fatal (ADR 0006).
            if (blanks !== undefined && order.length !== blanks) {
              throw new Error(
                `verifier answers do not fill every blank exactly once for item ${item.id}: ` +
                  `${order.length} token(s) for ${blanks} blank(s)`,
              );
            }
          }
          return { ...item, answers: v.answers };
        }
        return item;
      }),
    },
  };
}

// The illustrated scene Listen and Repeat shows while its sentences play: one image for the Set,
// plus one focus region per sentence for the highlight ring (ADR 0014). Two paid calls, and neither
// may fail the Set, so this returns a Set on every path but cancellation: a Speaking Set with audio
// and no picture is fully practisable, and its thirteen clips are already paid for.
//
//   - image fails  -> return the Set unchanged and do not call locateFocusRegions, which needs a
//     real file on disk (sceneImage.ts reports a missing one as "unreadable-image").
//   - regions fail -> return the Set with the image and no regions; the picture alone still helps.
// Both catches are catch-all: the image path throws SceneImageError, the vision path JudgeError,
// and anything unforeseen from either must not escape into publication and fail the job.
//
// A cancelled job is the exception, and buys neither call. The cancellation is checked before each
// call, both calls take the job's abort signal, and a call that fails because of it rethrows the
// cancellation rather than reading as a scene failure. A cancel during the audio render can arrive
// while a corrective retake is being bought, which audioPaceCorrection.ts absorbs by keeping the
// best take, so the check before the image call is the first one to see it.
async function attachSceneImage(
  set: SpeakingSet,
  setId: string,
  deps: Deps,
  onProgress?: OnGenerationProgress
): Promise<{ set: SpeakingSet; outcome: SceneGenerationOutcome }> {
  const sceneImage = deps.sceneImage ?? realGenerateSceneImage;
  const focusRegions = deps.focusRegions ?? realLocateFocusRegions;
  const callDeps = deps.abortSignal ? { signal: deps.abortSignal } : {};

  let image: Awaited<ReturnType<typeof realGenerateSceneImage>>;
  throwIfCancelled(deps.abortSignal);
  try {
    onProgress?.({ stage: "rendering-image", detail: { setId } });
    image = await sceneImage(setId, set.listenAndRepeat, callDeps);
  } catch (err) {
    throwIfCancelled(deps.abortSignal);
    console.warn(`[generator] scene image failed for ${setId}, publishing without one: ${errText(err)}`);
    return {
      set,
      outcome: { image: "failed", regions: "skipped" },
    };
  }

  const withImage: SpeakingSet = { ...set, listenAndRepeat: { ...set.listenAndRepeat, image } };
  throwIfCancelled(deps.abortSignal);
  try {
    onProgress?.({ stage: "locating-regions", detail: { setId } });
    // image.file is dataDir-relative with forward slashes (it is stored in JSON and served over
    // HTTP); the vision call needs a real filesystem path.
    const regions = await focusRegions(
      path.join(config.dataDir, image.file),
      set.listenAndRepeat.items.map((item) => item.sentence),
      callDeps,
    );
    // Logged so an all-null answer is visible: it publishes a Set with no rings at all, it happened
    // about once in five live runs (ADR 0014), and regions are computed once and stored, so the log
    // line is what names the Set to re-check.
    const located = regions.filter((r) => r !== null).length;
    console.log(`[generator] scene regions for ${setId}: ${located}/${regions.length} located`);
    return {
      set: applyScene(withImage, image, regions),
      outcome: { image: "succeeded", regions: "succeeded" },
    };
  } catch (err) {
    throwIfCancelled(deps.abortSignal);
    console.warn(`[generator] focus regions failed for ${setId}, publishing image without rings: ${errText(err)}`);
    return {
      set: withImage,
      outcome: { image: "succeeded", regions: "failed" },
    };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
