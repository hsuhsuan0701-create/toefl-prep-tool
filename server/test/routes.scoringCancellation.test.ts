import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";

describe("scoring cancellation API", () => {
  it("returns 404, idempotent 200, and terminal 409 with durable metadata", async () => {
    const r = sqliteStores(openDb(":memory:"));
    const app = buildAttemptsRoutes({
      repo: r,
      transcriptionRecovery: {},
      speakingFinalization: {},
      onScoringTerminal: async () => undefined,
    } as never);
    r.createAttempt({ id: "attempt", kind: "writing", mode: "drill", setId: "set", isRepeat: false });
    r.createScoringJob({ id: "active", attemptId: "attempt", taskType: "email", itemIds: ["item"] });

    expect((await app.request("/other/score-jobs/active/cancel", { method: "POST" })).status).toBe(404);
    const accepted = await app.request("/attempt/score-jobs/active/cancel", { method: "POST" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      jobId: "active", status: "queued", cancellationReason: "user",
      cancellationRequestedAt: expect.any(String),
    });
    expect((await app.request("/attempt/score-jobs/active/cancel", { method: "POST" })).status).toBe(200);

    r.createScoringJob({ id: "done", attemptId: "attempt", taskType: "discussion", itemIds: ["item"] });
    r.seedScoringJobState({ id: "done", status: "done" });
    expect((await app.request("/attempt/score-jobs/done/cancel", { method: "POST" })).status).toBe(409);
    expect((await app.request("/attempt/score-jobs/missing/cancel", { method: "POST" })).status).toBe(404);
  });
});
