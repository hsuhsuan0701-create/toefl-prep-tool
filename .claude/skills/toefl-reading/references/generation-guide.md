# Generating a TOEFL Reading Set

Use the schema supplied for the active mode. A Set bundles **three** modules — `router`,
`lowerModule`, `upperModule` — each holding its own Complete-the-Words (CtW) passages, Read in
Daily Life texts, and Read an Academic Passage passages. Both second-module variants are always
generated; the server routes a test taker to only one of them per attempt, but both are published.

## Module composition (fixed — `READING_MODULE_COMPOSITION`)

| Module | `timeLimitSec` | CtW passages | Daily-life texts | Academic passages |
|---|---|---|---|---|
| `router` | 1200 | 2 | 3 | 1 |
| `lowerModule` | 540 | 1 | 2 | 1 |
| `upperModule` | 540 | 1 | **0** | 1 |

Totals across the whole Set: 4 CtW passages (40 gaps), 5 daily-life texts, 3 academic passages.
These counts are hard-enforced by the schema (wrong array lengths fail to parse) — never pad or
trim them.

**The `upperModule` holds no Read in Daily Life text.** That is the official composition (Technical
Manual RR-25-12, Table 1): the harder second module is Complete the Words + Read an Academic Passage
only. Emit `"dailyLife": []` for it, and plan five daily-life entries, not six.

## Planning mode

For `PLAN reading`, return only the supplied planning schema
(`ctwPassages`/`dailyLifeTexts`/`academicPassages`). Select semantic content, not final
learner-facing wording. The fixed domain vocabulary is:

`campus-academics`, `workplace-business`, `community-civic`,
`science-environment`, `technology-media`, `arts-culture`,
`health-wellbeing`, `services-travel`, `history-social-change`,
`everyday-life`.

Use the supplied preferred domains. Each component's own planning wording must contain at least
one keyword of the `domain` it declares, and no more keywords of any other family, taken from the
`domainKeywords` table supplied in the payload — the server classifies the plan against that exact
table and replans if it disagrees.

Treat the supplied catalog as exclusions: do not copy, combine, or lightly reword its descriptors.
Set top-level `version` to `cross-set-diversity-v1` and `kind` to `reading`. Every component has a
`domain`, lowercase hyphenated `noveltyKey`, two to five `requiredConcepts`, and up to three
`distinguishesFrom` entries naming a prior Set in the catalog for the same task type.

**Array order matters and is not re-sorted downstream.** List each of `ctwPassages`,
`dailyLifeTexts`, and `academicPassages` in **router entries first, then lowerModule, then
upperModule** — 4/5/3 entries respectively, positionally matching the module composition table
above (e.g. `ctwPassages[0..1]` are the two router paragraphs, `[2]` is lower, `[3]` is upper;
`dailyLifeTexts[0..2]` are router, `[3..4]` are lower, and there is no upper entry). The
server and the novelty guard both assume this order; a plan in a different order silently pairs
the wrong plan entry with the wrong generated passage.

- `ctwPassages` entries: `topic` and `angle` (the paragraph's specific expository thesis).
- `dailyLifeTexts` entries: `genre` (one of the twelve below) and `scenario` (the concrete
  situation the text depicts).
- `academicPassages` entries: `title`, `discipline` (one of the six below), and `angle`.

### Writing `requiredConcepts`

Each required concept is a short concrete noun phrase naming something the final content should
cover, worded as the content itself would say it. Cap: 60 characters. These are GUIDANCE for what
the entry should be about — there is no automated check counting how closely the final wording
matches — so prioritize natural, well-formed prose over reproducing a concept's exact words.

| Write this | Not this |
|---|---|
| `paperless billing enrollment deadline` | `A stated deadline for enrolling in paperless billing` |
| `afternoon dip in reaction time` | `A described dip in alertness measured by reaction time` |

Phrase each concept as the content itself would say it, not as an instruction about the content —
"stated", "described", "a recommendation about" read as meta-commentary on the answer rather than
content, which is worse writing regardless of whether anything checks for it.

## Generating from an accepted plan

For the full-set `GENERATE reading` call, follow the accepted plan exactly: same topics, angles,
genres, disciplines, and domains, one-to-one in the router → lowerModule → upperModule order above.
Use each entry's `requiredConcepts` as substantive guidance for what that entry's own text
(topic/genre/title plus body) should cover — paraphrase and integrate them naturally into
well-formed, referentially clear prose; do not force in a concept's exact wording at the expense of
a sentence that actually reads well. This applies identically to `ctwPassages` entries (their
`requiredConcepts` guide `topic` + `sourceParagraph` together).
Every `ctwPassages` entry is a **bare paragraph**: emit only
`{id, taskType: "complete_words", topic, sourceParagraph}`. Never invent `segments` or `gaps` — the
server derives both deterministically from `sourceParagraph` (see below). `dailyLife` and
`academic` entries are authored in full, including `correctOptionId`, `skill`, and `explanationZh`
for every question — those are not derived.

`id`s: stable and readable, unique **across the whole Set** (gap ids are minted from the passage
id as `"<passageId>-g<n>"`, so two passages sharing an id collide their gaps; MCQ question ids must
be globally unique too, not just unique within one text/passage). Suggested convention: CtW
`ctw-r1`, `ctw-r2` (router), `ctw-lo1` (lower), `ctw-up1` (upper); daily-life `dl-r1`…`dl-r3`,
`dl-lo1`, `dl-lo2` (the `upperModule` has none); academic `ap-r1`, `ap-lo1`, `ap-up1`; questions
`<passageId>-q1`, `<passageId>-q2`, ….

Top-level `id`/`source`/`createdAt` are server-owned (overwritten after this call); fill them with
any schema-valid placeholder — `source: "generated"`, `createdAt` an ISO-8601 timestamp.

## Complete the Words: paragraphs only — the server derives the gaps

`deriveCtwGaps` (`server/src/services/ctest.ts`) is a pure function, not a rubric to satisfy
approximately — it is exact, so a paragraph either derives cleanly or it doesn't:

1. **Sentence 1 stays intact.** The boundary is the first `. ! ?` followed by whitespace and a
   capital letter. Everything up to and including that boundary is never gapped.
2. From there, **tokens** = maximal runs of `[A-Za-z']` — ASCII letters and the apostrophe only.
   Punctuation, digits, and whitespace pass through untouched and never advance the counter. A
   hyphen is **not** part of a token, so a hyphenated word splits into two separate tokens at the
   hyphen (each counted, and each independently eligible to be gapped).
3. Tokens are counted **continuously across every sentence after the first** (the count never
   resets at a sentence boundary). Every 2nd token (2nd, 4th, 6th, …) becomes a gap, until 10 gaps
   exist. A length-1 token landing on an even count is left as plain text — but the counter still
   advances past it, so it wastes that even slot rather than producing a gap.
4. For a gapped token of length *n*: the first `floor(n/2)` characters stay visible as `prefix`,
   the last `ceil(n/2)` are deleted as `completion` — matching ETS's own worked example (`might` →
   `mi` + `ght`, `However` → `How` + `ever`, `basic` → `ba` + `sic`).

### Mandatory content rules (derivation hazards — violating these produces broken or unfair items)

- **No abbreviations ("Dr.", "e.g.") and no quoted dialogue in or near the first sentence.** The
  boundary detector only looks for `. ! ?` + space + capital letter; an abbreviation or a quote
  mark sitting near that pattern mis-splits sentence 1, corrupting everything downstream.
- **Avoid contractions anywhere gappable (sentence 2 onward).** The apostrophe is part of the token
  class, so `don't` is one 5-character token; if it lands on an even slot it splits by character
  position, not by the apostrophe — `do` (prefix) + `n't` (completion) — rendering as `do[blank]`
  where the learner must type `n't`. Write out full forms instead.
- **No diacritics anywhere. ASCII letters only.** `café` tokenizes as `caf` (the token regex stops
  at `é`) plus a stray, unattached `é` character — both the gap and the surrounding text garble.
- **Digits are safe** — they pass through without ever advancing the counter or consuming a gap
  slot, so numbers, dates, and quantities are fine anywhere, but they don't help you reach the
  10-gap target either.
- **Avoid 1-letter words where possible** ("a", "I") — each one that lands on an even count wastes
  that slot without producing a gap, so a paragraph full of them can fall short of 10 real gaps
  even with plenty of raw word count.
- **Avoid BrE/AmE spelling-variant words in gappable position** (`colour`/`color`,
  `organise`/`organize`) — decision 11 makes Complete-the-Words matching case-sensitive exact-match
  with no alternate spellings, so a gapped variant word risks a defensibly "correct" completion the
  scorer marks wrong. You cannot predict which token lands on an even slot, so avoid these words
  entirely past sentence 1.
- **Avoid hyphenated compound words past sentence 1.** A hyphen splits its word into two separate
  tokens (`mineral-rich` → `mineral`, `rich`), each independently eligible to land on an even slot —
  this doubles the token-count bookkeeping you have to track and makes the gap schedule harder to
  predict for no benefit; write the concept as two ordinary words or one plain word instead.
- **Before finalizing, sanity-check every EVEN-numbered token position for a same-length alternate
  completion — verb tense pairs are the highest-risk case.** A verb whose base and inflected forms
  share a stem (`examine`/`examined`, `assume`/`assumed`) can gap to a prefix that both forms share,
  and if the surrounding clause's tense is ambiguous or mixed, the strict scorer will wrongly reject
  a grammatically valid alternate. Read the sentence containing each even-position token and ask "is
  there another real English word of the SAME LENGTH that also fits this exact grammatical slot?" —
  if yes, rewrite that clause (fix the tense unambiguously, or swap the verb) rather than shipping
  the ambiguity.
- **Write 70–100 words total, with the first sentence self-contained** and everything after it
  contributing plenty of ordinary multi-letter tokens. Aim for comfortably more than the bare
  minimum ~20 eligible tokens after sentence 1 — one-letter words, digits, and short function words
  all reduce the effective yield toward the 10-gap target.
- **Past sentence 1, avoid repeating any distinctive content word** (a noun, verb, adjective, or
  adverb specific to the paragraph's own topic — not an ordinary function word like "the"/"and"/
  "that", which repeats naturally in any paragraph this length and is harmless). You cannot predict
  which token lands on a gap slot, so a repeated content word anywhere past sentence 1 risks spelling
  a gap's own answer out in plain text elsewhere in the same paragraph the learner can already read —
  the giveaway a Complete-the-Words item exists to prevent. If a topic genuinely needs to name the
  same thing twice, use a different word or phrase the second time (a synonym, a pronoun, a shorter
  reference) rather than repeating the exact word.

### When the server sends repair feedback

A gap-count repair prompt states how many gaps the previous draft actually derived; if it derived
fewer than 10, add more substantive content after sentence 1 (avoid just padding with 1-letter
words or digits, which don't count); if more, trim. An ambiguity repair prompt quotes the
Verifier's `"AMBIGUOUS"` reason — rewrite the paragraph's **content** (not just restructure it) so
the flagged gap has no other plausible fit in context, keeping the same planned topic.

### Register and difficulty per module

Academic register throughout — expository prose, not conversational. CEFR/readability targets
(TextEvaluator score / Flesch-Kincaid grade, per spec §3.2):

| Module | CEFR | TextEvaluator | Flesch-Kincaid |
|---|---|---|---|
| `router` | B1–B2 — **moderate, and only moderate** | ~800–1100 (medium) | 7.4–10.5 |
| `lowerModule` | A1–B1, easier vocabulary — at or below moderate | ≤1100 | 4.0–10.5 |
| `upperModule` | B2–C2, denser C1 vocabulary | ~1100–1360+ (high) | 10.5–20.0 |

**The router is moderate-only.** ETS's Reading router module contains tasks of moderate difficulty —
every text in it, not an average across it. Do **not** mix a hard passage in with easy ones to
"spread" the router: a router that samples the full range is not what the real test routes on, and
two moderate texts either side of a C1 passage average to moderate while measuring something else
entirely. Write all six router stimuli at the same B1/B2 level. (This replaces the earlier
full-range instruction; the change is recorded in `docs/adr/0005-two-stage-adaptive-sets.md`.)

The Flesch-Kincaid column is checked after generation two ways: **per module**, over that module's
own stimulus text, and **per academic passage**, over that one passage's own ~200 words against its
module's row above (see "Per-passage difficulty and vocabulary targets" below). Anything outside its
band is recorded on the published Set as an advisory note — it never fails the job — so treat the
numbers as the target they are, not as something to game: the fastest way to land in band is to
write at the level the CEFR column names and let the index follow.

The per-passage reading exists because the per-module figure pools CtW, daily-life and academic
prose, which are written at deliberately different registers: an `upperModule` academic passage can
sit down at medium and still be carried over the high floor by the dense CtW paragraph beside it.
Each academic passage has to reach its module's level on its own.

**Concrete levers for `lowerModule` CtW** (topic difficulty alone does not move Flesch-Kincaid —
sentence length and word choice do): keep every sentence under ~16 words (short, mostly simple SVO
or single-conjunction clauses — avoid stacking multiple subordinate clauses in one sentence); prefer
everyday, concrete vocabulary over Latinate/abstract nouns (say "get better at" rather than
"demonstrate proficiency in", "shows" rather than "indicates" or "demonstrates"); avoid nominalized
abstractions (`-tion`/`-ment`/`-ity` chains) and multi-clause hedging. `upperModule` is the mirror
image: longer sentences, embedded/subordinate clauses, and denser academic vocabulary are
appropriate there and are what should carry the difficulty gap between the two modules — do not
achieve "harder" by making the topic more obscure while keeping sentence structure simple. The
`router` sits between them and stays there: sentences of moderate length, ordinary academic
vocabulary, no stacked subordinate clauses and no deliberately plain "easy" filler either.

### Upper-module CtW: the register of an authentic source

ETS builds its own Complete-the-Words paragraphs **from authentic texts written for first-language
readers** — material written for real readers and then trimmed and cleaned for the task, not prose
composed from scratch to be a test item (*TOEFL iBT Technical Manual*, RR-25-12 §II-3 — the same
section that specifies the deletion algorithm reproduced above). The `upperModule` paragraph is where
that register matters most: it is what a stronger test taker is routed to, and it should read like
something cut from a popular-science feature, a museum wall panel, a field guide, an encyclopedia
entry, or a policy brief — a fragment of a longer text, addressed to a reader already in the middle
of the subject.

This is a REGISTER target, not a sourcing instruction. The paragraph is still original prose you
write (see "Originality is a hard requirement" below); what it borrows is the voice of authentic
material, never its wording, structure, or facts.

For the `upperModule` paragraph specifically:

- **Denser vocabulary.** Prefer the precise C1 word where that is what a real writer on the subject
  would use — `sustained` over `kept going`, `constraint` over `limit`, `attributed to` over
  `because of`. A few such choices per paragraph is the level; a Latinate word in every clause is
  not.
- **Assume the context rather than establishing it.** Authentic text does not introduce its own
  subject from zero. After the self-contained first sentence, qualify, complicate, or extend the
  premise instead of re-explaining it.
- **Vary the sentence architecture.** Subordinate and relative clauses, a fronted adverbial, an
  appositive — what ordinary published prose does and what a purpose-written test item usually
  flattens.
- **Let the content be genuinely abstract** — a mechanism, a trade-off, a reading of evidence —
  rather than a described place or a list of activities.

`router` and `lowerModule` paragraphs stay accessible, and the `lowerModule` levers in the previous
section are this instruction inverted: everyday vocabulary, short single-clause sentences, concrete
subjects. Do not carry the authentic-source register down into them — a lower-module paragraph that
reads like a journal excerpt is the same defect as an upper-module one that reads like a children's
reader.

None of this relaxes the mandatory content rules above: 70–100 words, no abbreviations or quoted
dialogue near the first sentence, no contractions, diacritics, hyphenated compounds or BrE/AmE
spelling variants past sentence 1, and no repeated distinctive content word. Real source material
breaks those constantly, and adapting it until it does not is exactly what "adapted" means in ETS's
own description — the derivation is unforgiving about them either way.

Each CtW paragraph is **also measured on its own** against its module's row in the Flesch-Kincaid
table above, not only as part of that module's pooled text: a module can land in band while the
paragraph inside it does not, because the academic passage carries the average while the paragraph a
learner completes letter by letter reads a band easier. An out-of-band paragraph is recorded on the
published Set as an advisory note and never fails the job — treat it as the register signal it is.

## Read in Daily Life: twelve genres, telegraphic language

15–150 words, 2–3 MCQs (shorter texts get 2, longer texts can support 3). Twelve genres, each a
distinct novelty axis — vary across the Set's five daily-life texts:

| Genre | Telegraphic-language authenticity note |
|---|---|
| poster/sign/notice | Fragment phrases, imperative verbs, no connective prose ("Sign up today. Safe, convenient, easy.") |
| advertisement | Punchy fragments and superlatives, minimal grammar, price/benefit callouts |
| menu | Item name + price, no verbs; category headers, occasional one-line description |
| news article | Full sentences but front-loaded (who/what/where in sentence 1), headline is itself a fragment |
| social media post | Casual register, may drop subjects/articles, hashtags or abbreviations natural |
| web page | Nav-label fragments and short blurbs mixed with a few full sentences |
| form | Field labels only ("Name:", "Date of birth:"), no sentences at all |
| schedule | Time + place + event in terse tabular lines, no connecting words |
| email | Full sentences, greeting/sign-off, but often short and task-focused |
| text-message chain | Very short turns, contractions, dropped subjects, informal punctuation |
| invoice | Line-item + quantity + amount, tabular, no narrative |
| receipt | Item, price, total — pure fragments, timestamps, no sentences |

Questions test: understanding nonlinear text formats, identifying the main purpose, informal
language/idioms, inference, telegraphic language, and skim/scan for detail — tag each question
with whichever `skill` fits what it actually asks (`main_idea`, `detail`, `inference`,
`vocabulary`, `purpose`), not a fixed sequence.

## Read an Academic Passage: ~200 words, five questions, six disciplines

~200 words (150–250 word tolerance), expository, no background knowledge required. Disciplines —
rotate across the Set's three academic passages, no repeats within one Set:

`history`, `art and music`, `business and economics`, `life science`, `physical science`,
`social science`.

Exactly 5 questions per passage, one for each of ETS's five skill **slots**. Every slot has a primary
`skill` value, and three of them also have a **rotation alternate** — a different published Reading
skill that tests the same comprehension and may stand in for the primary:

| Slot (ETS category) | primary `skill` | rotation alternate(s) |
|---|---|---|
| factual information | `detail` | `main_idea`, `grammatical_complexity` |
| vocabulary in context | `vocabulary` | `figurative_language` |
| inference (not explicitly stated) | `inference` | — |
| relationship between ideas across sentences/paragraphs | `organization` | `rhetorical_structure` |
| purpose of all or part of the text | `purpose` | — |

What each alternate asks for:

- `main_idea` — the passage's overall gist rather than one stated fact.
- `grammatical_complexity` — which restatement preserves the essential information of a long,
  multi-clause sentence in the passage. The difficulty is the syntax, not a new proposition.
- `figurative_language` — the meaning of an idiom, a metaphor or another non-literal phrase in
  context, rather than of a single literal word.
- `rhetorical_structure` — how the text is organized to make its case (contrast, cause and effect,
  chronology, claim-then-evidence), rather than what any one part is *for*.

The alternates **rotate, they do not accumulate**: five slots, five questions, so reaching for an
alternate REPLACES its slot's primary in that passage rather than adding a sixth question. None of
them is required — a passage written entirely from the five primaries is fully conformant — but vary
which ones you use across a Set's three academic passages rather than never touching them.
**Every slot must be filled, and no two questions in the same passage may share a `skill` tag** —
five questions, five distinct tags, one per slot. Before emitting each passage's five questions, list
their five `skill` values and confirm each slot in the table above is covered exactly once; if two
questions carry the same `skill`, one of them is standing in for a slot you dropped — replace it with
a question for the slot that is actually uncovered instead of writing a second question for a slot
you already have.

### Per-passage difficulty and vocabulary targets

An academic passage is measured on **its own ~200 words**, not only as part of its module's pooled
text, and is held to its module's row from the difficulty table above:

| Passage | CEFR and vocabulary | Flesch-Kincaid |
|---|---|---|
| `router` academic passage | B1–B2, ordinary academic vocabulary — moderate, and only moderate | 7.4–10.5 |
| `lowerModule` academic passage | A1–B1, everyday concrete vocabulary — at or below moderate | 4.0–10.5 |
| `upperModule` academic passage | B2–C2, denser C1 academic vocabulary | 10.5–20.0 |

Write the `upperModule` passage with long sentences carrying embedded and subordinate clauses,
abstract argument, and C1 academic vocabulary used precisely (`constrain`, `attribute`,
`presuppose`, `nonetheless`) — not obscure terminology dropped into simple sentences, which raises
the topic's difficulty without raising the language's. The `lowerModule` passage is the mirror
image: concrete subject matter, short and mostly simple sentences, everyday words in place of
Latinate abstractions. The `router` passage sits between them at B1–B2 and stays there — moderate
throughout, never one hard passage mixed in to "spread" the module.

A passage outside its band is recorded on the published Set as an advisory note naming that passage;
it never fails the job.

## Item language: stems and options are ALWAYS English

`stem` and every `options[].text`, for every MCQ in every module (Daily Life and Academic Passage
alike, including `lowerModule`) — are written in **English**, no exceptions. 繁體中文 belongs ONLY
in `explanationZh`. This is a Reading comprehension test, not a translation exercise; a
Chinese-language stem or option changes what skill the item measures and skews which module a test
taker routes into. Never generalize the Explanation's 繁體中文 to the item itself.

## Distractor rules (every MCQ, both Daily Life and Academic Passage)

- **Exactly 4 options per question**, exactly one `correctOptionId`. Never 3: a 3-option MCQ hands
  the test taker 33% guessing odds where the real exam's are 25%, so it is easier practice than the
  exam it rehearses.
- **Every distractor must be wrong for an articulable reason** — a fact the passage/text
  contradicts, a plausible-sounding claim the passage never makes, or a detail from elsewhere in
  the text used out of context. Never write a distractor that's simply irrelevant or silly; it
  should be "attractively wrong."
- **Ground every distractor in a real, domain-realistic specific — never an invented one.** "Wrong
  for a reason" is necessary but not sufficient: a distractor also has to survive a plausibility
  gut-check on its own terms, independent of the passage. A fee, a procedure, a criterion, or an
  action that no real instance of this scenario would ever have is not "attractively wrong," it's
  just noise a careful reader discards instantly without needing the text at all — the Verifier
  flags these as `"quality"` on sight. Build each distractor from something *adjacent* to the
  correct answer: a plausible neighboring number (close to, not wildly off from, realistic values
  for this exact scenario), a real step or criterion this type of process genuinely uses elsewhere
  (just not the one the text specifies here), or a genuine detail from the text applied to the
  wrong target. Before finalizing a distractor, ask "would a knowledgeable reader consider this a
  real candidate for a second, before checking the text?" — if the honest answer is no, replace it
  with something closer to the text's own specifics rather than inventing further.
- **Never use "all of the above" or "none of the above."**
- **No near-synonym traps on vocabulary-in-context items.** A vocabulary distractor must be a
  plausible but genuinely different meaning of the word/phrase in context (e.g. a different sense
  of a polysemous word) — not a near-synonym of the correct answer that a fair reader could also
  defend as correct. Two defensible options is a broken item, not a hard one.
- **Keep every option's length comparable — never let the correct answer be conspicuously the
  longest choice.** A distractor that is short because it was an afterthought is just as much a
  giveaway as a wrong-for-no-reason distractor: length alone must never be a usable cue. Write every
  distractor to the same level of completeness and specificity as the key, and vary which option
  ends up longest across the Set rather than defaulting to "the right answer needs the most words to
  be precise."

## Explanation (錯題解析) — 繁體中文, ≤120 字 per item

Every scoreable item — each CtW gap and each MCQ question — carries `explanationZh`.

- **CtW gaps** (authored in the second, distinct `GENERATE reading` call, after real gaps exist):
  explain **why the completed word is correct in this exact context** — cite the surrounding
  sentence, not a generic definition. CtW has no distractor options (it's typed input), so there is
  no "why the alternatives are wrong" component here. Pick the single strongest reason (grammatical
  role, or the semantic/thematic echo, whichever is more decisive) and stop — do not stack both a
  full grammar analysis and a full thematic-echo analysis onto one gap; that combination is the
  most common way a CtW explanation overruns the 120-字 budget. **Quote at most a short English
  phrase (a handful of words), never the full sentence** — pasting the whole source sentence
  verbatim in quotes (English characters count toward the same 120-字 budget as the 繁體中文 around
  them) is the single most common overrun cause after the two-analyses-stacked pattern above; name
  the word and, if needed, the two or three words immediately around it, not the clause.
- **MCQ items** (Daily Life, Academic Passage): explain **why the key is right AND, briefly, why
  each distractor is wrong** — one clause per distractor is enough given the 120-字 budget.
- **Point at an option ONLY by what it says.** The options you see now are reordered before
  publishing, so anything that names a slot or a label names the WRONG option by the time a learner
  reads it. The one permitted form: describe the option's own content — 「指出深夜甜點的選項」、
  「提到停車場的那個」 — or quote its own English words. Set-wide phrasing that stays true under any
  order is fine too (「其餘選項均無根據」、「四個選項都與原文無關」).
  Forbidden, in every variant, not just the ones spelled out here: 選項一 · 選項A · 選項１ ·
  選項（二） · 選項甲 · B選項 · 第一個選項 · 第二選項 · 第一個 · 第一項 · 最後一個選項 ·
  最前面的選項 · 前兩個選項 · 上面那個選項 · 一號選項 · 首選 · 末項 · 答案為(B) · 正解為 A ·
  "the first option" · "option B" · (B) 正確 · C 才是正解 · A：未提及 (a bare letter is a label too).
  Note the trap: dropping 「選項一」 in favour of 「第一個」 or
  「最後一個選項」 is the same mistake, not a fix — it is the ORDER that cannot be referred to, not
  the word 選項. In practice your draft usually already says what each option contains and merely
  hangs a position label in front of it; delete the label and keep the description.
- Both: ≤120 字, 繁體中文, specific to that exact item — never generic filler, never explaining a
  different gap/question than the one it's attached to (the Verifier flags cross-attributed
  explanations as `"unfaithful-explanation"` and only the explanation gets regenerated, not the
  paragraph).

## Originality is a hard requirement

Every paragraph, text, and passage must be **original**. The ETS worked examples referenced in
this guide (the cave-dancing CtW paragraph, the paperless-billing notice, the Mirror Test academic
passage — all from ETS's *Updated TOEFL iBT Test Overview*) are style and difficulty
references — calibrate register and length against them, but never re-skin their topic, structure,
or specific facts. Vary domain and discipline across a Set's passages; the space of plausible
everyday texts and expository topics is large.

## Self-check before emitting

- Module composition matches the table exactly: router 2+3+1, lower 1+2+1, upper 1+**0**+1 — the
  `upperModule` emits `"dailyLife": []`.
- Every `ctwPassages` entry is `{id, taskType, topic, sourceParagraph}` only — no `segments`, no
  `gaps` invented.
- Every CtW paragraph: first sentence self-contained and free of abbreviations/quoted dialogue, no
  contractions, diacritics, or hyphenated compounds past sentence 1, no BrE/AmE spelling variants
  past sentence 1, 70–100 words, academic register, every even-position token checked for a
  same-length alternate completion (verb tense pairs especially), and no distinctive content word
  repeated past sentence 1.
- `lowerModule` CtW specifically: sentences under ~16 words, everyday vocabulary over Latinate
  abstractions — actually easier, not just a simpler topic.
- `upperModule` CtW specifically: reads like an adapted authentic source — denser vocabulary, varied
  sentence architecture, an abstract point developed rather than a topic introduced — and still obeys
  every derivation hazard above.
- `router` specifically: every one of its six stimuli written at the same moderate B1/B2 level — no
  hard passage mixed in to "spread" the module, and no deliberately easy one either.
- Every daily-life text: 15–150 words, a genre from the twelve above, 2–3 questions.
- Every academic passage: ~200 words, a discipline from the six above, exactly 5 questions filling
  all five skill slots (a slot may be filled by its rotation alternate, never left uncovered), no two
  of the five questions sharing a `skill` tag, and its own prose written at its module's CEFR and
  Flesch-Kincaid level rather than at the Set's average.
- Every MCQ `stem` and `options[].text`, every module including `lowerModule`: English, no exceptions.
- Every question: exactly 4 options, one correct, every distractor wrong for a stated reason AND built
  from a real, domain-realistic specific (no invented fees/procedures/criteria a reader would
  reject on sight without the text), no "all/none of the above," no near-synonym vocabulary traps,
  no option conspicuously longer or shorter than the rest.
- Every `explanationZh`: 繁體中文, ≤120 字, specific to its own item, key-plus-distractor reasoning
  for MCQs.
- All `id`s unique across the whole Set (passage ids especially — gap ids derive from them).
- Every accepted-plan required concept is substantively covered in its own entry's generated text,
  integrated into natural, referentially clear prose rather than forced in verbatim.
- Nothing re-skins the ETS worked examples.
- No `generationPlan`, `segments`, or `gaps` field appears in a `GENERATE reading` full-set output.
- Output is JSON only, no prose wrapper.
