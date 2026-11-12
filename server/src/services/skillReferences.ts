import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../lib/config.js";

/**
 * The rubric and sample files the Writing and Speaking skills score with, and the one rule that
 * decides which copy of each is read.
 *
 * This project ships its own description of ETS's scoring criteria (ADR 0013). ETS's own wording
 * may not be redistributed, but a User may install it on their own machine: a file named in
 * OFFICIAL_REFERENCE_FILES is replaced by `references/official/<same name>` whenever that file
 * exists. The three consumers apply this rule identically — the HTTP Judge prompts
 * (judges/prompts.ts) and the Codex skill context (reasoning/skillContext.ts) resolve through
 * `resolveSkillReference`, and the skills' own SKILL.md tells the Claude CLI to read the official
 * copy first. That last consumer is a model following instructions, which cannot run a check, so
 * the rule is existence and nothing else; `checkReferenceStructure` is what `npm run rubrics:check`
 * and GET /api/setup-status use to say whether an installed copy is complete.
 *
 * Paths are project-relative with forward slashes, as SKILL.md and the skill context name them.
 */

export type ReferenceSource = "shipped" | "official";

export type RubricTaskType = "email" | "discussion" | "listen_repeat" | "interview";

/** The dimensions each Judge scores, by the exact names its report carries them under. */
export const RUBRIC_DIMENSIONS = {
  email: ["communicative goal & social conventions", "elaboration & cohesion", "grammar & vocabulary", "mechanics"],
  discussion: ["argument & engagement", "support & cohesion", "grammar & vocabulary", "mechanics"],
  listen_repeat: ["accuracy of repetition", "intelligibility"],
  interview: ["topical elaboration", "pace & pausing", "intelligibility & prosody", "grammar & vocabulary"],
} as const;

export type RubricSpec = {
  readonly taskType: RubricTaskType;
  readonly relativePath: string;
  readonly dimensions: readonly string[];
  /**
   * For each dimension, in order, wording ETS's own guide uses for it. An official copy never
   * carries this project's dimension names, so a pasted guide is recognised by these instead; each
   * set is also chosen to be absent from the other Task Type's guide in the same skill, so pasting
   * the wrong guide into a file fails the check.
   */
  readonly dimensionSignals: readonly RegExp[];
};

const LANGUAGE = /grammatic|syntactic|syntax|vocabulary|word choice|lexical/i;
const MECHANICS = /spelling|misspelling|punctuation|capitali[sz]ation|\btypos?\b/i;

const WRITING_REFS = ".claude/skills/toefl-writing/references";
const SPEAKING_REFS = ".claude/skills/toefl-speaking/references";

export const RUBRIC_SPECS: readonly RubricSpec[] = [
  {
    taskType: "email",
    relativePath: `${WRITING_REFS}/rubric-email.md`,
    dimensions: RUBRIC_DIMENSIONS.email,
    dimensionSignals: [/social convention|politeness|register/i, /elaborat/i, LANGUAGE, MECHANICS],
  },
  {
    taskType: "discussion",
    relativePath: `${WRITING_REFS}/rubric-academic-discussion.md`,
    dimensions: RUBRIC_DIMENSIONS.discussion,
    dimensionSignals: [/discussion/i, /elaborat|explanation|exemplification/i, LANGUAGE, MECHANICS],
  },
  {
    taskType: "listen_repeat",
    relativePath: `${SPEAKING_REFS}/rubric-listen-and-repeat.md`,
    dimensions: RUBRIC_DIMENSIONS.listen_repeat,
    dimensionSignals: [/repetition|repeat/i, /intelligib/i],
  },
  {
    taskType: "interview",
    relativePath: `${SPEAKING_REFS}/rubric-interview.md`,
    dimensions: RUBRIC_DIMENSIONS.interview,
    dimensionSignals: [/elaborat/i, /\bpace\b|paus/i, /intelligib|pronunciation|intonation|rhythm/i, /grammar|vocabulary/i],
  },
];

type SampleSpec = {
  readonly relativePath: string;
  /** Each Task Type the file anchors, and how a heading or line naming it reads. */
  readonly taskTypes: readonly { readonly name: string; readonly pattern: RegExp }[];
};

const SAMPLE_SPECS: readonly SampleSpec[] = [
  {
    relativePath: `${WRITING_REFS}/samples-scored.md`,
    taskTypes: [
      { name: "Write an Email", pattern: /\bemail\b/i },
      { name: "Write for an Academic Discussion", pattern: /academic discussion/i },
    ],
  },
  {
    relativePath: `${SPEAKING_REFS}/samples-scored.md`,
    taskTypes: [
      { name: "Listen and Repeat", pattern: /listen and repeat/i },
      { name: "Take an Interview", pattern: /interview/i },
    ],
  },
];

/** Every file the official-copy rule applies to, writing first, in the order a report lists them. */
export const OFFICIAL_REFERENCE_FILES: readonly string[] = [
  RUBRIC_SPECS[0].relativePath,
  RUBRIC_SPECS[1].relativePath,
  SAMPLE_SPECS[0].relativePath,
  RUBRIC_SPECS[2].relativePath,
  RUBRIC_SPECS[3].relativePath,
  SAMPLE_SPECS[1].relativePath,
];

/** Where the official copy of a shipped reference file is installed: `references/official/<name>`. */
export function officialReferencePath(relativePath: string): string {
  return path.posix.join(path.posix.dirname(relativePath), "official", path.posix.basename(relativePath));
}

export type ResolvedReference = { relativePath: string; source: ReferenceSource };

/**
 * The file to read for `relativePath`: its official copy when that is installed, otherwise the
 * path itself. Any path outside OFFICIAL_REFERENCE_FILES is returned unchanged.
 */
export function resolveSkillReference(relativePath: string, root: string = projectRoot): ResolvedReference {
  if (!OFFICIAL_REFERENCE_FILES.includes(relativePath)) return { relativePath, source: "shipped" };
  const official = officialReferencePath(relativePath);
  const installed = fs.statSync(path.join(root, official), { throwIfNoEntry: false })?.isFile() === true;
  return installed ? { relativePath: official, source: "official" } : { relativePath, source: "shipped" };
}

// The rubric files carry asides written for the skill's own Arbiter, and a Judge must never see the
// Arbiter's vocabulary: an AGGREGATE/partA/partB term in a Judge prompt invites a report shaped
// like the Arbiter's instead of an independent Judge Report. The file is split on its `## `
// headings and any whole section that mentions one of those terms is dropped. No section that holds
// score bands may mention them; checkReferenceStructure reads the text through this same filter, so
// a band that would be dropped is reported missing.
const ARBITER_VOCABULARY = /AGGREGATE|partA|partB/;

/** A reference file's text as a Judge prompt includes it. */
export function judgeVisibleText(text: string): string {
  return text
    .split(/\n(?=## )/)
    .filter((section) => !ARBITER_VOCABULARY.test(section))
    .join("\n");
}

// One heading line per band: optional markdown heading marks or bold, "Score", an optional colon,
// the digit, and nothing else on the line. That is what this project's files use and what a band
// heading pasted from ETS's guide looks like; a sentence that merely starts with "Score 5" is not a
// heading because it carries more words.
const BAND_HEADING = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*Score[ \t]*:?[ \t]*([0-5])[ \t]*[:.]?[ \t]*(?:\*\*)?[ \t]*$/i;
const SECTION_HEADING = /^[ \t]*#{1,2}[ \t]/;
const LEVELS = [5, 4, 3, 2, 1, 0] as const;
const MIN_BAND_WORDS = 3;

function bandProblems(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const headings: { level: number; line: number }[] = [];
  lines.forEach((line, index) => {
    const match = BAND_HEADING.exec(line);
    if (match) headings.push({ level: Number(match[1]), line: index });
  });
  const problems: string[] = [];
  for (const level of LEVELS) {
    const at = headings.filter((heading) => heading.level === level);
    if (at.length === 0) {
      problems.push(`no band heading for score ${level}`);
      continue;
    }
    if (at.length > 1) {
      problems.push(`score ${level} has ${at.length} band headings`);
      continue;
    }
    const start = at[0].line + 1;
    const next = headings.find((heading) => heading.line > at[0].line)?.line ?? lines.length;
    const bodyLines: string[] = [];
    for (let index = start; index < next && !SECTION_HEADING.test(lines[index]); index += 1) bodyLines.push(lines[index]);
    const words = bodyLines.join(" ").split(/\s+/).filter((word) => /[a-z]/i.test(word));
    if (words.length < MIN_BAND_WORDS) problems.push(`score ${level} has no text under its heading`);
  }
  return problems;
}

/**
 * What is missing from a reference file, as a list of plain sentences (empty when nothing is).
 *
 * A rubric must have one band per score level from 5 to 0, each with text under it, and must cover
 * every dimension: by the exact name when it is a shipped file (ours, which names them), by ETS's
 * own wording for it when it is an official copy. A sample file must anchor both of its skill's
 * Task Types. Everything is read as a Judge would see it.
 */
export function checkReferenceStructure(text: string, spec: RubricSpec, source: ReferenceSource): string[] {
  const visible = judgeVisibleText(text);
  const problems = bandProblems(visible);
  spec.dimensions.forEach((dimension, index) => {
    if (source === "shipped") {
      if (!visible.toLowerCase().includes(dimension)) problems.push(`the dimension name "${dimension}" does not appear`);
    } else if (!spec.dimensionSignals[index].test(visible)) {
      problems.push(`nothing describes the dimension "${dimension}"`);
    }
  });
  return problems;
}

function checkSampleStructure(text: string, spec: SampleSpec): string[] {
  return spec.taskTypes
    .filter((taskType) => !taskType.pattern.test(text))
    .map((taskType) => `no ${taskType.name} sample`);
}

export type ReferenceSourceEntry = {
  /** The shipped file's path, which is how every consumer names it. */
  relativePath: string;
  /** The file actually read. */
  resolvedPath: string;
  source: ReferenceSource;
  /** What checkReferenceStructure found missing; empty when the file is complete. */
  problems: string[];
};

function readProblems(root: string, resolvedPath: string, check: (text: string) => string[]): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, resolvedPath), "utf8");
  } catch {
    return ["the file cannot be read"];
  }
  return check(text);
}

/** Which copy each of the six files resolves to, and what each is missing. */
export function referenceSources(root: string = projectRoot): ReferenceSourceEntry[] {
  return OFFICIAL_REFERENCE_FILES.map((relativePath) => {
    const resolved = resolveSkillReference(relativePath, root);
    const rubric = RUBRIC_SPECS.find((spec) => spec.relativePath === relativePath);
    const sample = SAMPLE_SPECS.find((spec) => spec.relativePath === relativePath);
    const problems = readProblems(root, resolved.relativePath, (text) =>
      rubric ? checkReferenceStructure(text, rubric, resolved.source) : checkSampleStructure(text, sample!),
    );
    return { relativePath, resolvedPath: resolved.relativePath, source: resolved.source, problems };
  });
}

/**
 * "official" only when all four rubrics resolve to installed official copies and every one of them
 * passes the structure check. Any other state — nothing installed, some rubrics installed and some
 * not, or an installed copy missing a band or a dimension — is "rewritten". The sample files anchor
 * severity but are not rubrics, so they never decide this.
 */
export function rubricsSource(root: string = projectRoot): "rewritten" | "official" {
  const rubricPaths = new Set(RUBRIC_SPECS.map((spec) => spec.relativePath));
  const rubrics = referenceSources(root).filter((entry) => rubricPaths.has(entry.relativePath));
  return rubrics.every((entry) => entry.source === "official" && entry.problems.length === 0) ? "official" : "rewritten";
}
