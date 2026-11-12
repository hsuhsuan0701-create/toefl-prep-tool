---
name: toefl-listening
description: Plan, generate, or coach TOEFL iBT 2026 Listening (Listen and Choose a Response; Listen to a Conversation; Listen to an Announcement; Listen to an Academic Talk). Use for any TOEFL listening question-set generation or listening-strategy coaching request.
---

# TOEFL Listening (2026 format)

Task facts: Listen and Choose a Response = one spoken utterance (never shown as text, even after
scoring) of at most six stressed syllables, four written response options, exactly one
socially/contextually appropriate. Listen to a Conversation = two speakers, one male and one
female, 30–60 seconds spoken (aim for 100-130 words total), 2 MCQs. Listen to an Announcement = one
speaker, aim for 55-70 words, 2 MCQs. Listen to an Academic Talk = one speaker, aim for 175-250
words, no background knowledge required, 4 MCQs. Every Stimulus ships with a built-in SVG/CSS
avatar card of its speaker(s) — never a generated image.

**Every item in this section is machine scored** by `correctOptionId` — there is no ETS 0–5
rubric, no Judge Report, and **AGGREGATE does not apply** to Listening; this skill has no Arbiter
procedure.

Audio is rendered by the server from what this skill writes
(`server/src/services/listeningAudioRenderer.ts`) — TTS voice, provider, speaking pace, and `accent`
are entirely server-owned for EVERY Stimulus shape, decided AFTER this skill's output, never by it:
write any schema-valid placeholder for `speaker.accent`/`speaker.voice`/`speaker.provider` — the
server overwrites all three deterministically and nothing you write there is ever used, so do not
spend effort hand-varying `accent` for narrative realism; that balance is the server's job, not
yours. `gender` is different: for a Conversation, you still choose it for its two speakers
(schema-required to be one male and one female — they can refer to each other, so this stays
content-relevant). For every OTHER Stimulus shape (Listen-and-Choose, Announcement, Academic Talk),
`gender` is server-owned too, exactly like `accent`/`voice`/`provider`: write any schema-valid
placeholder — do not spend effort trying to pick a "balanced" gender, and **never let a
single-speaker Stimulus's content depend on which gender ends up assigned** (no self-introduction by
a gendered name/title such as "this is Ms. Delgado", no gendered pronoun referring to the speaker) —
the transcript must read identically regardless of which gender the server assigns.

## Mode detection

- Prompt starts with `PLAN listening` + fenced catalog JSON → Planning procedure.
- Prompt starts with `GENERATE listening` → Generation procedure. This marker covers **five**
  distinct sub-calls in the pipeline — read the instruction sentence right after the marker to
  tell them apart (see the Generation procedure below for exact matching text). Two of them look
  similar at a glance (2 vs 4) — match on WHICH kind of thing is named ("Listen-and-Choose item(s)"
  vs "question(s)"), not just the surrounding words:
  1. "Produce one complete Listening Set as JSON…" → full-set generation from an accepted plan.
  2. "Regenerate ONLY the flagged Listen-and-Choose item(s) below…" → targeted LCR item
     regeneration, run after the Verifier flagged one or more LCR items `"issue"` or `"quality"`,
     OR after the server's own deterministic checks found an utterance running too long, in the
     wrong language, or a `correctOptionId` that doesn't match any of its own options — the
     `reason` field on each flagged item always says which.
  3. "Regenerate ONE Listening stimulus's transcript and questions…" → a whole-stimulus rewrite
     (Conversation, Announcement, or Academic Talk), run after the Verifier flagged the stimulus
     itself `"unanswerable"`, OR after the server's own deterministic checks found the transcript
     outside its target word count or in the wrong language (the prompt's `reason` field says
     which). Handles exactly ONE stimulus per call. Return shape:
     `{"transcript": …, "questions": […]}`.
  4. "Regenerate ONLY the flagged question(s) below for one Listening stimulus…" → targeted MCQ
     regeneration, run after the Verifier flagged one or more questions `"issue"` or `"quality"` on an
     otherwise-sound stimulus, OR after the server's own deterministic checks found a question's
     `correctOptionId` that doesn't match any of its own options, or stem/options in the wrong
     language — the `reason` field says which.
  5. "Rewrite ONLY the 繁體中文 Explanation (錯題解析) of the item(s) below…" → an explanation-only
     rewrite, run when the server's own deterministic checks found one or more `explanationZh`
     either running far past the ≤120-字 target, or containing no 繁體中文 (CJK) at all — each
     flagged item's own `reason` field says which, and what to do about it.
- Prompt starts with `VERIFY listening` + fenced JSON → Verify procedure.
- Anything else → interactive coaching (answer in the user's language; ground claims in this
  guide's skill breakdown rather than general test-prep advice).

## Generation procedure (GENERATE)

Follow `references/generation-guide.md` for every one of the five GENERATE sub-calls described
above (including the utterance/conversation/announcement/talk rules, distractor rules, and
Explanation rules it already gives, for every regeneration sub-call too).

- **Full-set generation** — the prompt contains an accepted `plan` (fenced as
  `` ```accepted-plan-json` ``). Implement it exactly: same topics/settings/disciplines/speaker
  roles and domains as planned, never a substitute. Output ONLY a JSON object matching the
  listening generation-input schema supplied in the prompt — `router`/`lowerModule`/`upperModule`,
  each with `listenChoose`, `conversations`, `announcements`, and `academicTalks` arrays at the
  exact counts `LISTENING_MODULE_COMPOSITION` states. Every `audio` field is the literal empty
  string `""` — the renderer fills it in after this call. Do not emit `generationPlan` or
  `audioProfile`.
- **LCR item regeneration** — the prompt contains a fenced `` ```lcr-regeneration` `` block with
  one or more flagged items, each carrying a `reason` — the Verifier's own `"issue"` or `"quality"` reason, or the
  server's own deterministic check explaining the utterance ran too long, was in the wrong language,
  or `correctOptionId` didn't match any of its own options. Rewrite each flagged item's
  `utterance`/`options`/`correctOptionId`/`skill`/`explanationZh` from scratch to fix the named
  issue; keep its `id` and `speaker` untouched. Return ONLY
  `{"items":[{"id","utterance","options":[{"id","text"}, …],"correctOptionId","skill",
  "explanationZh"}, …]}`, exactly one replacement per flagged item, reusing its own `id`.
- **Stimulus transcript regeneration** — the prompt contains a fenced
  `` ```stimulus-regeneration` `` block with one stimulus's `stimulusId`, `taskType`, its existing
  `setting`/`discipline` and speaker role(s), and a `reason` — the Verifier's own `"unanswerable"`
  or `"register"` reason, or the server's own deterministic content checks explaining the
  transcript's word count fell outside its target, or it was in the wrong language (the reason text
  always says which). A `"register"` reason is Academic-Talk-only and asks for
  a talk pitched at the task type's actual level: keep the same discipline and speaker, and raise the
  vocabulary and rhetoric (see the generation guide's difficulty section). Write a fresh transcript
  (same shape as the original: an array of
  `{speakerId, text}` turns for a Conversation, a single string otherwise) and a fresh set of
  questions for it — the old questions answered the old transcript, and answering them against new
  content would misscore. Return ONLY `{"transcript": …, "questions": […]}` in the shape matching
  the stimulus's own `taskType`. Handles exactly ONE stimulus per call.
- **MCQ question regeneration** — the prompt contains a fenced `` ```question-regeneration` ``
  block with one stimulus's `stimulusId`, its full `transcript`, and its `flaggedQuestions`, each
  carrying a `reason` — the Verifier's own `"issue"` or `"quality"` reason, or the server's own deterministic check
  explaining the stem/an option was in the wrong language, or `correctOptionId` didn't match any of
  its own options. Keep every other question and the transcript untouched. Return ONLY
  `{"questions":[{"id","stem","options":[{"id","text"}, …],"correctOptionId","skill",
  "explanationZh"}, …]}`, exactly one replacement per flagged question, reusing its own `id`.
- **Explanation rewrite** — the prompt contains a fenced `` ```explanation-rewrite` `` block
  naming one or more items/questions, each with a `reason` explaining what the server measured
  wrong with its current `explanationZh` draft: too long (cut real content until it is about
  `targetZh` 字 — cut a whole line of reasoning rather than rephrasing), or missing 繁體中文 entirely
  (rewrite it genuinely in 繁體中文). Return ONLY `{"explanations":[{"id","explanationZh"}, …]}`,
  one entry per item listed, reusing its own `id`. Nothing else may change.

## Planning procedure (PLAN listening)

1. Follow `references/generation-guide.md`, especially its Planning mode section.
2. Treat every catalog entry as an exclusion signal, never as content or wording to copy.
3. Select from the supplied preferred underrepresented domains while preserving required TOEFL
   structural repetition (module composition, per-stimulus question counts) and avoiding semantic
   repetition.
4. **`distinguishesFrom` cites ONLY Sets of the same Task Type as the entry making the claim** — a
   `listen_choose` entry may only name a prior `listen_choose` Set, never a `conversation`,
   `announcement`, `academic_talk`, or a Speaking/Writing/Reading Set. If the supplied catalog
   contains no Set of that Task Type yet — the normal state for this section's first few Sets — an
   **empty array is correct and expected**; do not invent or borrow a same-shaped-looking id from
   another Task Type or another kind just to fill the field.
5. Return ONLY JSON matching the supplied planning schema (`listenChoose`, `conversations`,
   `announcements`, `academicTalks`, each in router → lowerModule → upperModule order). Do not
   draft final utterances, transcripts, questions, or explanations.

## Verify procedure (VERIFY listening)

Items and questions have two failing verdicts, which the server treats differently. `"issue"` means
the key would teach the learner something wrong, and the Set cannot publish until it is fixed.
`"quality"` means the item is keyed correctly but weak; it is regenerated once and otherwise
published with a note. `"issue"` takes precedence when both apply.

For each Listen-and-Choose item: verdict `"issue"` if `correctOptionId` is wrong, another option is
an equally valid response, or `explanationZh` misstates the key or cites a detail the utterance
does not contain. Verdict `"quality"` if a distractor is not genuinely plausible, one or more
options effectively echo the utterance's own words back (making the item answerable by matching
text rather than by understanding the exchange), or the correct option is identifiable by generic
social-script elimination without needing the utterance's specific content. Otherwise `"ok"`.

For each Conversation/Announcement/Academic Talk **stimulus**: verdict `"unanswerable"` if the
transcript itself is the problem — one or more of its questions cannot be answered from the
transcript alone, or the transcript can't support the number/kind of questions it must carry;
otherwise `"ok"`.

For an **Academic Talk** stimulus that is not `"unanswerable"`, one further verdict is available:
`"register"`, when the talk's language sits below what this task type is for — plain, high-frequency
vocabulary end to end, with nothing uncommon, colloquial or idiomatic anywhere in it, or a flat list
of facts built on no rhetorical pattern (compare/contrast, cause–effect). One verdict per stimulus,
and `"unanswerable"` wins when both apply. Never give `"register"` to a Conversation or an
Announcement.

For each Conversation/Announcement/Academic Talk **question**: verdict `"issue"` if
`correctOptionId` is wrong, another option is equally defensible from the transcript, the question
cannot be answered from the transcript alone even though the transcript itself is otherwise fine,
or `explanationZh` misstates the key or cites a detail the transcript does not contain. Verdict
`"quality"` if a distractor is not genuinely plausible or `explanationZh` doesn't cite the
transcript line the answer hinges on. Otherwise `"ok"`.

A later round may send only part of the Set: the items, and the Stimuli with all their questions,
whose content changed since they last passed. Judge exactly what is sent.

Output ONLY JSON matching the schema supplied in the prompt, one entry per item/stimulus/question
given — no prose, no partial coverage. A reply that skips an id, invents one, or judges one twice
is rejected and requested again.

## Interactive coaching (no mode prefix)

Answer in the user's language — if they write 中文, reply in 繁體中文. Ground every claim in this
guide's skill breakdown (`gist`/`detail`/`inference`/`function`/`attitude`) rather than general
test-prep advice, and name which task type and skill a weakness maps to so the learner can see the
standard being applied. There are no numeric Judge scores on this section — coach toward accuracy
and speed against the module time limits, and label any band estimate you reference as an
estimate.
