# Two-stage adaptive Sets for Reading and Listening

## Status

Accepted. The rule every Band Estimate now follows (the whole sitting scored) is ADR 0010.

## Context

The 2026 Reading and Listening sections are two-stage adaptive. Every test taker sits a Router
Module, then a lower or an upper second module chosen from Router performance [ETS: Test Blueprint
and Specifications]. ETS publishes which Task Types each module carries and how bands map to a
legacy 0–30 scale, but not its routing rule, not a raw-to-band formula for the new test, and nothing
about what the lower module limits.

Every constant below is marked **[ETS]** (traceable to an ETS document) or **[ours]** (an assumption
this project owns, can tune, and must disclose).

## Decision

Bake the shape into content. Every Reading and Listening Set permanently contains three modules,
Router, Lower and Upper, in one immutable JSON file. The server routes an Attempt, persists its
Module Path on the Attempt, and estimates the band with method `table3-v1`.

### What a module contains

**[ETS]** Scored items per Reading module (Technical Manual RR-25-12, Table 1):

| Module | Complete the Words | Read in Daily Life | Read an Academic Passage | Scored items |
|---|---|---|---|---|
| Router | 10 | 5 | 5 | 20 |
| Second stage, lower | 10 | 5 | 0 | 15 |
| Second stage, upper | 10 | 0 | 5 | 15 |

The upper module has no Read in Daily Life text and the lower module has no Academic Passage. The
two paths differ in task mix, not only in prose difficulty.

**[ours]** Our Sets carry more Stimuli per module than ETS does (`READING_MODULE_COMPOSITION` and
`LISTENING_MODULE_COMPOSITION` in `shared/src/schemas/listening.ts`), because practice volume matters more
than item-count fidelity here and `table3-v1` is percent-based, so the item count is
scoring-neutral. The Reading upper module follows Table 1 (no Daily Life text). The Reading lower
module keeps one Academic Passage, which Table 1 gives it none of: without it the lower path never
meets expository reading, the one Task Type a learner trying to move up most needs. The cost is a
lower path slightly harder than ETS's, which under-states rather than over-states a lower-path
band. Composition binds only the generation schemas, never the persisted Set schema, so Sets banked
under an older composition keep loading.

**[ETS]** The Reading Router carries moderate tasks only (CEFR B1–B2, the band ETS labels medium);
the second module opens the range (upper: high; lower: at or below medium). An earlier generation
guide told the model to spread the Router over the full range; that was never ETS's design and
produced lower modules that read at upper difficulty, which makes a routed band dishonest. The
generation guide's difficulty table and `READING_MODULE_GRADE_BANDS` in
`server/src/services/moduleDifficulty.ts` encode the bands and must agree. Out-of-band difficulty is
an advisory note (ADR 0006); an Upper Module not harder than its Lower is fatal.

### Routing threshold

`ROUTER_PROMOTION_THRESHOLD = 0.6` Router raw fraction, in `server/src/services/moduleRouter.ts`
**[ours]**. ETS discloses no routing rule. The number comes from third-party analyses that
extrapolate the digital SAT's module-2 routing point (about 55–70% correct). It is kept because it
also lines up with Table 3 below: Reading band 4.0, the B2 floor, starts at 18/30, exactly 60%, so
routing at 0.6 sends everyone performing at B2 or better to the module that can measure above the
lower-path cap. The same reading gives about 57% for Listening (17/30); one flat 0.6 is used for both
because a three-point spread is below one Router item's noise. Per-section thresholds read off
Table 3's band-4 boundary are the fallback if calibration ever warrants them.

That derivation reads a Router raw fraction against a whole-form boundary, which is comparable only
when the Router sits at the form's average difficulty. Since Reading Routers became moderate-only,
the same ability scores higher on the Router than it did on a mixed one, so 0.6 is a slightly easier
bar than when it was derived. Nothing is measured yet and 0.6 stays inside the 55–70% corridor, so
the value stands. A future retune must calibrate against routing data from moderate-only Routers.
Listening Routers carry no readability band and are unaffected.

### Band estimation: `table3-v1`

**[ETS]** Table 3 of the score-report overview maps each band to the legacy 0–30 scaled score. It is
non-linear:

| Band | Reading (scaled 0–30) | Listening (scaled 0–30) |
|---|---|---|
| 6.0 | 29–30 | 28–30 |
| 5.5 | 27–28 | 26–27 |
| 5.0 | 24–26 | 22–25 |
| 4.5 | 22–23 | 20–21 |
| 4.0 | 18–21 | 17–19 |
| 3.5 | 12–17 | 13–16 |
| 3.0 | 6–11 | 9–12 |
| 2.5 | 4–5 | 6–8 |
| 2.0 | 3 | 4–5 |
| 1.5 | 2 | 2–3 |
| 1.0 | 0–1 | 0–1 |

The overview's own Table 1 prints Reading and Listening as 0–30 under a "Raw Score Range" heading.
For these two sections that 0–30 is the legacy scaled range Table 3 uses, not raw: the Technical
Manual (Table 8) gives raw ranges of 0–35 for Reading and Listening.

**[ours]** `table3-v1` projects an Attempt's percent-correct onto 0–30
(`Math.round(fraction × 30)`) and reads the band off Table 3. ETS publishes no raw-to-band formula
for the new test, so the projection is ours.

**[ours]** `LOWER_PATH_BAND_CAP = 4.5` in `server/src/services/bandEstimator.ts`: an Attempt routed
to the Lower Module is capped there however well it scored. The lower module's task mix tops out
around B2 evidence, and an uncapped lookup would read an aced easier module as band 6. ETS states no
such cap.

Percent-correct ignores that lower-path items are easier; the cap is the coarse compensation. A
difficulty-weighted mapping would be a new method (`table3-v2`). Method strings are versioned so a
persisted estimate is never reinterpreted by a later formula.

### Band to CEFR level

**[ETS]** One concordance for all four sections and the Overall (Technical Manual RR-25-12,
Table 9): 6 = C2, 5–5.5 = C1, 4–4.5 = B2, 3–3.5 = B1, 2–2.5 = A2, 1–1.5 = A1. It lives in
`shared/src/cefr.ts` and is pinned by `server/test/cefr.test.ts`.

## Considered Options

- Linear Sets with no routing: rejected. Pacing and content mix stop matching the real exam, and a
  single difficulty level either under-measures a strong section or over-punishes a weak one.
- A shared item bank assembled per Attempt (IRT-lite): rejected. It destroys Set immutability,
  novelty accounting and reviewability, and there are no calibrated difficulty parameters to make it
  honest.
- An uncapped Table 3 lookup: rejected. Acing the easier lower module would read as band 6. The cap
  is coarse but errs toward honesty, and it is one exported constant.

## Consequences

Each Set carries about 1.6× the content one Attempt sees: the unrouted variant goes unused but keeps
Repeats and review coherent. Restructuring modules means regenerating Sets, not migrating them.

Every band-bearing surface discloses the Module Path and that the threshold and cap are estimator
assumptions, not ETS policy. Only a routed Simulation produces a Reading or Listening Band Estimate.
A Drill uses the Router Module's items without routing and never produces one.

An Upper Module that is not harder than its Lower fails generation (ADR 0006): the threshold and the
cap are honest only if the two modules differ.
