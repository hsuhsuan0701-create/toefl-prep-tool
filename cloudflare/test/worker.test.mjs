import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

const assets = { fetch: async () => new Response("SPA content", { status: 200 }) };
const request = (path) => new Request(`https://toefl.example${path}`);

test("health check works without AI API keys", async () => {
  const response = await worker.fetch(request("/api/health"), { ASSETS: assets });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("cloud status checks the actual D1 binding", async () => {
  const DB = { prepare(sql) {
    assert.match(sql, /FROM attempts/);
    return { first: async () => ({ count: 0 }) };
  } };
  const response = await worker.fetch(request("/api/cloud/status"), { DB, ASSETS: assets });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { dbConnected: true, attempts: 0, crossDeviceReady: false });
});

test("missing D1 migration is explicit", async () => {
  const DB = { prepare() { throw new Error("no such table: attempts"); } };
  const response = await worker.fetch(request("/api/cloud/status"), { DB, ASSETS: assets });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.dbConnected, false);
  assert.doesNotMatch(JSON.stringify(body), /no such table/);
});

test("unmigrated generation API still refuses requests", async () => {
  const response = await worker.fetch(new Request("https://toefl.example/api/generate", { method: "POST" }), { ASSETS: assets });
  assert.equal(response.status, 501);
  assert.match((await response.json()).error, /not been migrated/);
});

test("non-API requests are delegated to React SPA assets", async () => {
  const response = await worker.fetch(request("/simulate/reading"), { ASSETS: assets });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "SPA content");
});
