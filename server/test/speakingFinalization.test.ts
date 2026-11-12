import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { readBankSet } from "./helpers/setFixtures.js";
import { SKIPPED_ITEM_REASON } from "@toefl-prep/shared";
import type { CaptureStore } from "../src/services/attemptStore.js";
import { at } from "./helpers/timestamps.js";
import { openSqliteStores } from "./helpers/sqliteStores.js";

type SqliteStores = ReturnType<typeof openSqliteStores>;
import {
  AttemptNotFound,
  createSpeakingFinalization,
  expectedSpeakingItems,
  NotSpeakingSimulation,
  SetUnavailable,
  createSpeakingCoordinators,
  wireSpeakingBootRecovery,
} from "../src/services/speakingFinalization.js";

// A banked Speaking Set: 7 Listen and Repeat Items (lr-1..lr-7) and 4 Interview questions
// (int-1..int-4), the shape expectedSpeakingItems and markCaptureFinished compare against.
const SPEAKING_SET_ID = "spk-e5b2b735";
const speakingSet = readBankSet("speaking", SPEAKING_SET_ID);
const lrIds = speakingSet.listenAndRepeat.items.map((i) => i.id);
const intIds = speakingSet.interview.questions.map((q) => q.id);
const allExpectedIds: { id: string; taskType: "listen_repeat" | "interview" }[] = [
  ...lrIds.map((id) => ({ id, taskType: "listen_repeat" as const })),
  ...intIds.map((id) => ({ id, taskType: "interview" as const })),
];

const WRITING_SET_ID = "wri-77af733e";

function seedScoredItem(
  r: SqliteStores,
  attemptId: string,
  itemId: string,
  taskType: "listen_repeat" | "interview",
  score = 4,
): void {
  r.insertItemResult({
    attemptId, itemId, taskType,
    responseAudioPath: `audio/responses/${attemptId}/${itemId}.webm`,
    transcript: "a sample response transcript",
    deliveryReport: "{}",
  });
  r.updateItemScore({
    attemptId, itemId, score,
    scoreJson: JSON.stringify({ finalScore: score }),
    scoringStatus: "scored",
  });
}

// The `section_estimates` upsert is asserted by row count, not by reading the newest row back:
// `getSectionEstimate`'s own `ORDER BY rowid DESC LIMIT 1` cannot tell an atomic replace from an
// unbounded append that happens to return the newest row first.
function sectionEstimateRowCount(r: SqliteStores, attemptId: string): number {
  return r.countSectionEstimates(attemptId);
}

describe("expectedSpeakingItems", () => {
  it("returns exactly the immutable set's 7 listen_repeat items followed by its 4 interview questions", () => {
    expect(expectedSpeakingItems(speakingSet)).toEqual([
      ...lrIds.map((id) => ({ itemId: id, taskType: "listen_repeat" })),
      ...intIds.map((id) => ({ itemId: id, taskType: "interview" })),
    ]);
  });
});

describe("markCaptureFinished", () => {
  it("rejects an unknown attempt id", async () => {
    const r = openSqliteStores();
    const finalization = createSpeakingFinalization({ repo: r });
    await expect(finalization.markCaptureFinished("does-not-exist")).rejects.toThrow(AttemptNotFound);
  });

  it("rejects (fails closed) when the attempt's speaking set is missing or invalid, and never sets capture_finished_at", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-set-unavailable", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    const finalization = createSpeakingFinalization({ repo: r, setStore: { readSet: () => undefined } });

    await expect(finalization.markCaptureFinished("att-set-unavailable")).rejects.toThrow(SetUnavailable);
    expect(r.getAttempt("att-set-unavailable")!.capture_finished_at).toBeNull();
  });

  it("rejects a writing attempt — capture finalization is speaking-only", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-writing", kind: "writing", mode: "simulation", setId: WRITING_SET_ID, isRepeat: false });
    const finalization = createSpeakingFinalization({ repo: r });
    await expect(finalization.markCaptureFinished("att-writing")).rejects.toThrow(NotSpeakingSimulation);
  });

  it("rejects a speaking DRILL attempt — capture finalization is Simulation-only", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-drill", kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const finalization = createSpeakingFinalization({ repo: r });
    await expect(finalization.markCaptureFinished("att-drill")).rejects.toThrow(NotSpeakingSimulation);
  });

  it("writes capture_finished_at once; a later call (later injected clock) never moves it", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-sim", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    for (const item of allExpectedIds) seedScoredItem(r, "att-sim", item.id, item.taskType);
    let current = new Date("2026-07-30T10:00:00Z");
    const finalization = createSpeakingFinalization({ repo: r, now: () => current });

    await finalization.markCaptureFinished("att-sim");
    expect(r.getAttempt("att-sim")!.capture_finished_at).toBe("2026-07-30 10:00:00");

    current = new Date("2026-07-30T10:05:00Z");
    await finalization.markCaptureFinished("att-sim");
    expect(r.getAttempt("att-sim")!.capture_finished_at).toBe("2026-07-30 10:00:00");
  });

  // With no client hint saying otherwise, every Item that never got an upload is a deliberate skip
  // scored 0: an unanswered Item earns 0 on the real exam, and leaving skips out of the estimate
  // would let a User raise it by skipping the hard Items.
  it("compares the immutable set's 7+4 ids and scores each genuinely missing item 0 as a deliberate skip", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-missing", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    // Only lr-1 and int-1 actually arrived; the remaining 9 expected items never got an upload.
    seedScoredItem(r, "att-missing", "lr-1", "listen_repeat");
    seedScoredItem(r, "att-missing", "int-1", "interview");

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.markCaptureFinished("att-missing");

    const attempt = r.getAttempt("att-missing")!;
    expect(attempt.capture_finished_at).not.toBeNull();
    expect(attempt.items).toHaveLength(11);
    for (const item of attempt.items) {
      if (item.item_id === "lr-1" || item.item_id === "int-1") {
        expect(item.scoring_status).toBe("scored");
        expect(item.score).toBe(4);
      } else {
        expect(item.scoring_status).toBe("scored");
        expect(item.score).toBe(0);
        expect(JSON.parse(item.score_json!)).toEqual({ skipped: true, reason: SKIPPED_ITEM_REASON });
        // No Judge ever ran, so nothing here may look like a heard response.
        expect(item.transcript).toBeNull();
        expect(item.response_audio_path).toBeNull();
        // Stamped, so the row is visible to every "currently scored" stats query rather than
        // counting toward the band while silently missing from trends.
        expect(item.scored_at).not.toBeNull();
      }
    }
  });

  // A lost upload and a skip stay distinguishable.
  it("keeps a client-reported lost upload as an excluded 'failed' placeholder while its siblings become skips", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-lost-upload", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });

    const finalization = createSpeakingFinalization({ repo: r });
    // The browser recorded lr-2 and could not land it; nothing else was recorded at all.
    await finalization.markCaptureFinished("att-lost-upload", { uploadFailedItemIds: ["lr-2"] });

    const items = r.getAttempt("att-lost-upload")!.items;
    const lostRow = items.find((i) => i.item_id === "lr-2")!;
    expect(lostRow.scoring_status).toBe("failed");
    expect(lostRow.score).toBeNull();
    expect(lostRow.scored_at).toBeNull();
    expect(JSON.parse(lostRow.score_json!)).toEqual({ error: "recording upload did not arrive" });

    for (const item of items.filter((i) => i.item_id !== "lr-2")) {
      expect(item.scoring_status).toBe("scored");
      expect(item.score).toBe(0);
      expect(JSON.parse(item.score_json!)).toEqual({ skipped: true, reason: SKIPPED_ITEM_REASON });
    }
  });

  it("ignores an upload-failure id that is not an expected item of the set — the immutable set still decides what exists", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-foreign-hint", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.markCaptureFinished("att-foreign-hint", { uploadFailedItemIds: ["not-in-this-set", "lr-1"] });

    const items = r.getAttempt("att-foreign-hint")!.items;
    expect(items).toHaveLength(11);
    expect(items.some((i) => i.item_id === "not-in-this-set")).toBe(false);
    expect(items.find((i) => i.item_id === "lr-1")!.scoring_status).toBe("failed");
  });

  it("an existing item row wins even when the browser lost its upload response — a placeholder never overwrites it", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-existing-wins", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    // lr-1's audio reached the server and was scored; only the success response was lost on the
    // client. Every other expected Item is missing.
    seedScoredItem(r, "att-existing-wins", "lr-1", "listen_repeat", 5);

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.markCaptureFinished("att-existing-wins");

    const lr1 = r.getAttempt("att-existing-wins")!.items.find((i) => i.item_id === "lr-1")!;
    expect(lr1.scoring_status).toBe("scored");
    expect(lr1.score).toBe(5);
    expect(lr1.score_json).toBe(JSON.stringify({ finalScore: 5 }));
  });

  it("repeated calls do not duplicate placeholder rows", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-repeat-marker", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    const finalization = createSpeakingFinalization({ repo: r });

    await finalization.markCaptureFinished("att-repeat-marker");
    await finalization.markCaptureFinished("att-repeat-marker");
    await finalization.markCaptureFinished("att-repeat-marker");

    expect(r.getAttempt("att-repeat-marker")!.items).toHaveLength(11);
  });

  it("never bypasses the atomic capture seam by calling either of the two narrower capture primitives directly", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-atomic-seam", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    // Neither narrower primitive is a member of CaptureStore, so finalization has nothing to call.
    // The runtime check hands it a store that does carry both, so a port that gained them, or code
    // that reached for them dynamically, would still be caught. The real stores have no such
    // members for `spyOn` to replace, so they are added as plain spies.
    const markSpy = vi.fn();
    const placeholderSpy = vi.fn();
    const withNarrowPrimitives = {
      ...r,
      markCaptureFinished: markSpy,
      insertMissingItemPlaceholderIfAbsent: placeholderSpy,
    };

    const finalization = createSpeakingFinalization({ repo: withNarrowPrimitives });
    await finalization.markCaptureFinished("att-atomic-seam");

    expect(markSpy).not.toHaveBeenCalled();
    expect(placeholderSpy).not.toHaveBeenCalled();

    // The same claim at compile time. Without the two primitives, the two-step sequence with a
    // crash window between the marker and the placeholders cannot be written against the port.
    // Each @ts-expect-error below fails typecheck if its member is added to CaptureStore.
    const port: CaptureStore = r;
    // @ts-expect-error — CaptureStore has no `markCaptureFinished`.
    void port.markCaptureFinished;
    // @ts-expect-error — CaptureStore has no `insertMissingItemPlaceholderIfAbsent`.
    void port.insertMissingItemPlaceholderIfAbsent;
  });
});

describe("reconcileAttempt", () => {
  it("is a silent no-op for an unknown attempt id (wired broadly as the scoring-terminal callback; must never throw)", async () => {
    const r = openSqliteStores();
    const finalization = createSpeakingFinalization({ repo: r });
    await expect(finalization.reconcileAttempt("does-not-exist")).resolves.toBeUndefined();
  });

  it("is a silent no-op for a writing attempt", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-writing-reconcile", kind: "writing", mode: "drill", setId: WRITING_SET_ID, isRepeat: false });
    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt("att-writing-reconcile");
    expect(r.getAttempt("att-writing-reconcile")!.status).toBe("in_progress");
  });

  // A Writing Simulation completes before its essays finish scoring, so a completed Writing
  // Attempt's estimate is recomputed when they land. Here a stale row from Build a Sentence alone
  // is replaced by the band the scored essays give.
  it("recomputes a COMPLETED writing attempt's estimate when its essays finish scoring later", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-writing-late", kind: "writing", mode: "simulation", setId: WRITING_SET_ID, isRepeat: false });
    // Completed with only Build a Sentence scored, and a stale estimate row.
    r.insertItemResult({ attemptId: "att-writing-late", itemId: "bs-1", taskType: "build_sentence", responseText: "a b c", scoringStatus: "pending" });
    r.updateItemScore({ attemptId: "att-writing-late", itemId: "bs-1", score: 1, scoreJson: "{}", scoringStatus: "scored" });
    r.completeAttempt("att-writing-late");
    r.saveSectionEstimate({ attemptId: "att-writing-late", section: "writing", rawDetail: "{}", estimatedBand: 6, method: "linear-v2" });

    // The essays land a minute later, as they really do.
    r.insertItemResult({ attemptId: "att-writing-late", itemId: "em1", taskType: "email", responseText: "Dear Prof", scoringStatus: "pending" });
    r.updateItemScore({ attemptId: "att-writing-late", itemId: "em1", score: 3, scoreJson: "{}", scoringStatus: "scored" });
    r.insertItemResult({ attemptId: "att-writing-late", itemId: "ad1", taskType: "discussion", responseText: "I agree", scoringStatus: "pending" });
    r.updateItemScore({ attemptId: "att-writing-late", itemId: "ad1", score: 3, scoreJson: "{}", scoringStatus: "scored" });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt("att-writing-late");

    // The seeded 6 came from Build a Sentence alone; the recomputed band includes the essays.
    const estimate = r.getAttempt("att-writing-late")!;
    expect(estimate.status).toBe("completed");
    const row = r.latestEstimate("writing");
    expect(row?.estimatedBand).toBeLessThan(6);
  });

  it("still does not complete or estimate an UNcompleted writing attempt", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-writing-open", kind: "writing", mode: "drill", setId: WRITING_SET_ID, isRepeat: false });
    r.insertItemResult({ attemptId: "att-writing-open", itemId: "bs-1", taskType: "build_sentence", responseText: "a b c", scoringStatus: "pending" });
    r.updateItemScore({ attemptId: "att-writing-open", itemId: "bs-1", score: 1, scoreJson: "{}", scoringStatus: "scored" });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt("att-writing-open");

    // Scoring one Item mid-Drill never completes a Drill still in progress.
    expect(r.getAttempt("att-writing-open")!.status).toBe("in_progress");
    expect(r.latestEstimate("writing")).toBeUndefined();
  });

  it("returns early for a speaking simulation with no capture marker yet, even with a fully scored item", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-sim-no-marker", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, "att-sim-no-marker", "lr-1", "listen_repeat");
    const finalization = createSpeakingFinalization({ repo: r });

    await finalization.reconcileAttempt("att-sim-no-marker");

    expect(r.getAttempt("att-sim-no-marker")!.status).toBe("in_progress");
    expect(r.getSectionEstimate("att-sim-no-marker")).toBeUndefined();
  });

  // replaceScoringJobAndSupersede is scoped to (attempt_id, task_type) and supersedes every active
  // job there, including a disjoint one-Item job that recovery launched for an Item the client's own
  // POST /score leaves out. The new job covers the Items it names, and a recovery job's Item is
  // precisely one it does not.
  //
  // Counting the superseded row as coverage would make that Item permanently invisible: 'pending'
  // with a transcript, no transcription panel, no Re-score button (that requires 'failed'), never
  // orphan-healed, and missing from the Band Estimate.
  it("an item covered ONLY by a superseded scoring job is a true orphan, not covered work", async () => {
    const r = openSqliteStores();
    const attemptId = "att-superseded-only-coverage";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });

    // The client's own request scored three interview items.
    seedScoredItem(r, attemptId, "int-1", "interview");
    seedScoredItem(r, attemptId, "int-3", "interview");
    seedScoredItem(r, attemptId, "int-4", "interview");
    // int-2 hit a transient Ears failure, recovered mid-task, and holds a transcript awaiting the
    // one-item scoring job recovery launched for it.
    r.insertItemResult({
      attemptId, itemId: "int-2", taskType: "interview",
      transcript: "a recovered interview answer", deliveryReport: "{}",
    });

    // Recovery's one-Item job, then the client's section-end POST /score for the other three. The
    // second call supersedes the first even though their Item sets are disjoint.
    r.createScoringJob({ id: "job-recovery-int2", attemptId, taskType: "interview", itemIds: ["int-2"] });
    r.replaceScoringJobAndSupersede({ id: "job-client-rest", attemptId, taskType: "interview", itemIds: ["int-1", "int-3", "int-4"], now: at("2026-07-30 08:59:00") });
    r.seedScoringJobState({ id: "job-client-rest", status: "done" });
    expect(r.getScoringJob("job-recovery-int2")).toMatchObject({ status: "cancelled", cancellation_reason: "superseded" }); // the setup is real

    // Capture finished a minute ago, so the 30s orphan-heal grace has elapsed. Injected clock,
    // never the wall clock, so this cannot drift.
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: attemptId, now: at("2026-07-30 09:00:00"), placeholders: [] });
    const finalization = createSpeakingFinalization({
      repo: r,
      now: () => new Date("2026-07-30T09:01:00.000Z"),
    });

    await finalization.reconcileAttempt(attemptId);

    // int-2 is now visible and recoverable: 'failed' is the one status a manual Re-score accepts.
    const int2 = r.getAttempt(attemptId)!.items.find((i) => i.item_id === "int-2")!;
    expect(int2.scoring_status).toBe("failed");
    // Its three covered siblings are untouched by the heal.
    for (const itemId of ["int-1", "int-3", "int-4"]) {
      expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === itemId)!.scoring_status).toBe("scored");
    }
  });

  it("a COMPLETED speaking simulation with NO capture marker (capture_finished_at NULL) still recomputes its estimate after a late recovered score", async () => {
    const r = openSqliteStores();
    const attemptId = "att-sim-completed-no-marker";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, attemptId, "lr-1", "listen_repeat", 3);
    seedScoredItem(r, attemptId, "int-1", "interview", 3);
    // lr-2 was still transcription_pending when the Attempt completed, and the Attempt has no
    // capture marker, as one completed before the marker existed does.
    r.insertItemResult({
      attemptId, itemId: "lr-2", taskType: "listen_repeat",
      responseAudioPath: `audio/responses/${attemptId}/lr-2.webm`, scoringStatus: "transcription_pending",
    });
    r.completeAttempt(attemptId, at("2026-07-30 09:00:00"));
    // Seeded with the retired linear-v1 method: a persisted row keeps its method and stays readable
    // until a recompute replaces it with a row under the current method.
    r.saveSectionEstimate({
      attemptId, section: "speaking",
      rawDetail: JSON.stringify({ raw: 0.4, coverage: [{ taskType: "listen_repeat", itemCount: 1 }] }),
      estimatedBand: 3, method: "linear-v1",
    });
    expect(r.getAttempt(attemptId)!.capture_finished_at).toBeNull();

    // Later the User's Re-score or Retry recovers lr-2.
    r.updateItemScore({ attemptId, itemId: "lr-2", score: 5, scoreJson: JSON.stringify({ finalScore: 5 }), scoringStatus: "scored" });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt(attemptId);

    const attempt = r.getAttempt(attemptId)!;
    expect(attempt.status).toBe("completed");
    expect(attempt.completed_at).toBe("2026-07-30 09:00:00"); // unchanged
    const estimate = r.getSectionEstimate(attemptId)!;
    expect(estimate.estimatedBand).toBeGreaterThan(3); // recomputed with lr-2 now scored
    // The recompute rewrote the row under the current method: the linear-v1 row was readable
    // (nothing above threw or skipped), and a recompute does not preserve its method.
    expect(estimate.method).toBe("linear-v2");
    expect(sectionEstimateRowCount(r, attemptId)).toBe(1); // replaced, not duplicated
  });

  it("returns early for a speaking DRILL that hasn't been explicitly completed yet — an early-terminal scoring job must not force-complete a mid-drill attempt", async () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-drill-in-progress", kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    // Only Item 1 of 11 has been recorded and scored so far; the other 10 have no item_results rows
    // yet, as a real mid-Drill Attempt looks.
    seedScoredItem(r, "att-drill-in-progress", "lr-1", "listen_repeat");
    const finalization = createSpeakingFinalization({ repo: r });

    await finalization.reconcileAttempt("att-drill-in-progress");

    const attempt = r.getAttempt("att-drill-in-progress")!;
    expect(attempt.status).toBe("in_progress");
    expect(attempt.completed_at).toBeNull();
    expect(r.getSectionEstimate("att-drill-in-progress")).toBeUndefined();
  });

  it("never resurrects an 'aborted' attempt to 'completed', even one that carries a capture marker and a scored item", async () => {
    const r = openSqliteStores();
    const attemptId = "att-aborted";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, attemptId, "lr-1", "listen_repeat", 4);
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 09:00:00"), placeholders: [] });
    // No writer sets 'aborted' through the capture/completion path; `abortAttempt` is the Attempt
    // route's own writer, not finalization's.
    r.abortAttempt(attemptId);

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt(attemptId);

    expect(r.getAttempt(attemptId)!.status).toBe("aborted");
    expect(r.getAttempt(attemptId)!.completed_at).toBeNull();
  });

  it.each(["queued", "running", "retry_wait", "awaiting_score"] as const)(
    "active transcription status '%s' prevents completion",
    async (status) => {
      const r = openSqliteStores();
      const attemptId = `att-active-t-${status}`;
      r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
      seedScoredItem(r, attemptId, "lr-1", "listen_repeat");
      r.insertItemResult({
        attemptId, itemId: "lr-2", taskType: "listen_repeat",
        responseAudioPath: `audio/responses/${attemptId}/lr-2.webm`, scoringStatus: "transcription_pending",
      });
      const job = r.createOrGetTranscriptionJob({
        id: `tj-${attemptId}`, attemptId, itemId: "lr-2", taskType: "listen_repeat",
        audioPath: `audio/responses/${attemptId}/lr-2.webm`, audioSha256: "a".repeat(64), now: at("2026-07-30 09:00:00"),
      });
      if (status !== "queued") {
        r.updateTranscriptionJob({
          id: job.id, status,
          nextRetryAt: status === "retry_wait" ? at("2099-01-01 00:00:00") : null,
          now: at("2026-07-30 09:00:01"),
        });
      }
      r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 09:00:00"), placeholders: [] });

      const finalization = createSpeakingFinalization({ repo: r });
      await finalization.reconcileAttempt(attemptId);

      expect(r.getAttempt(attemptId)!.status).toBe("in_progress");
    },
  );

  it("active scoring (queued or running) prevents completion", async () => {
    const r = openSqliteStores();
    const attemptId = "att-active-scoring";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, attemptId, "lr-1", "listen_repeat");
    r.insertItemResult({ attemptId, itemId: "lr-2", taskType: "listen_repeat", transcript: "in flight", deliveryReport: "{}" });
    r.createScoringJob({ id: "job-active", attemptId, taskType: "listen_repeat", itemIds: ["lr-2"] });
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 09:00:00"), placeholders: [] });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt(attemptId);

    expect(r.getAttempt(attemptId)!.status).toBe("in_progress");
  });

  it("terminal exhausted transcription (status='failed') does NOT prevent completion — the exhausted item stays visibly incomplete while the rest of the attempt completes", async () => {
    const r = openSqliteStores();
    const attemptId = "att-exhausted-transcription";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, attemptId, "lr-1", "listen_repeat", 4);
    seedScoredItem(r, attemptId, "int-1", "interview", 4);
    r.insertItemResult({
      attemptId, itemId: "lr-2", taskType: "listen_repeat",
      responseAudioPath: `audio/responses/${attemptId}/lr-2.webm`, scoringStatus: "transcription_pending",
    });
    const job = r.createOrGetTranscriptionJob({
      id: "tj-exhausted", attemptId, itemId: "lr-2", taskType: "listen_repeat",
      audioPath: `audio/responses/${attemptId}/lr-2.webm`, audioSha256: "a".repeat(64), now: at("2026-07-30 09:00:00"),
    });
    r.updateTranscriptionJob({
      id: job.id, status: "failed", failureKind: "provider",
      error: "transcription failed unexpectedly", now: at("2026-07-30 09:05:00"),
    });
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 09:00:00"), placeholders: [] });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt(attemptId);

    const attempt = r.getAttempt(attemptId)!;
    expect(attempt.status).toBe("completed");
    const lr2 = attempt.items.find((i) => i.item_id === "lr-2")!;
    expect(lr2.scoring_status).toBe("transcription_pending"); // untouched — visibly incomplete
    // An Item never transcribed is not scored, so the completed Attempt has no band: neither one
    // that counts lr-2 as a 0 nor one that leaves it out.
    expect(r.getSectionEstimate(attemptId)).toBeUndefined();
  });

  it("a pending item with a transcript and no scoring job of any status becomes visibly failed/rescorable with 'scoring request did not arrive'", async () => {
    const r = openSqliteStores();
    const attemptId = "att-orphaned-transcript";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, attemptId, "lr-1", "listen_repeat", 4);
    // lr-2's transcription succeeded (transcript present, scoring_status still 'pending') but no
    // /score request was ever created for it — no scoring_jobs row of any status covers it.
    r.insertItemResult({
      attemptId, itemId: "lr-2", taskType: "listen_repeat",
      responseAudioPath: `audio/responses/${attemptId}/lr-2.webm`, transcript: "we open at six", deliveryReport: "{}",
    });
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 09:00:00"), placeholders: [] });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt(attemptId);

    const attempt = r.getAttempt(attemptId)!;
    expect(attempt.status).toBe("completed");
    const lr2 = attempt.items.find((i) => i.item_id === "lr-2")!;
    expect(lr2.scoring_status).toBe("failed");
    expect(JSON.parse(lr2.score_json!)).toEqual({ error: "scoring request did not arrive" });
  });

  it("does NOT flip a pending+transcript+uncovered item to failed, and does NOT complete the attempt, when reconciled immediately after the capture marker", async () => {
    const r = openSqliteStores();
    const attemptId = "att-orphan-grace-immediate";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, attemptId, "lr-1", "listen_repeat", 4);
    // lr-2's transcription just finished (transcript present, scoring_status still 'pending', no
    // scoring_jobs row yet). A healthy upload occupies this state briefly, until the client's own
    // POST /score creates the covering scoring_jobs row.
    r.insertItemResult({
      attemptId, itemId: "lr-2", taskType: "listen_repeat",
      responseAudioPath: `audio/responses/${attemptId}/lr-2.webm`, transcript: "we open at six", deliveryReport: "{}",
    });
    const markerTime = new Date("2026-07-30T10:00:00Z");
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 10:00:00"), placeholders: [] });

    // Reconciled at the instant the marker was set, as the capture-finished path does
    // (markCaptureFinished, then reconcileAttempt).
    const finalization = createSpeakingFinalization({ repo: r, now: () => markerTime });
    await finalization.reconcileAttempt(attemptId);

    const attempt = r.getAttempt(attemptId)!;
    expect(attempt.status).toBe("in_progress"); // not completed
    expect(attempt.completed_at).toBeNull();
    expect(attempt.items.find((i) => i.item_id === "lr-2")!.scoring_status).toBe("pending");
    expect(r.getSectionEstimate(attemptId)).toBeUndefined();
  });

  it("DOES heal the same attempt once the grace margin has elapsed", async () => {
    const r = openSqliteStores();
    const attemptId = "att-orphan-grace-elapsed";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, attemptId, "lr-1", "listen_repeat", 4);
    seedScoredItem(r, attemptId, "int-1", "interview", 4);
    r.insertItemResult({
      attemptId, itemId: "lr-2", taskType: "listen_repeat",
      responseAudioPath: `audio/responses/${attemptId}/lr-2.webm`, transcript: "we open at six", deliveryReport: "{}",
    });
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 10:00:00"), placeholders: [] });

    let current = new Date("2026-07-30T10:00:00Z");
    const finalization = createSpeakingFinalization({ repo: r, now: () => current });

    // First reconcile, immediately: the guard blocks, as in the test above, so this test stands on
    // its own.
    await finalization.reconcileAttempt(attemptId);
    expect(r.getAttempt(attemptId)!.status).toBe("in_progress");

    // Just past the 30-second grace margin (ORPHAN_HEAL_GRACE_MS).
    current = new Date("2026-07-30T10:00:30.001Z");
    await finalization.reconcileAttempt(attemptId);

    const attempt = r.getAttempt(attemptId)!;
    expect(attempt.status).toBe("completed");
    const lr2 = attempt.items.find((i) => i.item_id === "lr-2")!;
    expect(lr2.scoring_status).toBe("failed");
    expect(JSON.parse(lr2.score_json!)).toEqual({ error: "scoring request did not arrive" });
    // The healed lr-2 is failed, awaiting a Re-score, so there is no band until it is scored.
    expect(r.getSectionEstimate(attemptId)).toBeUndefined();
  });

  it("a pending item COVERED by a done scoring_jobs row is left untouched by the orphan check (discriminates 'never covered' from 'covered but not yet scored')", async () => {
    const r = openSqliteStores();
    const attemptId = "att-covered-not-orphan";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, attemptId, "lr-1", "listen_repeat", 4);
    r.insertItemResult({ attemptId, itemId: "lr-2", taskType: "listen_repeat", transcript: "already covered", deliveryReport: "{}" });
    // A done scoring job covers lr-2, so this is not the "never arrived" orphan case that 'scoring
    // request did not arrive' describes, and the heal leaves the Item as it is.
    r.createScoringJob({ id: "job-covered", attemptId, taskType: "listen_repeat", itemIds: ["lr-2"] });
    r.seedScoringJobState({ id: "job-covered", status: "done", result: "{}" });
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 09:00:00"), placeholders: [] });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt(attemptId);

    const lr2 = r.getAttempt(attemptId)!.items.find((i) => i.item_id === "lr-2")!;
    expect(lr2.scoring_status).toBe("pending");
  });

  // A cancelled job discarded its Score Report, so it covers nothing (scoringJobCoversItsItems): the
  // Item it named is an orphan like one no job ever named, and the heal fails it for a Re-score.
  it("a pending item whose only scoring job was cancelled is healed by the orphan check, as if never covered", async () => {
    const r = openSqliteStores();
    const attemptId = "att-cancelled-coverage";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, attemptId, "lr-1", "listen_repeat", 4);
    r.insertItemResult({ attemptId, itemId: "lr-2", taskType: "listen_repeat", transcript: "cancelled before scoring", deliveryReport: "{}" });
    r.createScoringJob({ id: "job-cancelled", attemptId, taskType: "listen_repeat", itemIds: ["lr-2"] });
    expect(r.requestScoringJobCancellation({ id: "job-cancelled", reason: "user", now: at("2026-07-30 08:59:00") })).toMatchObject({ accepted: true });
    expect(r.finishScoringJobCancellation({ id: "job-cancelled", now: at("2026-07-30 08:59:01") })).toBe(true);
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 09:00:00"), placeholders: [] });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt(attemptId);

    const lr2 = r.getAttempt(attemptId)!.items.find((i) => i.item_id === "lr-2")!;
    expect(lr2.scoring_status).toBe("failed");
    expect(JSON.parse(lr2.score_json!)).toEqual({ error: "scoring request did not arrive" });
  });

  it("once all work is terminal, completes the attempt and upserts the best available estimate", async () => {
    const r = openSqliteStores();
    const attemptId = "att-happy-path";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    for (const item of allExpectedIds) seedScoredItem(r, attemptId, item.id, item.taskType, 4);
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 09:00:00"), placeholders: [] });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt(attemptId);

    expect(r.getAttempt(attemptId)!.status).toBe("completed");
    const estimate = r.getSectionEstimate(attemptId);
    expect(estimate?.section).toBe("speaking");
    expect(estimate?.method).toBe("linear-v2");
    // All 11 items score 4/5 (0.8 normalized) across both task types — weights already sum to 1
    // with both present, so raw=0.8 and band = 1 + 5*0.8 = 5.
    expect(estimate?.estimatedBand).toBe(5);
  });

  // A skip counts, at the finalization seam. Both runs take the same Simulation through the same
  // entry points (markCaptureFinished, then reconcileAttempt) and differ in one Item, so the
  // comparison isolates whether a skipped Item enters the mean. Leaving it out and renormalizing
  // over the rest would let skipping the hard Items raise the band.
  async function bandForSimulation(
    attemptId: string,
    opts: { answerInt4: boolean },
  ): Promise<{ band: number; coverage: { taskType: string; itemCount: number; skippedCount?: number }[] }> {
    const r = openSqliteStores();
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    // Ten of the eleven items are answered identically in both halves. int-4 is the variable.
    for (const item of allExpectedIds) {
      if (item.id === "int-4" && !opts.answerInt4) continue;
      seedScoredItem(r, attemptId, item.id, item.taskType, 4);
    }

    const finalization = createSpeakingFinalization({ repo: r });
    // No upload-failure hint: int-4 was never recorded, which is exactly a deliberate skip.
    await finalization.markCaptureFinished(attemptId);
    await finalization.reconcileAttempt(attemptId);

    expect(r.getAttempt(attemptId)!.status).toBe("completed");
    const estimate = r.getSectionEstimate(attemptId)!;
    return {
      band: estimate.estimatedBand,
      coverage: (JSON.parse(estimate.rawDetail) as { coverage: { taskType: string; itemCount: number; skippedCount?: number }[] }).coverage,
    };
  }

  it("a skipped speaking item produces a LOWER Band Estimate than the same simulation with that item answered", async () => {
    const answered = await bandForSimulation("att-71-answered", { answerInt4: true });
    const skipped = await bandForSimulation("att-71-skipped", { answerInt4: false });

    expect(skipped.band).toBeLessThan(answered.band);
    // Concretely: all four Interview items at 4/5 gives interview avg 0.8 and raw 0.8 -> band 5.
    // Skipping int-4 makes interview avg (0.8*3 + 0)/4 = 0.6, raw = 7/11*0.8 + 4/11*0.6 = 0.72...
    // -> 1 + 5*0.72... = 4.63... -> band 4.5.
    expect(answered.band).toBe(5);
    expect(skipped.band).toBe(4.5);
  });

  it("the skipped item stays IN the coverage count and is disclosed as skipped there", async () => {
    const skipped = await bandForSimulation("att-71-coverage", { answerInt4: false });
    expect(skipped.coverage).toEqual([
      { taskType: "listen_repeat", itemCount: 7, skippedCount: 0 },
      { taskType: "interview", itemCount: 4, skippedCount: 1 },
    ]);
  });

  it("an INFRASTRUCTURE failure stays labeled failed, never captured, and leaves the Attempt without a band", async () => {
    const r = openSqliteStores();
    const attemptId = "att-71-infra";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    for (const item of allExpectedIds) {
      if (item.id === "int-4") continue;
      seedScoredItem(r, attemptId, item.id, item.taskType, 4);
    }

    const finalization = createSpeakingFinalization({ repo: r });
    // The same missing Item as the skip case above, but the browser reports it had a recording it
    // could not land, so no score may be invented for audio nobody heard.
    await finalization.markCaptureFinished(attemptId, { uploadFailedItemIds: ["int-4"] });
    await finalization.reconcileAttempt(attemptId);

    const int4 = r.getAttempt(attemptId)!.items.find((i) => i.item_id === "int-4")!;
    expect(int4.scoring_status).toBe("failed");
    expect(int4.score).toBeNull();
    expect(JSON.parse(int4.score_json!)).toEqual({ error: "recording upload did not arrive" });

    // No 0 invented for it and no band built without it: a band needs every Item scored.
    expect(r.getAttempt(attemptId)!.status).toBe("completed");
    expect(r.getSectionEstimate(attemptId)).toBeUndefined();
  });

  it("zero scored items completes the attempt without an estimate", async () => {
    const r = openSqliteStores();
    const attemptId = "att-zero-scored";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    r.markCaptureFinishedWithMissingItemPlaceholders({
      attemptId, now: at("2026-07-30 09:00:00"),
      placeholders: allExpectedIds.map((i) => ({
        itemId: i.id, taskType: i.taskType,
        scoreJson: JSON.stringify({ error: "recording upload did not arrive" }),
      })),
    });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt(attemptId);

    expect(r.getAttempt(attemptId)!.status).toBe("completed");
    expect(r.getSectionEstimate(attemptId)).toBeUndefined();
  });

  it("boot reconciliation: driving repo.listCaptureFinishedInProgressAttempts() (the real boot discovery query) finishes every capture-marked in-progress attempt, and only those", async () => {
    const r = openSqliteStores();
    const attemptId = "att-boot";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    for (const item of allExpectedIds) seedScoredItem(r, attemptId, item.id, item.taskType, 4);
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 09:00:00"), placeholders: [] });

    // A second, unrelated in-progress Attempt with no capture marker is not touched: the boot query
    // is selective, not "reconcile everything in_progress".
    const untouchedId = "att-boot-untouched";
    r.createAttempt({ id: untouchedId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, untouchedId, "lr-1", "listen_repeat", 4);

    const finalization = createSpeakingFinalization({ repo: r });
    for (const attempt of r.listCaptureFinishedInProgressAttempts()) {
      await finalization.reconcileAttempt(attempt.id);
    }

    expect(r.getAttempt(attemptId)!.status).toBe("completed");
    expect(r.getAttempt(untouchedId)!.status).toBe("in_progress");
  });

  it("a late recovered score replaces the one estimate row rather than duplicating it", async () => {
    const r = openSqliteStores();
    const attemptId = "att-late-recovery-estimate";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, attemptId, "lr-1", "listen_repeat", 3);
    seedScoredItem(r, attemptId, "int-1", "interview", 4);
    // lr-2 arrives late: transcribed, but its scoring job is still running at the first reconcile,
    // so completion (and any estimate) waits.
    r.insertItemResult({ attemptId, itemId: "lr-2", taskType: "listen_repeat", transcript: "late arrival", deliveryReport: "{}" });
    r.createScoringJob({ id: "job-lr2", attemptId, taskType: "listen_repeat", itemIds: ["lr-2"] });
    r.seedScoringJobState({ id: "job-lr2", status: "running" });
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 09:00:00"), placeholders: [] });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt(attemptId);
    expect(r.getAttempt(attemptId)!.status).toBe("in_progress"); // job-lr2 still active
    expect(r.getSectionEstimate(attemptId)).toBeUndefined();
    expect(sectionEstimateRowCount(r, attemptId)).toBe(0);

    // The job now settles and the recovered item scores.
    r.seedScoringJobState({ id: "job-lr2", status: "done", result: "{}" });
    r.updateItemScore({ attemptId, itemId: "lr-2", score: 5, scoreJson: JSON.stringify({ finalScore: 5 }), scoringStatus: "scored" });
    await finalization.reconcileAttempt(attemptId);

    expect(r.getAttempt(attemptId)!.status).toBe("completed");
    // Row count rather than getSectionEstimate's latest-row read, which would return a plausible
    // row even if a second one had been appended beside the first.
    expect(sectionEstimateRowCount(r, attemptId)).toBe(1);
    const estimate = r.getSectionEstimate(attemptId)!;
    // lr-1=3/5 (0.6) and lr-2=5/5 (1.0) average 0.8, int-1=4/5 is 0.8: band = 1 + 5*0.8 = 5.
    expect(estimate.estimatedBand).toBe(5);
  });

  it("late recovery preserves the original completed_at", async () => {
    const r = openSqliteStores();
    const attemptId = "att-preserve-completed-at";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, attemptId, "lr-1", "listen_repeat", 3);
    seedScoredItem(r, attemptId, "int-1", "interview", 4);
    // lr-2 has no covering scoring job and the capture marker is an hour old, so the orphan heal
    // fails it and this first reconcile already completes the Attempt.
    r.insertItemResult({ attemptId, itemId: "lr-2", taskType: "listen_repeat", transcript: "late", deliveryReport: "{}" });
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 09:00:00"), placeholders: [] });

    let current = new Date("2026-07-30T10:00:00Z");
    const finalization = createSpeakingFinalization({ repo: r, now: () => current });

    await finalization.reconcileAttempt(attemptId);
    const firstCompletedAt = r.getAttempt(attemptId)!.completed_at;
    expect(firstCompletedAt).toBe("2026-07-30 10:00:00");

    // Later lr-2, healed to a rescorable failure, is re-scored and recovers.
    current = new Date("2026-07-30T11:30:00Z");
    r.updateItemScore({ attemptId, itemId: "lr-2", score: 5, scoreJson: JSON.stringify({ finalScore: 5 }), scoringStatus: "scored" });
    await finalization.reconcileAttempt(attemptId);

    expect(r.getAttempt(attemptId)!.completed_at).toBe(firstCompletedAt); // unchanged
    expect(sectionEstimateRowCount(r, attemptId)).toBe(1);
    // lr-1=3/5 (0.6) and lr-2=5/5 (1.0) after recovery average 0.8, int-1=4/5 is 0.8:
    // band = 1 + 5*0.8 = 5.
    expect(r.getSectionEstimate(attemptId)!.estimatedBand).toBe(5);
  });

  it("repeated reconciliation with unchanged state creates neither duplicate placeholders nor duplicate estimates", async () => {
    const r = openSqliteStores();
    const attemptId = "att-repeat-reconcile";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    for (const item of allExpectedIds) seedScoredItem(r, attemptId, item.id, item.taskType, 4);

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.markCaptureFinished(attemptId);
    await finalization.markCaptureFinished(attemptId);

    await finalization.reconcileAttempt(attemptId);
    await finalization.reconcileAttempt(attemptId);
    await finalization.reconcileAttempt(attemptId);

    expect(r.getAttempt(attemptId)!.items).toHaveLength(11); // no duplicate placeholders
    expect(sectionEstimateRowCount(r, attemptId)).toBe(1); // no duplicate estimates
  });

  it("for a COMPLETED speaking drill, skips the capture gate but still recomputes/replaces the estimate after a late recovered score, preserving completed_at", async () => {
    const r = openSqliteStores();
    const attemptId = "att-drill-late-recovery";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    seedScoredItem(r, attemptId, "lr-1", "listen_repeat", 3);
    seedScoredItem(r, attemptId, "int-1", "interview", 3);
    // lr-2 was still transcription_pending when /complete completed the Drill (a Drill never calls
    // markCaptureFinished), so the seeded estimate leaves it out.
    r.insertItemResult({
      attemptId, itemId: "lr-2", taskType: "listen_repeat",
      responseAudioPath: `audio/responses/${attemptId}/lr-2.webm`, scoringStatus: "transcription_pending",
    });
    r.completeAttempt(attemptId, at("2026-07-30 09:00:00"));
    r.saveSectionEstimate({
      attemptId, section: "speaking",
      rawDetail: JSON.stringify({ raw: 0.4, coverage: [{ taskType: "listen_repeat", itemCount: 1 }] }),
      estimatedBand: 3, method: "linear-v2",
    });

    // Later lr-2 is retried and recovers.
    r.updateItemScore({ attemptId, itemId: "lr-2", score: 5, scoreJson: JSON.stringify({ finalScore: 5 }), scoringStatus: "scored" });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.reconcileAttempt(attemptId);

    const attempt = r.getAttempt(attemptId)!;
    expect(attempt.status).toBe("completed");
    expect(attempt.completed_at).toBe("2026-07-30 09:00:00"); // unchanged
    const estimate = r.getSectionEstimate(attemptId)!;
    expect(estimate.estimatedBand).toBeGreaterThan(3); // recomputed with lr-2 now scored
    expect(sectionEstimateRowCount(r, attemptId)).toBe(1);
  });
});

// The last boot pass. It reconciles what the earlier passes changed plus every capture-finished
// Simulation still in progress, and only once the process owns the listening port.
describe("wireSpeakingBootRecovery", () => {
  function fakeServer() {
    const listeners: (() => unknown)[] = [];
    return {
      server: { on: (_event: "listening", listener: () => void) => { listeners.push(listener); } },
      fireListening: () => Promise.all(listeners.map((l) => l())),
    };
  }

  it("does nothing until 'listening' fires, then reconciles each changed Attempt and each capture-finished in-progress one, once", async () => {
    const r = openSqliteStores();
    // Two capture-finished Attempts left in_progress by a crash, plus one that is not touched (no
    // marker and not changed by any earlier pass).
    r.createAttempt({ id: "boot-a", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    r.createAttempt({ id: "boot-b", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    r.createAttempt({ id: "boot-no-marker", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: "boot-a", now: at("2026-07-30 09:00:00"), placeholders: [] });
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: "boot-b", now: at("2026-07-30 09:00:00"), placeholders: [] });

    const reconcileAttempt = vi.fn(async (_attemptId: string) => {});
    const changedAttempts = new Set<string>();
    const { server, fireListening } = fakeServer();
    wireSpeakingBootRecovery(server, { repo: r, speakingFinalization: { reconcileAttempt }, changedAttempts });

    // Registration alone does nothing: the work waits for 'listening', so a second process retrying
    // after EADDRINUSE never touches a live first process's state.
    expect(reconcileAttempt).not.toHaveBeenCalled();

    // Filled in by earlier passes between registration and 'listening'; boot-a is in both sets.
    changedAttempts.add("completed-elsewhere").add("boot-a");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await fireListening();
    logSpy.mockRestore();

    expect(reconcileAttempt.mock.calls.map(([id]) => id)).toEqual(["completed-elsewhere", "boot-a", "boot-b"]);
  });

  it("isolates each attempt's reconcile so one failure does not skip the rest, and logs a bounded descriptor", async () => {
    const r = openSqliteStores();
    for (const id of ["boot-x", "boot-y", "boot-z"]) {
      r.createAttempt({ id, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
      r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: id, now: at("2026-07-30 09:00:00"), placeholders: [] });
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const reconciled: string[] = [];
      const { server, fireListening } = fakeServer();
      wireSpeakingBootRecovery(server, {
        repo: r,
        changedAttempts: new Set(),
        speakingFinalization: {
          reconcileAttempt: async (attemptId: string) => {
            reconciled.push(attemptId);
            if (attemptId === "boot-y") throw Object.assign(new Error("SCENARIO_CANARY: quoted row"), { code: "SQLITE_BUSY" });
          },
        },
      });
      await fireListening();
      expect(reconciled).toEqual(["boot-x", "boot-y", "boot-z"]);
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("Error (SQLITE_BUSY)");
      expect(logged).not.toContain("SCENARIO_CANARY");
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

// createTranscriptionRecovery memoizes its coordinator per database, so createSpeakingCoordinators
// memoizes the whole bundle the same way. Otherwise a second call for the same database would
// return the memoized recovery coordinator, still wired to the first finalizer, beside a new
// finalizer and onScoringTerminal, with only a console.warn to show it.
//
// The memo has two axes, the store object and its database file, and both are tested. The
// composition root builds the store with `speakingCoordinatorStore(stores)`, which allocates a new
// object on every call, so the file axis is the one production relies on.
describe("createSpeakingCoordinators memoization", () => {
  // Real database files, because the memo keys on the file a store's database lives in.
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "speaking-coordinators-"));
  afterAll(() => fs.rmSync(dbDir, { recursive: true, force: true }));

  it("returns the identical bundle for the same repo object, so the coordinator and the finalization in it can never diverge", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = openSqliteStores(path.join(dbDir, "one.sqlite"));
      const first = createSpeakingCoordinators({ repo: r });
      const second = createSpeakingCoordinators({ repo: r });

      expect(second).toBe(first);
      expect(second.transcriptionRecovery).toBe(first.transcriptionRecovery);
      expect(second.speakingFinalization).toBe(first.speakingFinalization);
      expect(second.onScoringTerminal).toBe(first.onScoringTerminal);
      // Nothing was built the second time, so nothing was warned about either.
      expect(warnSpy).not.toHaveBeenCalled();

      // A different database is a different lifecycle and gets its own bundle.
      expect(createSpeakingCoordinators({ repo: openSqliteStores(path.join(dbDir, "two.sqlite")) })).not.toBe(first);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // The axis production uses: two distinct store objects over one database file, as two
  // `speakingCoordinatorStore(stores)` calls produce. Without the file axis this would return a
  // mismatched bundle: the first transcription coordinator (deduplicated by its own file axis)
  // beside a second finalizer and onScoringTerminal, and a capture-finished Simulation could stay
  // `in_progress` until a restart. Asserting `.toBe(first)` on the whole bundle rules that out.
  it("returns the identical bundle for two DISTINCT store objects over one database file", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dbFile = path.join(dbDir, "shared.sqlite");
      const first = createSpeakingCoordinators({ repo: openSqliteStores(dbFile) });
      const secondRepo = openSqliteStores(dbFile);
      const second = createSpeakingCoordinators({ repo: secondRepo });

      expect(second).toBe(first);
      expect(second.speakingFinalization).toBe(first.speakingFinalization);
      expect(second.onScoringTerminal).toBe(first.onScoringTerminal);
      // Nothing was built the second time, so createTranscriptionRecovery never warned either.
      expect(warnSpy).not.toHaveBeenCalled();

      // `:memory:` is exempt from the file axis: each in-memory database is private to its
      // handle, so two of them get separate bundles.
      const memoryA = createSpeakingCoordinators({ repo: openSqliteStores() });
      const memoryB = createSpeakingCoordinators({ repo: openSqliteStores() });
      expect(memoryB).not.toBe(memoryA);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
