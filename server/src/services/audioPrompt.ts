// Builds the text-to-speech prompt both audio renderers send to Gemini, in the structure Gemini's
// speech-generation guide prescribes: Audio Profile -> Scene -> Director's Notes (Style / Accent /
// Pacing) -> transcript. The guide warns that a vague prompt can make the model read its directions
// aloud, which would put them into a published Stimulus. So the transcript sits below an explicit
// delimiter, and buildDeliveryPrompt refuses any transcript or note text that could pass for a
// section of the directions or break that boundary.

import type { PaceBand } from "./audioPace.js";

// The union of both sections' accents: Listening's three plus Speaking's new-zealand. A compile-time
// assertion in audioPrompt.test.ts fails if either schema gains an accent this module has no
// direction for.
export type DeliveryAccent = "north-american" | "british" | "new-zealand" | "australian";

// A named region, because the guide finds it beats a bare label ("British English accent as heard in
// Croydon, England" over "British Accent"). The anti-caricature instruction is appended once by
// buildDeliveryPrompt rather than repeated in each value.
export const ACCENT_DIRECTION: Readonly<Record<DeliveryAccent, string>> = {
  "north-american": "General American English, as heard in Columbus, Ohio",
  british: "Standard Southern British English, as heard in Guildford, Surrey, England",
  australian: "General Australian English, as heard in Melbourne, Victoria",
  "new-zealand": "General New Zealand English, as heard in Wellington",
};

// Follows every Accent line: a native-speaker delivery without exaggerated regional features.
const ANTI_CARICATURE_INSTRUCTION =
  "Avoid exaggerated or caricatured regional features — a natural, internationally intelligible native-speaker delivery.";

/**
 * The pace target as WORDS, never numbers: the guide asks for descriptive direction, and a number in
 * the prompt invites the model to recite it. No number derived from `band` reaches the string. Each
 * line names a manner of speaking and a speaker, chosen by `targetWpm`:
 *
 *   <=150    measured, unhurried, like a lecturer
 *   151-170  easy, conversational
 *   171-190  ordinary talk, delivered as one continuous phrase
 *   191-215  brisk, fluent
 *   >215     quick and light
 *
 * Each range brackets the speech rate its own line was measured to deliver on Listen and Repeat
 * sentences, so moving a band's target across a boundary changes the instruction its measurements were taken under (LISTENING_ROLE_POLICY's
 * `lcr-utterance` sits on 170 for that reason). The 171-190 line constrains phrasing rather than
 * tempo: at Listen and Repeat tail lengths, the gap between "conversational" and ETS's pace was
 * mostly silence between clauses, which counts toward WPM. Whether the fastest line needs the same
 * constraint is not yet measured.
 */
export function pacingDirection(band: PaceBand): string {
  if (band.targetWpm <= 150) {
    return "Speak at a measured, unhurried pace, like a lecturer who wants each point to land before moving on.";
  }
  if (band.targetWpm <= 170) {
    return "Speak at an easy, conversational pace — neither rushed nor slow.";
  }
  if (band.targetWpm <= 190) {
    return "Speak at the pace of ordinary talk between two people — an everyday speaking manner, delivered as one continuous phrase: each clause carries into the next instead of resting between them, and no word is held for emphasis.";
  }
  if (band.targetWpm <= 215) {
    return "Speak in a brisk, fluent delivery, the way someone speaks comfortably and at ease.";
  }
  return "Speak quickly and lightly, at the clip of someone saying a short line they say many times a day — energetic and running straight through, never clipped or breathless.";
}

/**
 * Which way a corrective re-render must move after a take missed its band. Gemini has no rate
 * parameter, so a correction can only be prompted.
 */
export type PaceDirection = "slower" | "faster";

/**
 * `round` is 1-based and counts corrective re-renders; it selects how hard the direction pushes (see
 * PACE_CORRECTION_DIRECTION). Direction and round travel as one value so a caller cannot attach a
 * direction to the wrong round.
 */
export type PaceCorrection = { readonly direction: PaceDirection; readonly round: number };

// An escalation ladder, one rung per corrective round, each stronger and more concrete than the one
// before, and all stronger than pacingDirection's own line, which the model has already read and not
// delivered on. Re-asking in the same words would buy the same take again. Like pacingDirection, no
// rung names a number: each varies the air between phrases, whether clauses run together, and
// whether any word is held.
//
// Round 1's wording must stay as it is: the measured authority of one nudge (about 7 WPM, behind
// audioPace.ts's FAR_BELOW_BAND_WPM) was taken from corrective takes rendered under it.
const PACE_CORRECTION_DIRECTION: Readonly<Record<PaceDirection, readonly string[]>> = {
  slower: [
    "That last take came out too fast. Slow down noticeably — leave a little more air between phrases and let each clause finish before starting the next.",
    "That is still too fast. Speak markedly slower than the last take — let each clause come to a full stop before the next begins, leave a clear beat of air at every phrase boundary, and give the closing words of the line room to land.",
    "Still too fast. Slow right down to a deliberate, unhurried delivery: a distinct pause at every phrase boundary, every word fully articulated, and nothing rushed through.",
  ],
  faster: [
    "That last take came out too slow. Pick the pace up noticeably — keep it moving, with less space between phrases, the way someone speaks when they are comfortable with the material.",
    "That is still too slow. Speak markedly faster than the last take — run each clause straight into the next with no pause between them, hold no word for emphasis, and let the whole line come out in one breath, the way someone speaks when they are in a hurry to be understood.",
    "Still too slow. Go as fast as you can while staying clearly intelligible: no pause anywhere inside the line, no syllable lengthened, and no settling into a reading voice — say it the way someone rattles off a line they say many times a day.",
  ],
};

/**
 * The direction line for one corrective round. Clamped at both ends rather than indexed raw: a round
 * past the ladder's last rung reuses that rung, so a caller that raises its correction budget without
 * writing new wording gets the strongest rung repeated instead of an `undefined` interpolated into a
 * published Stimulus's prompt.
 */
export function paceCorrectionDirection(correction: PaceCorrection): string {
  const ladder = PACE_CORRECTION_DIRECTION[correction.direction];
  const rung = Math.min(Math.max(Math.trunc(correction.round), 1), ladder.length) - 1;
  return ladder[rung]!;
}

export type DeliveryNotes = {
  readonly audioProfile: string;
  readonly scene: string;
  readonly style: string;
  readonly accent: DeliveryAccent;
  readonly band: PaceBand;
  /** Set only on a corrective re-render — see PaceCorrection. */
  readonly paceCorrection?: PaceCorrection;
};

/**
 * Thrown when prompt text cannot be safely delimited: it contains the transcript delimiter, or one of
 * its lines could be read as a section label. The message names the region, line number and label,
 * never the offending text, because Set content must not reach a log or an error response.
 */
export class TranscriptContaminationError extends Error {
  constructor(message: string) {
    super(message);
    // Without this `err.name` stays "Error", and reporting that keeps only an error's name (as
    // setStore.ts's safeSetErrorDescriptor does) could not tell this error apart.
    this.name = "TranscriptContaminationError";
  }
}

// The exact form is arbitrary; what matters is that it appears nowhere in ordinary prose. The
// synthesis preamble refers to it as "the transcript marker" instead of quoting it, so it occurs
// exactly once in every prompt.
export const TRANSCRIPT_DELIMITER = "=== TRANSCRIPT: SPEAK EVERYTHING BELOW THIS LINE, VERBATIM ===";

const AUDIO_PROFILE_LABEL = "Audio Profile:";
const SCENE_LABEL = "Scene:";
const DIRECTORS_NOTES_LABEL = "Director's Notes:";
const STYLE_LABEL = "Style:";
const ACCENT_LABEL = "Accent:";
const PACING_LABEL = "Pacing:";

// The section labels this module emits at the start of a line, in emission order. Matched only at
// the start of a line and only in this exact form: a substring check would reject ordinary Stimulus
// prose containing "style", "accent", "pace" or "scene" (audioPrompt.test.ts pins this).
export const DIRECTOR_SECTION_LABELS: readonly string[] = [
  AUDIO_PROFILE_LABEL,
  SCENE_LABEL,
  DIRECTORS_NOTES_LABEL,
  STYLE_LABEL,
  ACCENT_LABEL,
  PACING_LABEL,
];

const SYNTHESIS_PREAMBLE =
  "You are a speech-synthesis voice. Everything below up to the transcript marker is direction " +
  "for HOW to speak — an audio profile, a scene, and director's notes. It is not text to read " +
  "aloud. Only the material after the transcript marker is to be spoken, and it must be spoken " +
  "in full and verbatim, with nothing from above it included.";

/**
 * The safety half of buildDeliveryPrompt, which calls exactly this, exported so a renderer can run
 * it while planning, before any spend: thrown mid-render, it would discard every clip already
 * bought. Throws TranscriptContaminationError.
 *
 * It checks the notes as well as the transcript. A Listening Conversation's `scene` is built from
 * model-written `setting` and `role` text, and a delimiter there would sit above the director's
 * notes, so the model would read the notes aloud.
 */
export function assertDeliveryPromptDelimitable(notes: DeliveryNotes, transcript: string): void {
  assertNotContaminated(notes.audioProfile, "audio profile direction");
  // The first scene line follows this module's own `Scene: ` prefix, so a label at the start of the
  // raw value cannot start a new section. Later lines get the transcript's line-start check.
  assertNotContaminated(notes.scene, "scene direction", { firstLineIsNested: true });
  assertNotContaminated(notes.style, "style direction");
  assertNotContaminated(transcript, "transcript");
}

// `region` names which prompt region failed; the error carries the region, line number and label,
// never the offending text.
function assertNotContaminated(
  text: string,
  region: string,
  options: { firstLineIsNested?: boolean } = {},
): void {
  if (text.includes(TRANSCRIPT_DELIMITER)) {
    throw new TranscriptContaminationError(`${region} contains the transcript delimiter`);
  }
  const lines = text.split("\n");
  for (let i = options.firstLineIsNested ? 1 : 0; i < lines.length; i++) {
    const line = lines[i]!;
    const label = DIRECTOR_SECTION_LABELS.find((candidate) => line.startsWith(candidate));
    if (label !== undefined) {
      throw new TranscriptContaminationError(
        `${region} line ${i + 1} begins with the director's-notes label "${label}"`
      );
    }
  }
}

/**
 * Assembles a synthesis prompt as Audio Profile -> Scene -> Director's Notes (Style / Accent /
 * Pacing) -> TRANSCRIPT_DELIMITER -> transcript. Throws TranscriptContaminationError before
 * building anything if the transcript could be mistaken for part of the notes above it, or if the
 * notes themselves could break the boundary — see assertDeliveryPromptDelimitable.
 */
export function buildDeliveryPrompt(notes: DeliveryNotes, transcript: string): string {
  assertDeliveryPromptDelimitable(notes, transcript);

  const header = [
    SYNTHESIS_PREAMBLE,
    `${AUDIO_PROFILE_LABEL} ${notes.audioProfile}`,
    `${SCENE_LABEL} ${notes.scene}`,
    [
      DIRECTORS_NOTES_LABEL,
      `${STYLE_LABEL} ${notes.style}`,
      `${ACCENT_LABEL} ${ACCENT_DIRECTION[notes.accent]}. ${ANTI_CARICATURE_INSTRUCTION}`,
      `${PACING_LABEL} ${pacingDirection(notes.band)}${
        notes.paceCorrection ? ` ${paceCorrectionDirection(notes.paceCorrection)}` : ""
      }`,
    ].join("\n"),
  ].join("\n\n");

  return `${header}\n\n${TRANSCRIPT_DELIMITER}\n${transcript}`;
}
