# Generating a TOEFL Writing Set

Use the schema supplied for the active mode. A Set bundles **10** Build a Sentence items, **one**
Write an Email task, and **one** Write for an Academic Discussion task — matching the real
section's 12 items.

## Planning mode

For `PLAN writing`, return only the supplied planning schema. Select semantic content, not final
learner-facing wording. The fixed domain vocabulary is:

`campus-academics`, `workplace-business`, `community-civic`,
`science-environment`, `technology-media`, `arts-culture`,
`health-wellbeing`, `services-travel`, `history-social-change`,
`everyday-life`.

Use the supplied preferred domains. Each component's own planning wording must contain at least one
keyword of the `domain` it declares, and no more keywords of any other family, taken from the
`domainKeywords` table supplied in the payload — the server classifies the plan against that exact
table and replans if it disagrees.

Treat the supplied catalog as exclusions: do not copy, combine, or lightly reword its descriptors.
Structural repetition required by TOEFL is allowed; semantic repetition is not. When
`catalogOmittedByTaskType` is non-empty the listed entries are the most recent ones, not the whole
bank; `domainCountsByTaskType` always covers every saved component.

Set top-level `version` to `cross-set-diversity-v1` and `kind` to `writing`. Every component has
a `domain`, lowercase hyphenated `noveltyKey`, two to five
`requiredConcepts`, and up to three `distinguishesFrom` entries. Each distinction names a prior Set
that appears in the supplied catalog for the same Task Type and briefly states the substantive
difference; it is planning metadata, not final content.

- `buildASentence.situations`: plan ten distinct exchanges in array order. Each has a `situation`
  and two `participantRoles`. Obey the supplied `buildSentenceRules` exactly: at least
  `minimumDistinctDomains` domain families, no family more than `maximumPerDomain` times, and at
  least `minimumInPreferredDomains` situations inside the preferred set. That last figure is
  computed from how many preferred domains currently exist, so it can be below five when the
  preferred set is small — use the supplied number, not a remembered one.
- `email`: choose a `situation`, `recipientRole`, and exactly three different `communicativeActs`.
- `academicDiscussion`: choose a neutral `proposition` and two genuinely competing
  `competingValues`.

### Writing `requiredConcepts`

Each required concept is a short concrete noun phrase naming something the final content should
cover, worded as the content itself would say it. Cap: 60 characters (the schema enforces it). These
are GUIDANCE for what the item should be about — there is no automated check counting how closely
the final wording matches — so prioritize natural, well-formed prose over reproducing a concept's
exact words.

| Write this | Not this |
|---|---|
| `late check-out and the extra charge` | `A stated preference about late check-out, with a reason` |
| `sign-up sheet on the front table` | `A sign-up sheet described concretely, including where it sits` |

This is not a style preference. Phrase each concept as the content itself would say it, not as an
instruction about the content — "stated", "described", "concretely", "a recommendation about" read
as meta-commentary on the answer rather than content, which is worse writing regardless of whether
anything checks for it. Name the thing; do not instruct about the answer.

Preserve the exact object shape and return planning JSON only.

## Generating from an accepted plan

For `GENERATE writing`, follow the exact accepted plan supplied in the task. Use each component's
required concepts as substantive guidance for what it should cover — integrate them naturally into
well-formed, referentially clear prose rather than forcing in a concept's exact wording.
Do not substitute a planned situation, participant role, recipient, communicative act,
proposition, or competing value. Map the ten Build a Sentence plans one-to-one, in the same array
order, to the ten generated items.

Output only the original writing generation-input schema. The model output must not contain a
`generationPlan` field or `voiceInstructions`; planning metadata is server-owned.

## Originality is a hard requirement

Every scenario, post, and sentence must be **original**. Do not reuse or lightly reword ETS's
published samples — not the poetry-magazine email, not the volunteerism discussion, not its two
students' arguments — nor the scoring illustrations in `references/samples-scored.md` (the
damaged-camera email, the personal-finance discussion) or, where one is installed, the official
copy that replaces that file. They calibrate difficulty; they are not a template to refill. Vary
the topic domain across Sets (life sciences, history, business, campus logistics, urban planning)
as the ETS specifications describe.

`source`: `"generated"`. `createdAt`: ISO-8601 timestamp. `id`s stable and readable
(`bas-1` … `bas-10`, `email-1`, `disc-1`).

## Build a Sentence: exactly 10 items

Each item is an **exchange between two speakers**. `prompt` holds the first speaker's intact line.
The second speaker's reply is a **partial sentence with blanks in it** — the `frame` — and the tiles
are the words that go in the blanks. That context dependence is the point: a reply that is
grammatical but answers a different question is a broken item.

This is the format ETS describes, and it describes it from both ends. The **RR-25-12 Technical
Manual, §II-5** puts it as reordering: the test taker is shown words or phrases **in the wrong
order** and moves them to form **"a grammatical sentence or question"**. The Test Blueprint and
Specifications puts the same task the other way round — its Stimulus row says the test taker is
**"completing partial sentences using provided vocabulary"** — and names the skill
**"Reconstruct sentences with appropriate grammar"**.

Both are true of the task, and *which one an item looks like is the difficulty axis*. An early item
is mostly completion: the frame hands over the sentence's shape and the blanks sit inside it. A late
item is a reorder: the frame is blanks and a full stop, and the learner rebuilds the whole clause.
Write items across that whole span. Ten items of the first kind would not be this task.

Two things fall straight out of §II-5, and they are the two this guide most recently had wrong:

- **The reply may be a question.** "A grammatical sentence *or question*" is the official wording.
- **The reply's first word is routinely a tile.** Nothing requires the frame to fix the opening
  word, and from the middle of the ramp on, it must not.

### Worked examples: three points on the ramp

**Early ramp — the shape of ETS's one published item** (7 tiles, 6 blanks):

- `prompt`: `"How did the museum visit go?"`
- `frame`: `"The ___ ___ ___ ___ ___ ___ wonderful."`
- `tiles`: `["were", "the", "was", "new wing", "led us through", "who", "volunteers"]`
- `answers`: `[["volunteers", "who", "led us through", "the", "new wing", "were"]]`
- Completed sentence: *"The volunteers who led us through the new wing were wonderful."*

Read off it:

1. **`wonderful.` lives in the frame.** The frame always supplies the sentence-final punctuation, so
   that no tile has to — a tile ending in `.` could only ever be the last blank.
2. **`The` lives in the frame too, but that is this item's *position on the ramp*, not a rule.** A
   frame that fixes the opening word is what an early item looks like. Later items blank it, and the
   tile that fills that blank is written lowercase.
3. **Six blanks, seven tiles.** `was` is never used. It is there to force number agreement against
   the plural "volunteers" — a wrong choice that is only wrong for a grammatical reason.
4. **The tiles are not all single words.** `led us through` is one tile, `new wing` is another,
   and `the` is a third. Multi-word tiles are what let an item target clause structure instead of
   word-order trivia.
5. **One accepted order.** The relative clause cannot be repositioned without breaking the sentence.

ETS's overview publishes exactly one Build a Sentence item (p. 13), and the item above has its
shape: seven tiles for six blanks, the opening article and the closing adjective fixed in the
frame, a relative clause in the middle, and a singular verb left over against a plural subject. This
guide used to read that one published item as the template for all ten. It is one point on a ramp.

**Middle ramp — the start is blanked, and the reply is a question** (7 tiles, 6 blanks):

- `prompt`: `"We've moved the seminar over to the annex."`
- `frame`: `"___ ___ ___ ___ ___ ___ the same time?"`
- `tiles`: `["still", "the", "starts", "at", "will", "afternoon session", "start"]`
- `answers`: `[["will", "the", "afternoon session", "still", "start", "at"]]`
- Completed sentence: *"will the afternoon session still start at the same time?"*

`will` is a tile, and it is drawn **lowercase**, so the tray does not announce which tile opens the
reply. The completed sentence therefore reads with a lowercase first word; that is the exam's own
presentation and not a defect to repair. The frame supplies the `?`. `starts` is the distractor —
the tile a learner reaches for who has not noticed that a modal is in play.

**Top of the ramp — a full reorder** (10 tiles, 9 blanks):

- `prompt`: `"What came out of the department meeting?"`
- `frame`: `"___ ___ ___ ___ ___ ___ ___ ___ ___."`
- `tiles`: `["until", "approved", "the vote", "have", "they", "to postpone", "been", "the new budget", "agreed", "has"]`
- `answers`: `[["they", "agreed", "to postpone", "the vote", "until", "the new budget", "has", "been", "approved"]]`
- Completed sentence: *"they agreed to postpone the vote until the new budget has been approved."*

The frame fixes nothing but the full stop. Every word of the reply is a tile, every tile is
lowercase, and there is no proper noun and no `I` anywhere in the sentence — there could not be,
because no fixed frame text is left for one to sit in. `have` is the distractor, competing with
`has` on agreement against the singular "budget".

### The shape of a generated item

- `frame`: the reply with a blank where each tile goes. Write every blank as **three underscores**
  (`___`), separated by ordinary spaces. It must end in `.`, `!` or `?` — the frame supplies the
  sentence-final punctuation so that no tile has to. **How much else it fixes is the ramp**, and at
  the top of the ramp it fixes nothing else at all: `"___ ___ ___ ___ ___ ___ ___ ___ ___."` is a
  legal and intended frame, the shape §II-5's "words or phrases in the wrong order" describes most
  directly. The schema types this field as a string *or* `null`, for a mechanical reason that has
  nothing to do with you: an optional key would break the strict-schema check the routed providers
  enforce. **Never emit `null`.** Every one of the ten items has a real frame.
- `tiles`: **5-10 tiles**, ramping across the ten items (see below). A tile is a word *or a phrase*.
  **Every tile is written lowercase — including the tile the sentence starts with** — and no tile
  ends in sentence-final punctuation. Both rules close position leaks: one capitalised tile in a tray
  of lowercase ones is visibly the tile the sentence opens with, and a tile ending in `.` can only be
  last. Drawing the opening tile lowercase is precisely what makes blanking the start work at all,
  which is why the exam does it.
- **A word that carries a capital wherever it appears — a proper noun, a month or weekday, an
  acronym, the pronoun `I` — can only live in the frame's fixed text, never in a tile.** So it is
  available to you at the bottom of the ramp and unavailable at the top: an item that blanks the
  start has little fixed text to hide one in, and a full reorder has none. Decide that before you
  write the sentence — pick subjects and objects for the high-blank items that need no capital
  (`our supervisor`, `the committee`, `they`) rather than discovering at the tiling step that a word
  cannot be tiled. A frame's own fixed text is free to carry one:
  `"___ ___ ___ ___ ___ ___ before the Thursday deadline."` is fine.
- **Exactly one distractor: blanks = tiles − 1.** Nine blanks for nine tiles is not this task; two
  spare tiles is not either. Make the distractor a real competitor for one specific blank — a wrong
  agreement (`was`/`were`), a wrong tense, a wrong case, a wrong complementizer — so that choosing it
  is a grammatical mistake rather than a guess.

  > **This one-distractor rule is a convention of this project, inferred from ETS's single published
  > sample. It is NOT a stated ETS rule.** The 2026 Test Blueprint and Specifications does not
  > mention distractors anywhere, for this task or any other. One is what the sample shows, and one
  > keeps the item about grammar rather than about search cost, so one is what this app generates.

- `answers`: the tile texts in blank order, as a list of accepted orders. **Tile text, never a blank
  index, and copied out of `tiles` character for character.** The match is case-sensitive: an answer
  that writes `We` where the tray offers `we` names a tile the item does not have, and that is a
  fatal defect rather than a cosmetic one. This is where the lowercase-tile rule most often gets
  broken — the sentence in your head starts with a capital, the tray does not, and the key silently
  follows the sentence. Do not scramble the tiles yourself, either: the array order is not the order
  the learner sees, and the answer key names tiles by their text, so nothing about it depends on
  where a tile sits in `tiles`.
- `timeLimitSec`: **do not emit it on a Build a Sentence item.** The field was vestigial metadata
  the client never read (#50), and issue #85 dropped it from the shape you emit — the item schema
  no longer carries the key, and it rejects unknown keys. Timing is a pooled 410-second budget
  across all ten items, a project convention (ETS publishes no per-item Build a Sentence timing);
  never present 40 s per item as a task fact. The email's `420` and the discussion's `600` are
  unaffected — those items still carry their own `timeLimitSec`.

### Difficulty: grammar first, then how much the frame supplies, then tile count

The specifications define this skill as reconstructing sentences with **appropriate grammar**, so
difficulty belongs in the grammar first. The other two axes are not decoration, though: the climb
from a completion item to a full reorder is the shape the real exam has, and the tile count is what
makes the top of that climb physically expressible. Ramp all three together across the ten items, in
this order of importance.

> **Provenance.** The **CEFR A1-C2 span across the ten items** is the specifications' own, and it is
> what says the items must vary at all — no single difficulty spans A1 to C2. The ramp's **shape** is
> read off §II-5's "words or phrases in the wrong order" together with a test taker's report of a
> 2026 sitting of the real exam, which showed the sentence start blanked, far more of the sentence blanked than a
> seven-tile item can express, and every tile drawn lowercase. The **exact numbers** below — which
> item gets which structure, where the start starts being blanked, the tile sequence — are this
> app's house style; ETS states no tile count anywhere. Treat the numbers as a considered default
> that produces a usable ramp, not as a fidelity requirement, and not as something to defend against
> a better idea.

**1. Syntactic structure (primary).** What the learner has to reconstruct:

| Items | Structure |
|---|---|
| 1-2 | plain SVO; one adverbial or prepositional phrase to place |
| 3-5 | coordination, a modal or perfect/progressive aspect, a fronted adverbial |
| 6-8 | a subordinate clause, a relative clause, or a `that`-complement |
| 9-10 | a reduced relative, a cleft, a passive with an agent, or two stacked clauses |

**2. Scaffolding — how much the frame supplies (secondary).** This is the axis the frame format
adds, and it is **instructed, not merely permitted**. The *same sentence* is three different items
depending on how much of it the frame hands over:

- *generous* — **items 1-4.** The frame fixes the opening word and one or two content words; the
  blanks cluster in one region. `"The volunteers ___ ___ ___ the new wing ___ wonderful."`
- *start blanked* — **items 5-8.** The reply's **first word is a tile**, and that tile is lowercase.
  What the frame fixes is a tail, a preposition, or the sentence's final complement — never the
  opening word. `"___ ___ ___ ___ ___ ___ until the audit is finished."`
- *full reorder* — **items 9-10.** The frame is blanks plus the sentence-final punctuation and
  nothing else. `"___ ___ ___ ___ ___ ___ ___ ___ ___."`

So: **items 5 through 10 open with a blank, and items 9 and 10 fix nothing but the punctuation.**
A set whose tenth item still hands the learner its opening word is a ramp that never reaches the
exam's own top, which is the specific failure this ramp was rewritten to stop.

**3. Tile count (last, but it no longer barely moves).** Across the ten items, in array order:

`5 → 5 → 6 → 6 → 7 → 7 → 8 → 8 → 9 → 10`

Blanks follow from it — **4, 4, 5, 5, 6, 6, 7, 7, 8, 9** — since exactly one tile is always spare.

It used to run `4 → … → 7`, and it used to be the axis that moved least. It moves further now
because the top of the ramp requires it: a full reorder needs a tile for every word of the reply, and
nine blanks is roughly what an ordinary B1-B2 sentence costs when nothing is fixed. Ten is the
ceiling, and the reason is working memory rather than grammar — past ten, the item measures how many
fragments a learner can hold at once.

Five is the floor of the ramp, and it now fits the short, plain sentences the A1 end of the span
calls for. It did not use to: five tiles leave four blanks, and while the frame was still required
to fix a word, that made six words the shortest expressible item — which is why the old ramp had to
drop to four. That requirement is gone, so a five-tile item is a five- or six-word reply and the
floor can sit at five. Reach the low end by writing a short sentence, never by chopping a long one
into single-word tiles — that tests word order instead of grammar.

Target the A1-C2 span the specifications name.

### At least one reply is a question

§II-5's wording is "a grammatical sentence **or question**", and an interrogative is not a garnish on
the format — it is a different thing to reconstruct. Subject-auxiliary inversion, a *wh-* word that
has to land first, an auxiliary that has to agree with a subject it now precedes: none of that is
reachable from a declarative item.

**At least one of the ten replies is a question**, and its frame ends in `?`. It sits naturally in
the middle of the ramp, because a reply that asks something back is an ordinary turn in the kind of
exchange these items model — *"We've moved the seminar over to the annex."* / *"will the afternoon
session still start at the same time?"*. One or two is the shape; ten would be its own monotony.

### Alternate accepted orders: list one only when there genuinely is one

This task is machine scored by exact match (ETS specifications, p. 5: 10 items, machine scored, 0 AI
scored), so an order you fail to list is marked wrong even when it is good English. But **do not go
hunting for alternates.** A frame with a fixed shape usually admits exactly one order, and an item
that admits several is telling you something: it does not pin down a target, so the learner cannot
know what it is asking for. Redesign such an item — tighten the frame, change a tile — rather than
enumerating its answers.

List a second order only when it is genuinely unavoidable and genuinely equal: a movable adverbial
the frame cannot pin, either order of two coordinated elements. If you find yourself writing a third,
the item is wrong.

The higher up the ramp an item sits, the more this matters: a frame that fixes nothing has nothing
left to pin an adverbial against, so a full reorder is where stray alternates appear. Answer it by
**choosing the sentence**, not by enumerating orders — a reply whose word order is held in place by
its own syntax (a subordinate clause, a passive with its agent, a verb whose complement cannot move)
is what belongs at items 9 and 10. A sentence with a floating "yesterday" in it does not.

**Run the fronting test on every start-blanked and full-reorder item.** Take each tile that is a time
adverbial (`last week`, `yesterday`, `on Friday`) or a leading subordinator (`since …`, `because …`,
`after …`) and move it to the front of the sentence. If the result is still grammatical, you have
just built an order the key does not list, and this task is scored by exact match — the learner who
builds it is marked wrong for correct English. Fix it by **rewriting the sentence** so the phrase
cannot front (fold the time into the verb phrase, or drop it), not by adding the fronted order to
`answers`. The first pilot Set generated under these rules failed exactly this on two of its ten
items, both of them full reorders, and the verification pass did not catch either.

## Write an Email: one scenario, exactly 3 bullets

- `scenario`: a text-framed situation in an academic or social setting, ending in the problem or
  need that motivates writing. Two or three sentences, like ETS's.
- `bullets`: **exactly 3**, each a distinct communicative act, phrased as an instruction to the
  writer ("Explain what went wrong with your order."). Vary the acts across the three — ETS's example
  runs compliment → describe problem → request information. Pull from: recommend, invite, decline,
  apologize, propose a solution, request clarification, express appreciation, report a problem.
  Three bullets that are all "describe X" give the writer nothing to demonstrate.
- `to`: a plausible address matching the scenario. `subject`: a short line the writer would
  plausibly have been given.
- `timeLimitSec`: `420` (7 minutes). `wordGuidance`: `{min: 80, max: 120}`.

The recipient should be someone the writer does **not** know socially — an editor, a housing office,
a professor, a shop manager. Register is part of the construct, and a note to a close friend removes
the politeness and social-convention dimension the rubric scores.

<!-- voiceInstructions hint (email): none — this is a text-only stimulus with no audio. TTS handles
     voice separately; never emit a voiceInstructions field in the JSON. -->

## Write for an Academic Discussion: professor post + two opposing students

- `courseTitle` and `professorName`: a plausible course and instructor.
- `professorPost`: define or frame the topic in two or three sentences, then pose a direct opinion
  question ("What do you think? Should …? Why or why not?"). The framing must be neutral — a
  professor post that leans one way collapses the task into agreement.
- `studentPosts`: **exactly 2**, taking genuinely **opposing** positions, roughly 40–60 words each.
  Each must give a *reason*, not just a stance, because the strongest test-taker responses engage a
  named classmate's reasoning (ETS's official score-5 sample opens by granting one classmate's point
  before disagreeing with it). Give the two students clearly different first names and no surnames,
  matching ETS's presentation of each post under a bracketed first name.
- `timeLimitSec`: `600` (10 minutes). `minWords`: `100`.

Choose a question with real two-sidedness — a genuine trade-off between defensible values — and one
answerable from ordinary experience. If answering well requires knowing a specific study, statute,
or technical fact, the item is testing knowledge instead of writing. The two student posts should
between them leave obvious room for a third position: a qualification, a middle path, or a
consideration neither raised.

<!-- voiceInstructions hint (discussion): none — text-only stimulus, no audio. TTS handles voice
     separately; never emit a voiceInstructions field in the JSON. -->

## Self-check before emitting

- Exactly 10 Build a Sentence items, 1 email, 1 discussion.
- Every Build a Sentence item has a `frame`. Reading each frame with its accepted order dropped into
  the blanks gives a sentence that is natural English and actually answers the `prompt`.
- Difficulty ramps by structure and by how much the frame supplies, not by tile count alone.
- **Blank position ramps.** Items 1-4 fix the opening word; items 5-8 start with a blank; items 9
  and 10 are full reorders whose frame is blanks plus the sentence-final punctuation and nothing
  else. Count the frames that begin with `___`: there should be six.
- **Tile count ramps** `5 → 5 → 6 → 6 → 7 → 7 → 8 → 8 → 9 → 10`, and every item's blank count is
  exactly one fewer than its tile count.
- **No tile begins with a capital letter.** Check all ten trays, the opening tile of each reply
  included. No proper noun, no month or weekday, no acronym and no `I` appears in any tile; if an
  item needs one, it sits in that item's fixed frame text — which items 9 and 10 do not have.
- **Every accepted answer reproduces its tiles character for character**, casing included. Check
  each `answers` entry against its own `tiles` array rather than against the sentence you had in
  mind; a key that capitalises a lowercase tile is a fatal defect.
- **At least one reply is a question**, and that item's frame ends in `?`.
- **The fronting test has been run on items 5-10** (see above): no time adverbial or subordinator
  tile can be moved to the front and still give a grammatical sentence. This is the defect that
  survives every deterministic check, because an unlisted-but-correct order is invisible to a gate
  that only counts.
- No Build a Sentence item carries `timeLimitSec` (see above). `timeLimitSec` reads 420 on the
  email and 600 on the discussion.
- Email has exactly 3 bullets, each a different communicative act.
- Discussion has exactly 2 student posts and they genuinely disagree.
- Nothing overlaps ETS's poetry-magazine or volunteerism materials, or the damaged-camera and
  personal-finance illustrations in `references/samples-scored.md`.
- No `voiceInstructions` field appears anywhere in the JSON.
- Every accepted-plan required concept is substantively covered, integrated naturally rather than
  forced in verbatim, with one-to-one Build a Sentence plan order.
- No `generationPlan` field appears anywhere in the JSON.
- Output is JSON only, no prose wrapper.
