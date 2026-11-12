import path from "node:path";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { resolveAudioPath, resolveIntendedPathWithinBase, resolveRealPathWithinBase, toDataDirRelative } from "../src/lib/paths.js";

// A fixed, fake dataDir: resolveAudioPath is pure path arithmetic (no filesystem access), so it
// needs a stable absolute base to resolve against, not a real directory.
const dataDir = "/srv/toefl/data";

describe("resolveAudioPath", () => {
  it("resolves a legit relative path by joining onto dataDir", () => {
    expect(resolveAudioPath("audio/responses/att-1/lr-1.webm", dataDir)).toBe(
      path.join(dataDir, "audio/responses/att-1/lr-1.webm")
    );
  });

  it("resolves an absolute path already under dataDir unchanged", () => {
    const abs = path.join(dataDir, "audio/responses/att-1/lr-1.webm");
    expect(resolveAudioPath(abs, dataDir)).toBe(abs);
  });

  it("round-trips with toDataDirRelative: relative -> resolve -> back to the same relative form", () => {
    const rel = "audio/responses/att-2/int-1.webm";
    const resolved = resolveAudioPath(rel, dataDir);
    expect(toDataDirRelative(resolved, dataDir)).toBe(rel);
  });

  // resolveAudioPath is the one seam a stored response_audio_path passes through on its way to
  // fs.readFileSync (judges/speaking.ts) and probeDurationSec, so a tampered or corrupted value must
  // not become an arbitrary-file read. These mirror the audio routes' boundary tests in
  // routes.sets.test.ts.
  it("throws on a relative value that traverses outside dataDir via ..", () => {
    expect(() => resolveAudioPath("../../../etc/passwd", dataDir)).toThrow(/escapes dataDir/);
  });

  it("throws on an absolute path outside dataDir", () => {
    expect(() => resolveAudioPath("/etc/passwd", dataDir)).toThrow(/escapes dataDir/);
  });

  it("throws on a sibling-directory-prefix escape (data-evil string-prefix-matches dataDir without a separator)", () => {
    // The audio routes' "stimuli-evil" and "responses-evil" cases, here: a boundary check using
    // resolved.startsWith(dataDir) instead of resolved.startsWith(dataDir + path.sep) would let this
    // escape.
    expect(() => resolveAudioPath("/srv/toefl/data-evil/audio/responses/att-1/lr-1.webm", dataDir)).toThrow(
      /escapes dataDir/
    );
  });

  it("throws on a relative value engineered to land on a dataDir sibling after normalization", () => {
    expect(() => resolveAudioPath("../data-evil/secret.webm", dataDir)).toThrow(/escapes dataDir/);
  });
});

it("rejects an existing symlink that escapes its canonical base", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paths-link-")); const outside = fs.mkdtempSync(path.join(os.tmpdir(), "paths-outside-")); fs.writeFileSync(path.join(outside, "secret"), "x"); fs.symlinkSync(path.join(outside, "secret"), path.join(root, "link"));
  try { expect(() => resolveRealPathWithinBase("link", root)).toThrow(/unsafe/); } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

describe("resolveIntendedPathWithinBase", () => {
  it("rejects traversal and sibling-prefix paths for a new descendant", () => {
    expect(() => resolveIntendedPathWithinBase("../data-evil/file", dataDir)).toThrow(/escapes/);
    expect(() => resolveIntendedPathWithinBase("/srv/toefl/data-evil/file", dataDir)).toThrow(/escapes/);
  });
});
