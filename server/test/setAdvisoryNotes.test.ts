import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnySetSchema,
  MAX_SET_ADVISORY_NOTES,
  SetAdvisoryNoteSchema,
  stripAnswers,
  type SetAdvisoryNote,
} from "@toefl-prep/shared";
import { config } from "../src/lib/config.js";
import { listSets } from "../src/routes/sets.js";
import { createSetStore } from "../src/services/setStore.js";
import { recordAdvisoryNotes } from "../src/services/setAdvisoryLedger.js";
import { advisoryNotesFromIssues } from "../src/services/diversityIssues.js";
import type { DiversityIssue } from "../src/services/diversityIssues.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function bankWith(kind: string, set: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advisory-notes-"));
  tempDirs.push(dir);
  const setDir = path.join(dir, "question-sets", kind);
  fs.mkdirSync(setDir, { recursive: true });
  fs.writeFileSync(path.join(setDir, `${(set as { id: string }).id}.json`), JSON.stringify(set));
  return dir;
}

/**
 * A real published Writing Set under a new id. Writing is the one kind whose Set needs no audio
 * files or module structure on disk. It is read from the bank rather than copied in, so a schema
 * change that breaks the bank breaks this test too, instead of leaving a stale literal passing.
 */
const REAL_WRITING_SET: Record<string, unknown> = JSON.parse(
  fs.readFileSync(
    path.join(config.dataDir, "question-sets/writing/wri-00c1e95f.json"),
    "utf8",
  ),
);

function writingSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { advisoryNotes: _drop, generationPlan: _plan, ...rest } = REAL_WRITING_SET;
  return {
    ...rest,
    id: "wri-notes01",
    createdAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

const NOTE: SetAdvisoryNote = {
  check: "catalog-novelty",
  detail: "containment",
  taskType: "listen_choose",
  itemPosition: 19,
  conflictingSetIds: ["lsn-14659f38"],
  score: 0.8,
};

describe("SetAdvisoryNoteSchema", () => {
  it("accepts a structured note", () => {
    expect(SetAdvisoryNoteSchema.parse(NOTE)).toEqual(NOTE);
  });

  it("accepts a speech-rate note carrying its measured rate and band", () => {
    const note = {
      check: "speech-rate",
      detail: "lcr-utterance",
      measuredWpm: 149.5,
      targetWpm: 160,
      minWpm: 150,
      maxWpm: 170,
    };
    expect(SetAdvisoryNoteSchema.parse(note)).toEqual(note);
  });

  // The one check whose finding comes from a model rather than deterministic code, so the no-prose
  // rule matters most here: a fixed server-authored `detail`, and the talk named by position rather
  // than by its Stimulus id, which the producer authors.
  it("accepts a talk-register note naming its talk by position", () => {
    const note = {
      check: "talk-register",
      detail: "below-task-register",
      taskType: "academic_talk",
      itemPosition: 2,
    };
    expect(SetAdvisoryNoteSchema.parse(note)).toEqual(note);
  });

  it("rejects a check name it does not know", () => {
    expect(() => SetAdvisoryNoteSchema.parse({ ...NOTE, check: "vibes" })).toThrow();
  });

  it("has no field a scenario or transcript could occupy", () => {
    // The privacy rule, asserted structurally: every string field is a bounded server-owned label,
    // and `planLabel` (the Plan's own scenario, topic or title text) has no field here at all.
    const parsed = SetAdvisoryNoteSchema.parse({
      ...NOTE,
      planLabel: "grandmother's photo from the 1950s festival",
      scenario: "a heritage archive",
    }) as Record<string, unknown>;
    expect(parsed.planLabel).toBeUndefined();
    expect(parsed.scenario).toBeUndefined();
  });

  it("bounds its free-ish string fields so an immutable Set cannot absorb prose", () => {
    expect(() => SetAdvisoryNoteSchema.parse({ ...NOTE, detail: "x".repeat(65) })).toThrow();
    expect(() => SetAdvisoryNoteSchema.parse({ ...NOTE, taskType: "x".repeat(65) })).toThrow();
  });
});

describe("a generated Set persists the advisory issues it was published with", () => {
  it("round-trips notes through the Set schema", () => {
    const parsed = AnySetSchema.parse(writingSet({ advisoryNotes: [NOTE] }));
    expect(parsed.advisoryNotes).toEqual([NOTE]);
  });

  it("keeps parsing a Set published before notes existed, showing none", () => {
    const parsed = AnySetSchema.parse(writingSet());
    expect(parsed.advisoryNotes).toBeUndefined();
  });
});

describe("the advisory-note ledger", () => {
  const PACE_NOTE: SetAdvisoryNote = {
    check: "speech-rate",
    detail: "lr-item",
    take: "first",
    measuredWpm: 105,
    targetWpm: 180,
    minWpm: 150,
    maxWpm: 225,
  };

  const notesOf = (carrier: unknown): SetAdvisoryNote[] | undefined =>
    (carrier as { advisoryNotes?: SetAdvisoryNote[] }).advisoryNotes;

  /**
   * The one cap test for every producer. Each producer of notes (mint-time novelty residuals and
   * Build a Sentence conformance, the content gates' finishing step, both audio renderers' pace
   * notes) attaches through `recordAdvisoryNotes`, so the bound is asserted once here. The case: a
   * generation already near the cap, then an audio renderer appending its pace notes after every
   * mint-time check and before the schema parse at publish.
   */
  it("caps at the bound the schema rejects past, says the truncation out loud, and leaves the Set publishable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const nearCap = Array.from({ length: MAX_SET_ADVISORY_NOTES - 1 }, () => NOTE);
      const recorded = recordAdvisoryNotes(
        writingSet({ advisoryNotes: nearCap }),
        [PACE_NOTE, PACE_NOTE, PACE_NOTE],
        "speaking audio render",
      );

      expect(notesOf(recorded)).toHaveLength(MAX_SET_ADVISORY_NOTES);
      // Head kept, tail dropped — the earliest findings are the ones that survive, so exactly one of
      // the three pace notes fits.
      expect(notesOf(recorded)?.at(-1)).toEqual(PACE_NOTE);
      expect(warn.mock.calls.flat().join(" ")).toContain(
        `speaking audio render carries 502 advisory notes; recording the first ${MAX_SET_ADVISORY_NOTES}`,
      );
      // The point of the cap: publishing parses the Set against this schema, whose `advisoryNotes`
      // is `.max(MAX_SET_ADVISORY_NOTES)`, so an uncapped list would throw and discard a fully paid
      // Set over a diagnostic record.
      expect(() => AnySetSchema.parse(recorded)).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });

  it("omits the field rather than recording an empty array", () => {
    expect(recordAdvisoryNotes(writingSet({ advisoryNotes: [] }), [], "writing set"))
      .not.toHaveProperty("advisoryNotes");
    expect(recordAdvisoryNotes(writingSet(), [], "writing set")).not.toHaveProperty("advisoryNotes");
  });

  it("appends to what the Set already carries, and stays quiet when nothing was dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const recorded = recordAdvisoryNotes(writingSet({ advisoryNotes: [NOTE] }), [PACE_NOTE], "reading content gate");
      expect(notesOf(recorded)).toEqual([NOTE, PACE_NOTE]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the Set API returns the notes", () => {
  it("carries them on the set detail, through stripAnswers", () => {
    const dir = bankWith("writing", writingSet({ advisoryNotes: [NOTE] }));
    const set = createSetStore(dir).readSet("wri-notes01");
    expect(set).toBeDefined();
    // stripAnswers is what /api/sets/:id serves. The notes must survive it — they name no answer.
    const served = stripAnswers(set!);
    expect(served.advisoryNotes).toEqual([NOTE]);
  });

  it("carries them in the listing, so the picker can badge without fetching every Set", () => {
    const dir = bankWith("writing", writingSet({ advisoryNotes: [NOTE] }));
    expect(listSets(dir)).toEqual([
      expect.objectContaining({
        id: "wri-notes01",
        kind: "writing",
        source: "generated",
        createdAt: "2026-08-12T00:00:00.000Z",
        advisoryNotes: [NOTE],
      }),
    ]);
  });

  it("omits the field entirely for a Set with no notes, rather than sending an empty array", () => {
    const dir = bankWith("writing", writingSet());
    const [row] = listSets(dir);
    expect(row).not.toHaveProperty("advisoryNotes");
  });

  it("still strips the answers it always stripped", () => {
    const dir = bankWith("writing", writingSet({ advisoryNotes: [NOTE] }));
    const served = stripAnswers(createSetStore(dir).readSet("wri-notes01")!) as {
      buildASentence: { items: { answers?: unknown }[] };
      generationPlan?: unknown;
    };
    expect(served.buildASentence.items.every((item) => item.answers === undefined)).toBe(true);
    expect(served.generationPlan).toBeUndefined();
  });
});

describe("advisoryNotesFromIssues", () => {
  const issue = (over: Partial<DiversityIssue>): DiversityIssue => ({
    taskType: "listen_choose",
    kind: "containment",
    conflictingSetIds: ["lsn-14659f38"],
    ...over,
  });

  it("groups Catalog overlap under catalog-novelty", () => {
    const [note] = advisoryNotesFromIssues([issue({ kind: "containment" })]);
    expect(note?.check).toBe("catalog-novelty");
    expect(note?.detail).toBe("containment");
  });

  it("groups the conformance kinds as plan drift", () => {
    for (const kind of ["plan-drift", "domain-drift"] as const) {
      const [note] = advisoryNotesFromIssues([issue({ kind, conflictingSetIds: [] })]);
      expect(note?.check, kind).toBe("plan-conformance");
    }
  });

  // `domain-balance` measures this Set's spread against the Catalog (preferredDomains shrinks as
  // the bank grows). Filed under plan-conformance, it would tell the User the generator disobeyed
  // its Plan.
  it("groups domain-balance with the catalog-relative kinds, not with plan drift", () => {
    const [note] = advisoryNotesFromIssues([issue({ kind: "domain-balance", conflictingSetIds: [] })]);
    expect(note?.check).toBe("catalog-novelty");
  });

  // A collision with a concurrently reserved Plan carries a `pending:<ownerId>` id, which
  // SafeIdSchema rejects: copied into a note, it would make the publish it annotates throw.
  it("drops a reservation sentinel id rather than letting it fail the Set's own schema", () => {
    const [note] = advisoryNotesFromIssues([
      issue({ conflictingSetIds: ["pending:6f1c2d3e-1111-2222-3333-444455556666", "lsn-14659f38"] }),
    ]);
    expect(note?.conflictingSetIds).toEqual(["lsn-14659f38"]);
    expect(() => SetAdvisoryNoteSchema.parse(note)).not.toThrow();
  });

  it("carries the measured score and position, and never planLabel", () => {
    const [note] = advisoryNotesFromIssues([
      issue({ score: 0.8, itemPosition: 19, planLabel: "grandmother's photo from the 1950s festival" }),
    ]);
    expect(note).toEqual({
      check: "catalog-novelty",
      detail: "containment",
      taskType: "listen_choose",
      itemPosition: 19,
      conflictingSetIds: ["lsn-14659f38"],
      score: 0.8,
    });
    expect(JSON.stringify(note)).not.toContain("grandmother");
  });

  it("produces notes that satisfy the schema they are persisted under", () => {
    const notes = advisoryNotesFromIssues([issue({ score: 0.8, itemPosition: 19 })]);
    for (const note of notes) expect(() => SetAdvisoryNoteSchema.parse(note)).not.toThrow();
  });
});

describe("notes are never read by scoring", () => {
  it("is not referenced anywhere in the scoring path", () => {
    // Structural: notes are never read by scoring (`SetAdvisoryNoteSchema` in shared), which holds
    // only while no scorer names the field.
    const root = path.resolve(import.meta.dirname, "../src");
    const scoringSources = [
      "services/scoreItems.ts",
      "services/judgeEnsemble.ts",
      "services/bandEstimator.ts",
      "services/deterministicScoring.ts",
      "services/mcqScorer.ts",
      "services/ctwScorer.ts",
      "services/sentenceScorer.ts",
      "services/arbiter.ts",
      "services/scoringJobs.ts",
      "services/moduleRouter.ts",
      "services/sectionEstimates.ts",
      "routes/stats.ts",
    ];
    for (const relative of scoringSources) {
      const file = path.join(root, relative);
      // A moved or renamed scoring file fails here rather than dropping out of the check unseen.
      expect(fs.existsSync(file), `${relative} is not where the scoring path lives; update this list`).toBe(true);
      expect(fs.readFileSync(file, "utf8"), relative).not.toContain("advisoryNotes");
    }
  });
});
