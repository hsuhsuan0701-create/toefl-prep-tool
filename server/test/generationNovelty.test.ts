import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GenerationDomainFamilySchema,
  type AnySet,
  type GenerationDomainFamily,
} from "@toefl-prep/shared";
import { diversityRetrySummary } from "../src/services/diversityIssues.js";
import {
  buildNoveltyCatalog,
  compareCatalogEntries,
  compareCatalogOrder,
  domainCounts,
  entriesFromPlan,
  findCatalogCollisions,
  NOVELTY_THRESHOLDS,
  type NoveltyCatalogEntry,
} from "../src/services/generationCatalog.js";
import {
  inferGenerationDomain,
  preferredDomains,
} from "../src/services/generationDomains.js";
import {
  PHYSICAL_SETTING_TERMS,
  requiredPreferredSituations,
  stripInvalidDistinctions,
  validateGenerationPlan,
} from "../src/services/generationNovelty.js";
import {
  containmentScore,
  contentTokens,
  normalizeNoveltyText,
} from "../src/services/noveltySimilarity.js";
import { config } from "../src/lib/config.js";
import { createSetStore } from "../src/services/setStore.js";
import {
  speakingPlanFixture,
  speakingSetFixture,
  writingPlanFixture,
  writingSetFixture,
} from "./helpers/generationDiversityFixtures.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function scratchBank(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "generation-novelty-"));
  scratchDirs.push(dataDir);
  fs.mkdirSync(path.join(dataDir, "question-sets/speaking"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dataDir, "question-sets/writing"), {
    recursive: true,
  });
  return dataDir;
}

function writeSet(dataDir: string, set: AnySet): void {
  const kindDir = set.kind === "speaking" ? "speaking" : "writing";
  fs.writeFileSync(
    path.join(dataDir, "question-sets", kindDir, `${set.id}.json`),
    JSON.stringify(set),
  );
}

// Mirrors production construction: descriptor, noveltyKey and canonicalTitle are normalized exactly
// once here and never again, so overrides take raw prose as a real entry does. Normalization is not
// idempotent, so normalizing anywhere else would yield tokens a real entry never has.
function entry(
  overrides: Partial<NoveltyCatalogEntry> = {},
): NoveltyCatalogEntry {
  const raw: NoveltyCatalogEntry = {
    setId: "spk-prior",
    source: "generated",
    createdAt: "2026-07-31T00:00:00Z",
    taskType: "interview",
    domain: "everyday-life",
    descriptor: "planning short study breaks during difficult homework",
    classifierText: "planning short study breaks during difficult homework",
    conceptTokens: [
      "planning",
      "short",
      "study",
      "break",
      "difficult",
      "homework",
    ],
    itemPosition: 0,
    ...overrides,
  };
  return {
    ...raw,
    descriptor: normalizeNoveltyText(raw.descriptor),
    ...(raw.noveltyKey
      ? { noveltyKey: normalizeNoveltyText(raw.noveltyKey) }
      : {}),
    ...(raw.canonicalTitle
      ? { canonicalTitle: normalizeNoveltyText(raw.canonicalTitle) }
      : {}),
  };
}

// Builds the ten Build a Sentence situations a compliant plan must contain: at most three per
// domain family, at least `floor` of them inside the currently preferred set, at least five distinct
// families. Used to prove the rule stays satisfiable however the bank fills.
function allocateSituations(
  preferred: readonly GenerationDomainFamily[],
  floor: number,
): Partial<Record<GenerationDomainFamily, number>> {
  const plan: Partial<Record<GenerationDomainFamily, number>> = {};
  let placed = 0;
  let inPreferred = 0;
  for (const domain of preferred) {
    if (inPreferred >= floor) break;
    const take = Math.min(3, floor - inPreferred, 10 - placed);
    plan[domain] = (plan[domain] ?? 0) + take;
    inPreferred += take;
    placed += take;
  }
  const order = [
    ...preferred,
    ...GenerationDomainFamilySchema.options.filter(
      (domain) => !preferred.includes(domain),
    ),
  ];
  while (placed < 10) {
    const next = order.find((domain) => (plan[domain] ?? 0) === 0) ??
      order.find((domain) => (plan[domain] ?? 0) < 3);
    if (!next) break;
    plan[next] = (plan[next] ?? 0) + 1;
    placed += 1;
  }
  return plan;
}

describe("novelty normalization and comparison", () => {
  it("locks the containment threshold", () => {
    expect(NOVELTY_THRESHOLDS).toEqual({
      containment: 0.78,
      containmentMinTokens: 5,
    });
  });

  it("normalizes Unicode, punctuation, boilerplate, stop words, and conservative suffixes", () => {
    expect(
      normalizeNoveltyText(
        "Ｔｈａｎｋｓ for speaking with me today! Great. The STUDENTS were planning classes.",
      ),
    ).toBe("plan class");
    expect(contentTokens("OK. Next, I'd like your opinion about buses."))
      .toEqual(["bus"]);
  });

  it("measures containment from the smaller side", () => {
    expect(containmentScore(
      ["a", "b", "c", "d", "e"],
      ["a", "b", "c", "d", "e", "f"],
    )).toBe(1);
    expect(containmentScore(["a", "b", "c", "d"], ["a", "b", "e", "f", "g"])).toBe(0.5);
  });

  it("reports containment at its threshold, and nothing for a component too small to measure", () => {
    const left = entry({
      setId: "spk-containment-a",
      descriptor: "alpha",
      conceptTokens: Array.from({ length: 50 }, (_, index) => `token${index}`),
    });
    const right = entry({
      setId: "spk-containment-b",
      domain: "arts-culture",
      descriptor: "omega",
      conceptTokens: [
        ...Array.from({ length: 39 }, (_, index) => `token${index}`),
        ...Array.from({ length: 61 }, (_, index) => `other${index}`),
      ],
    });
    expect(compareCatalogEntries(left, right)).toEqual([{
      taskType: "interview",
      kind: "containment",
      conflictingSetIds: ["spk-containment-a", "spk-containment-b"],
      score: 0.78,
    }]);

    const small = entry({ setId: "spk-small", conceptTokens: ["token0", "token1", "token2", "token3"] });
    expect(compareCatalogEntries(small, right)).toEqual([]);
  });

  it("does not collide on required TOEFL frames or shared grammar terminology", () => {
    const factual = entry({
      setId: "spk-train",
      canonicalTitle: "Train Journey Planning",
      descriptor:
        "thanks for speaking with me today route information missed connections station staff",
      conceptTokens: contentTokens(
        "route information missed connections station staff",
      ),
    });
    const arts = entry({
      setId: "spk-gallery",
      canonicalTitle: "Visiting Local Galleries",
      descriptor:
        "thanks for speaking with me today gallery visits art preferences museum funding",
      conceptTokens: contentTokens(
        "gallery visits art preferences museum funding",
      ),
    });
    const grammarA = entry({
      setId: "wri-grammar-a",
      taskType: "build_sentence",
      descriptor: "relative clause professor rescheduled laboratory tour",
      conceptTokens: contentTokens(
        "relative clause professor rescheduled laboratory tour",
      ),
    });
    const grammarB = entry({
      setId: "wri-grammar-b",
      taskType: "build_sentence",
      descriptor: "relative clause neighbor repaired broken bicycle",
      conceptTokens: contentTokens(
        "relative clause neighbor repaired broken bicycle",
      ),
    });

    expect(compareCatalogEntries(factual, arts)).toEqual([]);
    expect(compareCatalogEntries(grammarA, grammarB)).toEqual([]);
  });
});

describe("complete novelty catalog", () => {
  it("reads every valid source and component in stable order while safely skipping invalid files", () => {
    const dataDir = scratchBank();
    const sources = ["generated", "imported", "ets-sample"] as const;
    for (const [index, source] of sources.entries()) {
      const speaking = speakingSetFixture();
      speaking.id = `spk-${source}`;
      speaking.source = source;
      if (source === "generated") {
        speaking.generationPlan = speakingPlanFixture();
      }
      writeSet(dataDir, speaking);

      const writing = writingSetFixture();
      writing.id = `wri-${source}`;
      writing.source = source;
      if (source === "generated") {
        writing.generationPlan = writingPlanFixture();
      }
      writing.buildASentence.items.forEach((item, itemIndex) => {
        item.id = `bas-${index}-${itemIndex}`;
      });
      writeSet(dataDir, writing);
    }

    fs.writeFileSync(
      path.join(dataDir, "question-sets/writing/corrupt.json"),
      "{ private fixture sentence",
    );
    fs.writeFileSync(
      path.join(dataDir, "question-sets/speaking/invalid.json"),
      JSON.stringify({ kind: "speaking", private: "private fixture sentence" }),
    );
    const staging = path.join(dataDir, "question-sets/.staging");
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(
      path.join(staging, "ignored.json"),
      JSON.stringify(writingSetFixture()),
    );
    const warnings: string[] = [];

    const catalog = buildNoveltyCatalog({
      store: createSetStore(dataDir),
      warn: (message) => warnings.push(message),
    });

    expect(new Set(catalog.map((item) => item.source))).toEqual(
      new Set(["generated", "imported", "ets-sample"]),
    );
    expect(catalog).toEqual([...catalog].sort(compareCatalogOrder));
    expect(
      catalog.filter((item) => item.taskType === "build_sentence"),
    ).toHaveLength(30);
    expect(catalog.filter((item) => item.taskType === "listen_repeat"))
      .toHaveLength(3);
    expect(catalog.filter((item) => item.taskType === "interview"))
      .toHaveLength(3);
    expect(catalog.some((item) => item.setId.includes("ignored"))).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).not.toContain("private fixture sentence");
  });

  it("represents every component in full instead of truncating it", () => {
    const dataDir = scratchBank();
    const speaking = speakingSetFixture();
    const writing = writingSetFixture();
    writeSet(dataDir, speaking);
    writeSet(dataDir, writing);

    const catalog = buildNoveltyCatalog({ store: createSetStore(dataDir) });
    const listenRepeat = catalog.find(
      ({ taskType }) => taskType === "listen_repeat",
    );
    const discussion = catalog.find(
      ({ taskType }) => taskType === "discussion",
    );

    // A truncated descriptor would let two Sets repeating their last sentences verbatim never
    // collide.
    const lastSentence = speaking.listenAndRepeat.items.at(-1)?.sentence ?? "";
    expect(contentTokens(lastSentence).length).toBeGreaterThan(0);
    for (const token of contentTokens(lastSentence)) {
      expect(listenRepeat?.descriptor.split(" ")).toContain(token);
    }
    for (const token of contentTokens(writing.academicDiscussion.professorPost)) {
      expect(discussion?.descriptor.split(" ")).toContain(token);
    }
  });

  it("never re-normalizes an already normalized descriptor", () => {
    const dataDir = scratchBank();
    const writing = writingSetFixture();
    writeSet(dataDir, writing);

    const discussion = buildNoveltyCatalog({ store: createSetStore(dataDir) }).find(
      ({ taskType }) => taskType === "discussion",
    );

    // Normalization is lossy and not idempotent: "buildings" becomes "building" on the first pass and
    // "build" on a second. A stored descriptor is already normalized, so re-tokenizing it would yield
    // tokens that never match a plan's single-pass required concepts.
    expect(normalizeNoveltyText("heritage buildings")).toBe("heritage building");
    expect(normalizeNoveltyText(normalizeNoveltyText("heritage buildings")))
      .toBe("heritage build");
    expect(discussion?.descriptor.split(" ")).toContain("building");
    expect(discussion?.descriptor.split(" ")).not.toContain("build");
  });

  it.each([
    ["campus-academics", "professor course library student"],
    ["workplace-business", "office manager customer company"],
    ["community-civic", "community city neighborhood volunteer"],
    ["science-environment", "laboratory climate habitat biology"],
    ["technology-media", "software device podcast digital"],
    ["arts-culture", "gallery museum music theater"],
    ["health-wellbeing", "clinic exercise sleep nutrition"],
    ["services-travel", "train hotel ticket route"],
    ["history-social-change", "history heritage migration reform"],
    ["everyday-life", "laundry breakfast umbrella weekend"],
  ] as const)("infers %s deterministically", (domain, text) => {
    expect(inferGenerationDomain(text)).toBe(domain);
  });

  it("classifies campus-academics on its most discriminative keyword", () => {
    // "student" is a stop word, so it never becomes a novelty token, but the domain classifier must
    // still count it: it is campus-academics' strongest term, and the counts drive domain balancing.
    expect(normalizeNoveltyText("the students arrived")).toBe("arriv");
    expect(inferGenerationDomain("the students arrived early"))
      .toBe("campus-academics");
    expect(inferGenerationDomain("a student asked about the deadline"))
      .toBe("campus-academics");
  });

  it("keeps the Build a Sentence balance rule satisfiable as the bank fills", () => {
    // preferredDomains can shrink to a single domain as the bank fills. A fixed floor of five
    // situations in preferred domains, with at most three per domain, would then be impossible and
    // every replan would be spent on it. Simulated forward over forty rounds, the clamped floor
    // (requiredPreferredSituations) stays satisfiable.
    const counts = Object.fromEntries(
      GenerationDomainFamilySchema.options.map((domain) => [domain, 0]),
    ) as Record<GenerationDomainFamily, number>;
    counts["everyday-life"] = 65;

    for (let round = 0; round < 40; round += 1) {
      const preferred = preferredDomains(counts);
      const floor = requiredPreferredSituations(preferred.length);
      expect(floor).toBeLessThanOrEqual(preferred.length * 3);
      expect(floor).toBeGreaterThan(0);

      const plan = allocateSituations(preferred, floor);
      const placements = Object.values(plan);
      expect(placements.reduce((sum, count) => sum + count, 0)).toBe(10);
      expect(placements).toHaveLength(
        new Set(Object.keys(plan)).size,
      );
      expect(Object.keys(plan).length).toBeGreaterThanOrEqual(5);
      expect(Math.max(...placements)).toBeLessThanOrEqual(3);
      expect(
        preferred.reduce((sum, domain) => sum + (plan[domain] ?? 0), 0),
      ).toBeGreaterThanOrEqual(floor);

      for (const [domain, count] of Object.entries(plan)) {
        counts[domain as GenerationDomainFamily] += count;
      }
    }
  });

  it("counts and balances domains separately per Task Type", () => {
    const catalog = [
      entry({
        taskType: "email",
        domain: "arts-culture",
        setId: "wri-one",
      }),
      entry({
        taskType: "email",
        domain: "arts-culture",
        setId: "wri-two",
      }),
      entry({
        taskType: "discussion",
        domain: "arts-culture",
        setId: "wri-three",
      }),
    ];

    const counts = domainCounts(catalog);

    expect(counts.email["arts-culture"]).toBe(2);
    expect(counts.discussion["arts-culture"]).toBe(1);
    expect(counts.interview["arts-culture"]).toBe(0);
    expect(preferredDomains(counts.email)).not.toContain("arts-culture");
    expect(preferredDomains(counts.discussion)).toContain("arts-culture");
  });

  it("reports catalog collisions in stable, privacy-safe form", () => {
    const issues = findCatalogCollisions([
      entry({ setId: "spk-z" }),
      entry({ setId: "spk-a" }),
    ]);

    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].conflictingSetIds).toEqual(["spk-a", "spk-z"]);
    expect(JSON.stringify(issues)).not.toContain("study breaks");
  });

  it("keeps the substantive legacy Discussion proposition strong enough to catch the known downtown-parking paraphrase", () => {
    const dataDir = scratchBank();
    const first = writingSetFixture();
    first.id = "wri-77af733e";
    first.academicDiscussion.courseTitle = "Introduction to Urban Studies";
    first.academicDiscussion.professorPost =
      "Many cities are rethinking how downtown street space is allocated. " +
      "Some have converted curbside parking into wider sidewalks, bike lanes, " +
      "or outdoor seating for restaurants, while others have kept the parking " +
      "to preserve convenient access for drivers. Should cities convert " +
      "downtown street parking into public space? Why or why not?";
    const second = writingSetFixture();
    second.id = "wri-787b9d66";
    second.academicDiscussion.courseTitle =
      "Urban Studies: Cities and Public Space";
    second.academicDiscussion.professorPost =
      "Many cities are rethinking what curb space is for. Some have converted " +
      "downtown street parking into wider sidewalks, bike lanes, and outdoor " +
      "seating, while others say removing parking sends shoppers elsewhere. " +
      "Should a city convert downtown street parking into space for pedestrians " +
      "and cyclists? Why or why not?";
    writeSet(dataDir, first);
    writeSet(dataDir, second);

    const discussions = buildNoveltyCatalog({ store: createSetStore(dataDir) }).filter(
      ({ taskType }) => taskType === "discussion",
    );
    const issues = findCatalogCollisions(discussions);

    expect(issues.some(({ conflictingSetIds, kind }) =>
      kind === "containment" &&
      conflictingSetIds.join(",") === "wri-77af733e,wri-787b9d66"
    )).toBe(true);
  });
});

describe("generation plan validation", () => {
  it("accepts balanced, distinct fixture plans against an empty bank", () => {
    expect(validateGenerationPlan({
      plan: speakingPlanFixture(),
      catalog: [],
    })).toEqual([]);
    expect(validateGenerationPlan({
      plan: writingPlanFixture(),
      catalog: [],
    })).toEqual([]);
  });

  it("requires an L&R plan to name a physical setting", () => {
    const plan = speakingPlanFixture();
    plan.listenAndRepeat.setting = "the abstract value of creativity";

    expect(validateGenerationPlan({ plan, catalog: [] })).toContainEqual({
      taskType: "listen_repeat",
      kind: "plan-drift",
      conflictingSetIds: [],
    });
  });

  // "training" is not "train". PHYSICAL_SETTING_TERMS leaves out "train" because the setting is
  // stemmed before matching and "training" is the verb nearly every Listen and Repeat scenario is
  // built on; with "train" listed, this setting, which names no place, would pass.
  it("does not accept plain 'training' language as a physical setting", () => {
    const plan = speakingPlanFixture();
    plan.listenAndRepeat.setting = "training a newly hired coworker before opening";

    expect(validateGenerationPlan({ plan, catalog: [] })).toContainEqual({
      taskType: "listen_repeat",
      kind: "plan-drift",
      conflictingSetIds: [],
    });
  });

  // Settings that are plainly concrete physical places pass the check.
  it.each([
    "a campus greenhouse",
    "a small heritage archive",
    "the campus zoo",
    "a neighborhood bakery",
    "the guest's rented apartment",
    "the campus food pantry",
    "the hotel's guest services desk",
    "a family's home",
    "a downtown shop",
    "a city bus",
  ])("accepts %j as a physical L&R setting", (setting) => {
    const plan = speakingPlanFixture();
    plan.listenAndRepeat.setting = setting;

    expect(validateGenerationPlan({ plan, catalog: [] })).not.toContainEqual(
      expect.objectContaining({ taskType: "listen_repeat", kind: "plan-drift" }),
    );
  });

  // The speaking generation guide suggests a campus venue per domain family and a non-academic
  // fallback list, so the model can satisfy the physical-setting check deliberately. This test reads
  // the guide's own prose and runs each suggested venue through the real validator, so a venue added
  // to the guide without a matching PHYSICAL_SETTING_TERMS entry fails here.
  it("accepts every campus-venue suggestion the generation guide itself makes", () => {
    const guidePath = path.join(
      config.projectRoot,
      ".claude/skills/toefl-speaking/references/generation-guide.md",
    );
    const guideText = fs.readFileSync(guidePath, "utf8");

    const domainSuggestions = (() => {
      const startMarker = "Most families still have an";
      const endMarker = "construction.";
      const start = guideText.indexOf(startMarker);
      const end = guideText.indexOf(endMarker, start) + endMarker.length;
      if (start < 0 || end < 0) {
        throw new Error(
          "generation-guide.md's campus-venue paragraph moved or was reworded — update this " +
            "test's markers alongside it.",
        );
      }
      const block = guideText.slice(start, end).replace(/\s+/g, " ");
      const parts = block.split(/(`[a-z-]+`)/);
      const clauses: string[] = [];
      for (let index = 0; index < parts.length; index += 1) {
        if (/^`[a-z-]+`$/.test(parts[index])) {
          const domain = parts[index].replace(/`/g, "");
          // campus-academics' own clause ("is academic by construction") names no venue by
          // design; see the guide prose just before it.
          if (domain === "campus-academics") continue;
          clauses.push((parts[index + 1] ?? "").trim());
        }
      }
      return clauses;
    })();

    const nonAcademicSuggestions = (() => {
      const startMarker = "Reserve a genuinely non-academic setting";
      const endMarker = "for the domains";
      const start = guideText.indexOf(startMarker);
      const end = guideText.indexOf(endMarker, start);
      if (start < 0 || end < 0) {
        throw new Error(
          "generation-guide.md's non-academic-setting sentence moved or was reworded — update " +
            "this test's markers alongside it.",
        );
      }
      const block = guideText.slice(start, end).replace(/\s+/g, " ");
      const listed = block.split("—")[1];
      if (!listed) {
        throw new Error("could not isolate the em-dash-delimited example list");
      }
      return listed.split(",").map((entry) => entry.trim()).filter(Boolean);
    })();

    const suggestions = [...domainSuggestions, ...nonAcademicSuggestions];
    // A floor on the extraction itself, not a count the guide must hold exactly: high enough that a
    // marker mismatch collapsing to 0 or 1 clause fails here instead of passing vacuously.
    expect(suggestions.length).toBeGreaterThanOrEqual(8);

    for (const setting of suggestions) {
      const plan = speakingPlanFixture();
      plan.listenAndRepeat.setting = setting;
      expect(
        validateGenerationPlan({ plan, catalog: [] }),
        `guide-suggested setting ${JSON.stringify(setting)} failed the physical-setting check`,
      ).not.toContainEqual(
        expect.objectContaining({ taskType: "listen_repeat", kind: "plan-drift" }),
      );
    }
  });

  it("exports the exact term list the physical-setting check validates against", () => {
    // PHYSICAL_SETTING_TERMS is handed to the planner prompt verbatim (generationPlanner.test.ts
    // pins that), so it must stay a plain, JSON-serializable array of lowercase words with no
    // duplicates.
    expect(PHYSICAL_SETTING_TERMS.length).toBeGreaterThan(20);
    expect(new Set(PHYSICAL_SETTING_TERMS).size).toBe(PHYSICAL_SETTING_TERMS.length);
    expect(PHYSICAL_SETTING_TERMS).not.toContain("train");
    for (const term of PHYSICAL_SETTING_TERMS) {
      expect(term).toBe(term.toLowerCase());
    }
  });

  // An invalid `distinguishesFrom` citation never rejects a plan: stripInvalidDistinctions removes
  // it before validateGenerationPlan runs (generationPlanner.ts's reserve()), so no retry is spent on
  // it. The only requirement for keeping a citation is that it names a Set in the same Task Type's
  // Catalog.
  it("keeps a distinction naming a real prior set of the same Task Type", () => {
    const plan = speakingPlanFixture();
    plan.interview.distinguishesFrom = [{
      setId: "spk-prior-travel",
      reason: "that set asks about air travel, this one about buses",
    }];
    const catalog = [
      entry({
        setId: "spk-prior-travel",
        taskType: "interview",
        domain: "services-travel",
        descriptor: "airport departure gates and long security queues",
        conceptTokens: ["airport", "departure", "gate", "security", "queue"],
      }),
    ];

    const stripped = stripInvalidDistinctions(plan, catalog);

    expect(stripped.interview.distinguishesFrom).toEqual([{
      setId: "spk-prior-travel",
      reason: "that set asks about air travel, this one about buses",
    }]);
    expect(validateGenerationPlan({ plan: stripped, catalog })).toEqual([]);
  });

  it("strips, rather than rejects, a distinction naming a set absent from that Task Type", () => {
    const plan = speakingPlanFixture();
    plan.interview.distinguishesFrom = [{
      setId: "spk-unrelated",
      reason: "uses a different travel decision",
    }];
    const catalog = [
      entry({
        setId: "spk-prior-travel",
        taskType: "interview",
        domain: "services-travel",
        descriptor: "airport departure gates and long security queues",
        conceptTokens: ["airport", "departure", "gate", "security", "queue"],
      }),
    ];

    const stripped = stripInvalidDistinctions(plan, catalog);

    expect(stripped.interview.distinguishesFrom).toEqual([]);
    // Every other field is untouched.
    expect(stripped.listenAndRepeat).toEqual(plan.listenAndRepeat);
    // The stripped plan validates clean: no issue over the removed citation.
    expect(validateGenerationPlan({ plan: stripped, catalog })).toEqual([]);
  });

  // A section's first Set has an empty same-Task-Type Catalog, so any citation is invalid. The
  // generation guide states the empty-array rule, but a model can still break a rule stated in
  // prose; stripping cannot be broken.
  it("strips every citation when the same-task-type catalog is empty, rather than rejecting the plan", () => {
    const plan = speakingPlanFixture();
    plan.interview.distinguishesFrom = [{
      setId: "spk-does-not-exist-yet",
      reason: "would distinguish from a prior interview, but there is no prior interview",
    }];

    const stripped = stripInvalidDistinctions(plan, []);

    expect(stripped.interview.distinguishesFrom).toEqual([]);
    expect(validateGenerationPlan({ plan: stripped, catalog: [] })).toEqual([]);
  });

  it("records a plan that overlaps a saved plan", () => {
    const plan = speakingPlanFixture();
    const catalog = entriesFromPlan(plan, {
      setId: "spk-saved",
      source: "generated",
    });

    const issues = validateGenerationPlan({ plan, catalog });

    expect(issues.some((issue) =>
      issue.kind === "containment" && issue.conflictingSetIds.includes("spk-saved")
    )).toBe(true);
  });

  it("enforces Build a Sentence domain spread, maximum, and preferred coverage", () => {
    const plan = writingPlanFixture();
    for (const situation of plan.buildASentence.situations) {
      situation.domain = "arts-culture";
    }

    expect(validateGenerationPlan({ plan, catalog: [] })).toContainEqual({
      taskType: "build_sentence",
      kind: "domain-balance",
      conflictingSetIds: [],
    });
  });

});

describe("planner retry metadata", () => {
  it("returns only bounded retry metadata", () => {
    const summary = diversityRetrySummary([
      {
        taskType: "interview",
        kind: "containment",
        conflictingSetIds: ["spk-z", "spk-a"],
        score: 0.75,
      },
      {
        taskType: "interview",
        kind: "containment",
        conflictingSetIds: ["spk-a"],
      },
      {
        taskType: "email",
        kind: "plan-drift",
        conflictingSetIds: [],
      },
    ]);

    expect(summary).toEqual({
      taskTypes: ["email", "interview"],
      collisionKinds: ["containment", "plan-drift"],
      conflictingSetIds: ["spk-a", "spk-z"],
    });
    expect(summary).not.toHaveProperty("score");
    expect(summary).not.toHaveProperty("descriptor");
  });
});
