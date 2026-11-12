import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectRoot } from "../src/lib/config.js";
import { RUBRIC_SPECS, checkReferenceStructure, judgeVisibleText } from "../src/services/skillReferences.js";

// The four rubric files this repository ships are its own description of ETS's criteria. These
// checks read the shipped files themselves, never an installed official copy, so they hold on any
// checkout.

const shipped = (relativePath: string) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

describe.each(RUBRIC_SPECS.map((spec) => [spec.relativePath, spec] as const))("%s", (_label, spec) => {
  it("has one band per score from 5 to 0 that a Judge sees, and names every Judge dimension exactly", () => {
    expect(checkReferenceStructure(shipped(spec.relativePath), spec, "shipped")).toEqual([]);
  });

  it("says whose words it is in, where the criteria come from, and how to use ETS's own text", () => {
    const header = shipped(spec.relativePath).split("\n## ")[0]!.replace(/\s+/g, " ");
    expect(header).toContain("own description");
    expect(header).toContain("It is not ETS's text.");
    expect(header).toContain("*Updated TOEFL iBT® Test Overview*");
    expect(header).toContain("https://www.ets.org/pdfs/toefl/toefl-ibt-test-overview.pdf");
    expect(header).toMatch(/pp?\. \d+/);
    expect(header).toContain("docs/official-rubrics.md");
  });

  it("never claims to be ETS's own text", () => {
    expect(shipped(spec.relativePath)).not.toMatch(/verbatim|transcribed/i);
  });

  it("keeps every band where a Judge prompt can see it", () => {
    const visible = judgeVisibleText(shipped(spec.relativePath));
    for (const level of [5, 4, 3, 2, 1, 0]) expect(visible).toContain(`### Score: ${level}`);
  });
});
