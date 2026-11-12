# Generating a TOEFL Listening Set

Use the schema supplied for the active mode. A Set bundles **three** modules — `router`,
`lowerModule`, `upperModule` — each holding its own Listen-and-Choose items, Conversations,
Announcements, and Academic Talks. Both second-module variants are always generated; the server
routes a test taker to only one of them per attempt, but both are published.

Everything in this section is **spoken register**, not the academic prose of Reading. Contractions,
discourse markers ("well,", "actually,", "you know"), and natural turn-taking are normal and
expected here — do not import Reading's "avoid contractions" rule; that rule exists only for
Reading's Complete-the-Words gap derivation and has no equivalent in Listening.

## Module composition (fixed — `LISTENING_MODULE_COMPOSITION`)

| Module | `timeLimitSec` | Listen & Choose | Conversations | Announcements | Academic Talks | Items |
|---|---|---|---|---|---|---|
| `router` | 1080 (18 min) | 10 | 3 (6 Qs) | 3 (6 Qs) | 1 (4 Qs) | 26 |
| `lowerModule` | 420 (7 min) | 5 | 2 (4 Qs) | 2 (4 Qs) | 0 | 13 |
| `upperModule` | 660 (11 min) | 5 | 2 (4 Qs) | 0 | 3 (12 Qs) | 21 |

Totals across the whole Set: 20 Listen-and-Choose items, 7 Conversations (14 questions), 5
Announcements (10 questions), 4 Academic Talks (16 questions). These counts are hard-enforced by
the schema (wrong array lengths fail to parse) — never pad or trim them. Note `lowerModule` has
**zero** Academic Talks and `upperModule` has **zero** Announcements — this is deliberate, not an
omission.

## Difficulty: per-task CEFR targets, and the upper-vs-lower gap

Each Task Type has its own CEFR range, from the ETS Listening blueprint. These describe the LEVEL of
the spoken English, not how obscure the topic is:

| Task Type | CEFR | What that range means here |
|---|---|---|
| Listen and Choose a Response | A1–B2 | Everyday one-clause utterances; the harder ones carry an implication to work out, not a longer sentence |
| Listen to a Conversation | A2–C1 | Ordinary campus exchanges at the bottom; genuinely idiomatic, elliptical, interruption-laden ones at the top |
| Listen to an Announcement | A2–C1 | Plain informational notices at the bottom; multi-condition policy and procedure notices at the top |
| Listen to an Academic Talk | A2–C2 | The only task reaching C2 — lecture register, and the Set's hardest listening |

**The `upperModule` must be genuinely harder to understand than the `lowerModule`, and this is
checked after generation.** They are two variants of the same second module: a test taker routed UP
is told they met a higher bar, and one routed DOWN has their Band Estimate capped for taking an
easier module, so an `upperModule` that is not actually harder makes both statements false.
Composition alone cannot carry that gap — the schema already fixes it (upper gets the three Academic
Talks, lower gets the two Announcements) — so what carries it is the PROSE. Write the `upperModule`'s
Listen-and-Choose utterances and Conversations toward the TOP of their CEFR ranges, the
`lowerModule`'s toward the BOTTOM, and keep the `router` between the two.

**Length is not the lever.** Every Task Type keeps the same word target in both modules (each task's
own section below states it, and it is checked). The gap is carried by the language itself:

| Lever | `lowerModule` | `upperModule` |
|---|---|---|
| Sentence length and complexity | Short, mostly one clause; coordination rather than subordination | Longer sentences, embedded and subordinate clauses, occasional fronting or inversion |
| Information density | One new fact per sentence, restated when it matters | Several linked facts per sentence, stated once |
| Vocabulary | Everyday, high-frequency, concrete | Less common words, including idiomatic and figurative use |
| Abstractness | Concrete objects, people, times, places | Abstract processes, relations, generalisations |
| Reference | Explicit — the noun gets repeated | Pronouns, ellipsis and back-reference the listener must resolve |

Do not reach for "harder" by making the TOPIC obscure while the sentences stay simple, and never
change a plan entry's topic, setting, discipline, speaker role or domain to reach a level — the level
lives in the wording, and the plan entry is not yours to move.

### Academic Talks carry the vocabulary and the rhetoric

The Academic Talk is the only task reaching C2, and the ETS Technical Manual (RR-25-12) is specific
about two things a talk must have. Both apply to EVERY Academic Talk, the `router`'s one included:

- **Vocabulary that is sometimes uncommon, colloquial, or idiomatic.** A talk written end to end in
  plain, high-frequency words sits below the task's level even when its subject is technical. Let the
  speaker talk the way lecturers actually do — an occasional idiom or figurative phrase, a colloquial
  aside, discipline vocabulary used in passing. This does NOT license unexplained jargon: the "no
  background knowledge required" rule still holds, so any term a question depends on is still
  introduced inside the talk itself.
- **A rhetorical pattern the talk is actually built on** — compare/contrast and cause–effect are the
  two ETS names. Weigh two cases against each other, or follow a chain from cause to consequence. A
  talk that is a flat list of facts gives its four questions nothing to ask beyond recall.

The Verifier is asked about both of these per Academic Talk; a talk that misses them is sent back for
a rewrite rather than failing the Set.

## Planning mode

For `PLAN listening`, return only the supplied planning schema (`listenChoose`/`conversations`/
`announcements`/`academicTalks`). Select semantic content, not final learner-facing wording. The
fixed domain vocabulary is:

`campus-academics`, `workplace-business`, `community-civic`,
`science-environment`, `technology-media`, `arts-culture`,
`health-wellbeing`, `services-travel`, `history-social-change`,
`everyday-life`.

Use the supplied preferred domains. Each component's own planning wording must contain at least
one keyword of the `domain` it declares, and no more keywords of any other family, taken from the
`domainKeywords` table supplied in the payload — the server classifies the plan against that exact
table and replans if it disagrees.

Treat the supplied catalog as exclusions: do not copy, combine, or lightly reword its descriptors.
Set top-level `version` to `cross-set-diversity-v1` and `kind` to `listening`. Every component has
a `domain`, lowercase hyphenated `noveltyKey`, and up to three `distinguishesFrom` entries.
`requiredConcepts` count differs by Task Type, sized to what its Stimulus can actually hold: a
Listen-and-Choose entry (`listenChoose`) takes **one to two** — its utterance is only 4-8 words, and
a longer list cannot fit — while `conversations`, `announcements`, and `academicTalks` each take
**two to five**, the same as every other section. Do not treat this as a typo or write more than two
for a `listenChoose` entry even if it "feels" too few; the schema itself enforces the count.

**`distinguishesFrom` cites ONLY a prior Set of the SAME Task Type as the entry making the
claim** — a `listen_choose` entry names only prior `listen_choose` Sets, a `conversation` entry
only prior `conversation` Sets, and so on; never a different Listening Task Type, and never a
Speaking/Writing/Reading Set. **When the supplied catalog holds no Set of that Task Type yet — the
normal, expected state for this section's first several Sets — the correct value is an empty
array `[]`.** Do not manufacture a citation by borrowing an id that merely looks similarly shaped;
an invalid citation is silently discarded before your plan is used for anything, so it buys you
nothing, and an empty array here is not a gap in your work, it is the only value that can be
correct until the catalog has an entry of that exact Task Type.

**Array order matters and is not re-sorted downstream.** List each of `listenChoose`,
`conversations`, `announcements`, and `academicTalks` in **router entries first, then
lowerModule, then upperModule** — 20/7/5/4 entries respectively, positionally matching the module
composition table above (e.g. `listenChoose[0..9]` are the ten router items, `[10..14]` are lower,
`[15..19]` are upper). The server and the novelty guard both assume this order; a plan in a
different order silently pairs the wrong plan entry with the wrong generated item.

- `listenChoose` entries: `topic` (what the exchange is about) and `speakerRole` (who is speaking —
  "barista", "coworker", "librarian" — a Listen-and-Choose item has exactly one speaker).
- `conversations` entries: `setting` (the physical/social scene, e.g. "campus dining hall") and
  `speakerRoles`, a tuple of exactly two roles, one per speaker. **Bias `setting` toward
  university/campus locations as the clear majority across the Set's Conversations** — per ETS,
  this task covers everyday topics "primarily in university/campus settings" (dining, social
  activities, education, entertainment, services, hobbies, home, communications, travel). `domain`
  keeps rotating across all ten domains below for topic variety exactly as before — a
  `services-travel` entry can still be two students at a campus study-abroad office, a
  `health-wellbeing` entry two students outside the campus clinic — vary the topic/domain freely,
  just keep the physical `setting` itself on or immediately adjacent to campus for the large
  majority of entries. A small minority of settings genuinely off campus (a nearby coffee shop, a
  bus stop) is fine; campus stays the clear majority, not the only option.
- `announcements` entries: `setting` and `speakerRole` (the one announcer). **Every Announcement is
  academic** — a classroom or school-related event, delivered in-person or as a broadcast (PA
  system, campus radio, a recorded phone/voicemail notice) — never a non-academic setting or
  announcer. Rotate `setting`/`speakerRole` across ETS's four announcement content types over the
  Set's Announcements: schedules (a class/event/service's time or location changing), directions
  (wayfinding to a campus building, room, office, or service), rules and regulations (policy
  reminders, deadlines, codes of conduct), and student achievements (awards, competition results,
  academic recognition).
- `academicTalks` entries: `discipline` (one of the six below) and `speakerRole` (e.g.
  "professor", "teaching assistant" — `discipline` is the topic axis, this is who is speaking).

### Writing `requiredConcepts`

Each required concept is a short concrete noun phrase naming something the final content should
cover, worded as the content itself would say it. Cap: 60 characters. These are GUIDANCE for what
the entry should be about — there is no automated check counting how closely the final wording
matches — so prioritize natural, well-formed spoken register over reproducing a concept's exact
words.

| Write this | Not this |
|---|---|
| `elevator closed for maintenance tomorrow` | `An announced closure of an elevator for maintenance` |
| `tidal pools support many organisms` | `A described range of organisms supported by tidal pools` |

Phrase each concept as the content itself would say it, not as an instruction about the content —
"stated", "described", "a recommendation about" read as meta-commentary on the answer rather than
content, which is worse writing regardless of whether anything checks for it.

## Generating from an accepted plan

For the full-set `GENERATE listening` call, follow the accepted plan exactly: same
topics/settings/disciplines/speaker roles and domains, one-to-one in the router → lowerModule →
upperModule order above. Use each entry's `requiredConcepts` as substantive guidance for what that
entry's own content (utterance, or transcript) should cover — paraphrase and integrate them
naturally into well-formed, referentially clear spoken register; do not force in a concept's exact
wording at the expense of a line that actually sounds natural when spoken.

`id`s: stable and readable, unique **across the whole Set**. Suggested convention: Listen-and-Choose
`lcr-r1`…`lcr-r10` (router), `lcr-lo1`…`lcr-lo5`, `lcr-up1`…`lcr-up5`; conversations `conv-r1`…
`conv-r3`, `conv-lo1`…`conv-lo2`, `conv-up1`…`conv-up2`; announcements `ann-r1`…`ann-r3`,
`ann-lo1`…`ann-lo2`; academic talks `talk-r1`, `talk-up1`…`talk-up3`; questions
`<stimulusId>-q1`, `<stimulusId>-q2`, …. Every `Speaker.id` must also be unique across the whole
Set; suggested convention `<stimulusId>-sp` for a single speaker, `<stimulusId>-sp1`/
`<stimulusId>-sp2` for a Conversation's two. Conversation `transcript` turns reference speakers by
this same `speakerId` — every turn's `speakerId` must match one of that Conversation's two
`speakers[].id` exactly.

Top-level `id`/`source`/`createdAt` are server-owned (overwritten after this call); fill them with
any schema-valid placeholder — `source: "generated"`, `createdAt` an ISO-8601 timestamp. Every
`audio` field is server-owned too: write the literal empty string `""`. Every `Speaker.voice` and
`Speaker.provider` are also server-owned: write any schema-valid placeholder (e.g.
`voice: "placeholder"`, `provider: "openai"`) — the server overwrites both after this call, and
what you write there has no effect on the published Set.

### Speakers: gender is yours to balance ONLY for a Conversation; accent, like voice/provider, is not yours at all

Every Speaker needs `gender` (`"male"` or `"female"`) and `accent`
(`"north-american"`/`"british"`/`"australian"`). A Conversation's two speakers **must be one male
and one female** — this is schema-enforced (a same-gender pair fails to parse and the whole call
is wasted), and this is the ONE shape where `gender` is genuinely yours: its two speakers can refer
to each other, so it stays content-relevant. **For every other stimulus shape (Listen-and-Choose,
Announcement, Academic Talk), `gender` is server-owned**, exactly like `voice`/`provider` above —
write any schema-valid placeholder and do not spend effort hand-balancing it (the server assigns it
deterministically after this call, balanced across the whole Set). Because you cannot know which
gender will actually be assigned, **never let a single-speaker Stimulus's transcript, item, or
options depend on the speaker's gender** — no self-introduction by a gendered name/title ("this is
Ms. Delgado", "Mr. Tanaka here"), no gendered pronoun referring back to the speaker. **`accent` is
server-owned for EVERY Stimulus shape, including Conversations** — write any schema-valid
placeholder; the server overwrites it deterministically and balances it across the whole Set after
this call, so do not spend effort hand-varying or hand-balancing it — unlike gender, nothing in a
Stimulus's content can ever depend on `accent` in the first place (it never changes what a speaker
says, only how the audio sounds), so there is no dependence rule to state for it the way there is
for gender.

## Listen and Choose a Response: one short utterance, four written options

The `utterance` is **never shown to the test taker as text, even after scoring** — it exists only
as audio the server renders from what you write, so write it as natural, spontaneous spoken
English, not a written sentence.

- **At most six stressed syllables (ETS's own bound).** In practice this means short, natural
  utterances — typically 4 to 8 words, one clause, no more than one subordinate element. If in
  doubt, say it aloud silently and count only the syllables that would land WITH stress, not every
  syllable in every word.
- The utterance must require actually understanding what was said — never something a listener
  could answer correctly by generic social-script guessing alone without having heard its specific
  content (e.g. an utterance so generic that any polite reply would do is not a valid item; make
  the utterance specific enough that only one of the four options is the right fit for THIS
  exchange).
- Cover a range of communicative functions across the Set's 20 items — requests, offers,
  complaints, invitations, apologies, suggestions, corrections, permission-seeking — not the same
  function repeated.
- Exactly four `options`, exactly one `correctOptionId`. The three wrong options must each be a
  plausible, well-formed response to SOME real utterance — never nonsense, never obviously silly —
  just not the right fit for this one (a mismatched social function, a response to a different
  implicit question, wrong register).
- **No option may echo the utterance's own distinctive words back.** An option that repeats
  content words from the utterance lets a test taker match text instead of understanding the
  exchange, and defeats the point of the task.

## Listen to a Conversation: two speakers, primarily university/campus settings, idiomatic turns

Two speakers, one male and one female (`speakers` — exactly two, schema-enforced). 30–60 seconds of
natural spoken exchange — **aim for 100 to 130 words total** across every turn, comfortably inside
the allowed range rather than at either edge (a script running a little short or a little long is
far easier to fix if it started near the middle). Everyday topics, **primarily in university/campus
settings** (ETS's own framing) — dining, social activities, education, entertainment, services,
hobbies, home, communications, travel. Follow the plan's `setting` exactly, which is already biased
toward campus as the clear majority (see Planning mode above): a Conversation whose plan `domain` is
not `campus-academics` still keeps its physical setting on or near campus (e.g. a `services-travel`
entry set at a campus study-abroad office rather than an off-campus travel agency). Natural idiomatic
turns: contractions, hedges, interruption-adjacent phrasing ("actually, wait—", "oh, I meant—"),
back-channel responses ("right, okay"). Every `transcript` turn's `speakerId` must reference one of
the two `speakers[].id`. Exactly 2 questions per Conversation.

## Listen to an Announcement: one speaker, academic framing, ~55-70 words

One speaker in an academic/campus role (a professor or instructor addressing a class, campus staff,
a club officer, a building manager, a dean's-office or campus-radio broadcast voice, …), a
single-string `transcript` — **aim for 55 to 70 words**, comfortably inside the allowed range rather
than at either edge. **Always a classroom or school-related event, delivered in-person or as a
broadcast** (a PA system, campus radio, a recorded phone/voicemail notice) — never a non-academic
setting or announcer. Rotate across ETS's four content types over the Set's Announcements,
informational/directive register throughout:

- **Schedules** — a class, event, or service's time or location changing.
- **Directions** — wayfinding to a campus building, room, office, or service.
- **Rules and regulations** — policy reminders, deadlines, codes of conduct.
- **Student achievements** — awards, competition results, academic recognition.

Exactly 2 questions per Announcement.

## Listen to an Academic Talk: one speaker, ~175-250 words, no background knowledge required

One speaker (a professor, a teaching assistant, a guest lecturer), a single-string `transcript` —
**aim for 175 to 250 words** (ETS's published band for this task), comfortably inside the allowed
range rather than at either edge.
**No background knowledge required** — every technical term the talk depends on must be introduced
or explained within the talk itself; a test taker who has never studied the discipline before must
still be able to answer every question from the talk alone. Disciplines — rotate across the Set's
four academic talks, no repeats within one Set:

`history`, `art and music`, `business and economics`, `life science`, `physical science`,
`social science`.

This is the Set's A2–C2 task, and the two requirements that come with that — vocabulary that is
sometimes uncommon, colloquial or idiomatic, and a rhetorical pattern the talk is built on
(compare/contrast, cause–effect) — are in the difficulty section above. The Verifier is asked about
both.

Exactly 4 questions per Academic Talk.

## Item language: stems and options are ALWAYS English

`stem` and every `options[].text`, for every Listen-and-Choose item and every Conversation/
Announcement/Academic-Talk question — are written in **English**, no exceptions. 繁體中文 belongs
ONLY in `explanationZh`. This is a Listening comprehension test, not a translation exercise; a
Chinese-language stem or option changes what skill the item measures and skews which module a test
taker routes into.

## Distractor rules (every question, every stimulus shape)

- 3–4 options per Conversation/Announcement/Academic-Talk question (Listen-and-Choose items always
  have exactly 4); exactly one `correctOptionId`.
- **Every distractor must be wrong for an articulable reason** — something the transcript
  contradicts, a plausible-sounding claim the transcript never makes, or a detail from elsewhere in
  the transcript used out of context. Never write a distractor that's simply irrelevant or silly;
  it should be "attractively wrong."
- **Ground every distractor in a real, domain-realistic specific — never an invented one.** A fee,
  a time, a procedure, or an action that no real instance of this scenario would ever have is not
  "attractively wrong," it's noise a careful listener discards without needing the transcript at
  all — the Verifier flags these as `"quality"` on sight. Build each distractor from something
  *adjacent* to the correct answer: a plausible neighboring time/number, a real step this type of
  process genuinely uses elsewhere (just not the one the transcript specifies here), or a genuine
  detail from the transcript applied to the wrong target.
- **Every question must be answerable from the transcript alone** — no outside knowledge required,
  and no question whose answer depends on something never stated or implied in the transcript.
- **Never use "all of the above" or "none of the above."**
- **No near-synonym traps.** A distractor must be a plausible but genuinely different claim — not
  a near-synonym of the correct answer that a fair listener could also defend as correct.
- **Keep every option's length comparable — never let the correct answer be conspicuously the
  longest choice.** A short, underdeveloped distractor is just as much a giveaway as a wrong-for-no-
  reason one: length alone must never be a usable cue. Write every distractor to the same level of
  completeness and specificity as the key, and vary which option ends up longest across the Set.

## Explanation (錯題解析) — 繁體中文, ≤120 字 per item, cites the transcript

Every scoreable item — each Listen-and-Choose item and each Conversation/Announcement/
Academic-Talk question — carries `explanationZh`.

- **Explain why the key is right AND, briefly, why each distractor is wrong** — one clause per
  distractor is enough given the 120-字 budget.
- **Cite the transcript line (or, for Listen-and-Choose, the utterance) the answer hinges on.**
  Quote at most a short English phrase (a handful of words), never the full sentence — pasting a
  whole line verbatim in quotes (English characters count toward the same 120-字 budget as the
  繁體中文 around them) is the fastest way to overrun it; name the key phrase, not the clause.
  Quoting the utterance/transcript here is fine — the Explanation is only ever shown to a test
  taker AFTER that item is scored, at which point the content is no longer an answer to protect.
- **Point at an option ONLY by what it says.** The options you see now are reordered before
  publishing, so anything that names a slot or a label names the WRONG option by the time a learner
  reads it. The one permitted form: describe the option's own content — 「提到停車場的選項」、
  「說要改約週五的那個」 — or quote its own English words. Set-wide phrasing that stays true under any
  order is fine too (「其餘選項均無根據」、「四個選項都與原文無關」).
  Forbidden, in every variant, not just the ones spelled out here: 選項一 · 選項A · 選項１ ·
  選項（二） · 選項甲 · B選項 · 第一個選項 · 第二選項 · 第一個 · 第一項 · 最後一個選項 ·
  最前面的選項 · 前兩個選項 · 上面那個選項 · 一號選項 · 首選 · 末項 · 答案為(B) · 正解為 A ·
  "the first option" · "option B" · (B) 正確 · C 才是正解 · A：未提及 (a bare letter is a label too).
  Note the trap: dropping 「選項一」 in favour of 「第一個」 or
  「最後一個選項」 is the same mistake, not a fix — it is the ORDER that cannot be referred to, not
  the word 選項. In practice your draft usually already says what each option contains and merely
  hangs a position label in front of it; delete the label and keep the description.
- ≤120 字, 繁體中文, specific to that exact item — never generic filler, never explaining a
  different item/question than the one it's attached to.

## Originality is a hard requirement

Every utterance, transcript, and question must be **original**. Vary domain, setting, and
discipline across a Set's stimuli; the space of plausible everyday exchanges and academic topics is
large.

## Self-check before emitting

- Module composition matches the table exactly: router 10+3+3+1, lower 5+2+2+0, upper 5+2+0+3.
- Every `audio` field is `""`; every `Speaker.voice`/`Speaker.provider` is a schema-valid
  placeholder, not a real choice; so is `Speaker.gender` for every Listen-and-Choose/Announcement/
  Academic Talk speaker (Conversations are the one exception — theirs is a real, schema-enforced
  one-male-one-female choice).
- Every Conversation's two speakers are one male and one female, and every transcript turn's
  `speakerId` matches one of them.
- No Listen-and-Choose/Announcement/Academic Talk content (utterance, transcript, item, options)
  depends on its speaker's gender — no self-introduction by a gendered name/title, no gendered
  pronoun referring back to the speaker.
- Every Listen-and-Choose utterance: at most ~6 stressed syllables, requires having heard its
  specific content (not answerable by generic social-script guessing), exactly 4 options with no
  option echoing the utterance's own words.
- Every Conversation: 100–130 words total across turns, idiomatic spoken register, setting on or
  near campus for the clear majority of the Set's Conversations (ETS's "primarily university/campus
  settings" framing — domain/topic still rotates freely), 2 questions.
- Every Announcement: 55–70 words, academic framing (classroom or school-related event, in-person or
  broadcast, never a non-academic setting/announcer), one of the four ETS content types (schedules,
  directions, rules and regulations, student achievements) represented across the Set, 2 questions.
- Every Academic Talk: 175–250 words, no background knowledge required, a discipline from the six
  above, 4 questions; vocabulary that is at least sometimes uncommon, colloquial or idiomatic, and
  built on one rhetorical pattern (compare/contrast, cause–effect) rather than a flat list of facts.
- The `upperModule` reads as genuinely harder than the `lowerModule` — longer and more complex
  sentences, denser information, less common vocabulary, more abstract content — with both modules
  still inside the same word targets, and no plan entry's topic/setting/discipline/speaker
  role/domain changed to get there.
- Every `stem` and `options[].text`, every module: English, no exceptions.
- Every question: exactly one correct option, every distractor wrong for a stated reason AND built
  from a real, domain-realistic specific, answerable from the transcript alone, no "all/none of the
  above," no near-synonym traps, no option conspicuously longer or shorter than the rest.
- Every `explanationZh`: 繁體中文, ≤120 字, cites the transcript/utterance phrase it hinges on,
  specific to its own item.
- All `id`s unique across the whole Set (`Speaker.id` included).
- Every accepted-plan required concept is substantively covered in its own entry's generated
  content, integrated into natural, referentially clear spoken register rather than forced in
  verbatim.
- No `generationPlan` or `audioProfile` field appears in a `GENERATE listening` full-set output.
- Output is JSON only, no prose wrapper.
