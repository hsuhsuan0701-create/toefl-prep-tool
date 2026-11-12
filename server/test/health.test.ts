import { describe, expect, it, vi } from "vitest";
import { app, wireAllBootRecovery } from "../src/index.js";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { sqliteTimestamp } from "../src/db/timestamps.js";
import { INTERRUPTED_BY_RESTART_ERROR } from "../src/services/transcriptionRecovery.js";

describe("health", () => {
  it("responds ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// The composition root's `if (NODE_ENV !== "test")` guard means index.ts's own wiring block can
// never be exercised by this suite, so the order of the chain it wires is asserted here: the speaking
// reconcile must observe what every earlier pass already settled.
describe("wireAllBootRecovery", () => {
  function fakeServer() {
    const listeners: (() => unknown)[] = [];
    return {
      server: { on: (_event: "listening", listener: () => void) => { listeners.push(listener); } },
      // Synchronous dispatch, the way Node's EventEmitter calls listeners; the returned promise
      // settles once every async listener has.
      fireListening: () => Promise.all(listeners.map((l) => l())),
    };
  }

  it("settles durable state before the speaking reconcile observes it", async () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-order", kind: "speaking", mode: "simulation", setId: "spk-order", isRepeat: false });
    // An interrupted scoring job, exactly as a previous process's death would leave it.
    r.createScoringJob({ id: "job-interrupted", attemptId: "att-order", taskType: "listen_repeat", itemIds: ["lr-1"] });
    expect(r.getScoringJob("job-interrupted")?.status).toBe("queued");

    // The last pass reports what it observes, which is the only way to tell "ran last" from "ran
    // first": had it run first it would see the interrupted job still 'queued'.
    let scoringJobStatusSeenByReconcile: string | undefined;
    const speakingFinalization = {
      reconcileAttempt: async () => {
        scoringJobStatusSeenByReconcile = r.getScoringJob("job-interrupted")?.status;
      },
    };

    const { server, fireListening } = fakeServer();
    wireAllBootRecovery(server, r, { speakingFinalization });
    // Registration alone must do nothing: every pass waits for 'listening', which production fires
    // once this process holds the execution lease.
    expect(scoringJobStatusSeenByReconcile).toBeUndefined();
    expect(r.getScoringJob("job-interrupted")?.status).toBe("queued");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await fireListening();
    logSpy.mockRestore();
    expect(r.getScoringJob("job-interrupted")?.status).toBe("failed");
    expect(scoringJobStatusSeenByReconcile).toBe("failed");
  });

  // Boot recovery spends nothing, which is safe only while every durable row stays retryable by an
  // explicit User action. A transcription a restart caught mid-Ears would not be: it stays
  // 'running', which arms no timer and which retry() refuses. So boot does the one piece of
  // bookkeeping, failing it as interrupted, and still starts nothing paid.
  it("terminalizes a transcription interrupted by the restart while starting no paid transcription or scoring work", async () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-30-boot", kind: "speaking", mode: "simulation", setId: "spk-order", isRepeat: false });
    const job = r.createOrGetTranscriptionJob({
      id: "tj-30-boot", attemptId: "att-30-boot", itemId: "lr-1", taskType: "listen_repeat",
      audioPath: "audio/responses/att-30-boot/lr-1.webm", audioSha256: "a".repeat(64), now: sqliteTimestamp(),
    });
    r.claimTranscriptionJob({ id: job.id, now: sqliteTimestamp() }); // -> 'running', then the process died
    expect(r.getTranscriptionJob(job.id)?.status).toBe("running");

    // The boot chain is handed the finalizer and nothing that can call Ears; reconciling is free.
    const reconciledAttempts: string[] = [];
    const speakingFinalization = {
      reconcileAttempt: async (attemptId: string) => { reconciledAttempts.push(attemptId); },
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { server, fireListening } = fakeServer();
    wireAllBootRecovery(server, r, { speakingFinalization });
    expect(r.getTranscriptionJob(job.id)?.status).toBe("running"); // registration alone does nothing

    await fireListening();
    logSpy.mockRestore();

    const swept = r.getTranscriptionJob(job.id)!;
    expect(swept.status).toBe("failed"); // terminal, and therefore accepted by retry()
    expect(swept.error).toBe(INTERRUPTED_BY_RESTART_ERROR);
    expect(reconciledAttempts).toEqual(["att-30-boot"]);
    expect(r.listAllScoringJobs()).toEqual([]); // and no scoring job was enqueued on its behalf
  });

  // A pass that throws must not suppress the passes after it: the boot recovery chain stops at the
  // first listener that throws, so every guarded pass logs its fault and lets the boot go on. The
  // realistic trigger is SQLITE_BUSY from a predecessor still holding the write lock past
  // better-sqlite3's busy timeout.
  it("still runs generation recovery when the no-speech sweep throws", async () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-sweep-throws", kind: "speaking", mode: "simulation", setId: "spk-order", isRepeat: false });
    r.createScoringJob({ id: "job-sweep-throws", attemptId: "att-sweep-throws", taskType: "listen_repeat", itemIds: ["lr-1"] });
    expect(r.getScoringJob("job-sweep-throws")?.status).toBe("queued");

    // A better-sqlite3-shaped failure (enum-ish `code`, no user content), so the logging path is
    // exercised the way it would be in production.
    const canary = "SWEEP_THROW_CANARY_secret_row_contents";
    r.listUnscoredItemsWithTranscript = () => {
      throw Object.assign(new Error(`database is locked: ${canary}`), { code: "SQLITE_BUSY" });
    };

    const speakingFinalization = { reconcileAttempt: async () => {} };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { server, fireListening } = fakeServer();
    wireAllBootRecovery(server, r, { speakingFinalization });

    await expect(fireListening()).resolves.toBeDefined();

    // Scoring recovery ran before it, and generation recovery still ran after it: it always logs
    // its summary line.
    expect(r.getScoringJob("job-sweep-throws")?.status).toBe("failed");
    expect(logSpy.mock.calls.flat(2).join(" ")).toContain("generation boot recovery");

    // The failure was logged via a bounded, safe descriptor — never the raw error/message.
    const loggedErrorText = errorSpy.mock.calls
      .flat(2)
      .map((v) => (v instanceof Error ? `${v.name}: ${v.message}\n${v.stack ?? ""}` : typeof v === "string" ? v : JSON.stringify(v)))
      .join(" ");
    expect(loggedErrorText).not.toContain(canary);
    expect(loggedErrorText).not.toContain("database is locked");
    expect(loggedErrorText).toContain("SQLITE_BUSY");

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});
