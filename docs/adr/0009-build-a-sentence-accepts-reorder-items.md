# Build a Sentence accepts reorder-shaped Items

## Status

Accepted (issue #126). Reverses two rules in `server/src/services/buildASentenceConformance.ts` that
were extrapolated from a single published sample, and moves the Task's pooled budget from 360 s to
410 s. The generation guide that tells the model what to emit is rewritten separately, in issue #127,
which this unblocks; nothing here publishes a new Set.

## Context

Build a Sentence had exactly one worked example to design against: the Item on p. 13 of ETS's
*Updated TOEFL iBT Test Overview* (2026). Seven tiles, six blanks, the sentence's first word and its
last word with the full stop fixed in the frame. Every rule the conformance gate enforced was
measured against it, and three of those rules were properties of that one Item rather than of the
task:

1. **The frame must fix at least one real word** (`frame-all-blanks`). An all-blank frame was
   reported as "the task degenerating into ordering every tile."
2. **The tile ceiling is seven.** "ETS's sample offers seven; more than that is a memory test rather
   than a grammar one."
3. **A word that must carry a capital belongs in the frame** — the stated justification for
   `tile-initial-capital`, which rests on the frame always fixing the sentence's opening word.

Two pieces of evidence say otherwise.

**RR-25-12 Technical Manual, §II-5** describes the task in its own words: the learner is shown words
or phrases in the wrong order and moves them to form a grammatical sentence or question. That is a
description of reordering, not of gap-filling, and it puts no floor on how much the frame fixes.
Our own reading — "completing partial sentences using provided vocabulary," from the Test Blueprint
and Specifications — is the same task described from the other end, and neither text states a tile
count anywhere while targeting CEFR A1-C2.

**A sitting of the real exam in 2026** (a test taker's first-hand report of how the Items were
presented, written down the same day) showed three things the sample does not:

- The **start** of the sentence gets blanked. The opening word is routinely a tile.
- Considerably **more** of the sentence is blanked than we generate — at the top of the ramp, all of
  it, with only the final punctuation fixed.
- **Every tile is drawn lowercase**, including the tile the sentence starts with.

The third observation is what makes the first two work. Blanking the start only hides which tile
comes first if no tile advertises itself with a capital; one capitalised tile in a tray of lowercase
ones gives the position straight back.

## Decision

**Accept the reorder shapes. Keep the casing rule, on the exam's reason instead of ours.**

- **`frame-all-blanks` is removed as a violation kind**, not merely stopped from firing. A frame
  fixing nothing but the sentence-final punctuation is the ramp's legal end state. Removing the kind
  is what makes the reversal visible: `generationCheckPolicy.ts` restates the gate's union and the
  two are pinned to each other by a mutual-assignability assertion, so neither side can quietly keep
  a kind the other dropped, and `generationCheckPolicy.test.ts` counts the union.
- **The tile ceiling is 10**, floor unchanged at 4. Ten is where a full reorder of an ordinary B1-B2
  sentence lands. The floor's own justification lost one of its two supports — five tiles used to be
  impossible for a short sentence partly *because* the frame had to fix a word — but four survives on
  the arithmetic that always held it: four tiles leave three blanks, and three is the minimum length
  `answers` allows.
- **`distractor-count` is unchanged**: blanks = tiles − 1, exactly one distractor. Nothing observed
  contradicts it, and it is the one rule that makes the Item a puzzle rather than a transcription.
- **`tile-initial-capital` stays, with a new reason.** It no longer means "a capitalised tile can
  only be the first blank." It means "the exam draws every tile lowercase, so a capital gives away
  which tile the sentence starts with." It still over-fires on a capital that leaks nothing on its
  own — a proper noun, the pronoun `I`, an acronym — and that is still deliberate: no counting rule
  can tell those from a sentence-initial capital, and under a lowercase-tile rule the distinction
  stopped mattering. It remains **advisory**, never fatal, exactly as ADR-0006 placed it.
- **The casing rule's fatal half already existed and is now pinned.** `answers` holds tile TEXT and
  `sentenceScorer.normalizeTile` compares case-sensitively, so an accepted answer that capitalises a
  lowercase tile names a tile the Item does not offer: `answer-not-from-tiles` fires, and that kind
  is fatal. Accepted answers must be reproducible from the tiles verbatim. `sentenceScorer.test.ts`
  and `buildASentenceConformance.test.ts` both hold that line against the hand-authored fixture.

**No schema change.** `BuildASentenceItemSchema` is deliberately loose and already parses every new
shape: a frame that begins with a blank, a frame that is only blanks, nine-token answers, ten tiles.
Tightening it would have been the wrong lever anyway — `readSet`/`listSets` drop an unparseable Set
**silently**, and a dropped Set takes every past Attempt against it out of review with it, so a
narrowed schema deletes practice history rather than reporting a defect. `schemas.test.ts` now
re-validates every banked Writing Set on disk, so a future narrowing fails the suite instead.

**The pooled budget is 410 s (6:50), up from 360 s.** ETS publishes no per-part figure for Build a
Sentence — only the section estimate of about 23 minutes, plus the two essays' own limits (7:00 and
10:00). 360 was the arithmetic residual, 1380 − 420 − 600, and that residual has to cover this
part's directions as well as its ten Items, so it was knowingly an upper bound on answering time
rather than a published number. 410 s is the figure third-party reporting (Magoosh) gives for the
part, and a reported measurement beats a residual: it is the only number anyone has actually
observed. It does not contradict the published total so much as expose what the residual left out —
410 + 420 + 600 = 1430 s = 23:50, still "about 23 minutes" once the section's own directions are
excluded, and the 50 s difference points the direction the residual's known flaw predicts. **If ETS
ever publishes a per-part figure, it outranks this one.**

## Consequences

The gate now reports nine kinds, four of them fatal, and accepts all three shapes in
`server/test/fixtures/build-a-sentence-reorder-shapes.json`: start-blanked, full reorder (ten tiles,
nine blanks), and the conventional fixed-opening frame, which is kept as the control — widening a
gate must not stop it accepting what it already accepted. An Item in the shape of ETS's sample still
passes every rule. ETS's own Item is no longer in the repository (ETS licenses it); the golden case
is `server/test/fixtures/build-a-sentence-reference-item.json`, an Item this project wrote in the
same shape.

Nothing in the render path changed. `parseSentenceFrame` already emitted no empty literal ahead of a
leading blank, and `SentenceTiles` already drew the frame's literals verbatim, so both new shapes
render correctly today — `sentenceFrame.test.ts` and `BuildSentenceTask.test.tsx` now pin that
rather than assume it, structurally (the frame's first child element *is* the first blank) instead
of by inspecting text, because an empty blank draws its own placeholder space and would mask a
phantom leading literal.

The budget's move made it stop being a whole number of minutes, which turned the Simulation's intro
copy into a lie: `Math.round(410 / 60)` promises seven minutes for a Task that ends at 6:50.
`BUILD_A_SENTENCE_BUDGET_CLOCK` lives next to the constant it formats and is what both screens print,
so the copy cannot drift from the clock the User is racing.

Two things this deliberately does NOT do:

- **It publishes no Set.** The three shapes exist as test fixtures. Generating a pilot Set against
  the new rules is issue #127's, along with the generation-guide rewrite that tells the model to emit
  them — until that lands, the gate accepts shapes the generator does not yet produce, which is the
  harmless direction for a gate to be wrong in.
- **It does not touch Import.** ADR-0006's reasoning holds unchanged: imported material is the
  User's own transcription, and no Build a Sentence gate runs over it.
