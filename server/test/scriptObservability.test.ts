import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/lib/config.js";

// The CLI generation scripts install the observability sinks the server installs.
//
// This is a source-text guard rather than a behavioural test: `scripts/generate-set.ts` and
// `scripts/import-set.ts` are top-level-await entry points, and importing either from a test would
// parse argv, open the real database and start a paid generation run. What can be pinned is the
// composition: both scripts install both sinks, with the same expressions `server/src/index.ts`
// uses, before they call into the generator. Without that, a Set generated from the CLI writes no
// `clip_measurements` rows and no model-call diagnostics (ADR 0004), because both recorders are
// no-ops until a sink is installed (modelCallLog.ts, clipMeasurementLog.ts).
//
// Comment lines are excluded, as in `generator.listening.test.ts`'s "constructs Errors in exactly
// one place" guard: both scripts explain this wiring in prose, and those mentions are not a second
// installation site.
//
// index.ts skips its database wiring when NODE_ENV is "test", because test files import it and an
// unguarded `openDb()` there would give every test worker a second write handle to the real
// database. Nothing imports the scripts, so they carry no such guard: it would only disable the
// wiring for anyone whose shell exports NODE_ENV=test.

const scriptSource = (relativePath: string): string =>
  fs.readFileSync(path.join(config.projectRoot, relativePath), "utf8");

const nonCommentLines = (source: string): string[] =>
  source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    });

const codeOf = (relativePath: string): string => nonCommentLines(scriptSource(relativePath)).join("\n");

// The two installations, read from the composition root itself rather than restated here, so "the
// same composition the server uses" is checked against index.ts as it stands.
const SERVER_SINK_INSTALLS = (() => {
  const server = codeOf("server/src/index.ts");
  const found = [
    /setModelCallSink\(createRepoModelCallSink\([\w.]+\)\)/.exec(server)?.[0],
    /setClipMeasurementSink\(createRepoClipMeasurementSink\([\w.]+\)\)/.exec(server)?.[0],
  ];
  // A plain throw, not an expect: this runs at collection time, where an expect() has no test to
  // attribute a failure to. If index.ts stops installing either sink, that is this file's premise
  // gone, and a collection error naming it is the honest report.
  if (!found.every((call) => call !== undefined)) {
    throw new Error("server/src/index.ts does not install both observability sinks, which is the premise of this guard");
  }
  // Returned and used verbatim: the assertions below are `toContain(install)`, so each script must
  // install its sink with the same source text index.ts does, character for character, argument
  // included (`stores.diagnostics`, `stores.clipMeasurements`). A rename on any of the three call
  // sites fails this suite until the others follow, which is intended: a script that hands a sink a
  // differently named store is the drift this file exists to catch.
  return found;
})();

describe("the CLI generation scripts record what a generation run measures", () => {
  const scripts: ReadonlyArray<{ file: string; entryPoint: string }> = [
    // generateSet renders Speaking and Listening audio, so a CLI run makes both model calls and TTS
    // clip measurements.
    { file: "scripts/generate-set.ts", entryPoint: "generateSet(" },
    // importSet's own model call writes diagnostics, and a Speaking import goes on to render
    // thirteen clips through the same renderer generation does.
    { file: "scripts/import-set.ts", entryPoint: "importSet(" },
  ];

  for (const { file, entryPoint } of scripts) {
    describe(file, () => {
      const code = codeOf(file);

      it.each(SERVER_SINK_INSTALLS)("installs `%s`, exactly as server/src/index.ts does", (install) => {
        expect(
          code,
          `${file} must install the observability sink with \`${install}\` — without it every CLI run silently discards the rows ADR-0004 describes as the way to debug a failed job, and the clip_measurements rows the pace record is built from.`,
        ).toContain(install);
      });

      it("opens the database exactly once, so the run holds a single write handle on it", () => {
        const opens = code.split("openDb(").length - 1;
        expect(opens, `${file} must call openDb() exactly once, not ${opens} times`).toBe(1);
      });

      it("installs both sinks BEFORE calling into the generator, so nothing the run does can slip past them", () => {
        const entryAt = code.indexOf(entryPoint);
        expect(entryAt, `${file} must still call ${entryPoint}`).toBeGreaterThan(-1);
        for (const install of SERVER_SINK_INSTALLS) {
          expect(code.indexOf(install), `${install} must appear before ${entryPoint}`).toBeGreaterThan(-1);
          expect(code.indexOf(install)).toBeLessThan(entryAt);
        }
      });

      it("validates argv before opening anything, so a usage mistake costs a usage error and not a database error", () => {
        const usageAt = code.indexOf("usage:");
        expect(usageAt, `${file} must still print a usage error`).toBeGreaterThan(-1);
        expect(usageAt).toBeLessThan(code.indexOf("openDb("));
      });
    });
  }
});
