import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validSpeakingSet, validWritingSet } from "./helpers/setFixtures.js";
import { skillSuccess } from "./helpers/skillResults.js";
import { openSqliteStores } from "./helpers/sqliteStores.js";
import { sqliteTimestamp } from "../src/db/timestamps.js";
import { config } from "../src/lib/config.js";
import {
  abortGenerationJob,
  computeBatchStatus,
  failInterruptedGenerationJobs,
  runGenerationBatch as runGenerationBatchWithPlanner,
  runGenerationJob as runGenerationJobWithPlanner,
  wireGenerationBootRecovery,
} from "../src/services/generationJobs.js";
import type { BootRecoveryServer } from "../src/services/scoringJobs.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import {
  createRepoModelCallSink,
  recordModelCall,
  resetModelCallSink,
  setModelCallSink,
} from "../src/services/modelCallLog.js";
import { buildGenerateRoutes } from "../src/routes/generate.js";
import { deriveJobDisplay } from "../../client/src/lib/progressUtils.js";
import {
  speakingPlanFixture,
  writingPlanFixture,
} from "./helpers/generationDiversityFixtures.js";
import {
  allOkListeningVerdict,
  buildListeningCandidate,
  buildListeningPlan,
  fakeProbeDuration as listeningProbeDuration,
  fakeSynthesize as listeningSynthesize,
  routed,
} from "./helpers/listeningGenerationFixture.js";

// Both paid scene calls, stubbed: any test that lets a speaking generation run to completion would
// otherwise reach the real image/vision APIs (see generator.ts's attachSceneImage).
function sceneDeps() {
  return {
    sceneImage: vi.fn().mockResolvedValue({ file: "images/scenarios/stub.webp", prompt: "p", model: "gpt-image-2" }),
    focusRegions: vi.fn().mockResolvedValue(Array.from({ length: 7 }, () => null)),
    probeDuration: vi.fn(async (filePath: string) => filePath.includes("iq") || filePath.includes("int-intro") ? 0.4 : 0.35),
  };
}

function calibratedTts() {
  return vi.fn(async (_request: unknown, outPath: string) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, "stub-audio");
  });
}

const SANITIZED_ROUTE_FAILURE = {
  ok: false as const,
  error: "Structured reasoning unavailable: Claude (quota) → Codex (timeout).",
  attempts: [
    { provider: "claude" as const, kind: "quota" as const },
    { provider: "codex" as const, kind: "timeout" as const },
  ],
};

function emitRunning(
  request: SkillTaskRequest<unknown>,
  provider: "claude" | "codex" = "claude",
): void {
  request.onEvent?.({
    state: "running",
    provider,
    ...(provider === "codex" ? { fallbackFrom: "claude" as const } : {}),
  });
}

// Same shape as scoringJobs.test.ts's own buildDeps. Every reasoning fake is the facade seam, so
// automated tests never execute a real Claude or Codex CLI. The store is the real one over a private
// in-memory database: the claim, the progress writes, the publication intent, the three mutually
// exclusive terminal writers and the batch parent's settle all run the statements production runs,
// and the blocks that reach past the generation aggregate (the model-call diagnostics tables, the
// generate route) read the same database.
function buildDeps() {
  const testRepo = openSqliteStores();
  const runSkillTask = vi.fn();
  return { repo: testRepo, runSkillTask };
}

function jobPlanner() {
  return {
    reserve: vi.fn(async (input: {
      kind: "speaking" | "writing" | "reading" | "listening";
      ownerId: string;
    }) => ({
      reservationId: `reservation-${input.ownerId}`,
      ownerId: input.ownerId,
      plan: input.kind === "speaking"
        ? speakingPlanFixture()
        : writingPlanFixture(),
    })),
    validateCandidate: vi.fn().mockReturnValue([]),
    release: vi.fn(),
  };
}

function runGenerationJob(
  deps: Parameters<typeof runGenerationJobWithPlanner>[0],
  jobId: string,
  input: Parameters<typeof runGenerationJobWithPlanner>[2],
) {
  return runGenerationJobWithPlanner(
    { ...deps, planner: deps.planner ?? jobPlanner() },
    jobId,
    input,
  );
}

// batchConcurrency 1 throughout this file: production runs children concurrently (see
// generationBatchWindow.ts), but `runSkillTask` is one shared mock whose per-call implementations
// are queued in order, so overlapping children would make which child got which stub
// nondeterministic. Every batch test here is about the runner's bookkeeping (terminal status,
// cancellation, cleanup), which the window's width doesn't change; concurrency itself is the
// window's own suite (generationBatchWindow.test.ts).
function runGenerationBatch(
  deps: Parameters<typeof runGenerationBatchWithPlanner>[0],
  batchId: string,
) {
  return runGenerationBatchWithPlanner(
    { ...deps, batchConcurrency: 1, planner: deps.planner ?? jobPlanner() },
    batchId,
  );
}

// The lifecycle facts every job family shares (queued no-op, cancel-before-start, mid-flight
// supersession, boot sweep idempotence) are proved once in durableJobRunner.test.ts. This file
// covers generation's adapter: artifact cleanup, publication intent, the progress detail shape, batch
// classification, and the reservation and correlation wiring.
describe("runGenerationJob", () => {
  it("uses the durable generation job id as the reservation owner", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    const planner = jobPlanner();
    r.createGenerationJob({ id: "durable-owner-job", kind: "writing" });
    runSkillTask.mockResolvedValueOnce(SANITIZED_ROUTE_FAILURE);

    await runGenerationJob(
      { repo: r, runSkillTask, planner: planner as never },
      "durable-owner-job",
      { kind: "writing" },
    );

    expect(planner.reserve).toHaveBeenCalledWith(expect.objectContaining({
      kind: "writing",
      ownerId: "durable-owner-job",
    }));
    expect(planner.release).toHaveBeenCalledTimes(1);
  });

  // Every model call a job makes is correlated back to that job, with the stage and attempt on the
  // diagnostics row, so a job's calls can be listed by its id.
  it("correlates every model call back to the job, with its stage and attempt", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    setModelCallSink(createRepoModelCallSink(r));
    const planner = jobPlanner();
    // Conformance is advisory: the issue is computed and recorded on the Set, and costs no attempt.
    planner.validateCandidate.mockReturnValue([
      { taskType: "build_sentence", kind: "required-concept", conflictingSetIds: [] },
    ]);
    runSkillTask.mockImplementation(async (request: SkillTaskRequest<unknown>) => {
      recordModelCall({
        provider: "claude",
        route: "skill-task",
        task: "generate:writing",
        prompt: request.prompt,
        response: "{...}",
        outcome: "succeeded",
      });
      // The job runs on to verification, so the Build a Sentence Verifier call needs an answer too.
      if (request.task.context === "build_sentence") {
        return skillSuccess({
          items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok", answers: null })),
        });
      }
      return skillSuccess(validWritingSet());
    });
    r.createGenerationJob({ id: "correlated-job", kind: "writing" });

    try {
      await runGenerationJob({ repo: r, runSkillTask, planner: planner as never }, "correlated-job", { kind: "writing" });

      const rows = r.listModelCallsByContext({ kind: "generation-job", id: "correlated-job" });
      // One generation attempt, correlated and identifiable. (No planning row: the planner is stubbed
      // here, so it makes no model call of its own.)
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const generating = rows
        .map((row) => JSON.parse(row.context_detail ?? "{}") as { stage?: string; generationAttempt?: number })
        .filter((detail) => detail.stage === "generating")
        .map(({ stage, generationAttempt }) => ({ stage, generationAttempt }));
      expect(generating).toEqual([{ stage: "generating", generationAttempt: 1 }]);
      expect(rows.every((row) => row.prompt.length > 0 && row.response === "{...}")).toBe(true);

      const job = r.getGenerationJob("correlated-job")!;
      // The job succeeds: the conformance issue is recorded on the Set, not a reason to fail.
      expect(job.status).toBe("done");
    } finally {
      resetModelCallSink();
    }
  });

  it("records a typed audio collision while preserving the pre-existing sentinel", async () => {
    const { repo: r, runSkillTask } = buildDeps(); r.createGenerationJob({ id: "collision-job", kind: "speaking" });
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue("job-collision-0000-0000-0000-000000000000");
    const setId = "spk-job-coll"; const audio = path.join(config.dataDir, "audio/stimuli", setId);
    fs.mkdirSync(audio, { recursive: true }); fs.writeFileSync(path.join(audio, "sentinel.txt"), "owner");
    runSkillTask.mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => { emitRunning(request); return skillSuccess(validSpeakingSet()); });
    try {
      await runGenerationJob({ repo: r, runSkillTask, ...sceneDeps(), tts: calibratedTts() }, "collision-job", { kind: "speaking" });
      const job = r.getGenerationJob("collision-job")!;
      expect(job.status).toBe("failed"); expect(job.error).toBe("speaking audio render output directory already exists or cannot be acquired");
      expect(fs.readFileSync(path.join(audio, "sentinel.txt"), "utf8")).toBe("owner");
    } finally { uuid.mockRestore(); fs.rmSync(audio, { recursive: true, force: true }); }
  });

  // The Listening renderer refuses an output directory that already exists, and the generator's own
  // cleanup keeps it. The runner's cleanup after the failure must keep it too.
  it("keeps a pre-existing Listening audio directory when the render refuses it", async () => {
    const { repo: r } = buildDeps();
    r.createGenerationJob({ id: "listening-collision-job", kind: "listening" });
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue("lsn-coll-0000-0000-0000-000000000000");
    const setId = "lsn-lsn-coll"; const audio = path.join(config.dataDir, "audio/stimuli", setId);
    fs.mkdirSync(audio, { recursive: true }); fs.writeFileSync(path.join(audio, "sentinel.txt"), "owner");
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) =>
      request.task.task === "generate"
        ? skillSuccess(request.parse(buildListeningCandidate()))
        : routed(request, allOkListeningVerdict(request.prompt)));
    const planner = {
      reserve: vi.fn(async (input: { ownerId: string }) => ({
        reservationId: `reservation-${input.ownerId}`, ownerId: input.ownerId, plan: buildListeningPlan(),
      })),
      validateCandidate: vi.fn().mockReturnValue([]),
      release: vi.fn(),
    };
    try {
      await runGenerationJob(
        { repo: r, runSkillTask: runSkillTask as never, planner: planner as never, tts: listeningSynthesize, probeDuration: listeningProbeDuration },
        "listening-collision-job",
        { kind: "listening" },
      );
      const job = r.getGenerationJob("listening-collision-job")!;
      expect(job.status).toBe("failed");
      expect(job.error).toBe("listening audio render output directory already exists or cannot be acquired");
      expect(job.set_id).toBe(setId);
      expect(fs.readFileSync(path.join(audio, "sentinel.txt"), "utf8")).toBe("owner");
    } finally { uuid.mockRestore(); fs.rmSync(audio, { recursive: true, force: true }); }
  });

  // An in-memory abort persists no cancel request: index.ts's onLeaseLost calls
  // generationJobCancellations.cancelAll("shutdown") and touches no row. The 'cancelled' writer
  // (finishGenerationJobCancellation) requires `cancel_requested_at`, so the runner has to record the
  // request itself and retry. A row left at 'running' keeps a poller, and the batch roll-up that
  // reads child status, waiting until the next boot's sweep.
  it("terminalizes a job aborted in-memory with no persisted cancel request, instead of stranding it at 'running'", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationJob({ id: "gen-lease-lost", kind: "writing" });

    let releaseVerify!: () => void;
    const gate = new Promise<void>((resolve) => { releaseVerify = resolve; });
    let verifyStartedResolve!: () => void;
    const verifyStarted = new Promise<void>((resolve) => { verifyStartedResolve = resolve; });
    runSkillTask
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request);
        return skillSuccess(validWritingSet());
      })
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request);
        verifyStartedResolve();
        await gate;
        return skillSuccess({ items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok", answers: null })) });
      });

    const runPromise = runGenerationJob({ repo: r, runSkillTask }, "gen-lease-lost", { kind: "writing" });
    await verifyStarted;
    // The onLeaseLost shape exactly: wake the in-flight run, touch no row.
    expect(abortGenerationJob("gen-lease-lost", "shutdown")).toBe(true);
    expect(r.getGenerationJob("gen-lease-lost")?.cancel_requested_at).toBeNull();
    releaseVerify();
    await runPromise;

    const job = r.getGenerationJob("gen-lease-lost")!;
    expect(job.status).toBe("cancelled");
    expect(job.cancellation_reason).toBe("shutdown");
    expect(job.terminal_at).not.toBeNull();
    expect(job.cancelled_at).not.toBeNull();
  });

  it("marks the job running (visible before generateSet settles), persists onProgress checkpoints including setId as soon as it's minted, then done with the setId on success", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationJob({ id: "gen-1", kind: "writing" });

    let releaseVerify!: () => void;
    const gate = new Promise<void>((resolve) => { releaseVerify = resolve; });
    let verifyStartedResolve!: () => void;
    const verifyStarted = new Promise<void>((resolve) => { verifyStartedResolve = resolve; });
    runSkillTask
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request);
        return skillSuccess(validWritingSet());
      })
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request, "codex");
        verifyStartedResolve(); // signals after emitRunning's synchronous progress write above
        await gate;
        return skillSuccess(
          { items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })) },
          "codex",
        );
      });

    const runPromise = runGenerationJob({ repo: r, runSkillTask }, "gen-1", { kind: "writing" });

    // Waits until the verify call has started (past its progress write) and is blocked on `gate`.
    // A signal rather than a count of Promise.resolve() ticks: the number of microtask hops before
    // this point is not a constant, and other test files sharing the worker shift it.
    await verifyStarted;
    const midFlight = r.getGenerationJob("gen-1");
    expect(midFlight?.status).toBe("running");
    expect(midFlight?.stage).toBe("verifying"); // past 'generating', blocked on the gated verify call
    expect(midFlight?.set_id).not.toBeNull(); // minted the moment the generate call parsed
    expect(JSON.parse(midFlight!.progress!)).toEqual({
      provider: "codex",
      fallbackFrom: "claude",
      generationAttempt: 1,
      maxDiversityAttempts: 3,
      setId: midFlight?.set_id,
    });

    releaseVerify();
    await runPromise;

    const job = r.getGenerationJob("gen-1")!;
    expect(job.status).toBe("done");
    expect(job.stage).toBe("saving");
    expect(job.error).toBeNull();
    expect(job.set_id).toMatch(/^wri-/);
    // Provider provenance remains available after later checkpoints and terminal persistence.
    expect(JSON.parse(job.progress!)).toEqual({
      provider: "codex",
      fallbackFrom: "claude",
      generationAttempt: 1,
      maxDiversityAttempts: 3,
      setId: job.set_id,
    });

    fs.rmSync(path.join(config.dataDir, "question-sets/writing", `${job.set_id}.json`));
  });

  it("retains a successful speaking scene outcome in persisted progress after the job reaches done", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationJob({ id: "gen-scene-outcome", kind: "speaking" });
    runSkillTask.mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      return skillSuccess(validSpeakingSet());
    });

    await runGenerationJob(
      {
        repo: r,
        runSkillTask,
        tts: calibratedTts(),
        ...sceneDeps(),
      },
      "gen-scene-outcome",
      { kind: "speaking" },
    );

    const job = r.getGenerationJob("gen-scene-outcome")!;
    expect(job.status).toBe("done");
    expect(job.stage).toBe("saving");
    expect(JSON.parse(job.progress!)).toEqual({
      provider: "claude",
      generationAttempt: 1,
      maxDiversityAttempts: 3,
      done: 13,
      total: 13,
      setId: job.set_id,
      scene: { image: "succeeded", regions: "succeeded" },
    });

    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${job.set_id}.json`));
  });

  it("persists only the sanitized Claude-to-Codex failure chain when generation exhausts the route", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationJob({ id: "gen-2", kind: "writing" });
    runSkillTask.mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
      request.onEvent?.({ state: "running", provider: "claude" });
      request.onEvent?.({
        state: "fallback",
        provider: "codex",
        fallbackFrom: "claude",
        failureKind: "quota",
      });
      request.onEvent?.({ state: "running", provider: "codex", fallbackFrom: "claude" });
      return SANITIZED_ROUTE_FAILURE;
    });

    await runGenerationJob({ repo: r, runSkillTask }, "gen-2", { kind: "writing" });

    const job = r.getGenerationJob("gen-2")!;
    expect(job.status).toBe("failed");
    expect(job.error).toBe(SANITIZED_ROUTE_FAILURE.error);
    expect(job.error).not.toMatch(/http|raw/i);
    expect(JSON.parse(job.progress!)).toEqual({
      provider: "codex",
      fallbackFrom: "claude",
      generationAttempt: 1,
      maxDiversityAttempts: 3,
    });
    expect(job.set_id).toBeNull();
  });

  // The rename into the bank runs after the publication intent commits. Once it has, only the bytes
  // can say whether the Set published, so nothing may be deleted before the intent is reconciled.
  function speakingRunWithSceneFile(setIdOut: { value: string }) {
    return {
      tts: calibratedTts(),
      probeDuration: async (filePath: string) => filePath.includes("iq") || filePath.includes("int-intro") ? 0.4 : 0.35,
      sceneImage: vi.fn(async (id: string) => {
        setIdOut.value = id;
        const imagePath = path.join(config.dataDir, "images/scenarios", `${id}.webp`);
        fs.mkdirSync(path.dirname(imagePath), { recursive: true });
        fs.writeFileSync(imagePath, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]));
        return { file: `images/scenarios/${id}.webp`, prompt: "p", model: "gpt-image-2" as const };
      }) as never,
      focusRegions: vi.fn().mockResolvedValue(Array.from({ length: 7 }, () => null)) as never,
    };
  }

  function failingSetRename(times: number) {
    const realRename = fs.renameSync;
    const failures = { count: 0 };
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (failures.count < times && String(from).includes(path.join("question-sets", ".staging"))) {
        failures.count += 1;
        throw Object.assign(new Error("simulated rename failure"), { code: "EBUSY" });
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);
    return { spy, failures };
  }

  it("reconciles a Set whose rename failed after its intent committed: the staged bytes are moved into place and the job is done", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationJob({ id: "gen-rename-once", kind: "speaking" });
    runSkillTask.mockResolvedValueOnce(skillSuccess(validSpeakingSet()));
    const setId = { value: "" };
    const rename = failingSetRename(1);
    try {
      await runGenerationJob({ repo: r, runSkillTask, ...speakingRunWithSceneFile(setId) }, "gen-rename-once", { kind: "speaking" });
      expect(rename.failures.count).toBe(1);
      const job = r.getGenerationJob("gen-rename-once")!;
      expect(job).toMatchObject({ status: "done", set_id: setId.value, error: null });
      const published = JSON.parse(fs.readFileSync(path.join(config.dataDir, "question-sets/speaking", `${setId.value}.json`), "utf8"));
      expect(published.id).toBe(setId.value);
      expect(fs.readdirSync(path.join(config.dataDir, "audio/stimuli", setId.value))).toContain("audio-manifest.json");
      expect(fs.existsSync(path.join(config.dataDir, "images/scenarios", `${setId.value}.webp`))).toBe(true);
    } finally {
      rename.spy.mockRestore();
      if (setId.value) {
        cleanupSet("speaking", setId.value);
        fs.rmSync(path.join(config.dataDir, "images/scenarios", `${setId.value}.webp`), { force: true });
      }
    }
  });

  // A Set that reconciliation publishes is published like any other, so the Set it replaces is
  // retired too. Without that, a replacement would leave both Sets in the picker.
  it("retires the Set a replacement supersedes when reconciliation is what completes its publication", async () => {
    const REPLACED = "spk-e5b2b735";
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationJob({ id: "gen-rename-supersede", kind: "speaking" });
    runSkillTask.mockResolvedValueOnce(skillSuccess(validSpeakingSet()));
    const setId = { value: "" };
    const manifest = path.join(config.dataDir, "question-sets/supersessions.json");
    const manifestBefore = fs.existsSync(manifest) ? fs.readFileSync(manifest, "utf8") : null;
    expect(r.listSupersededSetIds().has(REPLACED)).toBe(false);
    const rename = failingSetRename(1);
    try {
      await runGenerationJob(
        { repo: r, runSkillTask, ...speakingRunWithSceneFile(setId) },
        "gen-rename-supersede",
        { kind: "speaking", supersedesSetId: REPLACED },
      );
      expect(rename.failures.count).toBe(1);
      expect(r.getGenerationJob("gen-rename-supersede")).toMatchObject({ status: "done", set_id: setId.value });
      expect(r.listSupersededSetIds().has(REPLACED)).toBe(true);
    } finally {
      rename.spy.mockRestore();
      if (manifestBefore === null) fs.rmSync(manifest, { force: true });
      else fs.writeFileSync(manifest, manifestBefore);
      if (setId.value) {
        cleanupSet("speaking", setId.value);
        fs.rmSync(path.join(config.dataDir, "images/scenarios", `${setId.value}.webp`), { force: true });
      }
    }
  });

  it("fails, rather than strands, a job whose staged Set still cannot be moved into place, and removes its artifacts", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationJob({ id: "gen-rename-always", kind: "speaking" });
    runSkillTask.mockResolvedValueOnce(skillSuccess(validSpeakingSet()));
    const setId = { value: "" };
    const rename = failingSetRename(Number.POSITIVE_INFINITY);
    try {
      await expect(
        runGenerationJob({ repo: r, runSkillTask, ...speakingRunWithSceneFile(setId) }, "gen-rename-always", { kind: "speaking" }),
      ).resolves.toBeUndefined();
      expect(rename.failures.count).toBe(2);
      expect(r.getGenerationJob("gen-rename-always")).toMatchObject({ status: "failed", error: "invalid interrupted publication artifact" });
      expect(fs.existsSync(path.join(config.dataDir, "question-sets/speaking", `${setId.value}.json`))).toBe(false);
      expect(fs.existsSync(path.join(config.dataDir, "question-sets/.staging", `${setId.value}.json`))).toBe(false);
      expect(fs.existsSync(path.join(config.dataDir, "audio/stimuli", setId.value))).toBe(false);
      expect(fs.existsSync(path.join(config.dataDir, "images/scenarios", `${setId.value}.webp`))).toBe(false);
    } finally {
      rename.spy.mockRestore();
      if (setId.value) {
        cleanupSet("speaking", setId.value);
        fs.rmSync(path.join(config.dataDir, "images/scenarios", `${setId.value}.webp`), { force: true });
      }
    }
  });

  it("preserves a staging directory collision, cleans audio and scene, and records the original late validation failure", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationJob({ id: "gen-late-save-failure", kind: "speaking" });
    runSkillTask.mockResolvedValueOnce(skillSuccess(validSpeakingSet()));

    let setId = "";
    const tts = vi.fn(async (_req: unknown, outPath: string) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, "stub-audio");
    });
    const sceneImage = vi.fn(async (id: string) => {
      setId = id;
      const imagePath = path.join(config.dataDir, "images/scenarios", `${id}.webp`);
      const stagingCollision = path.join(config.dataDir, "question-sets/.staging", `${id}.json`);
      fs.mkdirSync(path.dirname(imagePath), { recursive: true });
      fs.writeFileSync(imagePath, Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.alloc(4),
        Buffer.from("WEBP"),
      ]));
      fs.mkdirSync(stagingCollision, { recursive: true });
      fs.writeFileSync(path.join(stagingCollision, "owner.txt"), "unrelated collision");
      return { file: `images/scenarios/${id}.webp`, prompt: "p", model: "gpt-image-2" as const };
    });
    // applyScene accepts the transport shape, but the authoritative schema rejects this region
    // during the final save. That reproduces the real late-failure window after all paid artifacts
    // exist without introducing a production-only test hook.
    const focusRegions = vi.fn().mockResolvedValue([
      { x: 2, y: 0.1, w: 0.2, h: 0.2 },
      ...Array.from({ length: 6 }, () => null),
    ]);

    try {
      await expect(
        runGenerationJob(
          {
            repo: r,
            runSkillTask,
            tts,
            probeDuration: async (filePath: string) => filePath.includes("iq") || filePath.includes("int-intro") ? 0.4 : 0.35,
            sceneImage: sceneImage as never,
            focusRegions: focusRegions as never,
          },
          "gen-late-save-failure",
          { kind: "speaking" },
        ),
      ).resolves.toBeUndefined();

      const job = r.getGenerationJob("gen-late-save-failure")!;
      expect(job.status).toBe("failed");
      expect(job.error).toMatch(/too_big|Too big/);
      expect(job.set_id).toBe(setId);
      expect(fs.existsSync(path.join(config.dataDir, "audio/stimuli", setId))).toBe(false);
      const stagingCollision = path.join(config.dataDir, "question-sets/.staging", `${setId}.json`);
      expect(fs.lstatSync(stagingCollision).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(stagingCollision, "owner.txt"), "utf8")).toBe("unrelated collision");
      expect(fs.existsSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`))).toBe(false);
      expect(fs.existsSync(path.join(config.dataDir, "images/scenarios", `${setId}.webp`))).toBe(false);
    } finally {
      if (setId) cleanupSet("speaking", setId);
      if (setId) fs.rmSync(path.join(config.dataDir, "images/scenarios", `${setId}.webp`), { force: true });
      if (setId) fs.rmSync(path.join(config.dataDir, "question-sets/.staging", `${setId}.json`), { recursive: true, force: true });
    }
  });

});

describe("durable provider progress display", () => {
  it("retains diversity attempts through later checkpoints and GET without exposing planning content", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    const planner = jobPlanner();
    planner.reserve.mockImplementationOnce(async (input: {
      kind: "speaking" | "writing" | "reading" | "listening";
      ownerId: string;
      onProgress?: (progress: {
        stage: "planning";
        detail: {
          provider: "codex";
          fallbackFrom: "claude";
          planningAttempt: 2;
          maxDiversityAttempts: 3;
        };
      }) => void;
    }) => {
      input.onProgress?.({
        stage: "planning",
        detail: {
          provider: "codex",
          fallbackFrom: "claude",
          planningAttempt: 2,
          maxDiversityAttempts: 3,
        },
      });
      return {
        reservationId: `reservation-${input.ownerId}`,
        ownerId: input.ownerId,
        plan: input.kind === "speaking"
          ? speakingPlanFixture()
          : writingPlanFixture(),
      };
    });
    r.createGenerationJob({ id: "durable-attempts", kind: "writing" });
    runSkillTask
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request, "codex");
        return skillSuccess(validWritingSet(), "codex");
      })
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request, "codex");
        return skillSuccess({
          items: Array.from({ length: 10 }, (_, i) => ({
            id: `bs${i + 1}`,
            verdict: "ok",
          })),
        }, "codex");
      });

    await runGenerationJob(
      { repo: r, runSkillTask, planner: planner as never },
      "durable-attempts",
      { kind: "writing" },
    );

    const response = await (
      await buildGenerateRoutes({ repo: r }).request("/durable-attempts")
    ).json();
    expect(response.progress).toEqual({
      provider: "codex",
      fallbackFrom: "claude",
      planningAttempt: 2,
      generationAttempt: 1,
      maxDiversityAttempts: 3,
      setId: response.setId,
    });

    const forbidden = new Set([
      "domain",
      "title",
      "topic",
      "scenario",
      "question",
      "answer",
      "noveltyKey",
      "distinguishesFrom",
      "catalog",
      "prompt",
    ]);
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        expect(forbidden.has(key)).toBe(false);
        visit(child);
      }
    };
    visit(response.progress);

    cleanupSet("writing", response.setId);
  });

  it("keeps the current provider and fallback through single and batch route serialization without a stale queue", async () => {
    const r = openSqliteStores();
    r.createGenerationBatch({ id: "batch-provider-progress", total: 1 });
    r.updateGenerationBatch({ id: "batch-provider-progress", status: "running" });
    r.createGenerationJob({
      id: "child-provider-progress",
      kind: "writing",
      batchId: "batch-provider-progress",
      batchIndex: 0,
    });
    r.updateGenerationJob({
      id: "child-provider-progress",
      status: "running",
      stage: "verifying",
      progress: JSON.stringify({
        provider: "codex",
        fallbackFrom: "claude",
        setId: "wri-provider-progress",
      }),
      setId: "wri-provider-progress",
    });

    const app = buildGenerateRoutes({ repo: r });
    const single = await (await app.request("/child-provider-progress")).json();
    const batch = await (await app.request("/batch-provider-progress")).json();

    expect(single.progress).toMatchObject({
      provider: "codex",
      fallbackFrom: "claude",
    });
    expect(batch.current.progress).toEqual(single.progress);
    expect(batch.children[0].progress).toEqual(single.progress);
    expect(deriveJobDisplay(single.stage, single.progress)).toMatchObject({
      provider: "codex",
      fallbackFrom: "claude",
      queuePosition: null,
      concreteStage: "verifying",
    });
  });

  // The tolerated novelty residual rides the progress channel, not `error`: a published Set is not a
  // failure. This pins the whole route it travels: fired at a planning checkpoint, merged into the
  // cumulative detail, persisted on generation_jobs.progress, still present once the job reaches
  // 'done' (the job runner leaves the last progress JSON intact), and readable by the client's own
  // deriver.
  it("persists a tolerated novelty residual on the job row and keeps it visible on done", async () => {
    const deps = buildDeps();
    const noveltyResidual = [
      { taskType: "listen_choose", kind: "containment", conflictingSetIds: ["lsn-14659f38"], score: 0.83 },
    ];
    const planner = {
      reserve: vi.fn(async (input: {
        ownerId: string;
        onProgress?: (progress: { stage: string; detail: Record<string, unknown> }) => void;
      }) => {
        input.onProgress?.({ stage: "planning", detail: { provider: "claude", planningAttempt: 1 } });
        input.onProgress?.({ stage: "planning", detail: { noveltyResidual } });
        return {
          reservationId: `reservation-${input.ownerId}`,
          ownerId: input.ownerId,
          plan: writingPlanFixture(),
          acceptedNoveltyResidual: [],
        };
      }),
      validateCandidate: vi.fn().mockReturnValue([]),
      release: vi.fn(),
    };
    deps.runSkillTask.mockImplementation(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      return skillSuccess(
        request.task.task === "generate"
          ? validWritingSet()
          : { items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok", answers: null })) },
      );
    });

    deps.repo.createGenerationJob({ id: "residual-job", kind: "writing" });
    await runGenerationJob({ ...deps, planner: planner as never }, "residual-job", { kind: "writing" });

    const row = deps.repo.getGenerationJob("residual-job");
    expect(row?.status).toBe("done");
    try {
      const progress = JSON.parse(row!.progress!) as Record<string, unknown>;
      expect(progress.noveltyResidual).toEqual(noveltyResidual);
      // Not lost to the later checkpoints that overwrite the reasoning-route fields.
      expect(progress.provider).toBe("claude");
      expect(deriveJobDisplay(row!.stage, progress).noveltyResidual).toEqual(noveltyResidual);
      // The privacy invariant, at the last hop before the UI.
      expect(row!.progress).not.toContain("planLabel");
    } finally {
      if (row?.set_id) {
        fs.rmSync(path.join(config.dataDir, "question-sets/writing", `${row.set_id}.json`), { force: true });
      }
    }
  });

  it("never derives a same-provider fallback or a queue claim outside the queued checkpoint", () => {
    expect(deriveJobDisplay("verifying", {
      provider: "claude",
      fallbackFrom: "claude",
      queuePosition: 3,
      position: 3,
    })).toMatchObject({
      provider: "claude",
      fallbackFrom: null,
      queuePosition: null,
      waiting: false,
    });
  });

  it("derives retained audio counts even when polling skips ahead to a later checkpoint", () => {
    expect(deriveJobDisplay("saving", {
      provider: "claude",
      done: 13,
      total: 13,
      setId: "spk-provider-progress",
    })).toMatchObject({
      concreteStage: "saving",
      provider: "claude",
      audioProgress: { done: 13, total: 13 },
    });
  });

  it("derives diversity attempts defensively for sticky client display", () => {
    expect(deriveJobDisplay("saving", {
      planningAttempt: 2,
      generationAttempt: 3,
      maxDiversityAttempts: 3,
    })).toMatchObject({
      planningAttempt: 2,
      generationAttempt: 3,
      maxDiversityAttempts: 3,
    });
    expect(deriveJobDisplay("saving", {
      planningAttempt: 9,
      generationAttempt: 0,
      maxDiversityAttempts: 4,
    } as never)).toMatchObject({
      planningAttempt: null,
      generationAttempt: null,
      maxDiversityAttempts: null,
    });
  });

  it("replaces a fallback route with a later direct route and keeps it isolated from the next job", async () => {
    const r = openSqliteStores();
    const firstRun = vi.fn()
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        request.onEvent?.({ state: "running", provider: "claude" });
        request.onEvent?.({
          state: "fallback",
          provider: "codex",
          fallbackFrom: "claude",
          failureKind: "quota",
        });
        request.onEvent?.({ state: "running", provider: "codex", fallbackFrom: "claude" });
        return skillSuccess(validWritingSet(), "codex");
      })
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request, "claude");
        return skillSuccess({
          items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })),
        }, "claude");
      });
    const secondRun = vi.fn()
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request, "claude");
        return skillSuccess(validWritingSet(), "claude");
      })
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request, "claude");
        return skillSuccess({
          items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })),
        }, "claude");
      });

    r.createGenerationJob({ id: "sticky-first", kind: "writing" });
    r.createGenerationJob({ id: "sticky-second", kind: "writing" });
    await runGenerationJob({ repo: r, runSkillTask: firstRun }, "sticky-first", { kind: "writing" });
    await runGenerationJob({ repo: r, runSkillTask: secondRun }, "sticky-second", { kind: "writing" });

    const first = r.getGenerationJob("sticky-first")!;
    const second = r.getGenerationJob("sticky-second")!;
    expect(JSON.parse(first.progress!)).toEqual({
      provider: "claude",
      generationAttempt: 1,
      maxDiversityAttempts: 3,
      setId: first.set_id,
    });
    expect(JSON.parse(second.progress!)).toMatchObject({
      provider: "claude",
    });
    expect(JSON.parse(second.progress!)).not.toHaveProperty("fallbackFrom");

    cleanupSet("writing", first.set_id);
    cleanupSet("writing", second.set_id);
  });
});

describe("failInterruptedGenerationJobs", () => {
  it("recovers all jobs when one has a staging directory collision, preserving it while cleaning later artifacts", () => {
    const r = openSqliteStores();
    const setId = "spk-recoverycollision1";
    r.createGenerationJob({ id: "gen-collision", kind: "speaking" });
    r.updateGenerationJob({ id: "gen-collision", status: "running", stage: "saving", setId });
    r.createGenerationJob({ id: "gen-after-collision", kind: "writing" });
    r.updateGenerationJob({ id: "gen-after-collision", status: "running", stage: "generating" });

    const stagingCollision = path.join(config.dataDir, "question-sets/.staging", `${setId}.json`);
    const stimuliDir = path.join(config.dataDir, "audio/stimuli", setId);
    const imagePath = path.join(config.dataDir, "images/scenarios", `${setId}.webp`);
    fs.mkdirSync(stagingCollision, { recursive: true });
    fs.writeFileSync(path.join(stagingCollision, "owner.txt"), "unrelated collision");
    fs.mkdirSync(stimuliDir, { recursive: true });
    fs.writeFileSync(path.join(stimuliDir, "lr1.mp3"), "partial-audio");
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, "RIFF....WEBP");

    try {
      let summary: ReturnType<typeof failInterruptedGenerationJobs> | undefined;
      expect(() => {
        summary = failInterruptedGenerationJobs({ repo: r });
      }).not.toThrow();
      expect(summary).toEqual({ jobs: 2, cleaned: 1 });
      expect(r.getGenerationJob("gen-collision")?.status).toBe("failed");
      expect(r.getGenerationJob("gen-after-collision")?.status).toBe("failed");
      expect(fs.lstatSync(stagingCollision).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(stagingCollision, "owner.txt"), "utf8")).toBe("unrelated collision");
      expect(fs.existsSync(stimuliDir)).toBe(false);
      expect(fs.existsSync(imagePath)).toBe(false);
    } finally {
      fs.rmSync(stagingCollision, { recursive: true, force: true });
      fs.rmSync(stimuliDir, { recursive: true, force: true });
      fs.rmSync(imagePath, { force: true });
    }
  });

  it("marks a job left 'running' as failed (an interrupted generation must not look 'running' forever)", () => {
    const r = openSqliteStores();
    r.createGenerationJob({ id: "gen-running", kind: "writing" });
    r.updateGenerationJob({ id: "gen-running", status: "running", stage: "generating" });

    const summary = failInterruptedGenerationJobs({ repo: r });
    expect(summary.jobs).toBe(1);

    const job = r.getGenerationJob("gen-running")!;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("interrupted by server restart");
  });

  it("deletes the half-written staging JSON and stimuli audio directory for an interrupted speaking job whose setId was minted but never published", () => {
    const r = openSqliteStores();
    const setId = "spk-interrupted1";
    r.createGenerationJob({ id: "gen-spk", kind: "speaking" });
    r.updateGenerationJob({ id: "gen-spk", status: "running", stage: "rendering-audio", setId });

    const stagingPath = path.join(config.dataDir, "question-sets/.staging", `${setId}.json`);
    const stimuliDir = path.join(config.dataDir, "audio/stimuli", setId);
    fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
    fs.writeFileSync(stagingPath, "{}"); // this path is only reachable in the tiny write-before-rename window, but exercise it anyway
    fs.mkdirSync(stimuliDir, { recursive: true });
    fs.writeFileSync(path.join(stimuliDir, "lr1.mp3"), "partial-audio");

    try {
      const summary = failInterruptedGenerationJobs({ repo: r });
      expect(summary).toEqual({ jobs: 1, cleaned: 1 });
      expect(fs.existsSync(stagingPath)).toBe(false);
      expect(fs.existsSync(stimuliDir)).toBe(false);
      expect(r.getGenerationJob("gen-spk")?.status).toBe("failed");
    } finally {
      fs.rmSync(stagingPath, { force: true });
      fs.rmSync(stimuliDir, { recursive: true, force: true });
    }
  });

  it("deletes the orphaned scene image too — it is a SECOND artifact minted under the same setId, published before the set JSON exists", () => {
    // The stimuli-directory case above, for the scene image. Without this sweep, a job killed
    // between the image's renameSync and the Set's own renameSync leaves
    // data/images/scenarios/<setId>.webp behind, referenced by nothing.
    const r = openSqliteStores();
    const setId = "spk-imageorphan1";
    r.createGenerationJob({ id: "gen-spk-img", kind: "speaking" });
    r.updateGenerationJob({ id: "gen-spk-img", status: "running", stage: "locating-regions", setId });

    const imagePath = path.join(config.dataDir, "images/scenarios", `${setId}.webp`);
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, "RIFF....WEBP");

    try {
      // No staging JSON and no stimuli directory here on purpose: the image alone must be enough to
      // count as a cleaned artifact, so the sweep can't silently depend on another one being present.
      const summary = failInterruptedGenerationJobs({ repo: r });
      expect(summary).toEqual({ jobs: 1, cleaned: 1 });
      expect(fs.existsSync(imagePath)).toBe(false);
      expect(r.getGenerationJob("gen-spk-img")?.status).toBe("failed");
    } finally {
      fs.rmSync(imagePath, { force: true });
    }
  });

  it("deletes exact-set scene-image temp files left by a hard kill during the atomic image write", () => {
    const r = openSqliteStores();
    const setId = "spk-imagetemp1";
    r.createGenerationJob({ id: "gen-spk-img-temp", kind: "speaking" });
    r.updateGenerationJob({ id: "gen-spk-img-temp", status: "running", stage: "rendering-image", setId });

    const scenariosDir = path.join(config.dataDir, "images/scenarios");
    const tempPath = path.join(scenariosDir, `.${setId}.deadbeef.webp.tmp`);
    const otherSetTemp = path.join(scenariosDir, `.${setId}-other.deadbeef.webp.tmp`);
    fs.mkdirSync(scenariosDir, { recursive: true });
    fs.writeFileSync(tempPath, "partial-webp");
    fs.writeFileSync(otherSetTemp, "belongs-to-another-set");

    try {
      expect(failInterruptedGenerationJobs({ repo: r })).toEqual({ jobs: 1, cleaned: 1 });
      expect(fs.existsSync(tempPath)).toBe(false);
      expect(fs.existsSync(otherSetTemp)).toBe(true);
    } finally {
      fs.rmSync(tempPath, { force: true });
      fs.rmSync(otherSetTemp, { force: true });
    }
  });

  it("does NOT delete the scene image when the set was actually published (the set that references it is real)", () => {
    const r = openSqliteStores();
    const setId = "spk-imagepublished1";
    r.createGenerationJob({ id: "gen-spk-img-pub", kind: "speaking" });
    r.updateGenerationJob({ id: "gen-spk-img-pub", status: "running", stage: "saving", setId });

    const imagePath = path.join(config.dataDir, "images/scenarios", `${setId}.webp`);
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, "RIFF....WEBP");
    const setPath = path.join(config.dataDir, "question-sets/speaking", `${setId}.json`);
    const published = validSpeakingSet();
    fs.writeFileSync(setPath, JSON.stringify({
      ...published,
      id: setId,
      listenAndRepeat: {
        ...published.listenAndRepeat,
        image: {
          file: `images/scenarios/${setId}.webp`,
          prompt: "trusted prompt",
          model: "gpt-image-2",
        },
      },
    }));

    try {
      expect(failInterruptedGenerationJobs({ repo: r })).toEqual({ jobs: 1, cleaned: 0 });
      expect(fs.existsSync(imagePath)).toBe(true); // deleting it would break a live set's illustration
    } finally {
      fs.rmSync(imagePath, { force: true });
      fs.rmSync(setPath, { force: true });
    }
  });

  // The stimuli directory exists from the start of a speaking render, while the first clip can take
  // network latency and tts.ts's withRetries backoff to finish. Boot cleanup is keyed on the row's
  // set_id, so renderSpeakingAudio announces {done: 0} with the setId before it creates the
  // directory. This test kills the job inside that window, after the fake tts's mkdirSync and before
  // it resolves, and asserts boot recovery still finds the setId and removes the directory.
  it("has the setId on the row before the first TTS render completes, so boot recovery removes the stimuli directory of a job killed inside that render", async () => {
    const r = openSqliteStores();
    const runSkillTask = vi.fn().mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      return skillSuccess(validSpeakingSet());
    });

    let stimuliDir: string | undefined;
    let releaseFirstRender!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirstRender = resolve; });
    let ttsCalledResolve!: () => void;
    const ttsCalled = new Promise<void>((resolve) => { ttsCalledResolve = resolve; });
    // Mirrors tts.ts's synthesizeToFile: a synchronous mkdirSync of dirname(outPath), then a network
    // call, here an await on `gate` standing in for the network latency and retry backoff.
    const tts = vi.fn(async (_req: unknown, outPath: string) => {
      stimuliDir = path.dirname(outPath);
      fs.mkdirSync(stimuliDir, { recursive: true });
      fs.writeFileSync(outPath, "partial-audio");
      ttsCalledResolve();
      await gate;
    });

    r.createGenerationJob({ id: "gen-spk-early-kill", kind: "speaking" });
    const runPromise = runGenerationJob({ repo: r, runSkillTask, tts, ...sceneDeps() }, "gen-spk-early-kill", { kind: "speaking" });

    // Waits until the first tts() call has done its synchronous mkdirSync and write and is blocked on
    // `gate`. The {done: 0} announce and its synchronous row write happen before the loop calls
    // tts() at all, so they have landed by the time this promise resolves.
    await ttsCalled;

    const midFlight = r.getGenerationJob("gen-spk-early-kill")!;
    expect(midFlight.status).toBe("running");
    expect(midFlight.set_id).not.toBeNull(); // known before the first render finished
    expect(stimuliDir).toBeDefined();
    expect(fs.existsSync(stimuliDir!)).toBe(true); // the directory recovery has to find

    // Simulate the kill: boot recovery runs against the row exactly as a restarted process would
    // find it — still 'running', first render never finished.
    const summary = failInterruptedGenerationJobs({ repo: r });
    expect(summary).toEqual({ jobs: 1, cleaned: 1 });
    expect(fs.existsSync(stimuliDir!)).toBe(false);
    expect(r.getGenerationJob("gen-spk-early-kill")?.status).toBe("failed");

    // Let the abandoned in-process run settle so it doesn't outlive the test. What it does from here
    // does not affect the assertions, but it does touch the filesystem: it re-creates the stimuli
    // directory recovery just deleted, renders the remaining stubs and publishes the Set, which
    // cleanupSet then removes.
    releaseFirstRender();
    await runPromise.catch(() => undefined);
    cleanupSet("speaking", midFlight.set_id);
  });

  it("does NOT delete anything when the set was actually already published — only this job row's own bookkeeping was lost (crash between renameSync and the 'done' write)", () => {
    const r = openSqliteStores();
    const setId = "wri-published1";
    r.createGenerationJob({ id: "gen-pub", kind: "writing" });
    r.updateGenerationJob({ id: "gen-pub", status: "running", stage: "saving", setId });

    const dir = path.join(config.dataDir, "question-sets/writing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${setId}.json`), JSON.stringify({ id: setId }));

    try {
      const summary = failInterruptedGenerationJobs({ repo: r });
      expect(summary).toEqual({ jobs: 1, cleaned: 0 });
      expect(fs.existsSync(path.join(dir, `${setId}.json`))).toBe(true); // untouched
      expect(r.getGenerationJob("gen-pub")?.status).toBe("failed"); // still marked failed — only disk state is protected
    } finally {
      fs.rmSync(path.join(dir, `${setId}.json`), { force: true });
    }
  });

  it("a job with no setId yet (crashed before the claude call even returned) has nothing to clean up", () => {
    const r = openSqliteStores();
    r.createGenerationJob({ id: "gen-early", kind: "speaking" });
    r.updateGenerationJob({ id: "gen-early", status: "running" }); // stage/setId still null

    const summary = failInterruptedGenerationJobs({ repo: r });
    expect(summary).toEqual({ jobs: 1, cleaned: 0 });
    expect(r.getGenerationJob("gen-early")?.status).toBe("failed");
  });

  it("leaves 'done'/'failed' jobs completely untouched — only queued|running jobs are recovered", () => {
    const r = openSqliteStores();
    r.createGenerationJob({ id: "gen-done", kind: "writing" });
    r.updateGenerationJob({ id: "gen-done", status: "done", setId: "wri-alreadydone" });

    const summary = failInterruptedGenerationJobs({ repo: r });
    expect(summary).toEqual({ jobs: 0, cleaned: 0 });
    expect(r.getGenerationJob("gen-done")?.status).toBe("done");
  });

});

describe("wireGenerationBootRecovery", () => {
  it("does not run recovery at wiring time — only once the server fires 'listening' (confirming this process owns the port)", () => {
    const r = openSqliteStores();
    r.createGenerationJob({ id: "gen-wire", kind: "writing" });
    r.updateGenerationJob({ id: "gen-wire", status: "running" });

    const listeners: Partial<Record<"listening", () => void>> = {};
    const fakeServer: BootRecoveryServer = {
      on: (event, listener) => { listeners[event] = listener; },
    };

    wireGenerationBootRecovery(fakeServer, r);

    expect(r.getGenerationJob("gen-wire")?.status).toBe("running");

    listeners.listening!();
    expect(r.getGenerationJob("gen-wire")?.status).toBe("failed");
  });

  // The boot passes run one after another, and a throw from one ends the rest and the boot itself.
  // Generation's leftovers are not worth that: the pass reports its fault and returns.
  it("reports a fault in the pass instead of throwing it into the boot", () => {
    const unavailable = new Proxy(openSqliteStores(), {
      get() {
        throw new Error("store unavailable");
      },
    });
    const listeners: Partial<Record<"listening", () => void>> = {};
    const fakeServer: BootRecoveryServer = {
      on: (event, listener) => { listeners[event] = listener; },
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      wireGenerationBootRecovery(fakeServer, unavailable);
      expect(() => listeners.listening!()).not.toThrow();
      expect(errors.mock.calls.some(([first]) => String(first).includes("generation boot recovery failed"))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});

function writingSkillCall() {
  return async (request: SkillTaskRequest<unknown>) => {
    emitRunning(request);
    return skillSuccess(validWritingSet());
  };
}
function verifyOkSkillCall() {
  return async (request: SkillTaskRequest<unknown>) => {
    emitRunning(request);
    return skillSuccess({
      items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })),
    });
  };
}
function cleanupSet(kind: "writing" | "speaking", setId: string | null | undefined) {
  if (!setId) return;
  fs.rmSync(path.join(config.dataDir, "question-sets", kind, `${setId}.json`), { force: true });
  // A published speaking Set owns a sibling stimuli directory too.
  fs.rmSync(path.join(config.dataDir, "audio/stimuli", setId), { recursive: true, force: true });
}

describe("computeBatchStatus", () => {
  it("classifies a batch's children into done (all done) / partial (mixed) / failed (all failed)", () => {
    expect(computeBatchStatus([{ status: "done" }, { status: "done" }])).toBe("done");
    expect(computeBatchStatus([{ status: "done" }, { status: "failed" }])).toBe("partial");
    expect(computeBatchStatus([{ status: "failed" }, { status: "failed" }])).toBe("failed");
  });

  // A child can be cancelled without its parent (POST /api/generate/:id/cancel takes a child's own
  // id, and the in-memory shutdown abort reaches children one by one), so one cancelled child among
  // nine published Sets is a partial batch, not a cancelled one. Cancellation is the batch's whole
  // story only when it cost every Set.
  it("reports partial, not cancelled, when a child was cancelled but others still published", () => {
    expect(computeBatchStatus([{ status: "done" }, { status: "cancelled" }])).toBe("partial");
    expect(computeBatchStatus([{ status: "done" }, { status: "failed" }, { status: "cancelled" }])).toBe("partial");
    expect(
      computeBatchStatus([
        ...Array.from({ length: 9 }, () => ({ status: "done" })),
        { status: "cancelled" },
      ]),
    ).toBe("partial");
  });

  it("still reports cancelled when no child completed", () => {
    expect(computeBatchStatus([{ status: "cancelled" }, { status: "cancelled" }])).toBe("cancelled");
    // Cancelled children count alongside the failed ones, but a cancel that salvaged nothing is
    // still what the User asked for and is what the batch should say happened.
    expect(computeBatchStatus([{ status: "failed" }, { status: "cancelled" }])).toBe("cancelled");
  });
});

describe("runGenerationBatch", () => {
  // Pins the window, not a sequential runner: every test in this describe runs at batchConcurrency
  // 1 (see the wrapper at the top of this file) for deterministic mock ordering, and at that setting
  // the window must admit exactly one child at a time. The real default is GENERATION_BATCH_WINDOW.
  it("admits one child at a time at concurrency 1 — the next set's reasoning call never fires until the previous set has reached a terminal DB status (gated stub), and the parent reports 'done' once every child succeeds", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationBatch({ id: "batch-seq", total: 2 });
    r.createGenerationJob({ id: "child-0", kind: "writing", batchId: "batch-seq", batchIndex: 0 });
    r.createGenerationJob({ id: "child-1", kind: "writing", batchId: "batch-seq", batchIndex: 1 });

    let releaseChild0Verify!: () => void;
    const child0VerifyGate = new Promise<void>((resolve) => { releaseChild0Verify = resolve; });
    let child0VerifyStartedResolve!: () => void;
    const child0VerifyStarted = new Promise<void>((resolve) => { child0VerifyStartedResolve = resolve; });
    let child0StatusWhenChild1GenerateFired: string | undefined;

    runSkillTask
      .mockImplementationOnce(writingSkillCall()) // child-0 generate
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => { // child-0 verify, gated
        emitRunning(request);
        child0VerifyStartedResolve();
        await child0VerifyGate;
        return skillSuccess({
          items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })),
        });
      })
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => { // child-1 generate
        emitRunning(request);
        // If the window admitted child-1 before child-0 settled, this would run while child-0 is
        // still blocked on its gated verify call (status 'running'), not after it reached 'done'.
        child0StatusWhenChild1GenerateFired = r.getGenerationJob("child-0")?.status;
        return skillSuccess(validWritingSet());
      })
      .mockImplementationOnce(verifyOkSkillCall()); // child-1 verify

    const runPromise = runGenerationBatch({ repo: r, runSkillTask }, "batch-seq");

    await child0VerifyStarted;
    expect(r.getGenerationJob("child-0")?.status).toBe("running"); // still mid-flight
    expect(runSkillTask).toHaveBeenCalledTimes(2); // only child-0's two calls so far — child-1 hasn't started
    releaseChild0Verify();

    await runPromise;

    expect(child0StatusWhenChild1GenerateFired).toBe("done");
    expect(r.getGenerationJob("child-0")?.status).toBe("done");
    expect(r.getGenerationJob("child-1")?.status).toBe("done");
    expect(r.getGenerationBatch("batch-seq")?.status).toBe("done");

    cleanupSet("writing", r.getGenerationJob("child-0")?.set_id);
    cleanupSet("writing", r.getGenerationJob("child-1")?.set_id);
  });

  it("plans each child immediately before generation and the next plan sees the earlier published set", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationBatch({ id: "batch-plan-boundary", total: 2 });
    r.createGenerationJob({
      id: "plan-child-0",
      kind: "writing",
      batchId: "batch-plan-boundary",
      batchIndex: 0,
    });
    r.createGenerationJob({
      id: "plan-child-1",
      kind: "writing",
      batchId: "batch-plan-boundary",
      batchIndex: 1,
    });

    const events: string[] = [];
    let activeOwner: string | null = null;
    let secondPlanSawPublishedFirst = false;
    const planner = {
      reserve: vi.fn(async (input: {
        kind: "speaking" | "writing" | "reading" | "listening";
        ownerId: string;
      }) => {
        events.push(`plan:${input.ownerId}`);
        activeOwner = input.ownerId;
        if (input.ownerId === "plan-child-1") {
          const first = r.getGenerationJob("plan-child-0");
          secondPlanSawPublishedFirst =
            first?.status === "done" &&
            typeof first.set_id === "string" &&
            fs.existsSync(path.join(
              config.dataDir,
              "question-sets/writing",
              `${first.set_id}.json`,
            ));
        }
        return {
          reservationId: `reservation-${input.ownerId}`,
          ownerId: input.ownerId,
          plan: writingPlanFixture(),
        };
      }),
      validateCandidate: vi.fn().mockReturnValue([]),
      release: vi.fn(() => {
        if (activeOwner) events.push(`release:${activeOwner}`);
        activeOwner = null;
      }),
    };
    runSkillTask.mockImplementation(
      async (request: SkillTaskRequest<unknown>) => {
        events.push(`${request.task.task}:${activeOwner}`);
        emitRunning(request);
        if (request.task.task === "generate") {
          return skillSuccess(validWritingSet());
        }
        return skillSuccess({
          items: Array.from({ length: 10 }, (_, i) => ({
            id: `bs${i + 1}`,
            verdict: "ok",
          })),
        });
      },
    );

    await runGenerationBatch(
      { repo: r, runSkillTask, planner: planner as never },
      "batch-plan-boundary",
    );

    expect(events).toEqual([
      "plan:plan-child-0",
      "generate:plan-child-0",
      "verify:plan-child-0",
      "release:plan-child-0",
      "plan:plan-child-1",
      "generate:plan-child-1",
      "verify:plan-child-1",
      "release:plan-child-1",
    ]);
    expect(secondPlanSawPublishedFirst).toBe(true);

    cleanupSet("writing", r.getGenerationJob("plan-child-0")?.set_id);
    cleanupSet("writing", r.getGenerationJob("plan-child-1")?.set_id);
  });

  it("partial success: one child failing does not stop the batch — the next child still runs, banked sets stay, and the parent reports 'partial'", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationBatch({ id: "batch-partial", total: 2 });
    r.createGenerationJob({ id: "child-fail", kind: "writing", batchId: "batch-partial", batchIndex: 0 });
    r.createGenerationJob({ id: "child-ok", kind: "writing", batchId: "batch-partial", batchIndex: 1 });

    runSkillTask
      .mockResolvedValueOnce(SANITIZED_ROUTE_FAILURE) // child-fail's generate
      .mockImplementationOnce(writingSkillCall()) // child-ok generate
      .mockImplementationOnce(verifyOkSkillCall()); // child-ok verify

    await runGenerationBatch({ repo: r, runSkillTask }, "batch-partial");

    expect(r.getGenerationJob("child-fail")?.status).toBe("failed");
    expect(r.getGenerationJob("child-fail")?.error).toBe(SANITIZED_ROUTE_FAILURE.error);
    expect(r.getGenerationJob("child-ok")?.status).toBe("done"); // still ran, despite child-fail's failure
    expect(r.getGenerationBatch("batch-partial")?.status).toBe("partial");

    cleanupSet("writing", r.getGenerationJob("child-ok")?.set_id);
  });

  it("all children failing resolves the parent to 'failed' (not 'partial') — distinguishing all-failed from a mixed outcome", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationBatch({ id: "batch-all-failed", total: 2 });
    r.createGenerationJob({ id: "af0", kind: "writing", batchId: "batch-all-failed", batchIndex: 0 });
    r.createGenerationJob({ id: "af1", kind: "writing", batchId: "batch-all-failed", batchIndex: 1 });

    runSkillTask.mockResolvedValue(SANITIZED_ROUTE_FAILURE);

    await runGenerationBatch({ repo: r, runSkillTask }, "batch-all-failed");

    expect(r.getGenerationJob("af0")?.status).toBe("failed");
    expect(r.getGenerationJob("af1")?.status).toBe("failed");
    expect(r.getGenerationBatch("batch-all-failed")?.status).toBe("failed");
  });

  it("cancels every unpublished queued child once batch cancellation is observed", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationBatch({ id: "batch-cancel", total: 3 });
    r.createGenerationJob({ id: "c0", kind: "writing", batchId: "batch-cancel", batchIndex: 0 });
    r.createGenerationJob({ id: "c1", kind: "writing", batchId: "batch-cancel", batchIndex: 1 });
    r.createGenerationJob({ id: "c2", kind: "writing", batchId: "batch-cancel", batchIndex: 2 });

    let releaseC0Verify!: () => void;
    const gate = new Promise<void>((resolve) => { releaseC0Verify = resolve; });
    let c0VerifyStartedResolve!: () => void;
    const c0VerifyStarted = new Promise<void>((resolve) => { c0VerifyStartedResolve = resolve; });

    // Only c0's generate and verify are queued: a reasoning call from c1 or c2 after the cancel
    // would get the bare mock's undefined and fail the assertions below.
    runSkillTask
      .mockImplementationOnce(writingSkillCall()) // c0 generate
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => { // c0 verify, gated
        emitRunning(request);
        c0VerifyStartedResolve();
        await gate;
        return skillSuccess({
          items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })),
        });
      });

    const runPromise = runGenerationBatch({ repo: r, runSkillTask }, "batch-cancel");

    await c0VerifyStarted;
    expect(r.getGenerationBatch("batch-cancel")?.status).toBe("running");
    // POST /:batchId/cancel arriving while c0 is still in flight.
    r.updateGenerationBatch({ id: "batch-cancel", cancelRequested: true });
    releaseC0Verify(); // let c0 finish naturally — a cancel must never interrupt an in-flight render

    await runPromise;

    expect(r.getGenerationJob("c0")?.status).toBe("done"); // finished normally, untouched by the cancel
    expect(r.getGenerationJob("c1")?.status).toBe("cancelled");
    expect(r.getGenerationJob("c2")?.status).toBe("cancelled");
    // c0's Set published and is kept, so the batch is 'partial', not 'cancelled', which would tell
    // the User nothing survived when a third of the batch did.
    expect(r.getGenerationBatch("batch-cancel")?.status).toBe("partial");
    expect(runSkillTask).toHaveBeenCalledTimes(2); // only c0's two calls — c1/c2 never used reasoning

    cleanupSet("writing", r.getGenerationJob("c0")?.set_id);
  });

  // The other half of the same rule: nothing published, so cancellation is the whole story and
  // 'cancelled' is the honest report.
  it("reports 'cancelled' when the cancel landed before any child could publish", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationBatch({ id: "batch-cancel-all", total: 2 });
    r.createGenerationJob({ id: "ca0", kind: "writing", batchId: "batch-cancel-all", batchIndex: 0 });
    r.createGenerationJob({ id: "ca1", kind: "writing", batchId: "batch-cancel-all", batchIndex: 1 });
    // The cancel wins the race against the runner's first admission check.
    r.updateGenerationBatch({ id: "batch-cancel-all", cancelRequested: true });

    await runGenerationBatch({ repo: r, runSkillTask }, "batch-cancel-all");

    expect(r.getGenerationJob("ca0")?.status).toBe("cancelled");
    expect(r.getGenerationJob("ca1")?.status).toBe("cancelled");
    expect(r.getGenerationBatch("batch-cancel-all")?.status).toBe("cancelled");
    expect(runSkillTask).not.toHaveBeenCalled(); // no spend at all
  });

  // A child cancelled on its own: POST /:id/cancel with the child's id stamps the child's row and
  // aborts it in memory without touching the batch's `cancel_requested`. Its siblings keep running
  // and publishing, so the batch must not report itself cancelled.
  it("reports 'partial' when ONE child is cancelled directly and its siblings still publish", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationBatch({ id: "batch-child-cancel", total: 2 });
    r.createGenerationJob({ id: "cw0", kind: "writing", batchId: "batch-child-cancel", batchIndex: 0 });
    r.createGenerationJob({ id: "cw1", kind: "writing", batchId: "batch-child-cancel", batchIndex: 1 });

    let releaseCw0Verify!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCw0Verify = resolve; });
    let cw0VerifyStartedResolve!: () => void;
    const cw0VerifyStarted = new Promise<void>((resolve) => { cw0VerifyStartedResolve = resolve; });

    runSkillTask
      .mockImplementationOnce(writingSkillCall()) // cw0 generate
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => { // cw0 verify, gated
        emitRunning(request);
        cw0VerifyStartedResolve();
        await gate;
        return skillSuccess({
          items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })),
        });
      })
      .mockImplementationOnce(writingSkillCall()) // cw1 generate
      .mockImplementationOnce(verifyOkSkillCall()); // cw1 verify

    const runPromise = runGenerationBatch({ repo: r, runSkillTask }, "batch-child-cancel");

    await cw0VerifyStarted;
    // What routes/generate.ts's cancel route does when handed a child's own id.
    r.requestGenerationJobCancellation({ id: "cw0", reason: "user", now: sqliteTimestamp() });
    expect(abortGenerationJob("cw0", "user")).toBe(true);
    releaseCw0Verify();

    await runPromise;

    expect(r.getGenerationJob("cw0")?.status).toBe("cancelled");
    expect(r.getGenerationBatch("batch-child-cancel")?.cancel_requested).toBe(0); // parent never cancelled
    expect(r.getGenerationJob("cw1")?.status).toBe("done"); // sibling ran and published anyway
    expect(r.getGenerationBatch("batch-child-cancel")?.status).toBe("partial");

    cleanupSet("writing", r.getGenerationJob("cw1")?.set_id);
  });

  // The same per-child cancel, landing while the child is still queued behind the window. That is
  // not a narrow race: a child stays queued for as long as every child ahead of it runs. The
  // window's shouldAdmit reads only the parent's cancel flag, which a per-child cancel never sets,
  // so the child is admitted and refused by its own running claim, and the runner still has to
  // terminalize it in this run. Left at 'queued', it would sit in a terminal batch with anything
  // polling its id waiting until the next boot.
  it("cancels a child by its own id BEFORE the window admits it, in the same run, leaving its siblings alone", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationBatch({ id: "batch-preadmit-cancel", total: 2 });
    r.createGenerationJob({ id: "pa0", kind: "writing", batchId: "batch-preadmit-cancel", batchIndex: 0 });
    r.createGenerationJob({ id: "pa1", kind: "writing", batchId: "batch-preadmit-cancel", batchIndex: 1 });

    let releasePa0Verify!: () => void;
    const gate = new Promise<void>((resolve) => { releasePa0Verify = resolve; });
    let pa0VerifyStartedResolve!: () => void;
    const pa0VerifyStarted = new Promise<void>((resolve) => { pa0VerifyStartedResolve = resolve; });

    // Only pa0's two calls are queued: a reasoning call from the cancelled pa1 would get the bare
    // mock's undefined and fail the assertions below.
    runSkillTask
      .mockImplementationOnce(writingSkillCall()) // pa0 generate
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => { // pa0 verify, gated
        emitRunning(request);
        pa0VerifyStartedResolve();
        await gate;
        return skillSuccess({
          items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })),
        });
      });

    const runPromise = runGenerationBatch({ repo: r, runSkillTask }, "batch-preadmit-cancel");

    await pa0VerifyStarted;
    expect(r.getGenerationJob("pa1")?.status).toBe("queued"); // still waiting behind pa0
    // What POST /api/generate/:id/cancel does when handed a child's own id. The abort finds nothing
    // to wake, since pa1 has no run registered, so the durable request is the cancel's only trace
    // and honouring it is the runner's job.
    r.requestGenerationJobCancellation({ id: "pa1", reason: "user", now: sqliteTimestamp() });
    expect(abortGenerationJob("pa1", "user")).toBe(false);
    releasePa0Verify();

    await runPromise;

    const cancelled = r.getGenerationJob("pa1")!;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.terminal_at).not.toBeNull(); // terminal in this run, not at the next boot
    expect(cancelled.cancelled_at).not.toBeNull();
    expect(cancelled.cancellation_reason).toBe("user"); // its own cancel, never recast as its parent's
    expect(r.getGenerationJob("pa0")?.status).toBe("done"); // sibling ran and published, untouched
    expect(r.getGenerationBatch("batch-preadmit-cancel")?.cancel_requested).toBe(0); // parent never cancelled
    // pa0's Set published and is kept, so 'partial', not 'cancelled'.
    expect(r.getGenerationBatch("batch-preadmit-cancel")?.status).toBe("partial");
    expect(runSkillTask).toHaveBeenCalledTimes(2); // pa1 cost no reasoning call at all

    cleanupSet("writing", r.getGenerationJob("pa0")?.set_id);
  });

  it("a cancel requested after the last child has already started has nothing left to stop — the batch still resolves done/partial/failed normally, not 'cancelled'", async () => {
    const { repo: r, runSkillTask } = buildDeps();
    r.createGenerationBatch({ id: "batch-cancel-noop", total: 1 });
    r.createGenerationJob({ id: "cn0", kind: "writing", batchId: "batch-cancel-noop", batchIndex: 0 });

    runSkillTask
      .mockImplementationOnce(writingSkillCall())
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request);
        // Cancel arrives after this (the only, and already-running) child has started — there is
        // nothing left in the sequence for it to stop.
        r.updateGenerationBatch({ id: "batch-cancel-noop", cancelRequested: true });
        return skillSuccess({
          items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })),
        });
      });

    await runGenerationBatch({ repo: r, runSkillTask }, "batch-cancel-noop");

    expect(r.getGenerationJob("cn0")?.status).toBe("done");
    expect(r.getGenerationBatch("batch-cancel-noop")?.status).toBe("done"); // not 'cancelled' — nothing was actually stopped

    cleanupSet("writing", r.getGenerationJob("cn0")?.set_id);
  });
});

describe("failInterruptedGenerationJobs: batch recovery", () => {
  it("marks a batch's non-terminal children failed and recomputes the parent to 'partial' when some children had already finished successfully before the crash", () => {
    const r = openSqliteStores();
    r.createGenerationBatch({ id: "batch-crash-partial", total: 3 });
    r.updateGenerationBatch({ id: "batch-crash-partial", status: "running" });
    r.createGenerationJob({ id: "cc0", kind: "writing", batchId: "batch-crash-partial", batchIndex: 0 });
    r.updateGenerationJob({ id: "cc0", status: "done", setId: "wri-crashdone1" });
    r.createGenerationJob({ id: "cc1", kind: "writing", batchId: "batch-crash-partial", batchIndex: 1 });
    r.updateGenerationJob({ id: "cc1", status: "running", stage: "verifying" }); // orphaned mid-flight
    r.createGenerationJob({ id: "cc2", kind: "writing", batchId: "batch-crash-partial", batchIndex: 2 });
    // cc2 stays 'queued' — never even started before the crash

    const dir = path.join(config.dataDir, "question-sets/writing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "wri-crashdone1.json"), JSON.stringify({ id: "wri-crashdone1" }));

    try {
      const summary = failInterruptedGenerationJobs({ repo: r });
      expect(summary.jobs).toBe(2); // cc1 (running) + cc2 (queued) swept — cc0 was already terminal

      expect(r.getGenerationJob("cc0")?.status).toBe("done"); // untouched — already terminal
      expect(r.getGenerationJob("cc1")?.status).toBe("failed");
      expect(r.getGenerationJob("cc1")?.error).toBe("interrupted by server restart");
      expect(r.getGenerationJob("cc2")?.status).toBe("failed"); // never started, but still non-terminal at boot

      const batch = r.getGenerationBatch("batch-crash-partial")!;
      expect(batch.status).toBe("partial"); // 1 done, 2 failed — neither all-succeeded nor all-failed
      expect(batch.error).toBeNull(); // 'partial' carries no top-level error — per-child errors already say why
    } finally {
      fs.rmSync(path.join(dir, "wri-crashdone1.json"), { force: true });
    }
  });

  it("recomputes an interrupted batch as 'failed' when every child ends up failed, and leaves an already-terminal batch parent completely untouched", () => {
    const r = openSqliteStores();
    r.createGenerationBatch({ id: "batch-crash-failed", total: 2 });
    r.updateGenerationBatch({ id: "batch-crash-failed", status: "running" });
    r.createGenerationJob({ id: "cf0", kind: "writing", batchId: "batch-crash-failed", batchIndex: 0 });
    r.updateGenerationJob({ id: "cf0", status: "running" });
    r.createGenerationJob({ id: "cf1", kind: "writing", batchId: "batch-crash-failed", batchIndex: 1 });
    // cf1 stays 'queued'

    r.createGenerationBatch({ id: "batch-already-done", total: 1 });
    r.updateGenerationBatch({ id: "batch-already-done", status: "done" });

    const summary = failInterruptedGenerationJobs({ repo: r });
    expect(summary.jobs).toBe(2);

    const batch = r.getGenerationBatch("batch-crash-failed")!;
    expect(batch.status).toBe("failed");
    expect(batch.error).toBe("interrupted by server restart");

    // A batch that was already terminal before this boot must not be touched at all.
    expect(r.getGenerationBatch("batch-already-done")?.status).toBe("done");
  });

  it("still cleans up a half-written artifact for an interrupted batch child exactly like a standalone job would (batch_id being set changes nothing about per-child cleanup)", () => {
    const r = openSqliteStores();
    r.createGenerationBatch({ id: "batch-crash-artifact", total: 1 });
    r.updateGenerationBatch({ id: "batch-crash-artifact", status: "running" });
    const setId = "spk-batchorphan1";
    r.createGenerationJob({ id: "ca0", kind: "speaking", batchId: "batch-crash-artifact", batchIndex: 0 });
    r.updateGenerationJob({ id: "ca0", status: "running", stage: "rendering-audio", setId });

    const stimuliDir = path.join(config.dataDir, "audio/stimuli", setId);
    fs.mkdirSync(stimuliDir, { recursive: true });
    fs.writeFileSync(path.join(stimuliDir, "lr1.mp3"), "partial-audio");

    try {
      const summary = failInterruptedGenerationJobs({ repo: r });
      expect(summary).toEqual({ jobs: 1, cleaned: 1 });
      expect(fs.existsSync(stimuliDir)).toBe(false);
      expect(r.getGenerationJob("ca0")?.status).toBe("failed");
      expect(r.getGenerationBatch("batch-crash-artifact")?.status).toBe("failed"); // its one and only child failed
    } finally {
      fs.rmSync(stimuliDir, { recursive: true, force: true });
    }
  });

  // Boot recovery can produce cancelled children: index.ts's shutdown stamps `cancel_requested_at`
  // on every interrupted generation job, and the sweep honours that stamp rather than overwriting it
  // with 'failed'. The reclassification must reach the verdict the live runner would for the same
  // children, so it is asserted against computeBatchStatus rather than restated as a literal.
  it("reclassifies a crash-recovered batch exactly as the live runner would, cancelled children included", () => {
    const r = openSqliteStores();
    const now = sqliteTimestamp();
    r.createGenerationBatch({ id: "batch-crash-cancelled", total: 3 });
    r.updateGenerationBatch({ id: "batch-crash-cancelled", status: "running" });
    r.createGenerationJob({ id: "cx0", kind: "writing", batchId: "batch-crash-cancelled", batchIndex: 0 });
    r.updateGenerationJob({ id: "cx0", status: "done", setId: "wri-crashcancel1" });
    r.createGenerationJob({ id: "cx1", kind: "writing", batchId: "batch-crash-cancelled", batchIndex: 1 });
    r.updateGenerationJob({ id: "cx1", status: "running", stage: "verifying" });
    r.requestGenerationJobCancellation({ id: "cx1", reason: "shutdown", now }); // shutdown got this far
    r.createGenerationJob({ id: "cx2", kind: "writing", batchId: "batch-crash-cancelled", batchIndex: 2 });
    r.requestGenerationJobCancellation({ id: "cx2", reason: "shutdown", now });

    failInterruptedGenerationJobs({ repo: r });

    const children = r.listGenerationJobsByBatch("batch-crash-cancelled");
    expect(children.map((c) => c.status)).toEqual(["done", "cancelled", "cancelled"]);
    const batch = r.getGenerationBatch("batch-crash-cancelled")!;
    expect(batch.status).toBe(computeBatchStatus(children));
    expect(batch.status).toBe("partial"); // cx0's Set published and is retained
    expect(batch.error).toBeNull();
  });

  it("recovers a batch whose every child was cancelled at shutdown as 'cancelled'", () => {
    const r = openSqliteStores();
    const now = sqliteTimestamp();
    r.createGenerationBatch({ id: "batch-crash-all-cancelled", total: 2 });
    r.updateGenerationBatch({ id: "batch-crash-all-cancelled", status: "running" });
    for (const id of ["cy0", "cy1"]) {
      r.createGenerationJob({ id, kind: "writing", batchId: "batch-crash-all-cancelled", batchIndex: id === "cy0" ? 0 : 1 });
      r.updateGenerationJob({ id, status: "running" });
      r.requestGenerationJobCancellation({ id, reason: "shutdown", now });
    }

    failInterruptedGenerationJobs({ repo: r });

    const children = r.listGenerationJobsByBatch("batch-crash-all-cancelled");
    expect(children.map((c) => c.status)).toEqual(["cancelled", "cancelled"]);
    const batch = r.getGenerationBatch("batch-crash-all-cancelled")!;
    expect(batch.status).toBe(computeBatchStatus(children));
    expect(batch.status).toBe("cancelled");
  });
});
