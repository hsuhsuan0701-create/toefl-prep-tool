import test from "node:test";
import assert from "node:assert/strict";
import { checkGeminiModel } from "../src/geminiModelCheck.ts";

test("missing key refuses without invoking Gemini", async () => {
  const result = await checkGeminiModel(undefined, "gemini-test", async () => { throw Error("must not call"); });
  assert.equal(result.keyConfigured, false);
  assert.equal(result.modelAccessible, false);
});

test("model metadata request does not generate text or expose key", async () => {
  const key = "SECRET_TEST_ONLY";
  const result = await checkGeminiModel(key, "gemini-test", async (url, init) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test");
    assert.equal(init.method, "GET");
    assert.equal(init.headers["x-goog-api-key"], key);
    return Response.json({ name: "models/gemini-test", supportedGenerationMethods: ["generateContent"] });
  });
  assert.equal(result.modelAccessible, true);
  assert.equal(result.supportsGenerateContent, true);
  assert.ok(!JSON.stringify(result).includes(key));
});

test("unknown model yields generic 404 and no secrets", async () => {
  const result = await checkGeminiModel("SECRET_TEST_ONLY", "gemini-test", async () => new Response("NO",{status:404}));
  assert.equal(result.modelAccessible, false);
  assert.equal(result.httpStatus, 404);
});
