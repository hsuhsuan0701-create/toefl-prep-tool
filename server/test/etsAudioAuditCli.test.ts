import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEtsAuditArgs, writeAuditOutput } from "../src/services/etsAudioAuditCli.js";
describe("ETS audio audit CLI policy", () => {
  it("accepts the documented practice-test command", () => expect(parseEtsAuditArgs(["--source", "practice-test-5", "--audio-dir", "/audio", "--out", "/out.json"])).toMatchObject({ source: "practice-test-5" }));
  it("rejects malformed and contradictory flags", () => { for (const args of [["--wat"], ["--source", "practice-test-5", "--source", "practice-test-5", "--audio-dir", "/a", "--no-write"], ["--source", "lesson-plan", "--audio-dir", "/a"], ["--source", "practice-test-5", "--audio-dir", "/a", "--force"], ["--source", "practice-test-5", "--audio-dir", "/a", "--no-write", "--out", "/x"]]) expect(() => parseEtsAuditArgs(args)).toThrow(); });
  it("uses exclusive writes unless force is explicit", () => { const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ets-audit-")), "out.json"); writeAuditOutput(file, "one", false); expect(() => writeAuditOutput(file, "two", false)).toThrow(); writeAuditOutput(file, "two", true); expect(fs.readFileSync(file, "utf8")).toBe("two"); });
});
