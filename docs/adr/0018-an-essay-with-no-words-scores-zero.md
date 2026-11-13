# An essay with no words scores 0 without a Judge, and the editor asks before handing one in

## Status

Accepted.

## Context

Pressing "Submit Email" or "Submit post" with nothing typed, or with only spaces and newlines,
handed the essay in at once, and `POST /api/attempts/:id/score` sent the empty text into the Judge
ensemble like any other essay (issue #39). With keys, that is two paid Judge calls and an Arbiter
call for a Response with nothing in it to judge. Without them the job ended "Scoring failed", which
left the Attempt with no Band Estimate and a Re-score button that would send the empty text again.

The app already had both halves of an answer elsewhere. Build a Sentence asks before finishing with
an empty blank, because an empty blank scores 0. A recording with no speech scores a deterministic 0
marked "No speech detected" and never reaches a Judge, and that 0 counts toward the Band Estimate
like any other: on the real test, an item left unanswered scores 0.

## Decision

**Both. The editor asks before an empty essay is handed in, and an essay with no words scores a
deterministic 0 that never reaches a Judge or the Arbiter.**

- **The boundary is whitespace.** An Email or Academic Discussion Response has no words when it is
  empty once its whitespace is trimmed (`essayHasNoWords` in `shared/src/schemas/scoring.ts`). A
  single word, or a lone punctuation mark, is an essay and goes to the Judges, who are the ones to
  say how little it achieves. The server's scoring and the editor's question read the one rule.
- **The editor asks.** In `TimedEditor`, shared by the Writing Drill and the Writing Simulation,
  Submit on an essay with no words opens a `ConfirmDialog` that says the essay is empty and scores
  0. "Keep writing" returns to the editor with its draft and its clock, which never stopped;
  "Submit empty email" or "Submit empty post" hands it in. The clock running out is not a press: it
  closes the question if it is open and hands the essay in as it stands, empty or not, without
  asking.
- **The server scores it 0.** `scoreEssay` (`server/src/services/scoreItems.ts`) checks the rule
  before any Judge call. The Response is stored first, as always (the route writes the essay before
  its job exists), and the job still runs, so the client follows it like any scoring job. The Item
  ends `scored` with score 0 and a Score Report item (`noWordsReportItem` in `judgeEnsemble.ts`) with
  no dimensions and no Deductions, a note and a 繁體中文 summary saying no Response was written, and
  `noWordsWritten: true`, which tells it apart from a judged 0 as `noSpeechDetected` does for a
  recording. Any Judge Report from an earlier scoring of the Item is deleted with the write. No
  Judge, no Arbiter, no model call and so no diagnostics row; the stored state names no provider.
- **A Re-score lands on the same branch**, so an empty essay that failed scoring before this record
  is scored 0 by its Re-score and its text is never sent to a Judge.
- **It counts.** A scored 0 is a scored Item (ADR 0010), so a Writing Attempt whose only gap was an
  empty essay can have its Band Estimate.
- **The review reads it as what it is.** Attempt review and the Writing Drill's results show "No
  Response written" with the note, the summary and the empty Response, and none of the Score Report
  parts that describe a judging that did not happen (Deductions, the Arbiter's reasoning, Judge
  cautions).

## Considered Options

- **Only score it 0, without asking**: rejected on its own. A Submit pressed too early on a blank
  editor, on a 7- or 10-minute task, would throw the task away with no chance to take it back.
- **Only ask, and leave scoring as it was**: rejected on its own. A User who confirms, a clock that
  runs out on an empty editor and an empty essay already on file would still buy two Judge calls and
  an Arbiter call, or end "Scoring failed" and keep the Attempt from its band.
- **Refuse an empty essay at the route (4xx)**: rejected. The clock running out must hand the essay
  in, whatever it holds, and a refusal would leave the Item without a Response or a score.
- **Count words with a stricter rule (a minimum length, letters only)**: rejected. Any line drawn
  above "nothing written" is a judgement about the content, and that is the Judges' job.

## Consequences

- `noWordsWritten` joins `noSpeechDetected` as the second Score Report marker of a deterministic 0
  in `score_json`. Both have the Score Report's shape, so every reader that renders a scored Item
  renders them.
- A scoring job for an empty essay is claimed at its `judging` stage like any other and ends `done`
  within moments; it calls nothing.
- What this does not change: the boot sweep and a cancelled job's stranded Items still settle an
  essay that was never scored as failed and rescorable (their rule for a recording with no speech
  reads its transcript, which an essay has not got), and its Re-score then scores it 0 at no cost.

Pinned by `server/test/noWordsEssayScoring.test.ts`, `client/test/WritingDrill.test.tsx`,
`client/test/WritingSimulation.test.tsx` and `client/test/AttemptReviewStates.test.tsx`.
