import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  AnySetSchema,
  GenerationPlanSchema,
  LISTENING_MODULE_COMPOSITION,
  LISTENING_MODULE_TIME_LIMITS_SEC,
  ListeningGenerationInputSchema,
  ListeningSetSchema,
  stripAnswers,
} from "@toefl-prep/shared";
import { LISTENING_FIXTURE, LISTENING_PLAN_MARKER } from "./fixtures/listening-set.fixture.js";
import { collectObjectKeys, collectSchemaKeys } from "./schemaAssertions.js";

// A minimal generation input that is schema-valid at LISTENING_MODULE_COMPOSITION's exact counts.
// Not LISTENING_FIXTURE: that is a published Set whose router carries one of each Task Type, while
// ListeningGenerationInputSchema binds every module to the composition (router 10/3/3/1). Every
// `audio` field is "", the placeholder the renderer fills (see ListeningGenerationInputSchema).
function speakerEntry(
  id: string,
  gender: "male" | "female" = "female",
) {
  return {
    id, role: "role", gender, accent: "north-american" as const,
    voice: "voice", provider: "openai" as const,
  };
}
function mcqEntry(id: string, correctId: string) {
  return {
    id, stem: `Stem for ${id}?`,
    options: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }],
    correctOptionId: correctId, skill: "detail" as const, explanationZh: "解析",
  };
}
function listenChooseEntry(id: string) {
  return {
    id, taskType: "listen_choose" as const, audio: "",
    speaker: speakerEntry(`${id}-sp`),
    utterance: "placeholder utterance",
    options: [
      { id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }, { id: "d", text: "D" },
    ],
    correctOptionId: "a", skill: "function" as const, explanationZh: "解析",
  };
}
function conversationEntry(id: string) {
  return {
    id, taskType: "conversation" as const, audio: "", setting: "setting",
    speakers: [speakerEntry(`${id}-sp1`, "male"), speakerEntry(`${id}-sp2`, "female")],
    transcript: [
      { speakerId: `${id}-sp1`, text: "placeholder turn one" },
      { speakerId: `${id}-sp2`, text: "placeholder turn two" },
    ],
    questions: [mcqEntry(`${id}-q1`, "a"), mcqEntry(`${id}-q2`, "b")],
  };
}
function announcementEntry(id: string) {
  return {
    id, taskType: "announcement" as const, audio: "", setting: "setting",
    speaker: speakerEntry(`${id}-sp`),
    transcript: "placeholder announcement transcript",
    questions: [mcqEntry(`${id}-q1`, "a"), mcqEntry(`${id}-q2`, "b")],
  };
}
function academicTalkEntry(id: string) {
  return {
    id, taskType: "academic_talk" as const, audio: "", discipline: "discipline",
    speaker: speakerEntry(`${id}-sp`),
    transcript: "placeholder talk transcript",
    questions: [
      mcqEntry(`${id}-q1`, "a"), mcqEntry(`${id}-q2`, "b"),
      mcqEntry(`${id}-q3`, "c"), mcqEntry(`${id}-q4`, "a"),
    ],
  };
}
function moduleGenerationInput(
  counts: { listenChoose: number; conversations: number; announcements: number; academicTalks: number },
  prefix: string,
  // timeLimitSec is a per-module literal (LISTENING_MODULE_TIME_LIMITS_SEC), so a schema-valid
  // generation input supplies the exact value for the module being built.
  timeLimitSec: number,
) {
  return {
    timeLimitSec,
    listenChoose: Array.from({ length: counts.listenChoose }, (_, i) => listenChooseEntry(`${prefix}-lcr${i + 1}`)),
    conversations: Array.from({ length: counts.conversations }, (_, i) => conversationEntry(`${prefix}-conv${i + 1}`)),
    announcements: Array.from({ length: counts.announcements }, (_, i) => announcementEntry(`${prefix}-ann${i + 1}`)),
    academicTalks: Array.from({ length: counts.academicTalks }, (_, i) => academicTalkEntry(`${prefix}-talk${i + 1}`)),
  };
}
function validGenerationInput() {
  return {
    id: "lsn-schematest", kind: "listening" as const, source: "generated" as const,
    createdAt: "2026-08-09T00:00:00.000Z",
    router: moduleGenerationInput(LISTENING_MODULE_COMPOSITION.router, "r", LISTENING_MODULE_TIME_LIMITS_SEC.router),
    lowerModule: moduleGenerationInput(
      LISTENING_MODULE_COMPOSITION.lowerModule, "lo", LISTENING_MODULE_TIME_LIMITS_SEC.lowerModule,
    ),
    upperModule: moduleGenerationInput(
      LISTENING_MODULE_COMPOSITION.upperModule, "up", LISTENING_MODULE_TIME_LIMITS_SEC.upperModule,
    ),
  };
}

describe("listening set schema", () => {
  it("parses the fixture through AnySetSchema", () => {
    expect(AnySetSchema.parse(LISTENING_FIXTURE).kind).toBe("listening");
  });

  it("rejects a listen_choose item without exactly 4 options", () => {
    const bad = structuredClone(LISTENING_FIXTURE);
    bad.router.listenChoose[0]!.options.pop();
    expect(AnySetSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a conversation whose two speakers are the same gender", () => {
    const bad = structuredClone(LISTENING_FIXTURE);
    bad.router.conversations[0]!.speakers[1]!.gender = "male";
    const result = AnySetSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("one male and one female");
  });

  it("rejects a conversation transcript turn that references an unknown speakerId", () => {
    const bad = structuredClone(LISTENING_FIXTURE);
    bad.router.conversations[0]!.transcript[0]!.speakerId = "conv-1-sp-unknown";
    const result = AnySetSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("conv-1-sp-unknown");
  });

  it("accepts the listening plan through GenerationPlanSchema", () => {
    expect(GenerationPlanSchema.parse(LISTENING_FIXTURE.generationPlan).kind).toBe("listening");
  });

  // `generationPlan` is persisted inside every published Set and re-validated on every read
  // (setStore.ts), so binding it to the composition-derived plan lengths would make every banked
  // Listening Set unloadable the day LISTENING_MODULE_COMPOSITION changes by one entry. So the schema
  // is split: ListeningSetSchema takes the unpinned published plan shape, GenerationPlanSchema (the
  // model-facing union) the derived counts. Both halves are asserted on the same off-count plan, so
  // removing either fails. schemas.reading.test.ts has the same pair for Reading.
  it("keeps an off-count published plan (an extra announcement entry) parseable as a Set while the generation union pins the derived count", () => {
    const legacy = structuredClone(LISTENING_FIXTURE);
    const plan = legacy.generationPlan!;
    const derived = LISTENING_MODULE_COMPOSITION.router.announcements
      + LISTENING_MODULE_COMPOSITION.lowerModule.announcements
      + LISTENING_MODULE_COMPOSITION.upperModule.announcements;
    expect(plan.announcements).toHaveLength(derived);
    // The shape a retune would leave the archive in: one plan entry the current table no longer wants.
    plan.announcements.push({ ...plan.announcements[0]!, noveltyKey: "plan-key-ann-off-count" });
    expect(plan.announcements).toHaveLength(derived + 1);

    // The archive half: still a valid published Set, off-count plan and all.
    const parsed = ListeningSetSchema.parse(legacy);
    expect(parsed.generationPlan!.announcements).toHaveLength(derived + 1);
    expect(AnySetSchema.safeParse(legacy).success).toBe(true);
    // The generation half: that same plan is not a plan a fresh PLAN call may emit.
    expect(GenerationPlanSchema.safeParse(plan).success).toBe(false);
  });

  // A valid generation input matches LISTENING_MODULE_COMPOSITION's per-module counts, with every
  // audio field "" for the renderer to fill, as in Speaking.
  it("a generation input matching the exact router/lower/upper composition parses, with audio left as empty-string placeholders", () => {
    const parsed = ListeningGenerationInputSchema.parse(validGenerationInput());
    expect(parsed.router.listenChoose).toHaveLength(LISTENING_MODULE_COMPOSITION.router.listenChoose);
    expect(parsed.upperModule.academicTalks).toHaveLength(LISTENING_MODULE_COMPOSITION.upperModule.academicTalks);
    expect(parsed.lowerModule.academicTalks).toHaveLength(0); // lower drops Academic Talks entirely
    expect(parsed.upperModule.announcements).toHaveLength(0); // upper drops Announcements entirely
    expect(parsed.router.listenChoose[0]!.audio).toBe("");
  });

  it("rejects a router module with the wrong number of listen_choose items (composition is bound, not just checked later)", () => {
    const bad = validGenerationInput();
    bad.router.listenChoose.push(listenChooseEntry("r-lcr-extra"));
    expect(bad.router.listenChoose).toHaveLength(LISTENING_MODULE_COMPOSITION.router.listenChoose + 1);
    expect(ListeningGenerationInputSchema.safeParse(bad).success).toBe(false);
  });

  // ETS's module time limits (router 1080 s, lower 420 s, upper 660 s) are bound per module, as the
  // composition counts are, so a generate call cannot produce a Set with an invented number.
  it("rejects a generation input whose timeLimitSec is not the official ETS value, per module", () => {
    const wrongRouter = validGenerationInput();
    wrongRouter.router.timeLimitSec = 1200; // Reading's router value, not Listening's
    expect(ListeningGenerationInputSchema.safeParse(wrongRouter).success).toBe(false);

    const wrongLower = validGenerationInput();
    wrongLower.lowerModule.timeLimitSec = 700; // an invented value
    expect(ListeningGenerationInputSchema.safeParse(wrongLower).success).toBe(false);

    const wrongUpper = validGenerationInput();
    wrongUpper.upperModule.timeLimitSec = 1500; // an invented value
    expect(ListeningGenerationInputSchema.safeParse(wrongUpper).success).toBe(false);
  });

  it("accepts a generation input carrying exactly the official per-module timeLimitSec values", () => {
    const parsed = ListeningGenerationInputSchema.parse(validGenerationInput());
    expect(parsed.router.timeLimitSec).toBe(LISTENING_MODULE_TIME_LIMITS_SEC.router);
    expect(parsed.lowerModule.timeLimitSec).toBe(LISTENING_MODULE_TIME_LIMITS_SEC.lowerModule);
    expect(parsed.upperModule.timeLimitSec).toBe(LISTENING_MODULE_TIME_LIMITS_SEC.upperModule);
  });

  it("ListeningGenerationInputSchema has no audioProfile/generationPlan field to carry those values forward", () => {
    const withExtras = {
      ...validGenerationInput(),
      audioProfile: LISTENING_FIXTURE.audioProfile,
      generationPlan: LISTENING_FIXTURE.generationPlan,
    };
    const parsed = ListeningGenerationInputSchema.parse(withExtras);
    expect(parsed).not.toHaveProperty("audioProfile");
    expect(parsed).not.toHaveProperty("generationPlan");
  });
});

describe("stripAnswers(listening) leak scan", () => {
  const KNOWN_SECRETS = [
    LISTENING_FIXTURE.router.listenChoose[0]!.utterance, // never shown, as on the real test
    LISTENING_FIXTURE.lowerModule.listenChoose[0]!.utterance,
    LISTENING_FIXTURE.router.conversations[0]!.transcript[0]!.text,
    LISTENING_FIXTURE.router.conversations[0]!.transcript[1]!.text,
    LISTENING_FIXTURE.router.announcements[0]!.transcript,
    LISTENING_FIXTURE.router.academicTalks[0]!.transcript,
    LISTENING_FIXTURE.upperModule.academicTalks[0]!.transcript,
    LISTENING_FIXTURE.router.listenChoose[0]!.speaker.voice, // the actual leaked value, not just the key
    "utterance",
    "transcript",
    "correctOptionId",
    "skill",
    "explanationZh",
    "voice",
    "provider",
    "audioProfile",
    "generationPlan",
    "因為錄音明確提到", // explanation substring
    LISTENING_PLAN_MARKER, // plan content, not just the field name
  ];

  it("removes every answer-bearing string", () => {
    const serialized = JSON.stringify(stripAnswers(LISTENING_FIXTURE));
    for (const secret of KNOWN_SECRETS) expect(serialized).not.toContain(secret);
  });

  it("keeps what the client renders", () => {
    const pub = JSON.stringify(stripAnswers(LISTENING_FIXTURE));
    expect(pub).toContain("audio");
    expect(pub).toContain("stimuli/lsn-fixture1/lcr-01.mp3");
    expect(pub).toContain("role");
    expect(pub).toContain("librarian");
    expect(pub).toContain("accent");
    expect(pub).toContain("north-american");
    expect(pub).toContain("Option A");
    expect(pub).toContain("Sure, no problem.");
    expect(pub).toContain("setting");
    expect(pub).toContain("campus dining hall");
    expect(pub).toContain("discipline");
    expect(pub).toContain("marine biology");
    expect(pub).toContain("Stem for conv-1-q1?");
    expect(pub).toContain("lowerModule");
    expect(pub).toContain("upperModule");
  });

  // The two tests above enumerate known secrets and known kept fields, so neither notices a new
  // field: a render-direction string added to a Speaker, say, could describe the clip's content and
  // reach the client through stripAnswers with both still green. The two tests below classify every
  // key by name instead: the stripped payload may hold nothing outside ALLOWED_KEYS, and every key
  // ListeningSetSchema can produce must be classified as kept or stripped, so a new schema field
  // forces a decision here rather than shipping unclassified.
  const ALLOWED_KEYS = new Set([
    // Set
    "id", "kind", "source", "createdAt", "router", "lowerModule", "upperModule",
    // ListeningModule
    "timeLimitSec", "listenChoose", "conversations", "announcements", "academicTalks",
    // Item/Stimulus fields shared across the four shapes
    "taskType", "audio", "setting", "discipline",
    // Speaker; voice and provider are stripped, see below
    "speaker", "speakers", "role", "gender", "accent",
    // MCQ; correctOptionId, skill and explanationZh are stripped, see below
    "options", "questions", "stem",
    // McqOption
    "text",
    // The advisory notes a Set was published with, and the fields of one note. Kept: the Dashboard
    // and the practice-set picker show them before an Attempt, and SetAdvisoryNoteSchema has no field
    // an answer, transcript or scenario could occupy (each is a server-owned label, an id, a position
    // or a number). `detail` and `taskType` here are that schema's bounded label fields.
    "advisoryNotes", "check", "detail", "take", "itemPosition", "conflictingSetIds", "score",
    "measuredWpm", "targetWpm", "minWpm", "maxWpm",
    // Which clip a speech-rate note is about: a server-derived id constrained to a safe filename
    // segment, so it names the clip without carrying a word of its content.
    "clipId",
  ]);
  const STRIPPED_KEYS = new Set([
    "utterance", "transcript", "correctOptionId", "skill", "explanationZh",
    "voice", "provider", "audioProfile", "generationPlan",
    // These occur only inside a container stripAnswers drops whole: a transcript turn's speakerId
    // (inside `transcript`), the audio profile's version and model, and a plan entry's own fields
    // (inside `generationPlan`): domain, noveltyKey, requiredConcepts, distinguishesFrom, and Listen
    // and Choose's plan-only `topic`. Conversation and announcement plan entries reuse `setting`, and
    // talk entries `discipline`, both allowed because the Set fields of those names are kept.
    "speakerId", "version", "model", "domain", "noveltyKey", "requiredConcepts",
    "distinguishesFrom", "topic",
    // Each plan entry's speaker roles, likewise inside `generationPlan`.
    "speakerRole", "speakerRoles",
    // A plan distinction's fields (the elements of distinguishesFrom). LISTENING_FIXTURE's
    // distinguishesFrom arrays are empty, so only the schema walk below sees these.
    "setId", "reason",
  ]);

  it("keeps only allowlisted keys in the stripped payload — a field added anywhere without a matching strip fails this test, not just a future review", () => {
    const publicKeys = collectObjectKeys(stripAnswers(LISTENING_FIXTURE));
    const unexpected = [...publicKeys].filter((key) => !ALLOWED_KEYS.has(key));
    expect(unexpected).toEqual([]);
  });

  // A scan of the fixture sees only the keys it populates, so it misses an optional field, and an
  // optional field is the only kind a schema can gain: banked Sets are immutable and re-parsed on
  // every read, so a new required field would make them unloadable. Walking ListeningSetSchema's own
  // JSON Schema sees every key the schema can produce, populated in the fixture or not.
  it("classifies every key ListeningSetSchema can EVER produce as kept or stripped — including optional fields no fixture populates", () => {
    const sourceKeys = collectSchemaKeys(z.toJSONSchema(ListeningSetSchema));
    const unclassified = [...sourceKeys].filter(
      (key) => !ALLOWED_KEYS.has(key) && !STRIPPED_KEYS.has(key),
    );
    expect(unclassified).toEqual([]);
  });
});
