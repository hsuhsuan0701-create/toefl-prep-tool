import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OFFICIAL_REFERENCE_FILES,
  RUBRIC_SPECS,
  checkReferenceStructure,
  officialReferencePath,
  referenceSources,
  resolveSkillReference,
  rubricsSource,
  type RubricSpec,
} from "../src/services/skillReferences.js";

// The one rule every consumer of the rubric and sample files applies: a file named in
// OFFICIAL_REFERENCE_FILES is replaced by `references/official/<same name>` when that file exists.
// Every case here runs against a scratch project root, never the real one, because the real
// checkout may or may not hold an official copy and the answer must not depend on it.

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratchRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-references-"));
  roots.push(root);
  return root;
}

function put(root: string, relativePath: string, text: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const EMAIL = ".claude/skills/toefl-writing/references/rubric-email.md";
const EMAIL_OFFICIAL = ".claude/skills/toefl-writing/references/official/rubric-email.md";

/** A text with every band heading and enough words under each, plus whatever `extra` adds. */
function banded(extra: string, levels: readonly number[] = [5, 4, 3, 2, 1, 0]): string {
  return [
    "# Some guide",
    extra,
    "## Scoring guide",
    ...levels.flatMap((level) => [`### Score: ${level}`, `Words that describe band ${level} in some detail.`]),
  ].join("\n\n");
}

const spec = (taskType: RubricSpec["taskType"]): RubricSpec => {
  const found = RUBRIC_SPECS.find((candidate) => candidate.taskType === taskType);
  if (!found) throw new Error(`no spec for ${taskType}`);
  return found;
};

describe("resolveSkillReference", () => {
  it("uses the shipped file when no official copy is installed", () => {
    const root = scratchRoot();
    put(root, EMAIL, "shipped");
    expect(resolveSkillReference(EMAIL, root)).toEqual({ relativePath: EMAIL, source: "shipped" });
  });

  it("uses references/official/<same name> instead when that file exists", () => {
    const root = scratchRoot();
    put(root, EMAIL, "shipped");
    put(root, EMAIL_OFFICIAL, "official");
    expect(resolveSkillReference(EMAIL, root)).toEqual({ relativePath: EMAIL_OFFICIAL, source: "official" });
  });

  it("does not count a directory of that name as an installed copy", () => {
    const root = scratchRoot();
    put(root, EMAIL, "shipped");
    fs.mkdirSync(path.join(root, EMAIL_OFFICIAL), { recursive: true });
    expect(resolveSkillReference(EMAIL, root).source).toBe("shipped");
  });

  it("never redirects a file outside the six, even when an official copy of it sits there", () => {
    const root = scratchRoot();
    for (const name of ["SKILL.md", "references/generation-guide.md"]) {
      const relativePath = `.claude/skills/toefl-writing/${name}`;
      put(root, relativePath, "shipped");
      put(root, `.claude/skills/toefl-writing/references/official/${path.basename(name)}`, "official");
      expect(resolveSkillReference(relativePath, root)).toEqual({ relativePath, source: "shipped" });
    }
    // The reading and listening skills carry no ETS text and have no official counterpart.
    const reading = ".claude/skills/toefl-reading/references/rubric-email.md";
    put(root, ".claude/skills/toefl-reading/references/official/rubric-email.md", "official");
    expect(resolveSkillReference(reading, root).source).toBe("shipped");
  });

  it("covers exactly the four rubrics and the two sample files", () => {
    expect(OFFICIAL_REFERENCE_FILES).toEqual([
      ".claude/skills/toefl-writing/references/rubric-email.md",
      ".claude/skills/toefl-writing/references/rubric-academic-discussion.md",
      ".claude/skills/toefl-writing/references/samples-scored.md",
      ".claude/skills/toefl-speaking/references/rubric-listen-and-repeat.md",
      ".claude/skills/toefl-speaking/references/rubric-interview.md",
      ".claude/skills/toefl-speaking/references/samples-scored.md",
    ]);
    expect(officialReferencePath(EMAIL)).toBe(EMAIL_OFFICIAL);
  });
});

describe("checkReferenceStructure on an official copy", () => {
  // The signals an official copy is checked for are words ETS's own guide uses for each dimension,
  // so these fixtures carry them the way a pasted guide would: in the band text, not as headings.
  const EMAIL_SIGNALS = "Elaboration, social conventions, syntactic variety, word choice, common typos.";

  it("passes a copy with all six bands and every dimension described", () => {
    expect(checkReferenceStructure(banded(EMAIL_SIGNALS), spec("email"), "official")).toEqual([]);
  });

  it("reads the band headings a paste is likely to carry", () => {
    const text = [
      EMAIL_SIGNALS,
      "Score 5", "a band five description here",
      "**Score: 4**", "a band four description here",
      "## Score: 3", "a band three description here",
      "#### Score 2", "a band two description here",
      "Score: 1", "a band one description here",
      "Score 0", "a band zero description here",
    ].join("\n");
    expect(checkReferenceStructure(text, spec("email"), "official")).toEqual([]);
  });

  it("names a missing band", () => {
    const problems = checkReferenceStructure(banded(EMAIL_SIGNALS, [5, 4, 2, 1, 0]), spec("email"), "official");
    expect(problems).toEqual(["no band heading for score 3"]);
  });

  it("names a band whose heading has no text under it", () => {
    const text = banded(EMAIL_SIGNALS).replace("Words that describe band 2 in some detail.", "");
    expect(checkReferenceStructure(text, spec("email"), "official")).toEqual(["score 2 has no text under its heading"]);
  });

  it("names a band that appears twice, as two guides pasted into one file would", () => {
    const text = `${banded(EMAIL_SIGNALS)}\n\n### Score: 5\n\nA second band five block pasted below.`;
    expect(checkReferenceStructure(text, spec("email"), "official")).toEqual(["score 5 has 2 band headings"]);
  });

  it("names a dimension the copy never describes, which is what pasting another task's guide looks like", () => {
    // The Academic Discussion guide says nothing about social conventions.
    const discussionGuide = banded("Elaboration, syntactic variety, word choice, common typos, online discussion.");
    expect(checkReferenceStructure(discussionGuide, spec("email"), "official"))
      .toEqual(["nothing describes the dimension \"communicative goal & social conventions\""]);
  });

  it("checks what a Judge would see, so a band inside an arbiter-only section counts as missing", () => {
    const text = banded(EMAIL_SIGNALS).replace("### Score: 1", "## AGGREGATE notes\n\n### Score: 1");
    expect(checkReferenceStructure(text, spec("email"), "official")).toEqual([
      "no band heading for score 1",
      "no band heading for score 0",
    ]);
  });
});

describe("checkReferenceStructure on a shipped rubric", () => {
  it("requires each dimension by the exact name the Judges report it under", () => {
    const named = banded(spec("interview").dimensions.join(", "));
    expect(checkReferenceStructure(named, spec("interview"), "shipped")).toEqual([]);
    // Words ETS would use are not enough here: the shipped file is ours, and it names them.
    const signalsOnly = banded("elaboration, pace, intelligibility, grammar");
    expect(checkReferenceStructure(signalsOnly, spec("interview"), "shipped")).toEqual([
      "the dimension name \"topical elaboration\" does not appear",
      "the dimension name \"pace & pausing\" does not appear",
      "the dimension name \"intelligibility & prosody\" does not appear",
      "the dimension name \"grammar & vocabulary\" does not appear",
    ]);
  });
});

describe("referenceSources and rubricsSource", () => {
  const SIGNALS: Record<RubricSpec["taskType"], string> = {
    email: "Elaboration, social conventions, syntactic variety, word choice, common typos.",
    discussion: "Online discussion; explanations and elaboration; syntactic variety; word choice; typos.",
    listen_repeat: "An exact repetition that is fully intelligible.",
    interview: "Elaboration, speaking pace and pauses, intelligible pronunciation, grammar and vocabulary.",
  };

  function shippedTree(root: string): void {
    for (const rubric of RUBRIC_SPECS) put(root, rubric.relativePath, banded(rubric.dimensions.join(", ")));
    put(root, ".claude/skills/toefl-writing/references/samples-scored.md",
      "## Write an Email\n\nScore 4 anchor.\n\n## Write for an Academic Discussion\n\nScore 5 anchor.");
    put(root, ".claude/skills/toefl-speaking/references/samples-scored.md",
      "## Listen and Repeat\n\nScore 4 anchor.\n\n## Take an Interview\n\nScore 5 anchor.");
  }

  function installOfficial(root: string, taskType: RubricSpec["taskType"], text = banded(SIGNALS[taskType])): void {
    put(root, officialReferencePath(spec(taskType).relativePath), text);
  }

  it("reports rewritten when nothing is installed", () => {
    const root = scratchRoot();
    shippedTree(root);
    expect(rubricsSource(root)).toBe("rewritten");
    expect(referenceSources(root).every((entry) => entry.source === "shipped" && entry.problems.length === 0)).toBe(true);
  });

  it("reports official only when all four rubrics resolve to official copies that pass the check", () => {
    const root = scratchRoot();
    shippedTree(root);
    for (const rubric of RUBRIC_SPECS) installOfficial(root, rubric.taskType);
    expect(rubricsSource(root)).toBe("official");
  });

  it("reports rewritten for a mixed installation, and says which file is which", () => {
    const root = scratchRoot();
    shippedTree(root);
    installOfficial(root, "email");
    installOfficial(root, "discussion");
    expect(rubricsSource(root)).toBe("rewritten");
    const byPath = new Map(referenceSources(root).map((entry) => [entry.relativePath, entry]));
    expect(byPath.get(spec("email").relativePath)?.source).toBe("official");
    expect(byPath.get(spec("interview").relativePath)?.source).toBe("shipped");
  });

  it("reports rewritten when an installed copy fails the check, while still resolving to it", () => {
    const root = scratchRoot();
    shippedTree(root);
    for (const rubric of RUBRIC_SPECS) installOfficial(root, rubric.taskType);
    installOfficial(root, "interview", banded(SIGNALS.interview, [5, 4, 3, 2, 1]));
    expect(rubricsSource(root)).toBe("rewritten");
    const interview = referenceSources(root).find((entry) => entry.relativePath === spec("interview").relativePath);
    expect(interview).toMatchObject({ source: "official", problems: ["no band heading for score 0"] });
  });

  it("checks an installed sample file for both of its Task Types", () => {
    const root = scratchRoot();
    shippedTree(root);
    put(root, ".claude/skills/toefl-writing/references/official/samples-scored.md", "Write an Email, Score 4. Nothing else.");
    const samples = referenceSources(root).find(
      (entry) => entry.relativePath === ".claude/skills/toefl-writing/references/samples-scored.md",
    );
    expect(samples).toMatchObject({ source: "official", problems: ["no Write for an Academic Discussion sample"] });
    // Sample files are severity anchors, not rubrics: they never decide the rubric source.
    expect(rubricsSource(root)).toBe("rewritten");
  });
});
