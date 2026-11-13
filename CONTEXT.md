# TOEFL Prep Tool

Domain language for a personal TOEFL iBT 2026 practice app with multi-model auto-scoring of Speaking and Writing, and deterministic key-based scoring of Reading and Listening.

## Language

### Content

**Task Type**:
One of the twelve 2026-format exercises. Speaking: Listen and Repeat, Interview. Writing: Build a Sentence, Email, Academic Discussion. Reading: Complete the Words, Read in Daily Life, Read an Academic Passage. Listening: Listen and Choose a Response, Conversation, Announcement, Academic Talk. In code, the five Speaking/Writing values form `SpeakingWritingTaskType` (the only types Judge/Score Report schemas accept); `AnyTaskType` spans all twelve.
_Avoid_: question type, exercise

**Set**:
An immutable, pre-generated bundle of content for one section's practice, with a `source` of `ets-sample`, `generated`, or `imported`. No `ets-sample` Set ships: ETS's sample Sets may be kept only on the machine of whoever holds them (docs/official-rubrics.md), and the value stays valid so such a Set still loads. Reading/Listening Sets contain three modules: Router, Lower, Upper. A published Set is never edited, because past Attempts are reviewed against it: a defective one is replaced by a new Set and retired in `data/question-sets/supersessions.json` (docs/adr/0011). A retired Set leaves the listing and the Catalog but still loads for review.
_Avoid_: test, exam, question bank entry

**Item**:
One scoreable unit inside a Set (a sentence to repeat, one interview question, one tile puzzle, one essay task, one Complete-the-Words gap, one multiple-choice question).
_Avoid_: question (reserved for interview question text), exercise

**Frame**:
The partial sentence a Build a Sentence Item's tiles complete: fixed text with blanks, each blank written as `___`, filled left to right by the tiles. Optional on an Item — the Sets banked before frames existed carry none. A frame may begin with a blank, and may consist of nothing but blanks and the sentence-final punctuation (a full reorder). It always supplies that final punctuation, so no tile carries it; it does NOT supply sentence-initial capitalisation, because every tile is lowercase — including the one the sentence starts with — so that blanking the start actually hides which tile goes there (docs/adr/0009).
_Avoid_: template, stem, scaffold, skeleton

**Stimulus**:
The text, image, or audio material one or more Items are answered against (a Complete-the-Words paragraph, a Daily-Life text, a conversation recording, a Listen-and-Repeat clip), presented under the Attempt mode's constraints.
_Avoid_: passage/clip/audio as generic terms for this role

**Router Module**:
The first module of a Reading/Listening Set, taken by every Attempt; its raw score selects the second module.
_Avoid_: stage 1, calibration section

**Lower Module / Upper Module**:
The two second-module variants baked into every Reading/Listening Set — easier and harder task mixes. Exactly one is taken per routed Attempt.
_Avoid_: easy/hard mode, module 2 (unqualified)

### Generation

**Plan**:
The accepted content design a generated Set is produced from: per Task Type, a domain, the concepts the Set must use, and the prior Sets it is meant to differ from. Agreed before any Set content is written, and never learner-facing.
_Avoid_: outline, blueprint, spec

**Catalog**:
The prior Sets a Plan is checked against for overlap: each Set is represented by its stored Plan, or, for a Set that carries none, by entries read from its content. Plan admission is deterministic code: overlap with the Catalog is recorded on the Set as an advisory note and never stops a Plan (docs/adr/0006). A generated Set is not re-measured against the Catalog.
_Avoid_: bank, corpus, history

**Verifier**:
The Claude (or Codex) call that checks a generated Set's keys: that a Reading or Listening Item's key is the one right answer to it from its Stimulus, and that a Build a Sentence Item's accepted answers are right (it may correct them). Distinct from a Judge: a Verifier reads Sets and never sees a Response. It plays no part in Plan admission.
_Avoid_: judge, validator, checker, linter

### Practice

**User**:
The single test taker this app is built for — canonical term in code, API responses, and docs. Skill prose (`.claude/skills/toefl-*`) may say "test taker" or "learner" for the same person, for register/variety.
_Avoid_: introducing new synonyms in code; "test taker"/"learner" belong to skill prose only

**Attempt**:
One practice run of a Set, or of a single Task Type from it.
_Avoid_: session, run

**Drill**:
An Attempt mode with relaxed constraints (pauses, instant feedback, re-recording allowed).
_Avoid_: practice mode

**Simulation**:
An Attempt mode under exam constraints: continuous, play-once audio, deferred feedback. Preferred source for Band Estimates; for Reading/Listening, the only source — Drills never produce them.
_Avoid_: mock test, full test

**Module Path**:
Which second-module variant a routed Reading/Listening Attempt received (`lower` or `upper`), persisted on the Attempt and disclosed wherever its Band Estimate appears.
_Avoid_: difficulty level, track

**Promotion Threshold**:
The Router-Module raw fraction (≥ 0.6) at which an Attempt routes to the Upper Module. Our assumption — ETS does not disclose its routing rule.
_Avoid_: presenting it as ETS policy

**Full-Test Run**:
Four linked Simulation Attempts in ETS order (Reading, Listening, Writing, Speaking) under one combined report whose Overall band uses the official mean-then-round rule (`mean-of-sections-v1`). The Overall band is derived from the four section bands on every read, never stored, and absent until all four exist. A section whose Attempt still has scoring outstanding is pending, even if it once had a band; a settled section with no band says which Items and Task Types stand in the way. A sitting ends at Speaking's capture with its Judges still running, so a report usually starts with pending sections and states which, rather than averaging the ones it has. A Run in progress can be abandoned: it ends with no Overall, its finished sections keep their Attempts and bands, and the section being sat is discarded. A section restarted after a reload discards the Attempt it replaces in the same step.
_Avoid_: full test (unqualified), mock exam, a partial Overall band

**Repeat**:
An Attempt on a Set that already has an Attempt with a scored Item, or a completed Attempt holding at least one Item. Allowed and tagged; never a section's headline Band Estimate, though its own review still shows the band it earned. A Full-Test section restarted after a reload keeps the tag of the sitting it replaces.
_Avoid_: retake

**Response**:
The User's answer to an Item: a recording, a tile order, essay text, typed letters for a gap, or a selected option.
_Avoid_: answer, submission

### Scoring

**Judge**:
One LLM family (Gemini or OpenAI) that scores a Response against the Task Type's rubric independently of the other. The rubric is this project's own description of ETS's published criteria, or ETS's official text where a User has installed it locally (docs/official-rubrics.md, docs/adr/0013).
_Avoid_: scorer, grader

**Judge Report**:
A Judge's structured output for a Response: per-dimension 0–5, evidence quotes, deductions.
_Avoid_: score result

**Ears**:
The Gemini call that transcribes a spoken Response verbatim (disfluencies preserved) and produces its Delivery Report.
_Avoid_: transcription service, ASR

**Delivery Report**:
Structured audio observations for a spoken Response (pace, pauses, intelligibility, suspected mispronunciations, intonation), produced by Ears.
_Avoid_: audio analysis

**Text Fallback**:
The OpenAI speaking Judge's degraded mode: it scores from the transcript + Delivery Report instead of the audio, after its audio call fails structurally. Flagged per Judge Report.
_Avoid_: silent degradation, backup mode

**Arbiter**:
The scoring role that first commits its own rubric-anchored score and then reconciles it with the Judge Reports. Claude normally fills the role; Codex may fill it when Claude is unavailable.
_Avoid_: aggregator, meta-judge

**Self-Arbitration**:
The availability-first degraded mode where Codex may arbitrate a Response even when Codex also authored its OpenAI Judge Report. Continuity is preferred over model-role independence; the Score Report records this state, review history discloses it, and the score still contributes normally to Band Estimates.
_Avoid_: describing the result as fully independent, hiding the state after scoring, excluding it from progress calculations

**Score Report**:
The Arbiter's authoritative output for an Item: final 0–5, dimension notes, merged Deductions, reconciliation note, 繁體中文 summary, Model Rewrite.
_Avoid_: final result, verdict object

**Deduction**:
One specific point loss in a Score Report: a quote from the Response, the issue, the fix, and a category (扣分點).
_Avoid_: mistake, error item

**Model Rewrite**:
A rewrite of the User's Response showing a 5-level response on the Item's 0–5 scale, reusing the User's own ideas (改寫示範).
_Avoid_: sample answer, model answer (reserved for interview model answers)

**Disagreement Flag**:
A low-confidence marker on an Item whose Judges differ by ≥1.5 points.
_Avoid_: confidence score

**Band Estimate**:
An unofficial mapping from final Item scores to the 1–6 section band, always labeled as an estimate with a versioned method (`linear-v2` for Speaking and Writing, `table3-v1` for Reading/Listening; a persisted estimate keeps the method it was computed under, so pre-reweighting rows still read `linear-v1`). It exists only when every Item of the Attempt is scored (a deliberate skip is a scored 0) and every Task Type the section needs has an Item (for Reading and Listening, in each Module the Attempt took: the Router Module and the one its Module Path names); short of that there is no number, only what stands in the way: Items that failed scoring, are still unscored or never reached the server, and Task Types with no Item (docs/adr/0010). A section's headline is the estimate of its latest completed, non-Repeat Attempt, Simulations before Drills. The Overall band, on the Dashboard and in a Full-Test Run, is the mean-then-round of all four sections and exists only when all four do.
_Avoid_: score, band (unqualified), a band from part of a section

**CEFR Level**:
The Common European Framework level a band maps to on ETS's published concordance (6 = C2, 5–5.5 = C1, 4–4.5 = B2, 3–3.5 = B1, 2–2.5 = A2, 1–1.5 = A1 — one mapping for every section and for the Overall band). Derived from the band it is shown beside (`cefrForBand`), so it inherits that band's status: an estimated band yields an estimated level, a Target yields a level for a number the User chose.
_Avoid_: presenting it as a certification, a placement, or an official level

**Explanation (錯題解析)**:
The pre-authored 繁體中文 rationale carried by every Reading/Listening Item — why the key is right and each distractor wrong, with transcript reference for Listening. Written at generation time, verified with the Set, hidden until the Item is scored.
_Avoid_: hint, feedback (reserved for Score Report prose)

**Calibration Sample**:
An ETS-published Response with its official score, used to calibrate the scoring pipeline (`scripts/calibrate-writing.ts`, `scripts/calibrate-speaking.ts`). ETS licenses them, so none is in the repository: they live in a local, gitignored folder, and the calibration scripts stop with a message when it is absent. Distinct from this project's own scored illustrations (`samples-scored.md`), which are invented.
_Avoid_: golden sample, test fixture (unqualified)

### Dashboard

**Settings**:
The persisted key-value store backing the per-section Targets, read via `GET /api/stats/settings` and written via `PUT /api/stats/settings`.
_Avoid_: preferences, config (unqualified)

**Target**:
The band (1–6, half steps) the User is aiming for in one section. Every section has one, editable on the Dashboard, and every Band Estimate is shown against it. A Target is a goal, never a value: it never stands in for a missing Band Estimate and never enters the Overall band.
_Avoid_: goal score, pin, placeholder band
