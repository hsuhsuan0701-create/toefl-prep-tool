# One generation-check policy, in three tiers

Every check a generation stage performs is classified into exactly one tier. Plan admission, the four
content gates, the audio pace and clip-ceiling verdicts and the Upper-versus-Lower Module difficulty
check read theirs from `server/src/services/generationCheckPolicy.ts`. Three checks still decide in
their own stage, and the table below records where each landed:

- **Item ids** (`validateItemIds` in `generationCandidateLoop.ts`) throw, which fails the job. The
  exceptions are Listening's and Speaking's candidate adapters, which turn a candidate-stage failure
  into a rejection the candidate loop regenerates. They also check there what the audio render
  would otherwise find only after verification: that every id naming a clip file names its own,
  compared without case (a Listening Stimulus or Listen and Choose a Response item,
  `listeningClipIdProblem`; a Speaking Item, which also may not be `briefing`, `int-intro` or
  `audio-manifest`, `speakingClipIdProblem`).
- **Verifier verdicts** are counted by each section's verify policy (`readingGenerator.ts`,
  `listeningGenerator.ts`, `generator.ts`'s Build a Sentence Verifier), which decides which verdicts
  stay outstanding and which are accepted with a note.
- **Complete the Words gap derivation** (`deriveWithRepair` in `readingGenerator.ts`) asks for up to
  three paragraphs and fails the job if none yields ten gaps.

- **fatal** — the Set would be unusable, or would teach a wrong answer. The job fails.
- **advisory** — the Set is publishable. The issue is recorded on the Set (ADR-0006's companion,
  `advisoryNotes`) and never blocks. The User sees the kinds that change what they practise; the
  client hides the rest (`advisoryNoteLines` in `client/src/ui/labels.ts`).
- **repair-then-accept** — one bounded corrective attempt, then degrade. The tier carries its own
  degrade target so that "repair, then fail anyway" is a thing you have to write down rather than a
  thing that happens by omission.

**The rule that assigns a tier: a check may block a Set only when the Set would otherwise be unusable
or would teach a wrong answer. Similarity and taste are recorded, never fatal.**

The decision this replaces lived in five places, each written and changed independently: Plan
validation (`isPlanBlockingIssue`), the three candidate loops in `generator.ts` (which disagreed with
each other — speaking/writing/reading treated every issue as fatal while listening split them), the
two content gates' `REMEDIABLE_VIOLATION_KINDS`, and both audio renderers' pace handling. Commit
320511e counts fourteen rediscoveries of one defect underneath all of them: a deterministic gate
written as all-or-nothing over probabilistic output.

The evidence that forced this: of 33 recorded generation failures, 13 came from quality gates — 7
speech-rate band misses, 4 plan-conformance, 2 Plan diversity — and Listening had produced 0 Sets
from 4 jobs. The Catalog those novelty gates measured against held 1 Listening Set and 2 Reading
Sets, so the machinery was sized for a content library that does not exist.

## Considered Options

- **Keep per-stage decisions, fix them one at a time** — rejected: that is the history. Each of the
  fourteen rediscoveries was a local fix to a local gate, and the next gate drifted the same way.
- **Make every check advisory** — rejected: an ambiguous answer key or a Set whose Upper Module is
  not harder than its Lower does not become acceptable by being recorded. Some checks must block.
- **A numeric severity score with a threshold** — rejected: a threshold is a tunable number, and a
  tunable number is a gate that tightens on its own as someone nudges it. Three named partitions with
  no weights leave nothing to nudge.

## Where each check landed

| Check | Tier |
| --- | --- |
| Catalog overlap (containment), plan stage only, all sections | advisory |
| Plan-stage structural drift (`plan-drift`, `domain-drift`) | fatal |
| Plan-stage `domain-balance` for Build a Sentence (the replan loop is the repair) | repair-then-accept → advisory |
| Candidate-stage domain drift, all sections (recorded where found) | advisory |
| Upper Module not harder than Lower, Reading / Listening | **fatal** |
| Item ids unique and well-formed, re-checked after verification | **fatal** |
| Audio clip outside its speech-rate band | repair-then-accept → advisory |
| Audio clip outside the 0.3×–3.0× sanity window (truncated / stuck synthesis) | fatal |
| Listen and Repeat clip still past its clip ceiling after the corrective re-render | repair-then-accept → advisory |
| Content gate, module composition, Reading / Listening | fatal |
| Content gate, Reading word count (all three Task Types) and `academic-coverage` | advisory |
| Content gate, every remediable Reading kind but `invalid-answer-key`, and every remediable Listening kind but the two below | repair-then-accept → advisory |
| Content gate, `invalid-answer-key` in Reading and Listening (a key naming no option, or two options sharing an id), and Listening `transcript-language` | repair-then-accept → fatal |
| Verifier: MCQ `issue` (wrong or non-unique key, unanswerable, explanation misstates the key), CtW `ambiguous` over a typeable alternate, CtW `unfaithful-explanation`, Listening `unanswerable` | repair-then-accept → fatal |
| Verifier: MCQ `quality` (correctly keyed but weak), Academic Talk `register` | repair-then-accept → advisory |
| Content gate, Writing Build a Sentence, `frame-missing` / `frame-unparseable` / `answer-length` / `answer-not-from-tiles` | repair-then-accept → fatal |
| Content gate, Writing Build a Sentence, the other five kinds | repair-then-accept → advisory |

Plan-stage drift (`plan-drift`, `domain-drift`) stays fatal while candidate-stage domain drift does
not, and that is deliberate: a plan is cheap to re-ask for, the planner is shown the keyword table it
is graded against, and a plan that contradicts itself costs one short call to fix. A candidate is a
500–900s generate call. Build a Sentence `domain-balance` is the exception at plan stage: ten
situations bunched into too few domains are repetitive practice, not unusable Items, so the
planner's replan attempts are its repair, and the first plan whose only non-advisory issue is that
spread is kept and admitted with a note when they run out.

Similarity is measured once, at plan stage, against the Catalog's entries, each derived from a prior
Set's stored Plan (or from its content, for a Set that carries no Plan). A generated candidate is not measured against the Catalog again, and the
candidate-stage conformance checks that compared it with its Plan are gone, Listening's bounded
conformance repair with them. The one candidate-stage finding left is a component whose wording
classifies as a different domain than its Plan declares; it is recorded on the Set
(`candidateDomainDriftNotes` in `generationNovelty.ts`) and never rejects a candidate.

No candidate-stage similarity or domain check blocks anything, in any section. The three-attempt
candidate retry (`generationCandidateLoop.ts`) still serves what can reject a candidate: the
deterministic content gates (Writing's Build a Sentence, Speaking's Listen and Repeat), an Upper
Module not harder than its Lower, and Listening's and Speaking's item-id drift. For the two fatal ones, a fatal
finding at candidate stage rejects the candidate rather than ending the job at once: the loop
regenerates while its three attempts last, and the job fails when they run out. After verification
the same two checks run again on the content that will publish and fail the job on sight.

## Consequences

Novelty is a preference, permanently. It may bias a Plan — `preferredDomains` still reaches the
planner prompt — and it may warn, but it may never be the reason a section cannot produce a Set.

A tier change is now one edit in one file, and the test that pins each check's tier
(`server/test/generationCheckPolicy.test.ts`) has to be edited alongside it, deliberately.

The policy is a leaf module: it names no generator in any import, type-only or otherwise. The two
content-gate kind unions are therefore restated in the policy and pinned to the generators' own
unions by a mutual-assignability assertion that fails to compile if either drifts.

Issue #97 changed why that holds, and nothing else about it. The original reason was
`noveltyAudit.test.ts`, which walked the audit's import graph textually and would have failed on a
specifier naming a generator: the policy sat inside that graph because the audit reached it through
`generationNovelty.ts`. Splitting that module put the Catalog on the `SetStore` port and left the
policy out of the audit's graph entirely, so the textual scan no longer enforces this. The decision
stands on the reason it always had underneath: a policy that imports the stages which consult it
depends back on them, and the mutual-assignability assertion — which was always the thing keeping the
restated unions honest — is unaffected either way.

### The repair-then-fail deviation, closed

Until 2026-11 most remediable content-gate kinds were `repair-then-accept` with `unrepaired: "fatal"`:
the verify loop got a bounded budget and, if remediation never landed, the job still failed. That was
the one place the tiers did not meet their own definition, and the recorded failures sat there — an
explanation still too long, a position reference the detector should not have flagged, a paragraph
one word short. Each is now asked the rule's own question.

- **Advisory, no repair.** Reading word count for all three Task Types, and `academic-coverage`. A
  Complete-the-Words paragraph that reaches verification has already derived its 10 gaps, so its
  length changes nothing else. A Daily Life text or Academic Passage outside its range is off-target
  practice against the module clock, but its questions are still answerable from it — and one that
  cannot support its questions is the Verifier's `issue` verdict, which still blocks. An Academic
  Passage whose five questions miss a skill slot is a blueprint miss; every question is still
  answerable and keyed. None of these has a regeneration route that targets it.
- **Repair, then advisory.** Every other remediable kind in both sections but the three below:
  explanation length or language, a stem or option not in English, option-length bias,
  a Stimulus or utterance off its length target, a gap leak (issue #36), and a position reference in
  an explanation. Each is answerable and correctly keyed when the budget runs out. A surviving
  position reference is the one that could have gone on to teach a wrong answer: the finishing
  shuffle would move the option it names. The finishing step therefore leaves that Item's options in
  the order its explanation describes.
- **Repair, then fatal.** `invalid-answer-key`, in Reading and Listening alike (no option is the
  key, so no Response can be marked right; or two options share an id, so neither the key nor a
  Response can say which one it means), and Listening `transcript-language` (an English voice
  reading a non-English transcript is not a listening task). Each leaves the Set unusable, which is
  the rule's own bar. The question is regenerated whole, whether the defect came from the generate
  call or from a regeneration's reply, and the job fails only if it survives every repair round.

Every surviving finding is recorded on the Set as a `content-gate` note, and the ones that change
what the User practises are shown before they start.

Two Verifier verdicts were split the same way. An MCQ's `issue` now means only a key the learner
would be taught wrong; a correctly keyed but weak Item is `quality`, which buys one regeneration and
is then accepted with an `item-quality` note, the shape issue #131's `register` verdict set. A CtW
`ambiguous` verdict must name each gap and its alternate word, and the server drops any claim whose
word could not be typed into the blank. Separately, a Verifier pass now stands until the content it
judged changes. That is not a tier change, but it is what kept a final-round re-flag of an
already-passed Item from failing a job.

The related fix on the generation side, from issues #34–#36, still holds: a repair prompt states the
constraints its output will be measured against, because a repair is a different entry point into the
same skill and the model does not re-read the whole guide for it.

### Writing's Build a Sentence content gate (issue #44)

Writing's gate is the first content gate where EVERY kind is remediable, so both rows above are
`repair-then-accept` and only the ending differs. The repair is not a targeted per-entry call like
Listening's: it is the candidate loop's existing 3-attempt regeneration, handed the complete
violation list, which is cheap here because the whole gate is decidable by counting and is therefore
re-run for free on each attempt.

Splitting the kinds asked the rule's own question — is the Set unusable, or does it teach a wrong
answer? There were ten of them when this was written; ADR-0009 (issue #126) removed `frame-all-blanks`
outright, because an all-blank frame turned out to be the reorder the real exam sets rather than a
departure from the format, so nine remain and the tiering below is otherwise unchanged.

- **Four kinds fail it.** Build a Sentence is machine scored by exact match against `answers`, so an
  `answer-length` or `answer-not-from-tiles` violation means no arrangement the learner can build
  equals the key: every attempt is marked wrong. `frame-unparseable` has no blanks to render, and
  `BuildASentenceItemSchema` refuses it outright. `frame-missing` leaves an Item the Drill cannot lay
  out — issue #42 states that a frameless Item shows a notice rather than an interaction — so the
  learner cannot attempt it at all.
- **Five kinds pass it, and so degrade to advisory.** A frame missing its full stop, a tile count
  outside the accepted range, a second distractor, a tile carrying a capital or a period: each makes
  an Item off-format, easier, or uglier, and none makes it unanswerable. The banked Sets run 3–8
  tiles and are practised as they are. `tile-initial-capital` in particular over-fires by design on a
  proper noun or `I`, which no counting rule can distinguish from a genuine position leak —
  discarding a Set of ten Items plus an email plus a discussion over that would be issues #34–#36 all
  over again. (ADR-0009 later changed what that kind MEANS — it enforces the exam's lowercase-tile
  rule, not "this tile can only be first" — and widened the tile range to 4–10. Its tier is
  untouched.)

One shape needs naming because it looks like an exception: `distractor-count` covers the genuinely
unanswerable case of more blanks than tiles. It is still advisory, because that case always co-fires
`answer-length` or `answer-not-from-tiles`, which are fatal. Nothing unusable escapes through it.

Import runs no Build a Sentence gate at all. Imported material is the User's own transcription, and
annotating or rejecting it against a format ETS publishes one sample of would be the app
second-guessing something it was handed on purpose.

### The one conformance property that stays fatal

A Reading or Listening Set whose Upper Module is not harder than its Lower Module fails the job.
Those two sections are scored deterministically from the answer key with no Judge to catch a defect,
and ADR-0005's Module Path, `ROUTER_PROMOTION_THRESHOLD` and `LOWER_PATH_BAND_CAP` are only honest if
the two modules genuinely differ in difficulty. A Set that fails this yields a dishonest Band
Estimate, which is the definition of "teaches a wrong answer" applied to an estimate rather than an
item. Difficulty is compared deterministically — see `server/src/services/moduleDifficulty.ts` — so
the check costs nothing and is exercisable with no live model call.

### A fatal check that was failing its own premise (issue #115)

Speaking's plan-stage physical-setting check — `listenAndRepeat.setting` must contain one of
`PHYSICAL_SETTING_TERMS` — is `plan-drift`, and this document's own reasoning above says
plan-drift stays fatal because "the planner is shown the keyword table it is graded against" and a
plan that contradicts itself "costs one short call to fix." Issue #115 found that premise was false
for this one check: the term table lived only in server code, `generationPlanner.ts`'s prompt never
sent it, and the generation guide never named it. The model was rejected against a rule it had no
way to see, so "cheap to fix" degraded into "cheap to retry and hope" — exactly the failure this
policy exists to prevent, reintroduced by omission in the one check that forgot to apply it. The
Catalog measured 14 of the original 20 terms already in use across 48 banked Sets, and the
generation guide's own suggested campus venues (a greenhouse, an archive) fell outside the list
entirely — so the rejections were not rare bad luck, they were the predictable result of an unseen,
narrowing rule.

The fix sends `PHYSICAL_SETTING_TERMS` to the planner exactly as `DOMAIN_KEYWORDS` already is — same
mechanism, same file, same reasoning — and widens the list to close the gaps the generation guide's
own examples exposed. The check **stays fatal**: nothing about why the property matters changed.
`listenAndRepeat`'s setting is illustrated as a single map-view scene image and its seven items are
meant to progress through "movement through a space" (generation-guide.md); a setting with no
physical noun at all cannot support either, which is genuinely "the Set would be unusable," not
taste. What changed is that the ADR's stated justification for fatal — cheap, deliberate,
addressable — is now actually true of this check instead of only claimed for it.

One consequence is deliberately accepted rather than engineered around: a plan can still satisfy the
check by appending an unrelated listed word to an otherwise-fine setting ("a campus greenhouse
facility"). Closing that completely would mean replacing a keyword match with real semantic
judgment — the kind of check this policy's tiers were built to keep off the fatal path when a
cheaper signal will do, and no live model call is available at plan-validation time to make that
judgment cheaply. The hole is kept because it is one-directional: it can only let an already-concrete
setting through with an awkward word attached, never disguise a genuinely abstract one, since padding
a place noun onto "the abstract value of creativity" does not make it a place. `PHYSICAL_SETTING_TERMS`'
own comment in `generationNovelty.ts` states this in full, including why "train" is deliberately
excluded from the widened list despite being a plausible physical setting — it collides with
"training," the verb nearly every Listen and Repeat scenario is built on, and including it would have
made the check pass on incidental vocabulary rather than the setting the check exists to test.
