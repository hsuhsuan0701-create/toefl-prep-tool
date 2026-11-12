import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { framelessWritingSet } from "./helpers/setFixtures.js";
import { AnySetSchema, type AnySet } from "@toefl-prep/shared";
import { app } from "../src/index.js";
import { config } from "../src/lib/config.js";
import { listSetLoadFailures, listSets, reportSetLoadFailures } from "../src/routes/sets.js";
import { createSetStore } from "../src/services/setStore.js";
import { READING_FIXTURE } from "./fixtures/reading-set.fixture.js";

const writingSet = framelessWritingSet("wri-test1");

const speakingSet = {
  id: "spk-test1", kind: "speaking", source: "generated", createdAt: "2026-07-27T00:00:00Z",
  listenAndRepeat: {
    scenarioTitle: "At the campus bookstore",
    scenarioDescription: "You are helping a new student find course materials.",
    items: Array.from({ length: 7 }, (_, i) => ({
      id: `lr${i + 1}`, sentence: `Sentence number ${i + 1} for practice.`,
      audio: `stimuli/spk-test1/lr${i + 1}.mp3`,
      responseWindowSec: i < 2 ? 8 : i < 5 ? 10 : 12,
    })),
  },
  interview: {
    scenarioTitle: "Campus research study", intro: "Thanks for joining us today.",
    introAudio: "stimuli/spk-test1/int-intro.mp3",
    questions: Array.from({ length: 4 }, (_, i) => ({
      id: `iq${i + 1}`, type: i < 2 ? "factual" : "opinion",
      question: `Question ${i + 1}?`, audio: `stimuli/spk-test1/iq${i + 1}.mp3`,
      responseWindowSec: 45,
    })),
  },
};

beforeAll(() => {
  const dir = path.join(config.dataDir, "question-sets/writing");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "wri-test1.json"), JSON.stringify(writingSet));
  const speakingDir = path.join(config.dataDir, "question-sets/speaking");
  fs.mkdirSync(speakingDir, { recursive: true });
  fs.writeFileSync(path.join(speakingDir, "spk-test1.json"), JSON.stringify(speakingSet));
  const readingDir = path.join(config.dataDir, "question-sets/reading");
  fs.mkdirSync(readingDir, { recursive: true });
  fs.writeFileSync(path.join(readingDir, "rd-fixture1.json"), JSON.stringify(READING_FIXTURE));
  return () => {
    fs.rmSync(path.join(dir, "wri-test1.json"));
    fs.rmSync(path.join(speakingDir, "spk-test1.json"));
    fs.rmSync(path.join(readingDir, "rd-fixture1.json"));
  };
});

describe("sets routes", () => {
  // Every published Speaking Set in the real bank must parse and be listed. `listSets` skips a file
  // that fails AnySetSchema, so tightening a literal in, say, SpeakingAudioProfileSchema would make
  // published Sets vanish from the picker. GET /api/sets/unloadable reports that after the fact;
  // this test stops it beforehand.
  //
  // Read from `config.projectRoot`, not `config.dataDir`, which the suite points at a per-file copy
  // of the bank. Read-only: nothing here writes under data/.
  //
  // The counts are derived from the directory, because the bank grows when a Set is generated and
  // a hardcoded count would fail on correct behaviour. The one number written down is a floor: Sets
  // are only ever added, so a shrinking bank is a real failure.
  it("keeps every published Speaking Set in the real bank parseable and listed", () => {
    const MIN_BANKED_SPEAKING_SETS = 12;
    const realDataDir = path.join(config.projectRoot, "data");
    const speakingDir = path.join(realDataDir, "question-sets/speaking");
    const files = fs.readdirSync(speakingDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(MIN_BANKED_SPEAKING_SETS);

    const parsed = files.map((f) => {
      // safeParse, and only the file name in the failure message: a zod message quotes the offending
      // values, here target sentences and interview questions (setStore.ts's safeSetErrorDescriptor
      // exists for the same reason).
      const result = AnySetSchema.safeParse(JSON.parse(fs.readFileSync(path.join(speakingDir, f), "utf8")));
      expect(result.success, `speaking/${f} no longer parses`).toBe(true);
      expect(result.data?.kind).toBe("speaking");
      return result.data as Extract<AnySet, { kind: "speaking" }>;
    });
    // Every file parsed, and no two files claim one id.
    expect(parsed).toHaveLength(files.length);
    expect(new Set(parsed.map((set) => set.id)).size).toBe(files.length);

    // With no supersessions passed, `listSets` withholds nothing.
    const listedIds = listSets(realDataDir).filter((s) => s.kind === "speaking").map((s) => s.id);
    expect([...listedIds].sort()).toEqual([...parsed.map((set) => set.id)].sort());
  });

  // The Writing counterpart. `WritingSetSchema` derives from `WritingGenerationInputSchema`, so
  // tightening the generation input tightens the banked Sets too, and a Set that stops parsing does
  // not error: it leaves the picker and takes its past Attempts out of review. That is why a Build a
  // Sentence `frame` is optional on the persisted Item. Every banked Item happens to carry a frame
  // and a 4–7 tile count, but those rules stay in post-generation code
  // (services/buildASentenceConformance.ts), so a Set that breaks one fails as a report rather than
  // disappearing. Read the same way as the Speaking test above.
  it("keeps every published Writing Set in the real bank parseable and listed", () => {
    const MIN_BANKED_WRITING_SETS = 12;
    const realDataDir = path.join(config.projectRoot, "data");
    const writingDir = path.join(realDataDir, "question-sets/writing");
    const files = fs.readdirSync(writingDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(MIN_BANKED_WRITING_SETS);

    const parsed = files.map((f) => {
      // safeParse and the file name only: a zod message quotes the offending values, here scenario
      // text and tile contents.
      const result = AnySetSchema.safeParse(JSON.parse(fs.readFileSync(path.join(writingDir, f), "utf8")));
      expect(result.success, `writing/${f} no longer parses`).toBe(true);
      expect(result.data?.kind).toBe("writing");
      return result.data as Extract<AnySet, { kind: "writing" }>;
    });
    expect(new Set(parsed.map((set) => set.id)).size).toBe(files.length);

    const listedIds = listSets(realDataDir).filter((s) => s.kind === "writing").map((s) => s.id);
    expect([...listedIds].sort()).toEqual([...parsed.map((set) => set.id)].sort());
  });
  it("lists sets with metadata only", async () => {
    const res = await app.request("/api/sets?kind=writing");
    const list = (await res.json()) as { id: string; kind: string }[];
    const row = list.find((s) => s.id === "wri-test1");
    expect(row).toBeDefined();
    // Found by id, not taken as list[0]: other Sets in the bank sort around it, and a generated Set
    // may carry an optional `advisoryNotes` key, so the exact key list holds for this row only.
    expect(Object.keys(row!).sort()).toEqual(["attempted", "createdAt", "id", "kind", "source", "summary", "title"]);
    // Every row carries metadata only, whichever Sets are in the bank: no Set content reaches the
    // listing. `advisoryNotes` is metadata by construction (SetAdvisoryNoteSchema has no field
    // content could occupy), and `title` and `summary` are derived from the served, answer-stripped
    // Set (services/setTitle.ts).
    const allowed = new Set(["attempted", "createdAt", "id", "kind", "source", "summary", "title", "advisoryNotes"]);
    for (const entry of list) {
      expect(Object.keys(entry).filter((key) => !allowed.has(key))).toEqual([]);
    }
  });
  it("serves a set with answers stripped", async () => {
    const res = await app.request("/api/sets/wri-test1");
    expect(res.status).toBe(200);
    const set = await res.json();
    expect(set.buildASentence.items[0]).not.toHaveProperty("answers");
  });
  // `wri-test1` stores its three tiles in answer order on all 10 Items, the shape that gives the
  // answer away. With three distinct tiles all in the answer, "reads as the answer" is exactly
  // "equals ['a', 'b', 'c']", so this asserts a real property under production's own Math.random
  // without pinning a draw or flaking: tileScramble.ts's re-draw gate rules that order out.
  it("scrambles Build a Sentence tiles when it serves a Set, and leaves the Set on disk untouched", async () => {
    const file = path.join(config.dataDir, "question-sets/writing/wri-test1.json");
    const onDiskBefore = fs.readFileSync(file, "utf8");

    const res = await app.request("/api/sets/wri-test1");
    expect(res.status).toBe(200);
    const set = (await res.json()) as { buildASentence: { items: { id: string; tiles: string[] }[] } };
    for (const item of set.buildASentence.items) {
      expect(item.tiles, `${item.id} served in answer order`).not.toEqual(["a", "b", "c"]);
      expect([...item.tiles].sort()).toEqual(["a", "b", "c"]);
    }

    // Sets are immutable, and scoring reads the Set off disk rather than what the client was served:
    // the tray a User sees moves, and the answer key it is scored against does not.
    expect(fs.readFileSync(file, "utf8")).toBe(onDiskBefore);
    const stored = createSetStore(config.dataDir).readSet("wri-test1") as Extract<AnySet, { kind: "writing" }>;
    expect(stored.buildASentence.items[0]!.tiles).toEqual(["a", "b", "c"]);
    expect(stored.buildASentence.items[0]!.answers).toEqual([["a", "b", "c"]]);
  });
  it("serves a speaking set with the L&R sentence and interview question text stripped", async () => {
    const res = await app.request("/api/sets/spk-test1");
    expect(res.status).toBe(200);
    const set = await res.json();
    for (const item of set.listenAndRepeat.items) expect(item).not.toHaveProperty("sentence");
    for (const q of set.interview.questions) expect(q).not.toHaveProperty("question");
    // ids/audio/responseWindowSec and scenario/intro metadata survive
    expect(set.listenAndRepeat.items[0]).toMatchObject({ id: "lr1", audio: "stimuli/spk-test1/lr1.mp3", responseWindowSec: 8 });
    expect(set.interview.questions[0]).toMatchObject({ id: "iq1", audio: "stimuli/spk-test1/iq1.mp3", responseWindowSec: 45 });
    expect(set.interview.intro).toBe("Thanks for joining us today.");
    expect(JSON.stringify(set)).not.toContain("Sentence number");
    expect(JSON.stringify(set)).not.toMatch(/"question":"Question \d\?"/);
  });
  it("404s an unknown set", async () => {
    expect((await app.request("/api/sets/nope")).status).toBe(404);
  });
  // Both traversal tests aim at a valid Set planted one level above the kind directories, at
  // question-sets/wri-escaped.json, which `question-sets/<kind>/../wri-escaped.json` resolves to. A
  // 404 for a path that does not exist proves nothing; here the target exists and parses, so only the
  // id guard (SET_ID_RE) and the kind-directory boundary check in setStore.readSet keep it unserved.
  // Either one alone blocks it.
  describe("an id that climbs out of the kind directories", () => {
    const escapedFile = path.join(config.dataDir, "question-sets/wri-escaped.json");
    const escapedSet = { ...writingSet, id: "wri-escaped" };

    beforeAll(() => {
      expect(AnySetSchema.safeParse(escapedSet).success).toBe(true);
      fs.writeFileSync(escapedFile, JSON.stringify(escapedSet));
      return () => fs.rmSync(escapedFile, { force: true });
    });

    it("does not serve the planted Set to an encoded-slash id (..%2F), which the route decodes to ../", async () => {
      const res = await app.request("/api/sets/..%2Fwri-escaped");
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("wri-escaped");
    });

    // A literal ../ in a URL is collapsed by URL parsing before routing, so it never reaches the
    // route's id. It does reach the store in a JSON body (POST /api/attempts takes `setId` as any
    // non-empty string), so it is tested there.
    it("does not read the planted Set for a plain ../ id at the store", () => {
      expect(createSetStore(config.dataDir).readSet("../wri-escaped")).toBeUndefined();
    });
  });
  it("a malformed set file's own text never reaches the log — neither readSet's nor listSets' warning", () => {
    // JSON.parse's SyntaxError quotes a fragment of what it choked on, and in a Set file that
    // fragment is scenario text, an interview question or a target sentence. Set text is never
    // logged, on error paths included.
    const canary = "ORCHESTRATION_LOG_CANARY_scenario_text_that_must_never_be_logged";
    const dir = path.join(config.dataDir, "question-sets/writing");
    const corruptPath = path.join(dir, "wri-privacycanary.json");
    fs.writeFileSync(corruptPath, canary); // not JSON at all: JSON.parse throws quoting its first chars
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(createSetStore(config.dataDir).readSet("wri-privacycanary")).toBeUndefined();
      expect(listSets(config.dataDir).some((s) => s.id === "wri-privacycanary")).toBe(false);
      const logged = warnSpy.mock.calls.flat(2).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
      expect(warnSpy).toHaveBeenCalled(); // the warning paths really ran
      expect(logged).not.toContain(canary);
      expect(logged).not.toContain("ORCHESTRAT"); // the fragment Node 24's SyntaxError embeds
      expect(logged).toContain("SyntaxError"); // the bounded descriptor still names the error kind
      expect(logged).toContain("wri-privacycanary"); // and the filename still points at the culprit
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(corruptPath, { force: true });
    }
  });

  it("lists and serves reading sets stripped", async () => {
    const res = await app.request("/api/sets?kind=reading");
    const list = (await res.json()) as { id: string; kind: string }[];
    // Found by id, not position: the bank holds other Reading Sets.
    const fixture = list.find((s) => s.id === "rd-fixture1");
    expect(fixture).toMatchObject({ id: "rd-fixture1", kind: "reading" });
    const detail = await (await app.request("/api/sets/rd-fixture1")).json();
    expect(JSON.stringify(detail)).not.toContain("correctOptionId");
  });

  // Every published Reading Set in the real bank parses and carries ETS's module time limits, read
  // from `config.projectRoot` as above, so a tightened schema cannot silently drop one from the
  // picker. Many banked Sets were generated when the Upper Module still had a Daily Life text, so
  // they carry an upper `dailyLife` text and a six-entry `generationPlan.dailyLifeTexts`, a shape
  // the current composition table does not describe. Sets are re-parsed on every read, so binding
  // the persisted schema to the generation counts would make that whole corpus vanish.
  it("keeps every published Reading Set in the real bank parseable, and confirms all carry the official module time limits", () => {
    const realDataDir = path.join(config.projectRoot, "data");
    const readingDir = path.join(realDataDir, "question-sets/reading");
    const files = fs.readdirSync(readingDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(5);

    let withUpperDailyLife = 0;
    for (const f of files) {
      const result = AnySetSchema.safeParse(JSON.parse(fs.readFileSync(path.join(readingDir, f), "utf8")));
      expect(result.success, `reading/${f} no longer parses`).toBe(true);
      expect(result.data?.kind).toBe("reading");
      const set = result.data as Extract<AnySet, { kind: "reading" }>;
      expect(set.router.timeLimitSec, f).toBe(1200);
      expect(set.lowerModule.timeLimitSec, f).toBe(540);
      expect(set.upperModule.timeLimitSec, f).toBe(540);
      if (set.upperModule.dailyLife.length > 0) {
        withUpperDailyLife++;
        // A Set of the earlier composition: its plan carries the Daily Life entry for that text too.
        expect(set.generationPlan?.dailyLifeTexts.length, f).toBe(6);
      }
    }
    // A floor, not "all of them": Sets generated under the current composition have no upper Daily
    // Life text. What must not happen is the older corpus dropping out because it stopped parsing,
    // which the per-file assertion would catch first.
    expect(withUpperDailyLife).toBeGreaterThanOrEqual(7);
  });

  // Every published Listening Set in the real bank parses and carries ETS's module time limits
  // (router 1080s, lower 420s, upper 660s), read from `config.projectRoot` as above.
  // `lsn-2e77a970` and `lsn-fc96bdab` are named because their limits were corrected by hand, so the
  // test fails if either leaves the bank or loses them.
  it("keeps every published Listening Set in the real bank parseable and on the official module time limits, lsn-2e77a970 and lsn-fc96bdab included", () => {
    const realDataDir = path.join(config.projectRoot, "data");
    const listeningDir = path.join(realDataDir, "question-sets/listening");
    const files = fs.readdirSync(listeningDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(2);

    const parsed = new Map(files.map((f) => {
      const result = AnySetSchema.safeParse(JSON.parse(fs.readFileSync(path.join(listeningDir, f), "utf8")));
      expect(result.success, `listening/${f} no longer parses`).toBe(true);
      expect(result.data?.kind).toBe("listening");
      const set = result.data as Extract<AnySet, { kind: "listening" }>;
      return [set.id, set] as const;
    }));

    // Every other published Listening Set carries the same limits.
    for (const [id, set] of parsed) {
      if (id === "lsn-2e77a970" || id === "lsn-fc96bdab") continue;
      expect(set.router.timeLimitSec, id).toBe(1080);
      expect(set.lowerModule.timeLimitSec, id).toBe(420);
      expect(set.upperModule.timeLimitSec, id).toBe(660);
    }

    for (const id of ["lsn-2e77a970", "lsn-fc96bdab"]) {
      const set = parsed.get(id);
      expect(set, id).toBeDefined();
      expect(set!.router.timeLimitSec, id).toBe(1080);
      expect(set!.lowerModule.timeLimitSec, id).toBe(420);
      expect(set!.upperModule.timeLimitSec, id).toBe(660);
    }

    // Why ListeningSetSchema binds the unpinned published plan shape rather than the
    // composition-derived one: banked Listening Sets carry a `generationPlan` at the counts the
    // composition table had when they were generated (20 / 7 / 5 / 4), and the plan is re-validated
    // on every read. Bound to the derived lengths, the whole bank would stop parsing the day
    // LISTENING_MODULE_COMPOSITION changed by one entry, taking every past Listening Attempt's review
    // with it. The literals are hardcoded, not derived, because they describe what is on disk.
    let plansAtTheGeneratedCounts = 0;
    for (const [id, set] of parsed) {
      const plan = set.generationPlan;
      expect(plan, `listening/${id} lost its generationPlan`).toBeDefined();
      if (
        plan!.listenChoose.length === 20 && plan!.conversations.length === 7
        && plan!.announcements.length === 5 && plan!.academicTalks.length === 4
      ) plansAtTheGeneratedCounts++;
    }
    // A floor, not "all of them", for the Reading test's reason: Sets generated after a retune
    // would carry its counts.
    expect(plansAtTheGeneratedCounts).toBeGreaterThanOrEqual(13);
  });

  // The same two Sets through the real route, from this file's copy of the bank: answers stripped,
  // and the time limits reach the client unchanged, since nothing strips timeLimitSec.
  it("serves lsn-2e77a970 and lsn-fc96bdab with answers stripped and the official module time limits", async () => {
    for (const id of ["lsn-2e77a970", "lsn-fc96bdab"]) {
      const res = await app.request(`/api/sets/${id}`);
      expect(res.status, id).toBe(200);
      const set = await res.json();
      expect(set.kind).toBe("listening");
      expect(set.router.timeLimitSec).toBe(1080);
      expect(set.lowerModule.timeLimitSec).toBe(420);
      expect(set.upperModule.timeLimitSec).toBe(660);
      expect(JSON.stringify(set)).not.toContain("correctOptionId");
      expect(JSON.stringify(set)).not.toContain("explanationZh");
    }
  });

  it("tolerates an absent reading/ (and listening/) directory instead of throwing", () => {
    // A data directory may have no question-sets/reading or listening folder at all; listSets and
    // readSet skip a missing kind silently.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sets-no-reading-dir-"));
    const dir = path.join(dataDir, "question-sets/writing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "wri-onlyone.json"), JSON.stringify({ ...writingSet, id: "wri-onlyone" }));
    try {
      expect(() => listSets(dataDir)).not.toThrow();
      const ids = listSets(dataDir).map((s) => s.id);
      expect(ids).toContain("wri-onlyone");
      expect(ids).not.toContain("rd-fixture1");
      expect(createSetStore(dataDir).readSet("rd-fixture1")).toBeUndefined();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("lists and reads a reading set seeded into an otherwise-empty data dir", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sets-reading-seeded-"));
    const dir = path.join(dataDir, "question-sets/reading");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rd-fixture1.json"), JSON.stringify(READING_FIXTURE));
    try {
      expect(listSets(dataDir).map((s) => s.id)).toContain("rd-fixture1");
      expect(createSetStore(dataDir).readSet("rd-fixture1")?.kind).toBe("reading");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("skips corrupt set files in listSets", async () => {
    const dir = path.join(config.dataDir, "question-sets/writing");
    const corruptPath = path.join(dir, "corrupt-test.json");
    fs.writeFileSync(corruptPath, "{ invalid json }");
    try {
      const res = await app.request("/api/sets?kind=writing");
      const list = (await res.json()) as { id: string }[];
      expect(list.some((s) => s.id === "wri-test1")).toBe(true);
      expect(list.some((s) => s.id === "corrupt-test")).toBe(false);
    } finally {
      fs.rmSync(corruptPath);
    }
  });
});

// One malformed Set file must not blank the bank, so a file that fails AnySetSchema is skipped. On
// its own that makes a schema narrowing silent data loss: the Set stops appearing and nothing says
// why. So both halves are pinned together: the healthy Sets still list, and the ones that did not
// are named, with the field that broke, somewhere other than a stderr line.
describe("Set files that fail validation are reported, not silently dropped", () => {
  // Text that is only ever inside the broken files. `email.scenario` and a raw-text corrupt file are
  // the two shapes that leak: a zod message quotes the offending value and Node 24's SyntaxError
  // quotes the fragment it choked on. Neither may reach a log or an API response.
  const CANARY = "UNLOADABLE_CANARY_scenario_text_that_must_never_be_disclosed";

  // One healthy Set, one that is valid JSON but fails the schema at a known field, one that is not
  // JSON at all — the three populations the disclosure has to tell apart.
  function seedBank(): string {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sets-unloadable-"));
    const dir = path.join(dataDir, "question-sets/writing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "wri-healthy.json"), JSON.stringify({ ...writingSet, id: "wri-healthy" }));
    fs.writeFileSync(
      path.join(dir, "wri-schemabroken.json"),
      JSON.stringify({
        ...writingSet,
        id: "wri-schemabroken",
        email: { ...writingSet.email, scenario: CANARY, bullets: "seven minutes" },
      }),
    );
    fs.writeFileSync(path.join(dir, "wri-notjson.json"), `{ ${CANARY}`);
    return dataDir;
  }

  it("lists the rest of the bank while naming every file it could not load and the field that broke", () => {
    const dataDir = seedBank();
    try {
      // A malformed Set file does not stop the rest from listing...
      const listed = listSets(dataDir).map((s) => s.id);
      expect(listed).toContain("wri-healthy");
      expect(listed).not.toContain("wri-schemabroken");
      expect(listed).not.toContain("wri-notjson");

      // ...and the two it dropped are reported rather than gone.
      const failures = listSetLoadFailures(dataDir);
      expect(failures.map((f) => f.file).sort()).toEqual(["wri-notjson.json", "wri-schemabroken.json"]);
      expect(new Set(failures.map((f) => f.kind))).toEqual(new Set(["writing"]));

      // The schema failure names the failing path and rule, which is what tells a schema narrowing
      // from a corrupt file; "ZodError" alone would not.
      const schemaFailure = failures.find((f) => f.file === "wri-schemabroken.json")!;
      expect(schemaFailure.error).toContain("email.bullets");
      expect(schemaFailure.error).toContain("invalid_type");
      expect(schemaFailure.error).toContain("array"); // what the schema demanded, never what the file held
      expect(failures.find((f) => f.file === "wri-notjson.json")!.error).toContain("SyntaxError");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("names the failing field without ever quoting the file's own text", () => {
    // The rule "a malformed set file's own text never reaches the log" holds for the HTTP payload
    // too. The descriptor is built from an allow-list of zod issue fields (path, code, expected,
    // origin), so widening the diagnostic cannot widen the leak.
    const dataDir = seedBank();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const disclosed = JSON.stringify(listSetLoadFailures(dataDir));
      expect(disclosed).not.toContain(CANARY);
      expect(disclosed).not.toContain("UNLOADABLE_CANARY");
      expect(disclosed).not.toContain("seven minutes"); // the offending value, which zod's own message quotes

      reportSetLoadFailures(dataDir);
      const logged = errorSpy.mock.calls.flat(2).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
      expect(logged).not.toContain("UNLOADABLE_CANARY");
      expect(logged).not.toContain("seven minutes");
    } finally {
      errorSpy.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reports the count and every file at startup, on the error channel", () => {
    const dataDir = seedBank();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failures = reportSetLoadFailures(dataDir);
      expect(failures).toHaveLength(2);
      const logged = errorSpy.mock.calls.flat(2).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
      expect(logged).toContain("2 Set file(s)");
      expect(logged).toContain("writing/wri-schemabroken.json");
      expect(logged).toContain("writing/wri-notjson.json");
      expect(logged).toContain("email.bullets");
    } finally {
      errorSpy.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("says nothing at startup when every Set on disk loads", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sets-all-healthy-"));
    const dir = path.join(dataDir, "question-sets/writing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "wri-healthy.json"), JSON.stringify({ ...writingSet, id: "wri-healthy" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(reportSetLoadFailures(dataDir)).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("answers the count from the running app: GET /api/sets/unloadable, while the listing keeps working", async () => {
    // Discoverable from the running app, not only from stderr. Seeded into this file's copy of the
    // bank, so it goes through the real route and config.dataDir as the browser would.
    const dir = path.join(config.dataDir, "question-sets/writing");
    const brokenPath = path.join(dir, "wri-routeunloadable.json");
    fs.writeFileSync(
      brokenPath,
      JSON.stringify({ ...writingSet, id: "wri-routeunloadable", email: { ...writingSet.email, timeLimitSec: "later" } }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await app.request("/api/sets/unloadable");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number; failures: { kind: string; file: string; error: string }[] };
      // Not an exact count: the bank also holds this file's other fixtures.
      expect(body.count).toBe(body.failures.length);
      const mine = body.failures.find((f) => f.file === "wri-routeunloadable.json");
      expect(mine).toMatchObject({ kind: "writing" });
      expect(mine!.error).toContain("email.timeLimitSec");

      const listed = (await (await app.request("/api/sets?kind=writing")).json()) as { id: string }[];
      expect(listed.some((s) => s.id === "wri-test1")).toBe(true);
      expect(listed.some((s) => s.id === "wri-routeunloadable")).toBe(false);
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(brokenPath, { force: true });
    }
  });
});

describe("audio routes", () => {
  it("downloads a valid audio file", async () => {
    const res = await app.request("/api/audio/stimuli/spk-e5b2b735/lr-1.mp3");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(0);
  });
  it("404s for missing audio file", async () => {
    const res = await app.request("/api/audio/stimuli/spk-e5b2b735/missing.mp3");
    expect(res.status).toBe(404);
  });
  // The traversal tests below each target a real file with a servable extension outside the base,
  // and expect exactly 403. A 404 would also come from the canonical-path check or from a missing
  // file, so it cannot show that the lexical guard (the 403) is in place.
  it("answers 403 to a traversal out of stimuli, and does not serve the file it points at", async () => {
    const outsideFile = path.join(config.dataDir, "audio/outside-stimuli.mp3");
    fs.writeFileSync(outsideFile, "outside-stimuli-bytes");
    try {
      const res = await app.request("/api/audio/stimuli/spk-e5b2b735/..%2F..%2Foutside-stimuli.mp3");
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("outside-stimuli-bytes");
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });
  it("rejects sibling-directory-prefix traversal (stimuli-evil is not inside stimuli)", async () => {
    // "stimuli-evil" string-prefix-matches "stimuli" without a separator, so a boundary check
    // that used target.startsWith(base) instead of target.startsWith(base + path.sep) would let
    // this escape. Route through the file param (not a bare ".." setId) because a literal ".."
    // path segment never survives WHATWG URL normalization on the way in.
    const evilDir = path.join(config.dataDir, "audio/stimuli-evil");
    fs.mkdirSync(evilDir, { recursive: true });
    fs.writeFileSync(path.join(evilDir, "secret.mp3"), "top-secret");
    try {
      const res = await app.request("/api/audio/stimuli/x/..%2F..%2Fstimuli-evil%2Fsecret.mp3");
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("top-secret");
    } finally {
      fs.rmSync(evilDir, { recursive: true, force: true });
    }
  });
  it("404s (not 500 EISDIR) when the resolved target is a directory", async () => {
    const res = await app.request("/api/audio/stimuli/spk-e5b2b735/..%2Fspk-e5b2b735");
    expect(res.status).toBe(404);
  });

  // A stimulus is served from exactly `stimuli/<setId>/<file>`, the shape every banked Set's `audio`
  // field has. The tests below pin what the file guard must refuse inside a Set's own directory.
  describe("inside a Set's stimulus directory", () => {
    const setDir = path.join(config.dataDir, "audio/stimuli/spk-audioroute");

    beforeAll(() => {
      fs.mkdirSync(path.join(setDir, "nested"), { recursive: true });
      fs.writeFileSync(path.join(setDir, "lr-1.mp3"), "set-mp3-bytes");
      fs.writeFileSync(path.join(setDir, "nested", "lr-1.mp3"), "nested-mp3-bytes");
      fs.writeFileSync(
        path.join(setDir, "audio-manifest.json"),
        JSON.stringify({ baseClipCount: 13, clips: [{ file: "lr-1.mp3", role: "lr-item", wordCount: 12 }] }),
      );
      return () => fs.rmSync(setDir, { recursive: true, force: true });
    });

    it("serves a clip at stimuli/<setId>/<file>, and nothing nested deeper", async () => {
      const res = await app.request("/api/audio/stimuli/spk-audioroute/lr-1.mp3");
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("set-mp3-bytes");
      expect((await app.request("/api/audio/stimuli/spk-audioroute/nested/lr-1.mp3")).status).toBe(404);
    });

    it("rejects traversal escaping from a Set's directory", async () => {
      // A real file outside the base, so this cannot pass merely because the target does not exist
      // (the trap the scene-image traversal test below describes).
      const evilDir = path.join(config.dataDir, "audio/stimuli-evil");
      fs.mkdirSync(evilDir, { recursive: true });
      fs.writeFileSync(path.join(evilDir, "secret.mp3"), "top-secret");
      try {
        const res = await app.request("/api/audio/stimuli/spk-audioroute/..%2F..%2Fstimuli-evil%2Fsecret.mp3");
        expect(res.status).toBe(403);
        expect(Buffer.from(await res.arrayBuffer()).toString()).not.toBe("top-secret");
      } finally {
        fs.rmSync(evilDir, { recursive: true, force: true });
      }
    });

    it("rejects a symlink under stimuli that points at a readable file outside it", async (context) => {
      // The containment check is lexical and cannot see through a symlink; the realpath check
      // closes that, and this test proves it is wired in.
      const outsideFile = path.join(config.dataDir, "audio/outside-controlled.mp3");
      const link = path.join(setDir, "linked.mp3");
      fs.writeFileSync(outsideFile, "outside-secret-bytes");
      try {
        try {
          fs.symlinkSync(outsideFile, link);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
            context.skip(`platform cannot create the required test symlink (${code})`);
            return;
          }
          throw error;
        }
        const res = await app.request("/api/audio/stimuli/spk-audioroute/linked.mp3");
        expect(res.status).toBe(404);
        expect(Buffer.from(await res.arrayBuffer()).toString()).not.toBe("outside-secret-bytes");
      } finally {
        fs.rmSync(link, { force: true });
        fs.rmSync(outsideFile, { force: true });
      }
    });

    it("does not serve audio-manifest.json (per-clip wordCount is an answer-length leak)", async () => {
      // speakingAudioRenderer writes the manifest into the served directory. Without the extension
      // filter, GET /api/audio/stimuli/<setId>/audio-manifest.json would give out the word count of
      // every target sentence and interview question before the User answers, in a flow built to
      // keep those sentences hidden.
      const res = await app.request("/api/audio/stimuli/spk-audioroute/audio-manifest.json");
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    });
  });
});

describe("scene image routes", () => {
  const scenariosDir = path.join(config.dataDir, "images/scenarios");
  const setId = "spk-imageroute1";
  const validWebp = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WEBP"),
    Buffer.from("test-image-payload"),
  ]);

  beforeAll(() => {
    fs.mkdirSync(scenariosDir, { recursive: true });
    fs.writeFileSync(path.join(scenariosDir, `${setId}.webp`), validWebp);
    return () => fs.rmSync(path.join(scenariosDir, `${setId}.webp`), { force: true });
  });

  it("serves a valid WebP with its exact content type and immutable cache policy", async () => {
    // image.file is stored dataDir-relative ("images/scenarios/<setId>.webp"), and the route is
    // mounted so that string after /api/ is its URL: the client never rebuilds the path.
    const res = await app.request(`/api/images/scenarios/${setId}.webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(validWebp);
  });

  it("404s for a set that has no scene image", async () => {
    const res = await app.request("/api/images/scenarios/spk-nosuchset.webp");
    expect(res.status).toBe(404);
  });

  it("rejects a file whose extension is not .webp", async () => {
    const target = path.join(scenariosDir, "spk-wrong-extension.txt");
    fs.writeFileSync(target, validWebp);
    try {
      const res = await app.request("/api/images/scenarios/spk-wrong-extension.txt");
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it("rejects a .webp file whose bytes do not contain the WebP magic", async () => {
    const target = path.join(scenariosDir, "spk-wrong-magic.webp");
    fs.writeFileSync(target, "not a WebP image");
    try {
      const res = await app.request("/api/images/scenarios/spk-wrong-magic.webp");
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it("rejects a symlink inside scenarios that points to a readable file outside it", async (context) => {
    const outsideFile = path.join(config.dataDir, "images/outside-controlled.webp");
    const link = path.join(scenariosDir, "spk-symlink.webp");
    const outsideBytes = Buffer.concat([validWebp, Buffer.from("-outside-secret")]);
    fs.writeFileSync(outsideFile, outsideBytes);
    try {
      try {
        fs.symlinkSync(outsideFile, link);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
          context.skip(`platform cannot create the required test symlink (${code})`);
          return;
        }
        throw error;
      }

      const res = await app.request("/api/images/scenarios/spk-symlink.webp");
      expect(res.status).toBe(404);
      expect(Buffer.from(await res.arrayBuffer())).not.toEqual(outsideBytes);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("rejects path traversal in scene images", async () => {
    // Requesting ..%2F..%2Fetc%2Fpasswd and accepting 403 or 404 would pass with the guard deleted,
    // since that path does not exist under the data directory and a 404 satisfies it. So this
    // traverses to a file that exists one level up: without the guard it serves 200, with it 403.
    const outsideFile = path.join(config.dataDir, "images/not-a-scenario.webp");
    fs.writeFileSync(outsideFile, "reachable only if the guard is missing");
    try {
      const res = await app.request("/api/images/scenarios/..%2Fnot-a-scenario.webp");
      expect(res.status).toBe(403);
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("rejects sibling-directory-prefix traversal (scenarios-evil is not inside scenarios)", async () => {
    // Same class of bug as the audio routes' "stimuli-evil" case: "scenarios-evil" string-prefix-
    // matches "scenarios" without a separator, so target.startsWith(base) instead of
    // target.startsWith(base + path.sep) would let this escape.
    const evilDir = path.join(config.dataDir, "images/scenarios-evil");
    fs.mkdirSync(evilDir, { recursive: true });
    fs.writeFileSync(path.join(evilDir, "secret.webp"), validWebp);
    try {
      const res = await app.request("/api/images/scenarios/..%2Fscenarios-evil%2Fsecret.webp");
      expect(res.status).toBe(403);
    } finally {
      fs.rmSync(evilDir, { recursive: true, force: true });
    }
  });

  it("404s (not 500 EISDIR) when the resolved target is the scenarios directory itself", async () => {
    // Resolves back to `base`, the one case the traversal guard deliberately lets through
    // (target !== base is false), so it is the statSync().isFile() check that has to catch it.
    // A literal "." segment can't be used here — it never survives URL normalization into the param.
    const res = await app.request("/api/images/scenarios/..%2Fscenarios");
    expect(res.status).toBe(404);
  });
});

describe("responses audio routes", () => {
  const attemptId = "audio-route-test-attempt";
  const dir = path.join(config.dataDir, "audio/responses", attemptId);

  beforeAll(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "item1.webm"), "fake-webm-bytes");
    fs.writeFileSync(path.join(dir, "item1.mp3"), "fake-mp3-bytes");
    return () => fs.rmSync(path.join(config.dataDir, "audio/responses", attemptId), { recursive: true, force: true });
  });

  it("serves a webm response recording with Content-Type audio/webm", async () => {
    const res = await app.request(`/api/audio/responses/${attemptId}/item1.webm`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/webm");
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  it("serves the transcoded mp3 sibling with Content-Type audio/mpeg", async () => {
    const res = await app.request(`/api/audio/responses/${attemptId}/item1.mp3`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
  });

  it("404s for a missing response recording", async () => {
    const res = await app.request(`/api/audio/responses/${attemptId}/missing.webm`);
    expect(res.status).toBe(404);
  });

  it("404s for an unknown attempt id", async () => {
    const res = await app.request(`/api/audio/responses/no-such-attempt/item1.webm`);
    expect(res.status).toBe(404);
  });

  // A real .webm outside the base and an exact 403, for the reason given above the stimuli
  // traversal tests.
  it("answers 403 to a traversal out of responses, and does not serve the file it points at", async () => {
    const outsideFile = path.join(config.dataDir, "audio/outside-responses.webm");
    fs.writeFileSync(outsideFile, "outside-responses-bytes");
    try {
      const res = await app.request(`/api/audio/responses/${attemptId}/..%2F..%2Foutside-responses.webm`);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("outside-responses-bytes");
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("rejects sibling-directory-prefix traversal (responses-evil is not inside responses)", async () => {
    const evilDir = path.join(config.dataDir, "audio/responses-evil");
    fs.mkdirSync(evilDir, { recursive: true });
    fs.writeFileSync(path.join(evilDir, "secret.webm"), "top-secret");
    try {
      const res = await app.request(`/api/audio/responses/x/..%2F..%2Fresponses-evil%2Fsecret.webm`);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("top-secret");
    } finally {
      fs.rmSync(evilDir, { recursive: true, force: true });
    }
  });
});
