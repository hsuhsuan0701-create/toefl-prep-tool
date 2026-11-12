import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { openDb } from "../src/db/db.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { setStore } from "../src/services/setStore.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// POST /:id/complete through the real route and the real speaking coordinators over an in-memory
// database. Completion is a one-way step out of 'in_progress'.

const WRITING_SET_ID = "wri-77af733e";
const SPEAKING_SET_ID = "spk-e5b2b735";

function harness() {
  const db = openDb(":memory:");
  const repo = sqliteStores(db);
  const scoreDeps = { repo, judgeEssay: vi.fn(), aggregate: vi.fn(), judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn() };
  const coordinators = createSpeakingCoordinators({ ...scoreDeps, hearRecording: vi.fn() });
  const app = buildAttemptsRoutes({ ...scoreDeps, ...coordinators });
  return { db, repo, app };
}
type Harness = ReturnType<typeof harness>;

async function createAttempt(h: Harness, kind: "writing" | "speaking", setId: string, mode: "drill" | "simulation") {
  const res = await h.app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, mode, setId }),
  });
  return ((await res.json()) as { attemptId: string }).attemptId;
}

const post = (h: Harness, url: string) => h.app.request(url, { method: "POST" });
const estimateRows = (h: Harness, attemptId: string) =>
  h.db.prepare("SELECT COUNT(*) AS n FROM section_estimates WHERE attempt_id=?").get(attemptId) as { n: number };

describe("POST /:id/complete", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it.each([
    ["a Writing Drill", "writing", WRITING_SET_ID, "drill"],
    ["a Speaking Drill", "speaking", SPEAKING_SET_ID, "drill"],
    ["a Speaking Simulation", "speaking", SPEAKING_SET_ID, "simulation"],
  ] as const)("refuses to complete %s that was aborted, with a conflict that is not 'alreadyScored'", async (_label, kind, setId, mode) => {
    const attemptId = await createAttempt(h, kind, setId, mode);
    h.repo.insertItemResult({ attemptId, itemId: "bas-1", taskType: "build_sentence", responseText: "[]" });
    h.repo.updateItemScore({ attemptId, itemId: "bas-1", score: 1, scoreJson: "{}", scoringStatus: "scored" });
    expect((await post(h, `/${attemptId}/abort`)).status).toBe(200);

    const res = await post(h, `/${attemptId}/complete`);

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("alreadyScored");
    expect(h.repo.getAttempt(attemptId)).toMatchObject({ status: "aborted", completed_at: null, capture_finished_at: null });
    expect(estimateRows(h, attemptId).n).toBe(0);
  });

  it("answers a second identical /complete with the first one's outcome and writes nothing", async () => {
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "simulation");
    // Every Writing Task Type scored, so the first completion has a band to persist.
    for (const [itemId, taskType, score] of [["bas-1", "build_sentence", 1], ["email-x", "email", 4], ["disc-x", "discussion", 4]] as const) {
      h.repo.insertItemResult({ attemptId, itemId, taskType, responseText: "[]" });
      h.repo.updateItemScore({ attemptId, itemId, score, scoreJson: "{}", scoringStatus: "scored" });
    }
    const first = await post(h, `/${attemptId}/complete`);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toHaveProperty("estimate");
    h.db.prepare("UPDATE attempts SET completed_at='2026-01-01 00:00:00' WHERE id=?").run(attemptId);
    const estimatesBefore = h.db.prepare("SELECT * FROM section_estimates WHERE attempt_id=?").all(attemptId);

    // A changed score would change a recomputed estimate; a replay must not recompute.
    h.repo.updateItemScore({ attemptId, itemId: "email-x", score: 1, scoreJson: "{}", scoringStatus: "scored" });
    const second = await post(h, `/${attemptId}/complete`);

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect(h.repo.getAttempt(attemptId)).toMatchObject({ status: "completed", completed_at: "2026-01-01 00:00:00" });
    expect(h.db.prepare("SELECT * FROM section_estimates WHERE attempt_id=?").all(attemptId)).toEqual(estimatesBefore);
  });
});

describe("POST /:id/abort", () => {
  it("answers from the guarded write: a completion that lands after the route's read is a 409 naming 'completed'", async () => {
    const db = openDb(":memory:");
    const real = sqliteStores(db);
    let completeBeforeNextRead = false;
    // The real store, with one completion landing between the route's read of the Attempt and its
    // abort write: the interleaving a concurrent /complete produces.
    const repo = {
      ...real,
      getAttempt: (id: string) => {
        const attempt = real.getAttempt(id);
        if (completeBeforeNextRead) {
          completeBeforeNextRead = false;
          real.completeAttempt(id);
        }
        return attempt;
      },
    };
    const scoreDeps = { repo, judgeEssay: vi.fn(), aggregate: vi.fn(), judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn() };
    const app = buildAttemptsRoutes({ ...scoreDeps, ...createSpeakingCoordinators({ ...scoreDeps, hearRecording: vi.fn() }) });
    const h = { db, repo: real, app };
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "drill");

    completeBeforeNextRead = true;
    const res = await post(h, `/${attemptId}/abort`);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "attempt is already completed" });
    expect(real.getAttempt(attemptId)?.status).toBe("completed");
  });

  it("aborts an in-progress Attempt and refuses a second abort", async () => {
    const h = harness();
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "drill");

    const first = await post(h, `/${attemptId}/abort`);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "aborted" });

    const second = await post(h, `/${attemptId}/abort`);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "attempt is already aborted" });
  });
});

describe("POST /:id/items/:itemId/audio", () => {
  it("answers an unclassified intake fault with the route's bare 500 and logs only a safe descriptor", async () => {
    const db = openDb(":memory:");
    const repo = sqliteStores(db);
    const scoreDeps = { repo, judgeEssay: vi.fn(), aggregate: vi.fn(), judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn() };
    const coordinators = createSpeakingCoordinators({ ...scoreDeps, hearRecording: vi.fn() });
    // Not a TranscodeError, so intake has no outcome for it and rethrows.
    const transcode = vi.fn(async () => {
      throw new Error("ffmpeg crashed reading private-recording-detail");
    });
    const app = buildAttemptsRoutes({ ...scoreDeps, ...coordinators, transcode });
    const h = { db, repo, app };
    const attemptId = await createAttempt(h, "speaking", SPEAKING_SET_ID, "simulation");
    const set = setStore.readSet(SPEAKING_SET_ID);
    if (set?.kind !== "speaking") throw new Error("the banked Speaking Set did not load");
    const firstItemId = set.listenAndRepeat.items[0]!.id;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(4096)], "take.webm", { type: "audio/webm" }));
      const res = await app.request(`/${attemptId}/items/${firstItemId}/audio`, { method: "POST", body: form });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal error" });
      expect(transcode).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledWith("[attempts] recording upload failed:", "Error");
      expect(JSON.stringify(errors.mock.calls)).not.toContain("private-recording-detail");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("completeAttempt", () => {
  it("moves only an in-progress Attempt to completed, and says whether it did", () => {
    const repo = sqliteStores(openDb(":memory:"));
    for (const id of ["open", "aborted", "done"]) {
      repo.createAttempt({ id, kind: "writing", mode: "drill", setId: WRITING_SET_ID, isRepeat: false });
    }
    repo.abortAttempt("aborted");
    expect(repo.completeAttempt("done", "2026-01-01 00:00:00" as never)).toBe(true);

    expect(repo.completeAttempt("open", "2026-02-02 00:00:00" as never)).toBe(true);
    expect(repo.completeAttempt("aborted", "2026-02-02 00:00:00" as never)).toBe(false);
    expect(repo.completeAttempt("done", "2026-02-02 00:00:00" as never)).toBe(false);

    expect(repo.getAttempt("open")).toMatchObject({ status: "completed", completed_at: "2026-02-02 00:00:00" });
    expect(repo.getAttempt("aborted")).toMatchObject({ status: "aborted", completed_at: null });
    expect(repo.getAttempt("done")).toMatchObject({ status: "completed", completed_at: "2026-01-01 00:00:00" });
  });
});
