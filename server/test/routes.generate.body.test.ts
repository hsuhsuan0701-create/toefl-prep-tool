import { describe, expect, it } from "vitest";
import { buildGenerateRoutes } from "../src/routes/generate.js";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// POST /api/generate's body is parsed JSON of any shape. Every shape that is not a request object
// must be a 400 that queues nothing, never a 500 thrown out of the handler.

function post(body: string) {
  const repo = sqliteStores(openDb(":memory:"));
  const app = buildGenerateRoutes({ repo });
  return app.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

describe("POST /api/generate with a body that is not an object", () => {
  it.each(["null", "42", "\"speaking\"", "true", "[]", "[{\"kind\":\"writing\"}]"])("answers 400 for %s", async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});
