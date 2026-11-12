import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeholderSpeakingSet } from "./helpers/setFixtures.js";
import {
  LISTEN_AND_REPEAT_ITEM_TARGET_WPM,
  type ListeningModule,
  type ListeningSet,
} from "@toefl-prep/shared";
import {
  ABSOLUTE_DURATION_TOLERANCE_SEC,
  assessPace,
  SANITY_MAX_DURATION_RATIO,
  SANITY_MIN_DURATION_RATIO,
  targetDurationSec,
  type PaceAssessment,
  type PaceBand,
} from "../src/services/audioPace.js";
import {
  buildRenderPlan,
  LISTENING_ROLE_POLICY,
  renderListeningAudio,
  spokenWordCount,
  type ListeningAudioRole,
} from "../src/services/listeningAudioRenderer.js";
import {
  AUDIO_ROLE_POLICY,
  buildSpeakingRenderPlan,
  renderSpeakingAudio,
} from "../src/services/speakingAudioRenderer.js";
import { profileForSetId } from "../src/services/speakingAudioProfile.js";
import { config } from "../src/lib/config.js";
import type { ClipMeasurementInsert } from "../src/db/rows.js";
import { collectClipTakes } from "./helpers/clipMeasurementSink.js";
import {
  resetClipMeasurementSink,
  setClipMeasurementSink,
} from "../src/services/clipMeasurementLog.js";
import { LISTENING_FIXTURE } from "./fixtures/listening-set.fixture.js";

// Listening's and Speaking's pace gates are one decision.
//
// Nothing in this file says the two sections' role tables must match. They legitimately differ (a
// Listen and Choose a Response utterance and a Listen and Repeat item are not the same speech act)
// and must stay free to. What this file pins is that the function turning (wordCount, durationSec,
// band) into a verdict is one function, `assessPace` in audioPace.ts, reached by both renderers and
// reimplemented by neither. Retuning LISTENING_ROLE_POLICY or AUDIO_ROLE_POLICY fails nothing here.
// Two renderers that each hold a copy of a pace threshold, a retry rule or a take-selection rule
// drift apart one tuning at a time; this file keeps them on one copy.

// Follows the shape of `generator.listening.test.ts`'s "listeningGenerator.ts constructs Errors in
// exactly one place" guard, including its exclusion of comment lines: both renderers discuss these
// symbols at length in prose, and those mentions are the explanation, not a definition.
type SourceFile = { label: string; relativePath: string };

function discoverTypescriptSources(relativeDirectory: string): SourceFile[] {
  const discovered: SourceFile[] = [];
  const visit = (relativePath: string): void => {
    const absolutePath = path.join(config.projectRoot, relativePath);
    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
      const child = path.posix.join(relativePath, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        discovered.push({ label: child, relativePath: child });
      }
    }
  };
  visit(relativeDirectory);
  return discovered.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

// Scan every service and script recursively. `audioPace.ts` is the one sanctioned owner and is
// excluded; any future service or nested helper that names a copied pace primitive is covered
// without adding its filename here. Renderer-specific import/call assertions are derived from the
// same discovery set rather than a second hand-maintained list.
const SERVICE_SOURCES = discoverTypescriptSources("server/src/services").filter(
  (source) => source.relativePath !== "server/src/services/audioPace.ts",
);
const SCRIPT_SOURCES = discoverTypescriptSources("scripts");
const PACE_DECISION_SOURCES = [...SERVICE_SOURCES, ...SCRIPT_SOURCES];
const RENDERER_SOURCES = SERVICE_SOURCES.filter((source) => source.relativePath.endsWith("AudioRenderer.ts"));

// Everything audioPace.ts owns: the first four are constants, the rest functions. A second copy of
// any of them in another file is how two sections' pace decisions drift apart.
const AUDIO_PACE_SYMBOLS: readonly string[] = [
  "SANITY_MIN_DURATION_RATIO",
  "SANITY_MAX_DURATION_RATIO",
  "ABSOLUTE_DURATION_TOLERANCE_SEC",
  "FAR_BELOW_BAND_WPM",
  "countEnglishWords",
  "inBand",
  "wordsPerMinute",
  "targetDurationSec",
  "assessPace",
  "farBelowBand",
  "paceWarning",
];

// The subset a renderer calls itself. Neither renderer calls `assessPace`: both drive
// `renderClipWithPaceCorrection` (audioPaceCorrection.ts), which calls it for every take and owns the
// correction loop, so the two sections share the take-selection rule as well as the predicate. The
// sanity ratios, the absolute-duration tolerance, `inBand`, `wordsPerMinute` and `targetDurationSec`
// reach a renderer only through the PaceAssessment that `assessPace` returns, so requiring an import
// of them would force an unused one. The cases below pin the chain: each renderer reaches pace through
// the shared loop, and the loop reaches it through assessPace. Redefining any symbol on the list above
// stays forbidden in every file, renderers included.
const AUDIO_PACE_SYMBOLS_BOTH_RENDERERS_CALL: readonly string[] = [
  "countEnglishWords",
  "paceWarning",
];

const PACE_CORRECTION_RELATIVE_PATH = "server/src/services/audioPaceCorrection.ts";

function nonCommentLines(source: string): string[] {
  return source.split("\n").filter((line) => {
    const trimmed = line.trimStart();
    return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
  });
}

function rendererCode(relativePath: string): string {
  return nonCommentLines(fs.readFileSync(path.join(config.projectRoot, relativePath), "utf8")).join("\n");
}

/**
 * Every comparison (`<`, `<=`, `>`, `>=`) in `code` with a band edge (`minWpm` or `maxWpm`) on either
 * side, read directly, through destructuring, or through a local alias of either. Each is a per-clip
 * band decision made outside assessPace.
 */
function bandEdgeComparisons(code: string): string[] {
  const source = ts.createSourceFile("pace-source.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = new Set<string>();
  const isEdgeProperty = (node: ts.Node): boolean => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text === "minWpm" || node.name.text === "maxWpm";
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      const key = node.argumentExpression.text;
      return key === "minWpm" || key === "maxWpm";
    }
    return false;
  };
  const unwrap = (node: ts.Expression): ts.Expression => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      return unwrap(node.expression);
    }
    if (ts.isNonNullExpression(node)) return unwrap(node.expression);
    return node;
  };
  const isBandEdge = (expression: ts.Expression): boolean => {
    const node = unwrap(expression);
    return isEdgeProperty(node) || (ts.isIdentifier(node) && aliases.has(node.text));
  };
  const recordAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const property = element.propertyName?.getText(source) ?? element.name.getText(source);
          if ((property === "minWpm" || property === "maxWpm") && ts.isIdentifier(element.name)) {
            aliases.add(element.name.text);
          }
        }
      } else if (ts.isIdentifier(node.name) && isBandEdge(node.initializer)) {
        aliases.add(node.name.text);
      }
    }
    ts.forEachChild(node, recordAliases);
  };
  // Repeat once so `const floor = minWpmAlias` resolves even when declarations are not adjacent.
  recordAliases(source);
  recordAliases(source);

  const found: string[] = [];
  const comparisonOperators = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.GreaterThanEqualsToken,
  ]);
  const inspect = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      comparisonOperators.has(node.operatorToken.kind) &&
      (isBandEdge(node.left) || isBandEdge(node.right))
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      found.push(code.split("\n")[line]!.trim());
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return found;
}

/** `function foo(`, `const foo =`, `let foo =`, `var foo =` — a DEFINITION, never a call or a type. */
function definitionPattern(symbol: string): RegExp {
  return new RegExp(String.raw`(?:^|\s)(?:export\s+)?(?:async\s+function|function|const|let|var)\s+${symbol}\b`, "m");
}

describe("nothing that decides a clip's pace defines its own copy of what audioPace.ts owns", () => {
  it("actually found the scripts to scan", () => {
    // A readdir that silently returned nothing would make every case below vacuous.
    expect(SCRIPT_SOURCES.length).toBeGreaterThan(5);
    expect(SCRIPT_SOURCES.map((source) => source.label)).toContain("scripts/audit-speaking-audio.ts");
  });

  it("discovers nested scripts and service sources recursively instead of maintaining filename lists", () => {
    expect(PACE_DECISION_SOURCES.map((source) => source.label)).toContain("scripts/lib/scoringJob.ts");
    expect(PACE_DECISION_SOURCES.map((source) => source.label)).toContain(
      "server/src/services/speakingAudioAudit.ts",
    );
  });

  it("audit-speaking-audio.ts uses the speech prober, not the file prober", () => {
    const code = rendererCode("scripts/audit-speaking-audio.ts");
    // Must import probeSpeechDurationSec (bands are stated in speech rate, not file duration).
    expect(code).toContain("probeSpeechDurationSec");
    // Must NOT import probeDurationSec as a live value for the speech assessment.
    const importLine = /import\s*{\s*([^}]*?)\s*}\s*from\s*".*transcode\.js"/.exec(code);
    expect(importLine, "must import from transcode.js").not.toBeNull();
    const imported = importLine![1]!.split(",").map((entry) => entry.trim());
    expect(imported, "must import probeSpeechDurationSec, not probeDurationSec").toContain("probeSpeechDurationSec");
    expect(imported, "must NOT import probeDurationSec").not.toContain("probeDurationSec");
  });

  it.each([
    [
      "direct property comparison",
      "if (wpm < policy.minWpm || wpm > policy.maxWpm) return false;",
    ],
    [
      "renamed destructuring comparison",
      "const { minWpm: floor, maxWpm: ceiling } = policy;\nif (wpm < floor || wpm > ceiling) return false;",
    ],
    [
      "local alias of an edge",
      "const floor = policy.minWpm;\nconst lowest = floor;\nif (wpm < lowest) return false;",
    ],
  ])("rejects an actual per-clip band decision through %s", (_name, source) => {
    expect(bandEdgeComparisons(source)).not.toEqual([]);
  });

  it.each([
    ["policy definition", "const policy = { targetWpm: 160, minWpm: 150, maxWpm: 170 };"],
    ["harmless record copy", "const record = { floor: policy.minWpm, ceiling: policy.maxWpm };"],
  ])("accepts %s because it makes no per-clip decision", (_name, source) => {
    expect(bandEdgeComparisons(source)).toEqual([]);
  });

  for (const { label, relativePath } of PACE_DECISION_SOURCES) {
    describe(label, () => {
      const code = rendererCode(relativePath);

      it.each(AUDIO_PACE_SYMBOLS)("does not define `%s` locally", (symbol) => {
        const match = definitionPattern(symbol).exec(code);
        expect(
          match?.[0]?.trim() ?? null,
          `${label} defines \`${symbol}\` locally. audioPace.ts owns it — import it from audioPace.ts instead of redefining it here. Two copies of a pace threshold stay identical only until one of them is tuned.`,
        ).toBeNull();
      });

      if (relativePath !== PACE_CORRECTION_RELATIVE_PATH) {
        it("compares no per-clip band edge of its own — the pass/fail decision is assessPace's", () => {
          expect(
            bandEdgeComparisons(code),
            `${label} compares a per-clip band's minWpm/maxWpm itself instead of reading the verdict off assessPace. An open-coded band check skips ABSOLUTE_DURATION_TOLERANCE_SEC, so a clip the renderer published with pass:true reads as a failure here. Call assessPace and use \`withinTolerance\`/\`inBand\`.`,
          ).toEqual([]);
        });
      }
    });
  }

  for (const { label, relativePath } of RENDERER_SOURCES) {
    describe(label, () => {
      const code = rendererCode(relativePath);

      it.each(AUDIO_PACE_SYMBOLS_BOTH_RENDERERS_CALL)(
        "imports `%s` from audioPace.js and actually calls it — a guard that only forbids redefinition passes trivially if a renderer stops using pace logic at all",
        (symbol) => {
          const importStatement = /import\s*{([^}]*)}\s*from\s*"\.\/audioPace\.js"/.exec(code);
          expect(importStatement, `${label} must import from "./audioPace.js"`).not.toBeNull();
          const imported = importStatement![1]!.split(",").map((entry) => entry.trim().replace(/^type\s+/, ""));
          expect(
            imported,
            `${label} must import \`${symbol}\` from audioPace.ts rather than reaching its verdict some other way.`,
          ).toContain(symbol);
          const calls = code.split(`${symbol}(`).length - 1;
          expect(calls, `${label} imports \`${symbol}\` but never calls it`).toBeGreaterThan(0);
        },
      );

      it("reaches its pace verdict through the shared correction loop, not one of its own", () => {
        expect(
          /from\s*"\.\/audioPaceCorrection\.js"/.test(code),
          `${label} must drive renderClipWithPaceCorrection from audioPaceCorrection.ts. A renderer that synthesizes and assesses on its own again is a second copy of the retry policy, which is precisely how the two sections came to keep different takes.`,
        ).toBe(true);
        expect(code.split("renderClipWithPaceCorrection(").length - 1).toBeGreaterThan(0);
      });
    });
  }

  describe("audioPaceCorrection.ts", () => {
    const code = rendererCode(PACE_CORRECTION_RELATIVE_PATH);

    it("is the module that actually calls assessPace, on behalf of both renderers", () => {
      const importStatement = /import\s*{([^}]*)}\s*from\s*"\.\/audioPace\.js"/.exec(code);
      expect(importStatement, "audioPaceCorrection.ts must import from \"./audioPace.js\"").not.toBeNull();
      expect(
        importStatement![1]!.split(",").map((entry) => entry.trim().replace(/^type\s+/, "")),
      ).toContain("assessPace");
      expect(code.split("assessPace(").length - 1).toBeGreaterThan(0);
    });

    it("defines no pace symbol and limits band comparisons to correction direction and take ranking", () => {
      for (const symbol of AUDIO_PACE_SYMBOLS) {
        expect(definitionPattern(symbol).exec(code)?.[0]?.trim() ?? null, symbol).toBeNull();
      }
      // Band edges are compared here on exactly three lines, and none is a pass/fail decision, which
      // comes from assessPace alone. Pinned as the exact lines rather than a count, so a fourth has
      // to be read and justified:
      //   1. paceDirectionFor asks which way to nudge a clip already judged out of band.
      //   2/3. bandDistance measures how far outside the band each take is, to break a tie between
      //        two takes whose verdicts agree: an ordering, not a second pass/fail decision.
      // Take selection compares the two verdicts first and reaches these lines only on a tie.
      // Re-deriving a verdict from `band.minWpm`/`band.maxWpm` here would skip
      // ABSOLUTE_DURATION_TOLERANCE_SEC, which is what this case forbids. paceNote also copies both
      // edges into its advisory record; the detector reports comparisons, not property reads, so a
      // plain record copy passes.
      expect([...new Set(bandEdgeComparisons(code))]).toEqual([
        "return assessment.wpm > band.maxWpm ? \"slower\" : \"faster\";",
        "if (assessment.wpm < band.minWpm) return band.minWpm - assessment.wpm;",
        "if (assessment.wpm > band.maxWpm) return assessment.wpm - band.maxWpm;",
      ]);
    });
  });
});

// Behavioural parity, driven through the two real renderers over the shipping policies.
//
// Asserting `assessPace(x) === assessPace(x)` would be vacuous. What matters is that each renderer's
// observable pace behaviour is exactly what `assessPace` says for the same (wordCount, durationSec,
// band), so the two renderers agree wherever the numbers coincide, and a renderer that reintroduced a
// threshold of its own would part company with the shared function and fail here.
//
// All four fields are observable from outside a renderer, in both sections:
//   withinSanity    - the render throws a malfunction iff this is false
//   verdict         - throw / one paceWarning on stderr / silence
//   withinTolerance - the `pass` field of the renderer's own single-line clip log
//   inBand          - the `inBand` column each renderer writes to clip_measurements
//
// The duration grid per role is the band's own edges and tolerances plus every WPM value either
// shipping policy names, so both sections are driven with the same numbers as well as their own.

type Observed = Pick<PaceAssessment, "verdict" | "inBand" | "withinTolerance" | "withinSanity">;

let dirs: string[] = [];
afterEach(() => {
  dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  dirs = [];
  resetClipMeasurementSink();
});
const tmpDir = (prefix: string): string => {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(result);
  return result;
};

// Every WPM either policy names. Applied to every role in both sections, so the sweep is the same
// numbers on both sides and not two disjoint sets of band-relative points.
const SHARED_WPM_GRID: readonly number[] = [
  ...new Set(
    [...Object.values(LISTENING_ROLE_POLICY), ...Object.values(AUDIO_ROLE_POLICY)].flatMap((band) => [
      band.minWpm,
      band.targetWpm,
      band.maxWpm,
    ]),
  ),
].sort((a, b) => a - b);

/**
 * The per-role duration sweep: on target, both band edges, just outside each edge, just inside and
 * just outside the absolute-duration tolerance, and either side of both sanity ratios, plus the
 * shared WPM grid above.
 *
 * "Just outside the slow edge" is a longer duration and "just outside the fast edge" a shorter one:
 * a WPM band is a duration window, inverted.
 */
function probeDurations(wordCount: number, band: PaceBand): number[] {
  const target = targetDurationSec(wordCount, band);
  const at = (wpm: number): number => (wordCount / wpm) * 60;
  const durations = [
    target,
    at(band.minWpm),
    at(band.maxWpm),
    at(band.minWpm) + 0.02,
    at(band.maxWpm) - 0.02,
    target + ABSOLUTE_DURATION_TOLERANCE_SEC - 0.01,
    target - ABSOLUTE_DURATION_TOLERANCE_SEC + 0.01,
    target + ABSOLUTE_DURATION_TOLERANCE_SEC + 0.01,
    target - ABSOLUTE_DURATION_TOLERANCE_SEC - 0.01,
    target * SANITY_MIN_DURATION_RATIO + 0.01,
    target * SANITY_MIN_DURATION_RATIO - 0.01,
    target * SANITY_MAX_DURATION_RATIO - 0.01,
    target * SANITY_MAX_DURATION_RATIO + 0.01,
    ...SHARED_WPM_GRID.map(at),
  ];
  return [...new Set(durations.filter((duration) => duration > 0))];
}

/** Reads the `pass` field back out of a renderer's own single-line clip log. */
function passFlagOf(logLine: string, role: string): boolean | undefined {
  const json = logLine.slice(logLine.indexOf("{"));
  const parsed = JSON.parse(json) as { role: string; pass: boolean };
  return parsed.role === role ? parsed.pass : undefined;
}

async function observe(role: string, run: () => Promise<void>): Promise<Observed> {
  const logs: string[] = [];
  const warns: string[] = [];
  const collected = collectClipTakes();
  const rows: ClipMeasurementInsert[] = collected.rows;
  setClipMeasurementSink(collected.sink);
  const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => logs.push(line));
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((line: string) => warns.push(line));
  let failure: Error | undefined;
  try {
    await run();
  } catch (error) {
    failure = error as Error;
  } finally {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    resetClipMeasurementSink();
  }

  // The one hard failure a renderer can have here is assessPace's "malfunction", in both sections.
  // Anything else throwing would make every field below a lie, so it is rethrown rather than
  // swallowed. That includes the Listen and Repeat clip ceiling: its tier in generationCheckPolicy
  // is repair-then-accept, so a breach warns and publishes with a note instead of throwing.
  const malfunctioned = failure !== undefined && /wildly outside its plausible duration/.test(failure.message);
  if (failure && !malfunctioned) throw failure;

  const row = rows.find((candidate) => candidate.role === role);
  expect(row, `expected a clip_measurements row for role ${role}`).toBeDefined();
  const pass = logs.map((line) => passFlagOf(line, role)).find((value) => value !== undefined);
  expect(pass, `expected a clip log line for role ${role}`).toBeDefined();
  const warned = warns.filter((line) => line.includes(`role=${role} `)).length;
  expect(warned, `at most one pace warning per clip, for role ${role}`).toBeLessThanOrEqual(1);

  // An out-of-band verdict is read off the pace warning, which names the role. A slow `lr-item` clip
  // past the clip ceiling also gets the ceiling's own warning, but that one names only the file, so
  // it is not counted as a second pace warning.
  return {
    verdict: malfunctioned ? "malfunction" : warned > 0 ? "out-of-band" : "in-band",
    inBand: row!.inBand,
    withinTolerance: pass!,
    withinSanity: !malfunctioned,
  };
}

const EMPTY_MODULE: ListeningModule = {
  timeLimitSec: 300,
  listenChoose: [],
  conversations: [],
  announcements: [],
  academicTalks: [],
};

/** A Set carrying exactly one Stimulus, of the given role, so a probe drives exactly one clip. */
function listeningSetForRole(role: ListeningAudioRole, setId: string): ListeningSet {
  const fixture = JSON.parse(JSON.stringify(LISTENING_FIXTURE)) as ListeningSet;
  const router: ListeningModule = {
    ...EMPTY_MODULE,
    ...(role === "lcr-utterance" ? { listenChoose: fixture.router.listenChoose } : {}),
    ...(role === "conversation" ? { conversations: fixture.router.conversations } : {}),
    ...(role === "announcement" ? { announcements: fixture.router.announcements } : {}),
    ...(role === "academic-talk" ? { academicTalks: fixture.router.academicTalks } : {}),
  };
  return { ...fixture, id: setId, router, lowerModule: { ...EMPTY_MODULE }, upperModule: { ...EMPTY_MODULE } };
}

/** The word count the Listening renderer itself will use: speaker labels excluded for a Conversation. */
function listeningWordCount(role: ListeningAudioRole): number {
  const clip = buildRenderPlan(listeningSetForRole(role, "lsn-wordcount"))[0]!;
  return spokenWordCount(clip.text, clip.speakers);
}

async function observeListening(
  role: ListeningAudioRole,
  durationSec: number,
  dataDir: string,
  probeIndex: number,
): Promise<Observed> {
  const set = listeningSetForRole(role, `lsn-${probeIndex}`);
  return observe(role, async () => {
    await renderListeningAudio(set, {
      synthesize: async (_request, outPath) => fs.writeFileSync(outPath, "audio"),
      probeDuration: async () => durationSec,
      dataDir,
    });
  });
}

type SpeakingRole = keyof typeof AUDIO_ROLE_POLICY;

// Word counts of placeholderSpeakingSet, per role: briefing 5, each lr-item 7, intro 6, question 8.
const SPEAKING_WORD_COUNT: Readonly<Record<SpeakingRole, number>> = {
  "lr-briefing": 5, "lr-item": 7, "interview-intro": 6, "interview-question": 8,
};
// Speaking renders all thirteen clips in one call, so a probe targets the first clip of its role and
// leaves the other twelve on their own targets (briefing 166.7 WPM, intro 163.6, questions 154.8, and
// each Listen and Repeat item on its own per-item target), every one inside its band, so no other
// clip can warn or throw.
const SPEAKING_PROBE_INDEX: Readonly<Record<SpeakingRole, number>> = {
  "lr-briefing": 0, "lr-item": 1, "interview-intro": 8, "interview-question": 9,
};
const SPEAKING_GOOD_DURATIONS = [
  1.8,
  ...LISTEN_AND_REPEAT_ITEM_TARGET_WPM.map((targetWpm) => Number(((7 / targetWpm) * 60).toFixed(3))),
  2.2,
  ...Array(4).fill(3.1),
];

/**
 * The band the Speaking renderer itself will use for the clip this sweep probes.
 *
 * `role` alone does not answer that for a Listen and Repeat item: the seven items carry seven
 * targets, and the probe drives lr-1. Taken off the real render plan rather than restated, so the
 * sweep measures the renderer's own choice and not a second opinion about it.
 */
function speakingBand(role: SpeakingRole): PaceBand {
  const clip = buildSpeakingRenderPlan(placeholderSpeakingSet(), profileForSetId("spk-001"))[
    SPEAKING_PROBE_INDEX[role]
  ];
  expect(clip.role, `probe index for ${role} points at the wrong clip`).toBe(role);
  return clip.band;
}

async function observeSpeaking(
  role: SpeakingRole,
  durationSec: number,
  parentDir: string,
  probeIndex: number,
): Promise<Observed> {
  const durations = SPEAKING_GOOD_DURATIONS.map((good, index) =>
    index === SPEAKING_PROBE_INDEX[role] ? durationSec : good,
  );
  // Keyed by the clip being probed, not by call count. An out-of-band clip buys a corrective
  // re-render and is measured twice, so a call-indexed stub would hand every later clip its
  // predecessor's duration. Keyed on the file, a retake of the same clip measures the same, and the
  // observable verdict is exactly assessPace's however many takes the renderer buys.
  const byFile = new Map(
    [
      "briefing.mp3",
      ...Array.from({ length: 7 }, (_, i) => `lr-${i + 1}.mp3`),
      "int-intro.mp3",
      ...Array.from({ length: 4 }, (_, i) => `q-${i + 1}.mp3`),
    ].map((file, index) => [file, durations[index]!] as const),
  );
  const outputDir = path.join(parentDir, `probe-${probeIndex}`);
  return observe(role, async () => {
    await renderSpeakingAudio(
      placeholderSpeakingSet(),
      { setId: "spk-001", outputDir, audioPathPrefix: "stimuli/spk-001" },
      {
        synthesize: async (_request, outPath) => fs.writeFileSync(outPath, "audio"),
        probeDuration: async (filePath) => {
          // ".<file>.tmp" and ".<file>.retake.tmp" both belong to the same clip.
          const clipFile = path.basename(filePath).replace(/^\./u, "").replace(/(?:\.retake)?\.tmp$/u, "");
          const duration = byFile.get(clipFile);
          expect(duration, `unexpected probe of ${filePath}`).toBeDefined();
          return duration!;
        },
      },
    );
  });
}

/** Every state the sweep must actually reach, so a grid that quietly stopped exercising one fails. */
type Coverage = { inBandByBand: number; inBandByFloorOnly: number; outOfBand: number; malfunction: number };

function tally(coverage: Coverage, observed: Observed): void {
  if (observed.verdict === "malfunction") coverage.malfunction += 1;
  else if (observed.verdict === "out-of-band") coverage.outOfBand += 1;
  else if (observed.inBand) coverage.inBandByBand += 1;
  else coverage.inBandByFloorOnly += 1;
}

function expectFullyExercised(coverage: Coverage, section: string): void {
  expect(coverage.inBandByBand, `${section}: sweep never reached an in-band clip`).toBeGreaterThan(0);
  expect(
    coverage.inBandByFloorOnly,
    `${section}: sweep never reached a clip rescued by ABSOLUTE_DURATION_TOLERANCE_SEC alone (outside the WPM band, inside the absolute floor), where an open-coded band check would discard a paid render the renderer accepted`,
  ).toBeGreaterThan(0);
  expect(coverage.outOfBand, `${section}: sweep never reached an out-of-band clip`).toBeGreaterThan(0);
  expect(coverage.malfunction, `${section}: sweep never reached a malfunction`).toBeGreaterThan(0);
}

describe("both renderers reach their pace verdict through the one decision function (assessPace)", () => {
  const listeningCoverage: Coverage = { inBandByBand: 0, inBandByFloorOnly: 0, outOfBand: 0, malfunction: 0 };
  const speakingCoverage: Coverage = { inBandByBand: 0, inBandByFloorOnly: 0, outOfBand: 0, malfunction: 0 };

  it.each(Object.keys(LISTENING_ROLE_POLICY) as ListeningAudioRole[])(
    "listening role `%s`: verdict/inBand/withinTolerance/withinSanity match assessPace at every duration in the sweep",
    async (role) => {
      const band = LISTENING_ROLE_POLICY[role];
      const wordCount = listeningWordCount(role);
      const dataDir = tmpDir(`pace-parity-listening-${role}-`);
      const durations = probeDurations(wordCount, band);
      for (const [index, durationSec] of durations.entries()) {
        const expected = assessPace({ wordCount, durationSec, band });
        const observed = await observeListening(role, durationSec, dataDir, index);
        expect(observed, `listening ${role} at ${durationSec.toFixed(3)}s / ${wordCount} words`).toEqual({
          verdict: expected.verdict,
          inBand: expected.inBand,
          withinTolerance: expected.withinTolerance,
          withinSanity: expected.withinSanity,
        });
        tally(listeningCoverage, observed);
      }
      expect(durations.length).toBeGreaterThan(10);
    },
    30_000,
  );

  it.each(Object.keys(AUDIO_ROLE_POLICY) as SpeakingRole[])(
    "speaking role `%s`: verdict/inBand/withinTolerance/withinSanity match assessPace at every duration in the sweep",
    async (role) => {
      const band = speakingBand(role);
      const wordCount = SPEAKING_WORD_COUNT[role];
      const parentDir = tmpDir(`pace-parity-speaking-${role}-`);
      const durations = probeDurations(wordCount, band);
      for (const [index, durationSec] of durations.entries()) {
        const expected = assessPace({ wordCount, durationSec, band });
        const observed = await observeSpeaking(role, durationSec, parentDir, index);
        expect(observed, `speaking ${role} at ${durationSec.toFixed(3)}s / ${wordCount} words`).toEqual({
          verdict: expected.verdict,
          inBand: expected.inBand,
          withinTolerance: expected.withinTolerance,
          withinSanity: expected.withinSanity,
        });
        tally(speakingCoverage, observed);
      }
      expect(durations.length).toBeGreaterThan(10);
    },
    30_000,
  );

  // Runs last (vitest executes `it`s in declaration order within a describe). Without this the two
  // sweeps above could degrade into "every clip is in band" and still pass.
  it("the sweep above actually reached in-band, floor-rescued, out-of-band and malfunction in BOTH sections", () => {
    expectFullyExercised(listeningCoverage, "listening");
    expectFullyExercised(speakingCoverage, "speaking");
  });

  // The word counts and the roles are real, so the two policies cannot silently shrink to nothing.
  it("covers every role in both shipping policies", () => {
    expect(Object.keys(LISTENING_ROLE_POLICY)).toHaveLength(4);
    expect(Object.keys(AUDIO_ROLE_POLICY)).toHaveLength(4);
    expect(SHARED_WPM_GRID.length).toBeGreaterThanOrEqual(10);
  });
});

/**
 * Which take shipped, end to end, in both sections. Each case buys a corrective re-render that comes
 * back worse, so the better first take publishes and the newer one is deleted. The newest
 * clip_measurements row then describes audio that is not on disk, so the recorded rows and the
 * manifest must each mark the published take.
 */
describe("both renderers record which take shipped", () => {
  type Settled = { file: string; correctionCount: number; durationSec: number; takeDisposition: string | undefined };

  /** The two takes of the probed clip, plus what the manifest that travels with the audio says. */
  function assertPublishedTakeIsTheFirst(
    settled: Settled[],
    file: string,
    manifest: { takes: { file: string; correctionCount: number; disposition: string }[] },
    publishedDurationSec: number,
  ): void {
    const clipRows = settled.filter((row) => row.file === file);
    expect(clipRows.map((row) => row.correctionCount)).toEqual([0, 1]);

    const published = clipRows.filter((row) => row.takeDisposition === "published");
    expect(published).toHaveLength(1);
    // The shipped take is identifiable from the recorded rows alone, and it is the first one: neither
    // the newest row nor max(correction_count).
    expect(published[0]!.correctionCount).toBe(0);
    expect(published[0]!.durationSec).toBe(publishedDurationSec);
    expect(clipRows.at(-1)!.takeDisposition).toBe("discarded");

    // The same answer travels in the render's own manifest, which moves with the audio between
    // checkouts where the database rows do not.
    const manifestTakes = manifest.takes.filter((take) => take.file === file);
    expect(manifestTakes.map((take) => [take.correctionCount, take.disposition])).toEqual([
      [0, "published"],
      [1, "discarded"],
    ]);
  }

  it("speaking: the better first take is the one marked published", async () => {
    const collected = collectClipTakes();
    setClipMeasurementSink(collected.sink);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const outputDir = path.join(tmpDir("speaking-published-"), "target");
    try {
      const band = speakingBand("lr-item");
      const at = (wpm: number): number => (SPEAKING_WORD_COUNT["lr-item"] / wpm) * 60;
      const probed = "lr-1.mp3";
      const result = await renderSpeakingAudio(
        placeholderSpeakingSet(),
        { setId: "spk-001", outputDir, audioPathPrefix: "stimuli/spk-001" },
        {
          synthesize: async (_request, outPath) => fs.writeFileSync(outPath, "audio"),
          probeDuration: async (filePath) => {
            const base = path.basename(filePath);
            if (!base.startsWith(`.${probed}`)) {
              return SPEAKING_GOOD_DURATIONS[
                ["briefing.mp3", ...Array.from({ length: 7 }, (_, i) => `lr-${i + 1}.mp3`), "int-intro.mp3",
                  ...Array.from({ length: 4 }, (_, i) => `q-${i + 1}.mp3`)]
                  .indexOf(base.replace(/^\./u, "").replace(/(?:\.retake)?\.tmp$/u, ""))
              ]!;
            }
            // The correction overshoots: 25 WPM further below the floor than the take it replaces.
            return base.includes(".retake.") ? at(band.minWpm - 45) : at(band.minWpm - 20);
          },
        },
      );
      const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "audio-manifest.json"), "utf8"));
      assertPublishedTakeIsTheFirst(
        collected.settled() as Settled[],
        probed,
        manifest,
        result.measurements.find((m) => m.file === probed)!.durationSec,
      );
      // The published row is the audio on disk, without opening the audio on disk.
      expect(manifest.clips.find((c: { file: string }) => c.file === probed).durationSec)
        .toBe(collected.settled().find((r) => r.file === probed)!.durationSec);
    } finally {
      resetClipMeasurementSink();
      warn.mockRestore();
      log.mockRestore();
    }
  });

  /**
   * The escalating correction is Listening's alone. The two sections share the loop and differ only
   * in the budget they hand it: Listening passes LISTENING_PACE_CORRECTION_ROUNDS, Speaking passes
   * none and keeps the default of one. A clip 40 WPM below its floor would escalate in Listening;
   * Speaking still buys it exactly one corrective take.
   */
  it("speaking buys ONE corrective take even for a clip far below its band", async () => {
    const collected = collectClipTakes();
    setClipMeasurementSink(collected.sink);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const outputDir = path.join(tmpDir("speaking-far-below-"), "target");
    const synthesized: string[] = [];
    try {
      const band = speakingBand("lr-item");
      const at = (wpm: number): number => (SPEAKING_WORD_COUNT["lr-item"] / wpm) * 60;
      const files = ["briefing.mp3", ...Array.from({ length: 7 }, (_, i) => `lr-${i + 1}.mp3`), "int-intro.mp3",
        ...Array.from({ length: 4 }, (_, i) => `q-${i + 1}.mp3`)];
      await renderSpeakingAudio(
        placeholderSpeakingSet(),
        { setId: "spk-001", outputDir, audioPathPrefix: "stimuli/spk-001" },
        {
          synthesize: async (_request, outPath) => {
            synthesized.push(path.basename(outPath));
            fs.writeFileSync(outPath, "audio");
          },
          probeDuration: async (filePath) => {
            const base = path.basename(filePath);
            if (!base.startsWith(".lr-1.mp3")) {
              return SPEAKING_GOOD_DURATIONS[files.indexOf(base.replace(/^\./u, "").replace(/(?:\.retake)?\.tmp$/u, ""))]!;
            }
            return at(band.minWpm - 40);
          },
        },
      );
      expect(synthesized.filter((file) => file.startsWith(".lr-1.mp3"))).toEqual([
        ".lr-1.mp3.tmp",
        ".lr-1.mp3.retake.tmp",
      ]);
    } finally {
      resetClipMeasurementSink();
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("listening: the better first take is the one marked published", async () => {
    const collected = collectClipTakes();
    setClipMeasurementSink(collected.sink);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dataDir = tmpDir("listening-published-");
    try {
      const band = LISTENING_ROLE_POLICY["lcr-utterance"];
      const at = (wpm: number): number => (listeningWordCount("lcr-utterance") / wpm) * 60;
      const set = listeningSetForRole("lcr-utterance", "lsn-published");
      // The first take sits 10 WPM below the floor, within FAR_BELOW_BAND_WPM, so Listening buys
      // exactly one corrective round. A miss beyond that threshold would escalate into a four-take
      // render, and this case is about which of two takes shipped. The retake, 45 WPM under the
      // floor, is the worse of the two.
      await renderListeningAudio(set, {
        synthesize: async (_request, outPath) => fs.writeFileSync(outPath, "audio"),
        probeDuration: async (filePath) =>
          path.basename(filePath).includes(".retake.") ? at(band.minWpm - 45) : at(band.minWpm - 10),
        dataDir,
      });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(dataDir, "audio/stimuli/lsn-published/audio-manifest.json"), "utf8"),
      );
      const file = collected.rows[0]!.file;
      assertPublishedTakeIsTheFirst(
        collected.settled() as Settled[],
        file,
        manifest,
        manifest.clips.find((c: { file: string }) => c.file === file).durationSec,
      );
    } finally {
      resetClipMeasurementSink();
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
