---
name: toefl-speaking
description: Score, aggregate judge verdicts for, plan, generate, or coach TOEFL iBT 2026 Speaking (Listen and Repeat; Take an Interview). Use for any TOEFL speaking scoring, feedback, question generation, or 批改/打分 request.
---

# TOEFL Speaking (2026 format)

Task facts: Listen and Repeat = 7 sentences, heard once, response windows 8/8/10/10/10/12/12s,
scored 0–5 each on repetition accuracy + intelligibility. Take an Interview = 4 questions, 45s each,
no prep, scored 0–5 on elaboration, pace, intelligibility/prosody, grammar/vocabulary.

(The "maximum of 8 to 12 seconds" per-repetition range traces to the *Updated TOEFL iBT Test
Overview* but is unverified in-repo; it, the exact 8/8/10/10/10/12/12 ramp, and the no-prep
interview flow are this app's conventions. Don't attribute them to ETS when coaching.)

## Which rubric and sample files to read

`references/rubric-listen-and-repeat.md`, `references/rubric-interview.md` and `references/samples-scored.md` are
this project's own description of ETS's published scoring criteria and its own scored
illustrations. A user may install ETS's official text on their own machine. For each of those three
files, if `references/official/<same name>` exists, read it instead of the shipped file wherever
this skill says to read that file: try the official path first, and read the shipped file only when
the official one does not exist. When the files are supplied to you inline instead of read from
disk, the path on each supplied block already names the copy to use.

## Mode detection

- Prompt starts with `AGGREGATE listen_repeat` or `AGGREGATE interview` + fenced JSON → Arbiter procedure.
- Prompt starts with `PLAN speaking` + fenced catalog JSON → Planning procedure.
- Prompt starts with `GENERATE speaking` → Generation procedure.
- Prompt starts with `IMPORT speaking` + source text/path → Import procedure.
- Anything else → interactive coaching (answer in the user's language; cite the rubric).

## Arbiter procedure (AGGREGATE)

1. Read the relevant `references/rubric-*.md` for the task type
   (`rubric-listen-and-repeat.md` or `rubric-interview.md`).
2. The payload has two parts: `partA` (materials, transcript, Delivery Report, word alignment,
   judges' evidence WITHOUT scores) and `partB` (judges' numeric scores).
3. PHASE 1 — using ONLY partA and the rubric, score each item yourself, citing quoted evidence.
   Anchor severity against `references/samples-scored.md`. Commit these as `ownScore` BEFORE
   considering partB. (partB appears in your context; deliberately ignore it until phase 2 — this
   output-order commitment is the point. An independent score you can defend is the only thing that
   makes reconciliation meaningful; if you peek, you get anchoring dressed up as arbitration.)
4. PHASE 2 — compare with partB. Set `finalScore`, explain deviations in `reconciliationNote`.
   If judges differ by ≥1.5, set `lowConfidence: true`. If partB carries only one judge's score,
   set `singleJudge: true` — the learner should know a score rests on one opinion plus yours.
5. ASR caveat: transcript-derived intelligibility judgments are proxies; weight the Delivery Report
   and judges' audio observations for delivery dimensions.
6. For each item: deductions (quote → issue → fix → category), `feedbackZh` (1–3 句繁體中文總評),
   and for interview items a `modelRewrite` pitched at a high-scoring response (target band 5.5
   overall): a 5-level response on this item's 0–5 scale, reusing the test taker's own ideas.
7. Output ONLY JSON matching the provided schema. No prose.

### Severity anchors — read before committing any score

`references/samples-scored.md` (or its official copy, as above) is not optional background. Every
scored speaking response ETS publishes earns a **5**, including interview answers with roughly
twenty-five filled pauses between them, silences in the middle of clauses, self-repairs and several
uncorrected agreement errors — and ETS's comment on them treats the pauses and fillers as natural
speech that leaves the meaning intact. The shipped file illustrates the same point with this
project's own transcripts, and adds reasoned anchors for the bands below 5 that ETS never shows.

The dominant failure mode in this task is **over-penalizing a transcript for looking disfluent**.
A transcript of a perfectly natural answer reads as a mess of ellipses and "um"s that a listener
never noticed. Scoring how the text looks rather than whether meaning landed costs one to two bands
of accuracy. Before writing any hesitation-based deduction, ask the rubric's actual question: did
the pausing produce a **choppy pace** that broke the listener's ability to follow? Countable pauses
are not choppy pace.

Same for grammar: reserve deductions for errors that blur what was meant. An agreement slip such as
"a lot of students, they works part-time" costs nothing when the meaning lands.

For Listen and Repeat the scale is mechanical and the word alignment does most of the work — but
note the 5/4 boundary is strict (any deviation drops below 5) while the 4/3 boundary turns on
whether *meaning* survived, not on how many words moved.

## Generation procedure (GENERATE)

Follow `references/generation-guide.md`. When the prompt contains an accepted plan, implement it
exactly rather than selecting a replacement setting or topic. Output ONLY a JSON object matching
the speaking generation-input schema in the prompt.

## Planning procedure (PLAN speaking)

1. Follow `references/generation-guide.md`, especially its Planning mode section.
2. Treat every catalog entry as an exclusion signal, never as content or wording to copy.
3. Select from the supplied preferred underrepresented domains while preserving required TOEFL
   structural repetition and avoiding semantic repetition.
4. Return ONLY JSON matching the supplied planning schema. Do not draft learner-facing sentences
   or questions.

## Import procedure (IMPORT)

Parse the provided source material into the same speaking set schema, preserving original wording
exactly; where audio timing metadata is absent, apply the standard windows above. Output ONLY JSON.

## Interactive coaching (no mode prefix)

Answer in the user's language — if they write 中文, reply in 繁體中文. Ground every claim in the
rubric files rather than general test-prep advice, and quote the band descriptor you're applying so
the learner can see the standard rather than trusting your verdict. Band numbers are estimates;
label them that way.
