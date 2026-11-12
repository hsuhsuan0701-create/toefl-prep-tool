---
name: toefl-reading
description: Plan, generate, or coach TOEFL iBT 2026 Reading (Complete the Words; Read in Daily Life; Read an Academic Passage). Use for any TOEFL reading question-set generation or reading-strategy coaching request.
---

# TOEFL Reading (2026 format)

Task facts: Complete the Words = a 70–100-word academic paragraph with the second half of every 2nd
word (after an intact first sentence) deleted, 10 gaps per paragraph, answers **typed**, exact
spelling, no partial credit. Read in Daily Life = a 15–150-word practical text (notice, menu,
email, …) with 2–3 MCQs. Read an Academic Passage = a ~200-word expository passage with 5 MCQs
covering factual detail, vocabulary-in-context, inference, idea relationships, and purpose.

**Every item in this section is machine scored** — Complete the Words by exact string match
(`ctwScorer.ts`) and every MCQ by `correctOptionId`. There is no ETS 0–5 rubric, no Judge Report,
and **AGGREGATE does not apply** to Reading; this skill has no Arbiter procedure.

Gap positions for Complete the Words are never authored by the model. `GENERATE reading` produces
bare paragraphs only; the server derives every gap deterministically
(`server/src/services/ctest.ts`) so the answer key is correct by construction. See
`references/generation-guide.md` for exactly how that derivation works and what paragraph content
breaks it.

## Mode detection

- Prompt starts with `PLAN reading` + fenced catalog JSON → Planning procedure.
- Prompt starts with `GENERATE reading` → Generation procedure. This marker covers **five**
  distinct sub-calls in the pipeline — read the instruction sentence right after the marker to tell
  them apart (see the Generation procedure below for exact matching text):
  1. "Produce one complete Reading Set as JSON…" → full-set generation from an accepted plan.
  2. "Regenerate ONE Complete-the-Words source paragraph…" → a single paragraph repair (either the
     gap count came out wrong, or the Verifier flagged the paragraph ambiguous).
  3. "Write the 繁體中文 Explanation (錯題解析) for each derived Complete-the-Words gap…" → per-gap
     Explanation authoring, run only after the server has derived real gaps.
  4. "Regenerate ONLY the flagged MCQ question(s) below for one stimulus…" → targeted MCQ
     distractor regeneration, run only after the Verifier flagged one or more MCQ items "issue" or "quality".
  5. "Rewrite ONLY the 繁體中文 Explanation (錯題解析) of the MCQ question(s) below…" → an
     explanation-only rewrite, run when the server measured one or more MCQ `explanationZh` as
     running far past the ≤120-字 target.
- Prompt starts with `VERIFY reading` + fenced JSON → Verify procedure.
- Anything else → interactive coaching (answer in the user's language; ground claims in this
  guide's CEFR/skill breakdown rather than general test-prep advice).

## Generation procedure (GENERATE)

Follow `references/generation-guide.md` for every one of the five GENERATE sub-calls described
above (including the distractor rules and Explanation rules it already gives, for MCQ distractor
regeneration too).

- **Full-set generation** — the prompt contains an accepted `plan` (fenced as
  `` ```accepted-plan-json` ``). Implement it exactly: same topics/angles/genres/disciplines and
  domains as planned, never a substitute. Output ONLY a JSON object matching the reading
  generation-input schema supplied in the prompt — `router`/`lowerModule`/`upperModule`, each with
  `ctwPassages` (bare `{id, taskType, topic, sourceParagraph}` — no `segments`, no `gaps`),
  `dailyLife`, and `academic` arrays at the exact counts `READING_MODULE_COMPOSITION` states. Do
  not emit `generationPlan`.
- **CtW paragraph repair** — the prompt contains a fenced `` ```ctw-plan-entry` `` and
  `` ```repair-feedback` ``. Read the feedback (either a gap-count mismatch or an "AMBIGUOUS"
  reason quoting the Verifier) and rewrite just that one paragraph to fix it, keeping the same
  planned topic. Return ONLY `{"sourceParagraph": string}`.
- **CtW Explanation authoring** — the prompt contains a fenced `` ```ctw-derived-gaps` `` block
  with the real, already-derived gap ids and completed words. Return ONLY
  `{"explanations":[{"gapId","explanationZh"}, …]}`, exactly one entry per gap listed, using its
  own `gapId`.
- **MCQ distractor regeneration** — the prompt contains a fenced `` ```mcq-regeneration` `` block
  with one stimulus's `stimulusId`, `stimulusText`, and its `flaggedQuestions` (each carrying the
  Verifier's own `reason`). Apply the same distractor rules below to every flagged question, keep
  every other question and the stimulus text untouched, and return ONLY
  `{"questions":[{"id","stem","options":[{"id","text"}, …],"correctOptionId","skill",
  "explanationZh"}, …]}`, exactly one replacement per flagged question, reusing its own `id` and
  carrying exactly 4 options.
- **MCQ Explanation rewrite** — the prompt contains a fenced `` ```mcq-explanation-rewrite` `` block
  with one stimulus's `stimulusId`, `stimulusText`, the `targetZh`, and its `overlongExplanations`
  (each the whole question plus `actualLength`, the measured 字 count of its current draft). The
  question is otherwise fine: rewrite only its `explanationZh` down to `targetZh` (120 字) — cut a whole line
  of reasoning rather than rephrasing, since `actualLength` is how far over it actually is — and
  return ONLY `{"explanations":[{"id","explanationZh"}, …]}`, one entry per question listed,
  reusing its own `id`. Nothing else about the question may change.

## Planning procedure (PLAN reading)

1. Follow `references/generation-guide.md`, especially its Planning mode section.
2. Treat every catalog entry as an exclusion signal, never as content or wording to copy.
3. Select from the supplied preferred underrepresented domains while preserving required TOEFL
   structural repetition (module composition, gap/question counts) and avoiding semantic
   repetition.
4. Return ONLY JSON matching the supplied planning schema (`ctwPassages`, `dailyLifeTexts`,
   `academicPassages`, each in router → lowerModule → upperModule order). Do not draft final
   paragraphs, texts, questions, or explanations.

## Verify procedure (VERIFY reading)

Each gap carries its `prefix` and `blankLength`. The learner sees the prefix followed by exactly
`blankLength` empty letter boxes, and the answer field accepts no more letters than that. So the
only alternates that matter are words that **start with the prefix and have exactly
prefix-length + `blankLength` letters**. A word of any other length — "new" for `ne` + 2 missing
letters, "into" for `i` + 1, "their" for `t` + 2 — cannot be typed into the blank. It is never a
reason to call a gap ambiguous.

For each Complete-the-Words passage: verdict `"ambiguous"` if any gap has a genuinely plausible
alternate completion in its exact context that fits its blank as above — not merely a synonym
spelled differently, a real grammatical/semantic alternative the strict exact-match scorer would
wrongly mark incorrect. List every such gap in `ambiguousGaps` as `{gapId, alternate}`, where
`alternate` is the full alternate word. The server checks each one against the blank and discards
any claim whose word does not fit. Verdict `"unfaithful-explanation"` (listing the offending
`gapIds`) if one or more gaps'
`explanationZh` is factually wrong, explains a *different* gap, or doesn't actually justify why
that gap's own completed word fits its context; otherwise `"ok"`.

The payload carries the text every MCQ is about: `stimuli` holds each Daily Life text and Academic
Passage once (`id`, `taskType`, full `text`), and each `mcqItems` entry names its own by
`stimulusId`. Read that text before judging the item. Whether the key is right, whether a
distractor is genuinely wrong, and whether the explanation is faithful are all questions about what
the text says — never decide them from the stem, the options and the explanation alone.

For each MCQ item (Daily Life or Academic Passage), two failing verdicts, which the server treats
differently:

- `"issue"` — the key would teach the learner something wrong: `correctOptionId` is wrong, another
  option is equally defensible from the text, the question cannot be answered from the text, or
  `explanationZh` misstates the key or cites a detail the text does not contain. The Set cannot
  publish until this is fixed.
- `"quality"` — the item is keyed correctly but weak: a distractor is not genuinely plausible
  (obviously wrong without reading the text), or the `stem` or any `options[].text` is not written
  in English (`explanationZh` is the only field that is ever 繁體中文). The item is regenerated once
  and otherwise published with a note.

`"issue"` takes precedence when both apply; otherwise `"ok"`.

A later round may send only part of the Set: the passages and items whose content changed since
they last passed, each MCQ with its own text. Judge exactly what is sent.

Output ONLY JSON matching the schema supplied in the prompt, one entry per passage/item given —
no prose, no partial coverage. A reply that skips an id, invents one, or judges one twice is
rejected and requested again.

## Interactive coaching (no mode prefix)

Answer in the user's language — if they write 中文, reply in 繁體中文. Ground every claim in this
guide's CEFR descriptors and skill breakdown (`main_idea`/`detail`/`inference`/`vocabulary`/
`purpose`/`organization`, plus the academic-passage rotation alternates `figurative_language`/
`grammatical_complexity`/`rhetorical_structure`) rather than general test-prep advice, and name
which task type and skill a weakness maps to so the learner can see the standard being applied.
There are no numeric Judge scores on this section — coach toward accuracy and speed against the
module time limits, and label any band estimate you reference as an estimate.
