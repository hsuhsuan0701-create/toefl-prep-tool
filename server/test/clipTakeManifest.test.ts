import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeholderSpeakingSet } from "./helpers/setFixtures.js";
import { LISTEN_AND_REPEAT_ITEM_TARGET_WPM } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import type { ClipMeasurementRow } from "../src/db/rows.js";
import { createSqliteClipMeasurementStore } from "../src/db/stores/diagnostics.js";
import {
  parseClipTakeManifest,
  reconcileClipMeasurementsFromManifests,
  wireClipMeasurementReconciliation,
} from "../src/services/clipTakeManifest.js";
import { resetClipMeasurementSink } from "../src/services/clipMeasurementLog.js";
import { AUDIO_PROFILE_VERSION } from "../src/services/speakingAudioProfile.js";
import { renderSpeakingAudio } from "../src/services/speakingAudioRenderer.js";

/**
 * A render's measurements travel inside its artifact. `clip_measurements` rows stay in the database
 * of the checkout that rendered, so a Set rendered in another worktree or on another machine arrives
 * with its audio and none of its rows. `audio-manifest.json` lives in the render's output directory
 * and cannot be separated from the audio it describes, so every take is recorded there as well and
 * replayed into the local database at boot.
 *
 * These tests drive a real render (stubbed synthesis; no paid TTS is reachable from this suite) with
 * the measurement sink switched off, which is what "rendered in a different checkout" looks like from
 * here, and recover every measurement from the artifact alone.
 */

let dirs: string[] = [];
afterEach(() => {
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  dirs = [];
  resetClipMeasurementSink();
});
const tmpDir = (): string => {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "clip-take-manifest-"));
  dirs.push(result);
  return result;
};

/**
 * A render into `dataDir` with nothing written to any local database: a render whose rows never
 * reached the checkout that kept the Set.
 *
 * `probeDuration` makes lr-1 miss its band on the first take and miss it worse on the corrective
 * re-render, so this render also exercises the case the published-take flag exists for.
 */
async function renderIntoAnotherCheckout(dataDir: string): Promise<{ outputDir: string; publishedLr1Sec: number }> {
  const outputDir = path.join(dataDir, "audio/stimuli/spk-001");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const result = await renderSpeakingAudio(
      placeholderSpeakingSet(),
      { setId: "spk-001", outputDir, audioPathPrefix: "stimuli/spk-001" },
      {
        synthesize: async (_request, outPath) => fs.writeFileSync(outPath, "audio"),
        probeDuration: async (filePath) => {
          const base = path.basename(filePath);
          // lr-1 misses its band, and misses it worse on the correction (140 then 105 WPM, both below
          // the 156 WPM floor of a Listen and Repeat item's band), so this render exercises the
          // discarded-retake case. Every other clip sits exactly on its own target, each Listen and
          // Repeat item on its per-item target, so nothing else buys a re-render and the row count
          // is exact.
          if (base.startsWith(".lr-1.mp3")) return base.includes(".retake.") ? 4.0 : 3.0;
          const clip = base.replace(/^\./u, "").replace(/(?:\.retake)?\.tmp$/u, "");
          if (clip === "briefing.mp3") return 1.8;
          if (clip === "int-intro.mp3") return 2.2;
          if (clip.startsWith("q-")) return 3.1;
          const item = Number(clip.slice(3, -4)) - 1;
          return (7 / LISTEN_AND_REPEAT_ITEM_TARGET_WPM[item]!) * 60;
        },
      },
    );
    return { outputDir, publishedLr1Sec: result.measurements.find((m) => m.file === "lr-1.mp3")!.durationSec };
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
}

function freshStore() {
  const db = openDb(":memory:");
  return {
    db,
    store: createSqliteClipMeasurementStore(db),
    rows: (): ClipMeasurementRow[] =>
      db.prepare("SELECT * FROM clip_measurements ORDER BY rowid").all() as ClipMeasurementRow[],
  };
}

describe("a render's measurements travel with the published artifact", () => {
  it("recovers every take of a render whose rows were never written locally", async () => {
    const dataDir = tmpDir();
    const rendered = await renderIntoAnotherCheckout(dataDir);
    const { store, rows } = freshStore();

    // Nothing was recorded live, as for a Set rendered in another checkout.
    expect(rows()).toHaveLength(0);

    const result = reconcileClipMeasurementsFromManifests({ dataDir, repo: store });

    // Thirteen clips, one of which was corrected: fourteen syntheses, fourteen rows.
    expect(result).toEqual({ manifests: 1, inserted: 14 });
    expect(rows()).toHaveLength(14);

    // The current bank is queryable by profile version. Read off AUDIO_PROFILE_VERSION rather than a
    // literal, so the claim follows whatever the renderer stamps. The `profileVersion` literal in
    // the parser fixtures below is input data and deliberately not this constant.
    const current = rows().filter((row) => row.profile_version === AUDIO_PROFILE_VERSION);
    expect(current).toHaveLength(14);

    // And the published take of the corrected clip is identifiable without opening the mp3.
    const lr1 = rows().filter((row) => row.file === "lr-1.mp3");
    expect(lr1.map((row) => [row.correction_count, row.take_disposition])).toEqual([
      [0, "published"],
      [1, "discarded"],
    ]);
    expect(lr1.find((row) => row.take_disposition === "published")!.duration_sec)
      .toBe(rendered.publishedLr1Sec);
  });

  it("is idempotent — replaying the same manifest twice inserts nothing the second time", async () => {
    const dataDir = tmpDir();
    await renderIntoAnotherCheckout(dataDir);
    const { store, rows } = freshStore();

    reconcileClipMeasurementsFromManifests({ dataDir, repo: store });
    const first = rows();
    reconcileClipMeasurementsFromManifests({ dataDir, repo: store });

    // Same rows, same ids, same order: the manifest carries each row's own id, so a replay is a
    // no-op rather than a duplicate set of measurements for the same paid render.
    expect(rows()).toEqual(first);
  });

  it("dates a replayed row by the RENDER, in this project's on-disk timestamp form", async () => {
    const dataDir = tmpDir();
    await renderIntoAnotherCheckout(dataDir);
    const manifestPath = path.join(dataDir, "audio/stimuli/spk-001/audio-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.renderedAt = "2026-08-01T04:05:06.000Z";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const { store, rows } = freshStore();

    reconcileClipMeasurementsFromManifests({ dataDir, repo: store });

    // Space-form UTC (db/timestamps.ts), not the ISO the manifest carries and not "now": a row that
    // claimed to be new would outlive the retention it has already used up.
    expect(new Set(rows().map((row) => row.created_at))).toEqual(new Set(["2026-08-01 04:05:06"]));
  });

  it("skips a render already past the retention window rather than churning it every boot", async () => {
    const dataDir = tmpDir();
    await renderIntoAnotherCheckout(dataDir);
    const { store, rows } = freshStore();

    reconcileClipMeasurementsFromManifests({
      dataDir,
      repo: store,
      olderThan: new Date(Date.now() + 60_000),
    });

    expect(rows()).toHaveLength(0);
  });

  it("reads nothing, and throws nothing, in a checkout with no rendered audio at all", () => {
    const { store, rows } = freshStore();
    expect(reconcileClipMeasurementsFromManifests({ dataDir: tmpDir(), repo: store }))
      .toEqual({ manifests: 0, inserted: 0 });
    expect(rows()).toHaveLength(0);
  });
});

describe("parseClipTakeManifest", () => {
  const good = {
    setId: "spk-001",
    renderedAt: "2026-08-01T00:00:00.000Z",
    takes: [{
      measurementId: "m-1", role: "lr-item", file: "lr-1.mp3", wordCount: 7, durationSec: 2.1,
      wpm: 200, correctionCount: 0, inBand: true, accent: "north-american",
      profileVersion: "ets-2026-v4", disposition: "published",
    }],
  };

  it("accepts a manifest carrying takes", () => {
    expect(parseClipTakeManifest(good)?.takes).toHaveLength(1);
  });

  it("accepts a take from an escalated correction round", () => {
    // A Listening clip far below its band buys up to three rounds, so its manifest carries takes at
    // correctionCount 2 and 3. This parser is all-or-nothing per file: rejecting one of them would
    // discard the whole render's measurements, in the checkout that has to replay them.
    const escalated = { ...good, takes: [2, 3].map((correctionCount, index) => ({
      ...good.takes[0], measurementId: `m-${index}`, correctionCount,
    })) };
    expect(parseClipTakeManifest(escalated)?.takes.map((take) => take.correctionCount)).toEqual([2, 3]);
  });

  it("returns undefined for a manifest that predates the fields, with no complaint", () => {
    // A manifest without `takes`, as many in the bank are. Its `clips` array records only the
    // published take's duration and WPM, and synthesizing rows from that would invent
    // correctionCount, inBand and accent: fabricated values in the same columns as measured ones.
    // Those measurements are lost, and the module declines to make some up.
    expect(parseClipTakeManifest({ profile: {}, clips: [], baseClipCount: 13 })).toBeUndefined();
  });

  it.each([
    ["a take missing its measurement id", { measurementId: "" }],
    // A Listening clip far below its band buys up to three rounds, so 2 and 3 are real correction
    // counts. What is rejected is a count that cannot name a round at all, not one above a budget:
    // a budget check would reject whole manifests from renders that spent what they were allowed.
    ["a fractional correction count", { correctionCount: 1.5 }],
    ["a negative correction count", { correctionCount: -1 }],
    ["a non-numeric measurement", { wpm: "fast" }],
    ["an unknown disposition", { disposition: "maybe" }],
    ["a non-boolean band verdict", { inBand: 1 }],
  ])("rejects the WHOLE manifest on %s", (_label, override) => {
    // All-or-nothing per file: a partially replayed render is a measurement set that looks complete
    // and is not, which is the failure this module exists to prevent.
    expect(parseClipTakeManifest({ ...good, takes: [{ ...good.takes[0], ...override }] })).toBeUndefined();
  });

  it("rejects a manifest with no set id or an unparseable render time", () => {
    expect(parseClipTakeManifest({ ...good, setId: "" })).toBeUndefined();
    expect(parseClipTakeManifest({ ...good, renderedAt: "whenever" })).toBeUndefined();
  });
});

describe("the boot pass", () => {
  it("replays on 'listening', and never lets a failure abort the remaining passes", async () => {
    const dataDir = tmpDir();
    await renderIntoAnotherCheckout(dataDir);
    const { store, rows } = freshStore();
    const listeners: (() => void)[] = [];
    const server = { on: (_event: "listening", listener: () => void) => listeners.push(listener) };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      wireClipMeasurementReconciliation(server, store, dataDir);
      expect(rows()).toHaveLength(0); // Deferred to 'listening', like every other boot pass.
      listeners.forEach((listener) => listener());
      expect(rows()).toHaveLength(14);

      // A store that throws must not take the prune (or anything else on 'listening') down with it.
      const exploding = { insertClipMeasurement: () => { throw new Error("SQLITE_BUSY"); } };
      const boom: (() => void)[] = [];
      wireClipMeasurementReconciliation(
        { on: (_event: "listening", listener: () => void) => boom.push(listener) },
        exploding,
        dataDir,
      );
      expect(() => boom.forEach((listener) => listener())).not.toThrow();
      expect(error).toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
