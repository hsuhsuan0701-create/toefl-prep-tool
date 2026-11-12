# A band needs the whole sitting scored, and the Overall needs every section

## Status

Accepted. Tightened from "every Task Type has a scored Item" to "every Item is scored", and for
Reading and Listening from "every Task Type of the Modules taken" to "every Task Type of each Module
taken".

## Context

The estimator used to spread a section's weights over whichever Task Types had scores, and the
Dashboard took the latest Simulation whatever it covered. One Speaking Simulation whose three
Interview Items were skipped became the Speaking headline at 1.0 for a day. Another headline was
Listen and Repeat alone. A Writing band computed after Build a Sentence had scored but before either
essay had covered a third of the section's points and claimed all of them. A Full-Test Run read that
partial Writing band the moment the section ended, and kept it when essay scoring later failed.

A band built from some of a section's Task Types is not a rough version of the section band. It is
a different quantity under the same label.

Requiring one scored Item per Task Type was not enough. One real Speaking Attempt got a band of 1.5
from one Listen and Repeat Item (a silent recording scored 0) and four Interview answers, three of
them skipped, while the other six Listen and Repeat Items had failed scoring. Six of the eleven Items
said nothing about the User, and the band treated the one that remained as the whole Task Type.

Counting Task Types across a whole Reading or Listening Attempt was not enough either. The Router
Module carries every Task Type of its section, so a Simulation routed and then completed without its
second Module ("Finish and score" in the Attempt log) passed the count: a perfect Router Module
alone read as band 6 and became the section's headline, from half the test.

## Decision

**A Band Estimate exists only when every Item of the Attempt is scored and every Task Type its
section requires has at least one Item.** Short of that there is no number: the result says, per
Task Type, how many Items failed scoring, how many are still unscored, and how many recordings never
reached the server, and which required Task Types have no Item at all (for Reading and Listening,
which Module is short and of what). The surface says what to do in the User's terms.

- Speaking requires Listen and Repeat and Interview. Writing requires Build a Sentence, Email and
  Academic Discussion.
- Reading and Listening require it per Module: the Router Module and the second Module the Module
  Path names each need an Item of every Task Type that Module carries in the Module composition
  (`READING_MODULE_COMPOSITION`, `LISTENING_MODULE_COMPOSITION`). An Item belongs to the Module its
  score_json is tagged with, which deterministic scoring has always written; a row without the tag
  counts toward neither Module. A Module that carries more than the composition asks (an older
  Upper Module's Daily Life text) is scored like any other and never required.
- A deliberate skip scores 0 and counts as scored, as an unanswered Item does on the exam. Coverage
  reports how many of an Attempt's Items were skips.
- An Item whose scoring failed, that is pending or waiting on a transcription, or whose recording
  never reached the server means no band. Nothing is left out of the mean and nothing missing is
  scored 0: the User's options are a Re-score, a transcription Retry, or a new Attempt.
- A missing Task Type's weight is never spread over the ones present.
- The rule holds on the read side too, decided from the Attempt's current Item rows. A persisted
  estimate whose Attempt fails the rule, or whose stored coverage misses a Task Type, is not a band:
  rows written under the earlier rule stop surfacing without being rewritten.
- Bands are computed in exact fractions of integers and rounded half up, so a tie such as 3.75 does
  not drift to 3.7499… and round down.

**An Overall band exists only when all four sections have a value, and it is ETS's mean-then-round
over those four.** A mean of three sections is a different number, not an approximation of four. A
first run has no Overall. In a Full-Test Run, a section whose Attempt still has scoring outstanding
is pending, and the Run's Overall (`mean-of-sections-v1`) is absent while any section is pending; the
report says which.

The rule is stated once, in `bandShortfall` (`server/src/services/sectionEstimates.ts`), and every
writer and reader goes through it: `computeSectionEstimate` and `recomputeSectionEstimate` for writes,
`persistedRowToEstimate` for every read (the Attempt review, the Attempt list, the Full-Test Run, and
`server/src/db/stores/estimates.ts` for the Dashboard headline and its recent-Simulations range).
`deriveOverall` in `server/src/routes/stats.ts` and `deriveFullTestOverall` in
`server/src/services/fullTestRun.ts` compute the two Overalls from section bands that passed it.

## Considered Options

- **Re-spread the weights over what is present** (the original behaviour): rejected. It produced the
  1.0 headline above.
- **One scored Item per Task Type** (this ADR's first version): rejected. It produced the 1.5 above.
- **Leave unscored Items out of the mean**: rejected for the same reason; the band then describes the
  Items that happened to score.
- **Show a partial band with a warning**: rejected. A labelled wrong number is still read as the
  number, and an estimate's label is already doing the work of saying "unofficial".
- **Average the sections that have bands**: rejected for the same reason.

## Consequences

A section shows no band until every Item of an Attempt is scored, and a new User sees "No band yet"
with what to score next rather than a number. An infrastructure failure (a recording that never
arrived) now costs the Attempt its band, where before it cost only that Item. Fewer Attempts produce
a headline, and each one that does measures the whole sitting.

The tests that pin the rule: `server/test/bandWholeSitting.test.ts` (the rule through the routes, a
legacy row, the Writing band arriving with its last essay), `server/test/sectionEstimates.test.ts`
(the per-Module rule), `server/test/routes.attempts.reading.test.ts` (a routed Simulation finished
before its second Module), `server/test/bankedRoutedSittings.test.ts` (every banked Reading and
Listening Set, sat in full on either path, has its band),
`server/test/bandEstimator.test.ts` (weights, exact rounding),
`server/test/estimatesStore.coverage.test.ts` (stored coverage on the read side),
`server/test/routes.stats.honesty.test.ts` (the Overall), and
`server/test/routes.fullTests.bandStatus.test.ts` (a Full-Test section still scoring is pending).
