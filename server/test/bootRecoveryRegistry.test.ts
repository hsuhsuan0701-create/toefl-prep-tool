import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import {
  BOOT_RECOVERY_PASSES,
  BOOT_RECOVERY_PHASES,
  registeredBootRecoveryPasses,
  wireBootRecoveryPasses,
} from "../src/services/bootRecoveryRegistry.js";

/**
 * Node fires 'listening' listeners in registration order, so the order boot-recovery passes run in
 * is load-bearing. bootRecoveryRegistry.ts declares it as phases, and these tests assert against
 * that declaration rather than against where `server.on` happens to be called.
 */
describe("boot recovery registry", () => {
  it("declares every pass in a known phase, and registers them in declared-phase order", () => {
    const phaseIndex = (phase: string) => BOOT_RECOVERY_PHASES.indexOf(phase as never);
    for (const pass of BOOT_RECOVERY_PASSES) expect(phaseIndex(pass.phase)).toBeGreaterThanOrEqual(0);

    const registeredPhases = registeredBootRecoveryPasses().map((pass) => phaseIndex(pass.phase));
    expect(registeredPhases).toEqual([...registeredPhases].sort((a, b) => a - b));
  });

  // Scoring recovery must complete before any pass that can create a scoring job, or a
  // recovery-created job is swept to 'failed' and its Item is stranded for good (see the
  // scoring-interrupted-jobs pass's rationale). The speaking reconcile runs after every healing
  // pass, so the jobs they settled do not count as active work.
  it("puts scoring recovery first, the speaking reconcile after every healing pass, and housekeeping last", () => {
    const order = registeredBootRecoveryPasses().map((pass) => pass.name);
    expect(order).toEqual([
      "scoring-interrupted-jobs",
      "no-speech-items",
      "generation-interrupted-jobs",
      "transcription-interruption-sweep",
      "stranded-recordings",
      "speaking-boot-recovery",
      // Applies the tracked supersession manifest; first in housekeeping so the listing is whole early.
      "supersession-manifest",
      // The manifest replay runs ahead of the prune within housekeeping, so a row it replays and a
      // row the render wrote face the same retention edge in the same boot.
      "clip-measurement-manifest-reconciliation",
      "model-call-pruning",
    ]);
    expect(registeredBootRecoveryPasses().map((pass) => pass.phase)).toEqual([
      "scoring-recovery",
      "scoring-recovery",
      "generation-recovery",
      "transcription-sweep",
      "transcription-sweep",
      "speaking-reconcile",
      "housekeeping",
      "housekeeping",
      "housekeeping",
    ]);
  });

  it("states a rationale for every pass", () => {
    for (const pass of BOOT_RECOVERY_PASSES) expect(pass.rationale.length).toBeGreaterThan(0);
  });

  it("registers nothing at wiring time — every pass is deferred to 'listening'", async () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-registry", kind: "speaking", mode: "simulation", setId: "spk-registry", isRepeat: false });
    r.createScoringJob({ id: "job-registry", attemptId: "att-registry", taskType: "listen_repeat", itemIds: ["lr-1"] });

    const listeners: (() => void)[] = [];
    const reconciled: string[] = [];
    const speakingFinalization = { reconcileAttempt: async (id: string) => { reconciled.push(id); } };
    wireBootRecoveryPasses({ on: (_event, listener) => { listeners.push(listener); } }, { repo: r, speakingFinalization });
    expect(listeners).toHaveLength(registeredBootRecoveryPasses().length);
    expect(r.getScoringJob("job-registry")?.status).toBe("queued");
    expect(reconciled).toEqual([]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const listener of listeners) await listener();
    logSpy.mockRestore();
    expect(r.getScoringJob("job-registry")?.status).toBe("failed");
    // The Attempt the scoring pass changed reaches the last pass through the boot's shared record.
    expect(reconciled).toEqual(["att-registry"]);
  });
});
