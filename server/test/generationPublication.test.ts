import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { sqliteTimestamp } from "../src/db/timestamps.js";
import { config } from "../src/lib/config.js";
import { persistAndReconcileCleanupDebt, reconcileCleanupDebt, reconcileGenerationPublications } from "../src/services/generationPublication.js";

describe("generation publication recovery", () => {
  it("records idempotent cleanup debt before deletion and retains failures for boot retry", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createGenerationJob({ id: "child", kind: "writing" });
    const result = persistAndReconcileCleanupDebt(r, "child", ["/owned/staging"], () => { throw new Error("busy"); });
    expect(result).toEqual({ completed: 0, failed: 1 });
    expect(r.listPendingCleanupDebt()).toEqual([expect.objectContaining({ child_id: "child", path: "/owned/staging", last_error: "Error" })]);
    persistAndReconcileCleanupDebt(r, "child", ["/owned/staging"], () => undefined);
    expect(r.listPendingCleanupDebt()).toEqual([]);
  });

  it("retries cleanup debt without paid work and completes missing paths idempotently", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-debt-"));
    const artifact = path.join(dir, "stale");
    fs.mkdirSync(artifact);
    fs.writeFileSync(path.join(artifact, "part.json"), "partial");
    const complete = vi.fn(() => true);
    const fail = vi.fn(() => true);
    const debtRepo = {
      listPendingCleanupDebt: () => [{ id: "debt-1", path: artifact }, { id: "debt-2", path: path.join(dir, "already-gone") }],
      completeCleanupDebt: complete,
      failCleanupDebt: fail,
    };

    expect(reconcileCleanupDebt(debtRepo)).toEqual({ completed: 2, failed: 0 });
    expect(fs.existsSync(artifact)).toBe(false);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(fail).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("publishes a valid prepared artifact without starting paid work", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publication-"));
    const staging = path.join(dir, "staging.json");
    const canonical = path.join(dir, "sets", "set.json");
    const body = Buffer.from("prepared set");
    fs.writeFileSync(staging, body);
    const mark = vi.fn(() => true);

    expect(reconcileGenerationPublications({
      listUnreconciledGenerationPublicationIntents: () => [{
        child_id: "child", staging_path: staging, canonical_path: canonical,
        content_hash: crypto.createHash("sha256").update(body).digest("hex"),
      }],
      markGenerationPublicationComplete: mark,
      abandonGenerationPublicationIntent: vi.fn(() => true),
      // Present only to satisfy the shared repo shape: a publication that reconciles cleanly never
      // reaches the abandon branch, so none of these is touched on this path.
      listPendingCleanupDebt: vi.fn(() => []),
      completeCleanupDebt: vi.fn(() => true),
      failCleanupDebt: vi.fn(() => true),
      createCleanupDebt: vi.fn(),
    })).toEqual({ completed: 1, failed: 0 });

    expect(fs.readFileSync(canonical)).toEqual(body);
    expect(mark).toHaveBeenCalledWith({ childId: "child", now: expect.any(String) });
    fs.rmSync(dir, { recursive: true });
  });

  // Against the real store, because its guards are the point. failGenerationJobConditional refuses
  // any job holding a live publication intent, and every row this sweep visits holds one, so an
  // intent whose bytes are gone has to be abandoned (abandonGenerationPublicationIntent) to fail its
  // job. Otherwise the job stays 'running' with `published_at` NULL and is re-listed on every boot,
  // with no artifact left to publish.
  it("fails the job behind an intent whose prepared bytes are gone, and never re-lists it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publication-lost-"));
    // A leftover the dead attempt had already written under the same set id. The abandon fails the
    // job, so failInterruptedGenerationJobs' sweep (queued and running rows only) never reaches it,
    // and this path has to remove the orphan.
    const orphanedStaging = path.join(config.dataDir, "question-sets/.staging", "wri-lost.json");
    fs.mkdirSync(path.dirname(orphanedStaging), { recursive: true });
    fs.writeFileSync(orphanedStaging, "half-written");

    const r = sqliteStores(openDb(":memory:"));
    r.createGenerationJob({ id: "child-lost", kind: "writing" });
    expect(r.claimGenerationJobRunning("child-lost")).toBe("claimed");
    expect(r.commitGenerationPublicationIntent({
      childId: "child-lost",
      setId: "wri-lost",
      expectedKind: "writing",
      stagingPath: path.join(dir, "staging.json"),
      canonicalPath: path.join(dir, "sets", "wri-lost.json"),
      contentHash: crypto.createHash("sha256").update("never written").digest("hex"),
      now: sqliteTimestamp(),
    })).toBe(true);

    expect(reconcileGenerationPublications(r)).toEqual({ completed: 0, failed: 1 });

    const job = r.getGenerationJob("child-lost")!;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("invalid interrupted publication artifact");
    expect(job.terminal_at).not.toBeNull();
    expect(fs.existsSync(orphanedStaging)).toBe(false);
    expect(r.listPendingCleanupDebt()).toEqual([]);
    // A second boot has nothing left to do: the intent is retained as a record but is no longer
    // outstanding work, so it never re-enters the sweep.
    expect(r.listUnreconciledGenerationPublicationIntents()).toEqual([]);
    expect(reconcileGenerationPublications(r)).toEqual({ completed: 0, failed: 0 });
    // And the job it already failed can never be resurrected to 'done' by a later completion.
    expect(r.markGenerationPublicationComplete({ childId: "child-lost", now: sqliteTimestamp() })).toBe(false);
    expect(r.getGenerationJob("child-lost")?.status).toBe("failed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A directory at the canonical path is not the Set, and neither is a staged copy that cannot be
  // moved over it. That intent is abandoned without a throw, so the boot pass goes on and the next
  // intent still publishes.
  it("abandons an intent whose canonical path is a directory, and goes on to the next intent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publication-blocked-"));
    const r = sqliteStores(openDb(":memory:"));
    const body = Buffer.from("prepared set");
    const hash = crypto.createHash("sha256").update(body).digest("hex");
    for (const id of ["blocked", "clear"]) {
      r.createGenerationJob({ id: `child-${id}`, kind: "writing" });
      expect(r.claimGenerationJobRunning(`child-${id}`)).toBe("claimed");
      fs.writeFileSync(path.join(dir, `${id}-staging.json`), body);
      r.commitGenerationPublicationIntent({
        childId: `child-${id}`, setId: `wri-${id}`, expectedKind: "writing",
        stagingPath: path.join(dir, `${id}-staging.json`), canonicalPath: path.join(dir, "sets", `wri-${id}.json`),
        contentHash: hash, now: sqliteTimestamp(),
      });
    }
    fs.mkdirSync(path.join(dir, "sets", "wri-blocked.json", "occupant"), { recursive: true });

    expect(reconcileGenerationPublications(r)).toEqual({ completed: 1, failed: 1 });

    expect(r.getGenerationJob("child-blocked")).toMatchObject({ status: "failed", error: "invalid interrupted publication artifact" });
    expect(fs.lstatSync(path.join(dir, "sets", "wri-blocked.json")).isDirectory()).toBe(true);
    expect(r.getGenerationJob("child-clear")?.status).toBe("done");
    expect(fs.readFileSync(path.join(dir, "sets", "wri-clear.json"))).toEqual(body);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The other side of the same guard: an intent not yet reconciled protects its job from the
  // ordinary failure writer. Only abandoning the intent releases that protection.
  it("still refuses to fail a job whose publication intent is live", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createGenerationJob({ id: "child-live", kind: "writing" });
    expect(r.claimGenerationJobRunning("child-live")).toBe("claimed");
    r.commitGenerationPublicationIntent({
      childId: "child-live", setId: "wri-live", expectedKind: "writing",
      stagingPath: "/staging/wri-live.json", canonicalPath: "/sets/wri-live.json",
      contentHash: "hash", now: sqliteTimestamp(),
    });

    expect(r.failGenerationJobConditional({ id: "child-live", error: "nope", now: sqliteTimestamp() })).toBe(false);
    expect(r.getGenerationJob("child-live")?.status).toBe("running");
  });
});
