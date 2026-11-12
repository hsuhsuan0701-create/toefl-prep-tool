import { z } from "zod";
import { SafeIdSchema } from "./primitives.js";

/**
 * One advisory check a published Set did not satisfy: the durable record of ADR 0006's `advisory`
 * tier, shown with the Set on the Dashboard and the Sets page.
 *
 * Structure, never prose: every field is a server-owned identifier, an enum label or a number, so no
 * scenario, topic, transcript or question can travel through a note. The sentence the User reads is
 * composed on the client (advisoryNoteLines in client/src/ui/labels.ts).
 *
 * The server attaches notes at publish time. They are absent from every *GenerationInputSchema, so a
 * model's output can never carry notes of its own, and optional on every Set schema. Never read by
 * scoring.
 */
export const SetAdvisoryNoteSchema = z.object({
  /** Which check recorded it. Closed set: a note is machine-generated, never free-form. */
  check: z.enum([
    "catalog-novelty",       // overlaps a Set already in the Catalog
    "intra-set-similarity",  // two components of THIS Set overlap each other
    "plan-conformance",      // the generated content drifted from its accepted Plan
    "speech-rate",           // a clip missed its pace band after every corrective re-render it was budgeted
    // A deterministic content-gate finding the Set was published with; `detail` is the violation
    // kind, never the offending text.
    "content-gate",
    // An Academic Talk the Listening Verifier judged below its Task Type's register in every round it
    // was budgeted. The one check whose finding comes from a model, so the no-prose rule matters most:
    // the talk is named by `taskType` + `itemPosition`, never by the Verifier's `reason` (which may
    // quote the transcript) or by its Stimulus id, which the producer authors.
    "talk-register",
  ]),
  /** The DiversityIssueKind or audio role that fired — a server-side label, never content. */
  detail: z.string().min(1).max(64),
  /**
   * speech-rate only: which clip. `detail` names only the role, and a Listening Set has twenty Listen
   * and Choose a Response clips of one role. The server derives it from the role and the clip's
   * position ("lcr-utterance-7"); Sets published earlier carry the clip's Stimulus id here instead.
   */
  clipId: SafeIdSchema.optional(),
  /** Which component: a Task Type for the diversity checks, an audio role for speech-rate. */
  taskType: z.string().min(1).max(64).optional(),
  /**
   * Which slot within that Task Type's array, for the positionally addressed shapes. Listening counts
   * globally, router then lower then upper, as its plan arrays are written.
   */
  itemPosition: z.number().int().nonnegative().optional(),
  /** Which prior Sets this one overlaps. Ids only. */
  conflictingSetIds: z.array(SafeIdSchema).max(64).optional(),
  /** The measured overlap, for the scored diversity kinds. */
  score: z.number().optional(),
  /**
   * speech-rate only: which take was published. "retake" means a corrective re-render landed and is
   * what plays; "first" means every re-render came back worse or failed and the original was kept. It
   * does not say how many re-renders were bought (Listening allows up to three); the diagnostics do.
   */
  take: z.enum(["first", "retake"]).optional(),
  /** speech-rate only: what was measured, against which band. */
  measuredWpm: z.number().optional(),
  targetWpm: z.number().optional(),
  minWpm: z.number().optional(),
  maxWpm: z.number().optional(),
});
export type SetAdvisoryNote = z.infer<typeof SetAdvisoryNoteSchema>;

// A cap, so a pathological run cannot write an unbounded array into an immutable Set file; well past
// any real count (a Listening Set has 36 plan entries and 36 clips). Exported so the cap that
// truncates is the one that rejects: producers attach notes through recordAdvisoryNotes
// (server/src/services/setAdvisoryLedger.ts), which truncates to it. A producer that appended directly
// could make a fully paid run fail at publish.
export const MAX_SET_ADVISORY_NOTES = 500;
export const advisoryNotes = z.array(SetAdvisoryNoteSchema).max(MAX_SET_ADVISORY_NOTES).optional();
