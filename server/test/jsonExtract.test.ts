import { describe, expect, it } from "vitest";
import {
  extractClaudeJson,
  extractJsonObject,
} from "../src/lib/jsonExtract.js";

describe("extractJsonObject", () => {
  it("extracts the first through last braces from surrounding prose", () => {
    expect(extractJsonObject('prefix\n{"a":1}\nsuffix')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("returns the normalized missing-object error without raw input", () => {
    expect(extractJsonObject("secret diagnostics")).toEqual({
      ok: false,
      error: "no JSON object",
    });
  });

  it("returns the normalized parse error without parser diagnostics", () => {
    expect(extractJsonObject('prefix {"secret": } suffix')).toEqual({
      ok: false,
      error: "JSON parse failed",
    });
  });
});

describe("extractClaudeJson", () => {
  it("prefers structured_output in the envelope", () => {
    const out = JSON.stringify({ type: "result", subtype: "success", result: "ignored", structured_output: { a: 1 } });
    expect(extractClaudeJson(out)).toEqual({ ok: true, value: { a: 1 } });
  });
  it("falls back to parsing result text", () => {
    const out = JSON.stringify({ type: "result", subtype: "success", result: '{"b":2}' });
    expect(extractClaudeJson(out)).toEqual({ ok: true, value: { b: 2 } });
  });
  it("strips code fences and prose around JSON in result", () => {
    const out = JSON.stringify({ type: "result", subtype: "success", result: 'Here you go:\n```json\n{"c":3}\n```\nDone.' });
    expect(extractClaudeJson(out)).toEqual({ ok: true, value: { c: 3 } });
  });
  it("fails on error subtype", () => {
    const out = JSON.stringify({ type: "result", subtype: "error_during_execution", result: "boom" });
    expect(extractClaudeJson(out)).toEqual({
      ok: false,
      error: "claude result subtype: error_during_execution",
    });
  });
  it("fails on garbage", () => {
    expect(extractClaudeJson("not json at all")).toEqual({
      ok: false,
      error: "stdout is not JSON",
    });
  });
  it.each(["null", "[]"])(
    "rejects the non-object Claude envelope %s without throwing",
    (stdout) => {
      expect(extractClaudeJson(stdout)).toEqual({
        ok: false,
        error: "claude envelope is not an object",
      });
    }
  );
  it("retains the Claude-specific result extraction errors", () => {
    const missing = JSON.stringify({ subtype: "success", result: "not json" });
    const invalid = JSON.stringify({ subtype: "success", result: '{"x": }' });
    expect(extractClaudeJson(missing)).toEqual({
      ok: false,
      error: "no JSON object in result",
    });
    expect(extractClaudeJson(invalid)).toEqual({
      ok: false,
      error: "result JSON parse failed",
    });
  });
});
