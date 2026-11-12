---
name: toefl-writing
description: Score, aggregate judge verdicts for, plan, generate, or coach TOEFL iBT 2026 Writing (Build a Sentence; Write an Email; Write for an Academic Discussion). Use for any TOEFL writing scoring, feedback, essay/email feedback, prompt generation, or 批改/打分 request.
---

# TOEFL Writing (2026 format)

Task facts: Build a Sentence = 10 tile-ordering items, **machine scored** by exact match
against the Set's accepted orders — there is no ETS 0–5 rubric and AGGREGATE does not apply.
Timing is ONE pooled 410-second budget (6:50) across all ten items — this app's convention
(ETS publishes no per-part Build a Sentence timing; 410 s is the only reported measurement of
the part, and it replaced a 360 s figure that was merely the arithmetic residual of the 23-minute
section estimate — see #126). A tile item carries no `timeLimitSec` of its own — the vestigial `40`
literal was dropped in #85 — so don't teach or coach 40 s per item as a task fact.
Write an Email = 1 item, 7 minutes, scenario + exactly 3 instruction bullets, scored 0–5 on
communicative goal/social conventions, elaboration & cohesion, grammar & vocabulary, mechanics.
Write for an Academic Discussion = 1 item, 10 minutes, professor post + two opposing student posts,
at least 100 words, scored 0–5 on argument & engagement, support & cohesion, grammar & vocabulary,
mechanics.

(ETS publishes the 100-word floor for the discussion and no word count at all for the email; this
app's 80–120 email `wordGuidance` is a practice convention. Don't attribute it to ETS when coaching.)

## Which rubric and sample files to read

`references/rubric-email.md`, `references/rubric-academic-discussion.md` and `references/samples-scored.md` are
this project's own description of ETS's published scoring criteria and its own scored
illustrations. A user may install ETS's official text on their own machine. For each of those three
files, if `references/official/<same name>` exists, read it instead of the shipped file wherever
this skill says to read that file: try the official path first, and read the shipped file only when
the official one does not exist. When the files are supplied to you inline instead of read from
disk, the path on each supplied block already names the copy to use.

## Mode detection

- Prompt starts with `AGGREGATE email` or `AGGREGATE discussion` + fenced JSON → Arbiter procedure.
- Prompt starts with `PLAN writing` + fenced catalog JSON → Planning procedure.
- Prompt starts with `GENERATE writing` → Generation procedure.
- Prompt starts with `IMPORT writing` + source text/path → Import procedure.
- Prompt starts with `VERIFY build_sentence` + fenced JSON → Verification procedure.
- Anything else → interactive coaching (answer in the user's language; cite the rubric).

## Arbiter procedure (AGGREGATE)

1. Read the relevant `references/rubric-*.md` for the task type
   (`rubric-email.md` or `rubric-academic-discussion.md`).
2. The payload has two parts: `partA` (materials, response text, judges' evidence WITHOUT scores)
   and `partB` (judges' numeric scores).
3. PHASE 1 — using ONLY partA and the rubric, score each item yourself, citing quoted evidence.
   Anchor severity against `references/samples-scored.md`. Commit these as `ownScore` BEFORE
   considering partB. (partB appears in your context; deliberately ignore it until phase 2 — this
   output-order commitment is the point. An independent score you can defend is the only thing that
   makes reconciliation meaningful; if you peek, you get anchoring dressed up as arbitration.)
4. PHASE 2 — compare with partB. Set `finalScore`, explain deviations in `reconciliationNote`.
   If judges differ by ≥1.5, set `lowConfidence: true`. If partB carries only one judge's score,
   set `singleJudge: true` — the learner should know a score rests on one opinion plus yours.
5. For each item: deductions (quote → issue → fix → category), `feedbackZh` (1–3 句繁體中文總評),
   and a `modelRewrite` pitched at a high-scoring response (target band 5.5 overall): a 5-level
   response on this item's 0–5 scale, reusing the test taker's own ideas — rewrite their argument,
   don't substitute a better one, or the learner can't see what changed.
6. Output ONLY JSON matching the provided schema. No prose.

### Severity anchors — read before committing any score

Read `references/samples-scored.md` (or its official copy, as above) before scoring. Whichever copy
you have, it is anchored to what ETS's own published Writing samples establish: ETS's one published
discussion post earns a **5** with an agreement slip, a possessive and number error, a dropped
article and a stray hyphen in it, while its one published email loses a band — 5 to **4** — to a
single clause whose verb phrase falls apart. The shipped file illustrates the same contrast with
this project's own responses.

**Count consequence, not error volume.** The rule to apply:

> Errors a reader repairs automatically (spelling, a dropped article, an agreement slip) sit inside
> band 5. An error that forces the reader to stop and reconstruct the intended meaning costs a band.
> One is enough to move 5 → 4.

Both failure modes are live. Do not tally typos into a deduction cascade — a response full of
misspellings but syntactically sound is a 5, not a 3. And do not excuse a broken clause because the
piece is otherwise fluent and well organized — one such clause is enough to cost a polite, on-task,
well-structured email its 5.

Above band 4, separate 5 from 4 on **precision and idiomaticity**, not error count. Below band 4
ETS publishes no exemplar: the shipped anchors there are this project's illustrations, reasoned from
the rubric's descriptions, so say so if the learner asks how firm a low score is.

**Task completion is scored separately from language.** An email that silently drops one of its
three required bullets has not achieved its communicative purpose — that is a `completeness`
deduction no matter how clean the prose. Likewise a discussion post under 100 words, or one that
restates a classmate's position without adding the writer's own reasoning.

## Generation procedure (GENERATE)

Follow `references/generation-guide.md`. When the prompt contains an accepted plan, implement it
exactly rather than selecting replacement situations or propositions. Output ONLY a JSON object
matching the writing generation-input schema in the prompt.

## Planning procedure (PLAN writing)

1. Follow `references/generation-guide.md`, especially its Planning mode section.
2. Treat every catalog entry as an exclusion signal, never as content or wording to copy.
3. Select from the supplied preferred underrepresented domains while preserving required TOEFL
   structural repetition and avoiding semantic repetition.
4. Return ONLY JSON matching the supplied planning schema. Do not draft final prompts, tile
   answers, email bullets, or discussion posts.

## Import procedure (IMPORT)

Parse the provided source material into the same writing set schema, preserving original wording
exactly; where Build a Sentence accepted orders are absent, derive them and enumerate every valid
order. Every Build a Sentence item must carry the `frame` key: transcribe the partial sentence if the
source shows one, and emit `null` only when the source genuinely has no frame — imported material is
taken as given and is not reshaped to fit this app's conventions. Output ONLY JSON.

## Verification procedure (VERIFY build_sentence)

Each payload item carries a `frame` — a partial sentence with a blank (`___`) for each tile it takes.
Drop the accepted order's tiles into the blanks, in order, and read the completed sentence. Then ask
exactly three questions, and nothing else:

1. **Does the completed sentence read naturally, and does it actually answer `prompt`?**
2. **Is there a legitimate alternate order the key misses?** Only a genuinely equal one — a movable
   adverbial, either order of two coordinated elements. An item with many valid orders is a badly
   designed item, not one with an incomplete key; say so by leaving it `"ok"` rather than listing
   five orders.
3. **Does the unused tile genuinely discriminate?** Exactly one tile is left over. It should be a
   real grammatical competitor for one blank (wrong agreement, wrong tense, wrong case), not a word
   nobody would try.

Everything else the payload might tempt you to check — whether the blanks and tiles add up, whether
every answer token is one of the item's own tiles, whether a tile carries a stray capital or full
stop — is already checked deterministically in server code before you are called. Do not re-answer
it, and do not rewrite frames, tiles or prompts: you return **answer-key corrections only**.

Output ONLY JSON matching `{"items":[{"id","verdict":"ok"|"fix","answers":[[...]]?}]}`, one entry per
item, with `answers` present only when `verdict` is `"fix"` (a full replacement list, not a delta).
Every order in a replacement uses only that item's own tiles and fills every blank exactly once.

## Interactive coaching (no mode prefix)

Answer in the user's language — if they write 中文, reply in 繁體中文. Ground every claim in the
rubric files rather than general test-prep advice, and quote the band descriptor you're applying so
the learner can see the standard rather than trusting your verdict. Band numbers are estimates;
label them that way.
