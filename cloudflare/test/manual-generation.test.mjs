import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

const host = "https://private.example";
const env = { TOEFL_MANUAL_TEST_TOKEN: "a".repeat(48), AI_GENERATION_ENABLED: "false",
  GEMINI_API_KEY: "fake-gemini-key" };
function submit(headers, body = '{"confirm":"GENERATE_ONCE"}') {
  return worker.fetch(new Request(host + "/api/cloud/gemini-generate-once", {
    method: "POST", headers, body
  }), env);
}
test("missing bearer token cannot trigger Gemini", async () => {
  const res = await submit({ origin: host, "content-type": "application/json" });
  assert.equal(res.status, 401);
});
test("invalid bearer token cannot trigger Gemini", async () => {
  const res = await submit({ origin: host, "content-type": "application/json", authorization: "Bearer " + "z".repeat(48) });
  assert.equal(res.status, 401);
});
test("wrong origin cannot trigger Gemini even with valid token", async () => {
  const res = await submit({ origin: "https://other.example", "content-type": "application/json", authorization: "Bearer " + "a".repeat(48) });
  assert.equal(res.status, 403);
});
test("wrong confirmation cannot trigger Gemini even with valid token", async () => {
  const res = await submit({ origin: host, "content-type": "application/json", authorization: "Bearer " + "a".repeat(48) }, '{"confirm":"NO"}');
  assert.equal(res.status, 400);
});
test("missing manual secret refuses even a bearer token", async () => {
  const res = await worker.fetch(new Request(host + "/api/cloud/gemini-generate-once", {
    method: "POST", headers: { origin: host, "content-type": "application/json", authorization: "Bearer " + "a".repeat(48) },
    body: '{"confirm":"GENERATE_ONCE"}'
  }), { GEMINI_API_KEY:"mock-key", AI_GENERATION_ENABLED:"false" });
  assert.equal(res.status,401);
});
