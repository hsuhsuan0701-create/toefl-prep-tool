import { describe, expect, it } from "vitest";
import type { FullTestRunVM } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { buildFullTestRoutes } from "../src/routes/fullTests.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { at } from "./helpers/timestamps.js";

// The practice page's Full Test panel is the only route back to a half-sat Run, so it must be able
// to ask for every in-progress Run however many newer Runs exist.

function harness() {
  const r = sqliteStores(openDb(":memory:"));
  const app = buildFullTestRoutes({ repo: r, listSetBank: () => [] });
  const run = (id: string, createdAt: string, completed: boolean) => {
    r.createFullTestRun({ id, currentSection: "reading", setIds: {}, createdAt: at(createdAt) });
    if (completed) r.completeFullTestRun(id, at(createdAt));
  };
  return { app, run };
}

describe("GET /api/full-tests?status=", () => {
  it("lists every in-progress Run, even behind more newer Runs than a page holds", async () => {
    const { app, run } = harness();
    run("old-unfinished", "2026-08-01 09:00:00", false);
    for (let i = 0; i < 5; i++) run(`newer-${i}`, `2026-08-0${i + 2} 09:00:00`, true);
    // More abandoned sittings than the unfiltered listing's default page of 20.
    for (let i = 0; i < 25; i++) run(`open-${i}`, `2026-07-01 10:${String(i).padStart(2, "0")}:00`, false);

    const recent = (await (await app.request("/?limit=3")).json()) as FullTestRunVM[];
    expect(recent.map((r) => r.id)).not.toContain("old-unfinished");

    const inProgress = (await (await app.request("/?status=in-progress")).json()) as FullTestRunVM[];
    expect(inProgress).toHaveLength(26);
    expect(inProgress[0].id).toBe("old-unfinished");
    expect(inProgress.every((r) => r.status === "in-progress")).toBe(true);
  });

  it("reads `limit` as the Attempt log does: an integer of at least 1, capped at 50, else the default page", async () => {
    const { app, run } = harness();
    for (let i = 0; i < 60; i++) run(`run-${i}`, `2026-07-01 10:${String(i).padStart(2, "0")}:00`, true);
    const count = async (query: string) => ((await (await app.request(`/${query}`)).json()) as FullTestRunVM[]).length;

    expect(await count("?limit=3")).toBe(3);
    expect(await count("?limit=500")).toBe(50);
    for (const malformed of ["", "?limit=0", "?limit=-4", "?limit=2.5", "?limit=abc"]) {
      expect(await count(malformed)).toBe(20);
    }
  });

  it("ignores an unknown status rather than filtering everything out", async () => {
    const { app, run } = harness();
    run("a", "2026-08-01 09:00:00", false);
    run("b", "2026-08-02 09:00:00", true);
    const all = (await (await app.request("/?status=bogus")).json()) as FullTestRunVM[];
    expect(all.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
