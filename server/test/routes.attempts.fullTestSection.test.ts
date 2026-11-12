import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptListVM } from "@toefl-prep/shared";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { openDb } from "../src/db/db.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// The section a Full-Test Run in progress is sitting, seen from the Attempt log. A Run never re-sits
// an abandoned section, so discarding that Attempt from the log would cost the Run its Overall for
// good: the log names the Run its row belongs to, and POST /:id/abort refuses it. Every other
// unfinished Attempt (no Run, a Run no longer in progress, a section a restart has replaced) is
// discarded as before.

const WRITING_SET_ID = "wri-77af733e";

function harness() {
  const db = openDb(":memory:");
  const repo = sqliteStores(db);
  const scoreDeps = { repo, judgeEssay: vi.fn(), aggregate: vi.fn(), judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn() };
  const coordinators = createSpeakingCoordinators({ ...scoreDeps, hearRecording: vi.fn() });
  const app = buildAttemptsRoutes({ ...scoreDeps, ...coordinators });
  return { db, repo, app };
}
type Harness = ReturnType<typeof harness>;

async function createWritingSimulation(h: Harness): Promise<string> {
  const res = await h.app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "writing", mode: "simulation", setId: WRITING_SET_ID }),
  });
  return ((await res.json()) as { attemptId: string }).attemptId;
}

/** A Run sitting its Writing section on `attemptId`. */
function runSitting(h: Harness, runId: string, attemptId: string) {
  h.repo.createFullTestRun({ id: runId, currentSection: "writing", setIds: { writing: WRITING_SET_ID } });
  h.repo.linkFullTestAttempt(runId, "writing", attemptId);
}

const abort = (h: Harness, attemptId: string) => h.app.request(`/${attemptId}/abort`, { method: "POST" });

async function listed(h: Harness, attemptId: string) {
  const page = (await (await h.app.request("/")).json()) as AttemptListVM;
  return page.items.find((a) => a.id === attemptId)!;
}

describe("the unfinished section of a Full-Test Run in progress", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("is listed with the Run it belongs to", async () => {
    const attemptId = await createWritingSimulation(h);
    runSitting(h, "run-open", attemptId);

    expect((await listed(h, attemptId)).fullTestRun).toEqual({ id: "run-open", status: "in-progress" });
  });

  it("cannot be discarded: abort answers 409, names the Run, and changes nothing", async () => {
    const attemptId = await createWritingSimulation(h);
    runSitting(h, "run-open", attemptId);

    const res = await abort(h, attemptId);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/Full-Test Run in progress/), fullTestRunId: "run-open" });
    expect(h.repo.getAttempt(attemptId)).toMatchObject({ status: "in_progress", completed_at: null });
  });
});

describe("every other unfinished Attempt is discarded as before", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("one that belongs to no Run", async () => {
    const attemptId = await createWritingSimulation(h);

    expect((await listed(h, attemptId)).fullTestRun).toBeNull();
    expect((await abort(h, attemptId)).status).toBe(200);
    expect(h.repo.getAttempt(attemptId)!.status).toBe("aborted");
  });

  it("one whose Run is no longer in progress", async () => {
    const attemptId = await createWritingSimulation(h);
    runSitting(h, "run-done", attemptId);
    h.repo.completeFullTestRun("run-done");

    expect((await listed(h, attemptId)).fullTestRun).toEqual({ id: "run-done", status: "completed" });
    expect((await abort(h, attemptId)).status).toBe(200);
    expect(h.repo.getAttempt(attemptId)!.status).toBe("aborted");
  });

  it("one a restarted section has replaced, which its Run no longer points at", async () => {
    const replaced = await createWritingSimulation(h);
    runSitting(h, "run-open", replaced);
    const restarted = await createWritingSimulation(h);
    h.repo.linkFullTestAttempt("run-open", "writing", restarted);

    expect((await listed(h, replaced)).fullTestRun).toBeNull();
    expect((await abort(h, replaced)).status).toBe(200);
    expect(h.repo.getAttempt(replaced)!.status).toBe("aborted");
    expect((await abort(h, restarted)).status).toBe(409);
  });
});
