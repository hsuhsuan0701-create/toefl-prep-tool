import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectRoot } from "../src/lib/config.js";
import { CLI_PERMISSIONS_SETTINGS } from "../src/services/claudeRunner.js";
import { composeJudgePrompt, composeSpeakingJudgePrompt } from "../src/services/judges/prompts.js";
import {
  captureSkillTaskDescriptor,
  composeCapturedCodexSkillPromptAsync,
  composeCodexSkillPrompt,
} from "../src/services/reasoning/skillContext.js";
import { OFFICIAL_REFERENCE_FILES, officialReferencePath } from "../src/services/skillReferences.js";

// The official-copy rule, proved on each of the three paths that read rubric and sample text:
//
//   * the HTTP Judges' prompts (judges/prompts.ts),
//   * the Codex Arbiter's inlined skill context (reasoning/skillContext.ts),
//   * the Claude CLI Arbiter, which reads the files itself as SKILL.md tells it to.
//
// Both states are forced here rather than read off the disk, because a checkout may or may not
// have an official copy installed: `statSync` reports exactly the official copies a test installs
// and no others, and `readFileSync` serves an installed copy's canary text.

const OFFICIAL_CANARY = "OFFICIAL-COPY-CANARY";

const toRelative = (file: unknown) => path.relative(projectRoot, String(file)).split(path.sep).join("/");

function install(installed: readonly string[]): void {
  const officialCopies = new Set(installed.map(officialReferencePath));
  const realStat = fs.statSync;
  const realRead = fs.readFileSync;
  const realReadAsync = fs.promises.readFile;
  vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, options?: fs.StatSyncOptions) => {
    const relative = toRelative(file);
    if (relative.includes("/references/official/")) {
      return officialCopies.has(relative) ? ({ isFile: () => true } as fs.Stats) : undefined;
    }
    return realStat(file, options);
  }) as typeof fs.statSync);
  const official = (file: unknown) => officialCopies.has(toRelative(file));
  vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) =>
    official(file)
      ? `${OFFICIAL_CANARY} ${toRelative(file)}\n\n### Score: 5\n\nThe installed band text.`
      : realRead(file, options as BufferEncoding)) as typeof fs.readFileSync);
  vi.spyOn(fs.promises, "readFile").mockImplementation((async (file: fs.PathLike, options?: unknown) =>
    official(file)
      ? `${OFFICIAL_CANARY} ${toRelative(file)}\n\n### Score: 5\n\nThe installed band text.`
      : realReadAsync(file, options as BufferEncoding)) as typeof fs.promises.readFile);
}

afterEach(() => vi.restoreAllMocks());

const EMAIL = ".claude/skills/toefl-writing/references/rubric-email.md";
const DISCUSSION = ".claude/skills/toefl-writing/references/rubric-academic-discussion.md";
const WRITING_SAMPLES = ".claude/skills/toefl-writing/references/samples-scored.md";
const LISTEN_REPEAT = ".claude/skills/toefl-speaking/references/rubric-listen-and-repeat.md";
const INTERVIEW = ".claude/skills/toefl-speaking/references/rubric-interview.md";

const shippedText = (relativePath: string) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
/** The first line of a shipped file's body, a phrase only that file carries. */
const shippedMarker = (relativePath: string) => shippedText(relativePath).split("\n")[0]!;

describe("HTTP Judge prompts", () => {
  it("embed the shipped rubric when no official copy is installed", () => {
    install([]);
    const email = composeJudgePrompt("email", {}, "response");
    expect(email).toContain(shippedMarker(EMAIL));
    expect(email).not.toContain(OFFICIAL_CANARY);
    const interview = composeSpeakingJudgePrompt("interview", []);
    expect(interview).toContain(shippedMarker(INTERVIEW));
    expect(interview).not.toContain(OFFICIAL_CANARY);
  });

  it("embed the official copy instead, per file, once it is installed", () => {
    install([EMAIL, LISTEN_REPEAT]);
    const email = composeJudgePrompt("email", {}, "response");
    expect(email).toContain(`${OFFICIAL_CANARY} ${officialReferencePath(EMAIL)}`);
    expect(email).not.toContain(shippedMarker(EMAIL));
    expect(composeSpeakingJudgePrompt("listen_repeat", [])).toContain(
      `${OFFICIAL_CANARY} ${officialReferencePath(LISTEN_REPEAT)}`,
    );
    // Files with no installed copy are unaffected.
    expect(composeJudgePrompt("discussion", {}, "response")).toContain(shippedMarker(DISCUSSION));
    expect(composeSpeakingJudgePrompt("interview", [])).not.toContain(OFFICIAL_CANARY);
  });

  it("pick up a copy installed after an earlier prompt, with no restart", () => {
    install([]);
    expect(composeJudgePrompt("email", {}, "response")).not.toContain(OFFICIAL_CANARY);
    vi.restoreAllMocks();
    install([EMAIL]);
    expect(composeJudgePrompt("email", {}, "response")).toContain(OFFICIAL_CANARY);
  });
});

describe("the Codex skill context", () => {
  it("inlines the shipped files under their own paths when nothing is installed", () => {
    install([]);
    const composed = composeCodexSkillPrompt({ task: "aggregate", context: "email" }, "payload");
    expect(composed).toContain(`<skill-source path="${EMAIL}">`);
    expect(composed).toContain(`<skill-source path="${WRITING_SAMPLES}">`);
    expect(composed).not.toContain("/references/official/");
  });

  it("inlines each installed official copy, labelled with the path it was read from", async () => {
    install([EMAIL, WRITING_SAMPLES]);
    for (const composed of [
      composeCodexSkillPrompt({ task: "aggregate", context: "email" }, "payload"),
      await composeCapturedCodexSkillPromptAsync(captureSkillTaskDescriptor({ task: "aggregate", context: "email" }), "payload"),
    ]) {
      expect(composed).toContain(`<skill-source path="${officialReferencePath(EMAIL)}">\n${OFFICIAL_CANARY}`);
      expect(composed).toContain(`<skill-source path="${officialReferencePath(WRITING_SAMPLES)}">\n${OFFICIAL_CANARY}`);
      expect(composed).not.toContain(`<skill-source path="${EMAIL}">`);
      // SKILL.md is never redirected: it is this project's own instructions.
      expect(composed).toContain(`<skill-source path=".claude/skills/toefl-writing/SKILL.md">`);
    }
  });
});

describe("the Claude CLI skill route", () => {
  // This route reads the files itself, so the rule lives in each skill's own instructions, and the
  // spawn's Read permissions must let it reach the official folder.
  it.each([
    [".claude/skills/toefl-writing/SKILL.md", ["rubric-email.md", "rubric-academic-discussion.md", "samples-scored.md"]],
    [".claude/skills/toefl-speaking/SKILL.md", ["rubric-listen-and-repeat.md", "rubric-interview.md", "samples-scored.md"]],
  ] as const)("%s tells the model to read references/official/<name> first, for every file it may replace", (skill, files) => {
    const text = shippedText(skill);
    expect(text).toContain("references/official/");
    for (const file of files) expect(text).toContain(file);
    expect(text).toMatch(/references\/official\/<same name>|references\/official\/\{name\}/);
  });

  function readDenied(relativePath: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => {
      const glob = /^Read\((.*)\)$/.exec(pattern)?.[1];
      if (!glob) return false;
      if (glob.endsWith("/**")) {
        const prefix = glob.slice(0, -3);
        return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
      }
      const regex = new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
      return regex.test(relativePath);
    });
  }

  it("lets the spawned CLI read every official copy, and the shipped files beside them", () => {
    const { permissions } = JSON.parse(CLI_PERMISSIONS_SETTINGS) as { permissions: { deny: string[]; allow: string[] } };
    expect(permissions.allow).toContain("Read(.claude/skills/**)");
    for (const relativePath of OFFICIAL_REFERENCE_FILES) {
      expect(readDenied(relativePath, permissions.deny), relativePath).toBe(false);
      expect(readDenied(officialReferencePath(relativePath), permissions.deny), officialReferencePath(relativePath)).toBe(false);
    }
    // The matcher does deny what it should, so a pass above is not a matcher that denies nothing.
    expect(readDenied(".env", permissions.deny)).toBe(true);
    expect(readDenied("docs/official-rubrics.md", permissions.deny)).toBe(true);
  });
});
