# Generating a TOEFL Speaking Set

Use the schema supplied for the active mode. A Set bundles **one** Listen and Repeat scenario
(7 items) and **one** Take an Interview scenario (4 questions).

## Planning mode

For `PLAN speaking`, return only the supplied planning schema. Select semantic content, not final
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

Set top-level `version` to `cross-set-diversity-v1` and `kind` to `speaking`. Every component has
a `domain`, lowercase hyphenated `noveltyKey`, two to five
`requiredConcepts`, and up to three `distinguishesFrom` entries. Each distinction names a prior Set
that appears in the supplied catalog for the same Task Type and briefly states the substantive
difference; it is planning metadata, not final content.

- `listenAndRepeat`: choose a concrete physical `setting`, a `speakerRole`, and one
  `communicativePurpose` that can support seven progressively harder utterances. `setting` must
  contain a real word (a plural or the usual verb/noun ending is fine) from the `physicalSettingTerms`
  list supplied in the payload — the server checks the plan's own setting text against that exact
  list and replans if none of it appears, for the same reason `domainKeywords` is checked above. That
  list is not every possible physical place (English has far too many for any closed list), just a
  large sample of ordinary ones; pick whichever one actually names the place you had in mind rather
  than tacking on an unrelated word from the list to satisfy the check.
- `interview`: choose one `topic` and `premise`; `questionArc` describes, without writing the final
  questions, the fixed factual, experience, opinion, opinion progression.

### Writing `requiredConcepts`

Each required concept is a short concrete noun phrase naming something the final content should
cover, worded as the content itself would say it. Cap: 60 characters (the schema enforces it). These
are GUIDANCE for what the item should be about — there is no automated check counting how closely
the final wording matches — so prioritize natural, well-formed prose over reproducing a concept's
exact words.

| Write this | Not this |
|---|---|
| `cheaper fares versus frequent service` | `A stated preference between cheaper fares and more frequent service, with a reason` |
| `hydration counter refilled before opening` | `Hydration counter wiped down and refilled before the first exercise group arrives` |
| `missed connection changing a trip plan` | `One remembered occasion when a delay changed the speaker's plan` |

This is not a style preference. Phrase each concept as the content itself would say it, not as an
instruction about the content — "stated", "described", "concretely", "a recommendation about", "one
remembered occasion when" read as meta-commentary on the answer rather than content, which is worse
writing regardless of whether anything checks for it. Name the thing; do not instruct about the
answer.

Preserve the exact object shape and return planning JSON only.

## Generating from an accepted plan

For `GENERATE speaking`, follow the exact accepted plan supplied in the task. Use each component's
required concepts as substantive guidance for what it should cover — integrate them naturally into
well-formed, referentially clear prose rather than forcing in a concept's exact wording.
Do not substitute the planned setting, speaker role, communicative purpose, Interview
topic, premise, or four-step semantic arc. The Interview `type` sequence remains exactly
factual, experience, opinion, opinion.

Output only the original speaking generation-input schema. The model output must not contain a
`generationPlan` field. It also must not contain server-owned scene fields (`image`,
`focusRegion`) or `voiceInstructions`; those belong to later pipeline stages.

## Originality is a hard requirement

Every sentence, question, and scenario must be **original**. Do not copy, lightly reword, or
re-skin ETS's published samples — not the zoo scenario, not the urban life interview, not their
sentence frames — nor the scoring illustrations in `references/samples-scored.md` (the recycling
center, the commuting study) or, where one is installed, the official copy that replaces that file. Those exist to calibrate difficulty, and a learner who
practices on memorized ETS content learns nothing transferable. Pick a different setting each time;
the space of plausible campus and workplace scenarios is large.

## Field conventions

- `audio` and `introAudio`: emit `""`. Text-to-speech runs as a separate pipeline stage and fills
  these in. Do not invent file paths or URLs.
- `id`: stable, human-readable, e.g. `lr-1` … `lr-7`, `int-1` … `int-4`.
- `source`: `"generated"`. `createdAt`: ISO-8601 timestamp.

## Listen and Repeat: one scenario, exactly 7 sentences

**Scenario.** A communicative reason to listen and repeat — staff training, an orientation
walkthrough, a lab safety briefing, a library tour. The scenario should imply physical movement
through a space, because the real test pairs sentence progression with movement through an
illustration. Write `scenarioDescription` as the narrator would say it, ending with the instruction
to repeat (ETS's pattern: name the person to listen to, tell the test taker to repeat what that
person says, and say that each sentence is heard once).

**Setting is campus/academic by default.** The *Technical Manual* describes Listen and Repeat as
"typically in an academic setting" — treat that as an academic-majority policy, not a rule that only
applies when it happens to be convenient. It holds regardless of which `domain` family Planning mode
assigns this component: `domain` is a semantic-diversity label balanced across all ten families for
novelty tracking (see Planning mode above), while `setting` is a separate, freely chosen field, so a
non-`campus-academics` domain does not obligate a non-academic setting. Most families still have an
obvious campus venue that satisfies their domain keywords without leaving campus: `science-environment`
suits a campus lab or greenhouse, `technology-media` a campus media lab or radio station,
`arts-culture` a campus gallery or studio, `health-wellbeing` the student health center,
`workplace-business` a campus office (admissions, the bookstore, a career center),
`history-social-change` a campus archive or museum, and `campus-academics` is academic by
construction. Reach for that campus-adjacent venue first even when the assigned domain is one of
these. Reserve a genuinely non-academic setting — a home, a downtown shop, a bus or train, a
community center off campus — for the domains where an academic venue would be a stretch:
`everyday-life` and `services-travel` most often, `community-civic` occasionally. Aim for roughly 4
in 5 newly generated Listen and Repeat scenarios in a campus or academic setting, with no more than
1 in 5 genuinely non-academic; that ratio is what keeps "typically" true in practice against a domain
rotation that, left to itself, would otherwise put a non-`campus-academics` domain in the majority of
Sets.

**Register.** Natural spoken English, the way a person actually talks on the job. Contractions are
good. Avoid written-register constructions ("one must ensure that…") — the ETS specifications
explicitly call for "natural spoken features such as contractions".

**The complexity ramp.** Progression is by **syntactic complexity**, which is what the ETS
specifications state ("increasing in length and syntactic complexity"): each item's structure
should be at least as demanding as the one before it, following the Structure column below. Word
counts **trend upward** across the seven items but need not rise at every step — ties and local
dips are fine. ETS's own published example has both: the *Technical Manual* Figure 11 scenario
runs 5, 6, 6, 11, 8, 10, 15 words, so its item 5 is shorter than its item 4 and two items tie.
Do not force a length increase at every step; a ramp that climbs at every step from a 7-word
item 1 has nowhere to go but past every observed ETS ceiling by item 7.

| Item | Length | Structure | `responseWindowSec` | Max words at pace |
|---|---|---|---|---|
| 1 | ~6–9 words | one independent clause, simple SVO | 8 | 13 |
| 2 | ~8–10 words | one clause, compound subject or object | 8 | 13 |
| 3 | ~9–12 words | compound verb, or a prepositional chain | 10 | 13 |
| 4 | ~9–13 words | coordination (two clauses joined by and/but/or) | 10 | 13 |
| 5 | ~10–13 words | a dependent clause (when/if/because/after) | 10 | 13 |
| 6 | ~11–15 words | complex nominal phrase, or coordination + subordination | 12 | **13** |
| 7 | ~15–16 words | a relative clause (or reduced relative), embedded | 12 | **13** |

The window column is this app's fixed convention (8/8/10/10/10/12/12), as is the overall
8-to-12-second range it stays within (traceable to the *Updated TOEFL iBT Test Overview* but
unverified in-repo — see `rubric-listen-and-repeat.md`). Each Length cell's top number is a
ceiling the server checks at generation time — item 7 never exceeds 16 words. Three independent
official ETS item sets top out at 13, 14, and 15 words; a sentence far past that measures
working-memory span and breath, not language.

**Two budgets, and the smaller one wins.** The last column is the second, independent ceiling the
server checks: **no single sentence may run longer than 5.0 seconds of speech** when read at the
SLOWEST rate that item's recording band accepts. Length and rate are budgeted separately, so a
sentence can sit inside its Length cell, be read at a rate nobody would correct, and still run long —
the clip ceiling is the only check that sees their product. Measured at the slow edge of the band
rather than at the target, that budget is **13 words at every item**. It bites at items 6 and 7,
where the Length cell allows 15–16 words. Write to 13 there.

That is also where ETS itself lands: its own item 7 runs 13 words (zoo) and 14 (Teacher Practice
Test 5), and its longest Listen and Repeat clip anywhere is 4.68 seconds — 13 words at item 6 of
Teacher Practice Test 5.

Items 1–5 have Length cells at or below 13, so the clip budget never binds there. Items 1–3 are
also recorded FASTER than items 4–7 — ETS's measured shape, not this app's invention. Measured from
ETS's own Teacher Practice Test 5 audio, with the silence at each end removed, ETS reads its short
opening sentences at about 226 words per minute and its items 4–7 at about 183, trading rate against
length to keep memory load roughly flat. Do not compensate for it in the writing — the ramp you
write is length and syntax only, and the recording handles rate.

Item 7 of ETS's published zoo set is the model for the top of the ramp: 14 words whose subject
carries an embedded reduced relative (a participle phrase set off by commas), in entirely ordinary
vocabulary. A sentence of the same shape: *"The study rooms, located on the second floor, can be
booked online."* Difficulty should come from **structure**, not from rare
words. Avoid technical terms, proper nouns a learner might not catch, and tongue-twisters; a
mis-repetition should mean the structure was too complex to hold, not that the word was exotic.

<!-- voiceInstructions hint (L&R): warm staff-briefing delivery, brisk on the short opening items
     and easing as the sentences lengthen (ETS's own measured shape); one clear sentence per
     utterance with a full stop between; no background ambience. TTS handles voice separately —
     never emit a voiceInstructions field in the JSON. -->

## Take an Interview: one topic, exactly 4 questions

**Scenario.** One interview premise, delivered in `intro` as the narrator sets it up — a research
study, a scholarship interview, a student-newspaper profile, a campus survey. `scenarioTitle`
names the topic.

**Question order is fixed** and mirrors ETS's factual → experience → opinion → opinion progression.
The `type` field must follow this exact sequence:

1. `factual` — asks for concrete, retrievable information about the test taker's own life. Answerable
   without argument. ("Which part of your campus do you spend the most time in, and what do you
   usually do there?")
2. `experience` — asks the test taker to narrate or describe something they have lived through, with
   a reason attached ("What made it go wrong, and what did you do about it?").
3. `opinion` — introduces a position, ideally by naming two contrasting views the way ETS does
   ("Some people believe… Others find…"), then asks the test taker to take a side and justify it.
4. `opinion` — broadens to policy or a general claim, one step more abstract than Q3. This is the
   hardest item and should invite prediction, evaluation, or a recommendation.

All four must sit on **one topic**, each building on the last. Write them as a real interviewer
speaks: open with a courtesy ("Thanks for speaking with me today."), and start questions 2–4 with
a brief acknowledgement of the previous answer ("Great." / "OK. Next, I'd like your opinion on
this." / "Good points. One last question for you."). That connective tissue is what makes it a
conversation rather than four prompts, and ETS's own sample interview has it too.

**Every question must be answerable in 45 seconds** by someone with no preparation time, and must
not assume knowledge the test taker may not have — no country-specific institutions, no current
events, no academic content requiring study. `responseWindowSec` is always `45`.

Keep each question under about 70 words. Questions 3 and 4 carry framing, so they run longer than
1 and 2; that is expected.

<!-- voiceInstructions hint (interview): friendly professional interviewer, moderate pace, rising
     interest on the acknowledgement tokens; distinct from the L&R voice. TTS handles voice
     separately — never emit a voiceInstructions field in the JSON. -->

## Self-check before emitting

- Exactly 7 L&R items and exactly 4 interview questions.
- Word counts trend upward across the 7 L&R items (ties and local dips are fine), syntactic
  complexity never regresses, and no item exceeds its row's Length ceiling; item 7 ≤ 16 words.
- No item exceeds its row's "Max words at pace" — the 5.0-second clip ceiling. Items 6 and 7 are the
  rows where it binds before the Length cell does: **13 words each**.
- `responseWindowSec` reads 8, 8, 10, 10, 10, 12, 12 across L&R and 45 for every interview question.
- Interview `type` sequence is exactly factual, experience, opinion, opinion.
- No sentence, name, or scenario overlaps ETS's zoo or urban-life materials, or the recycling-center
  and commuting illustrations in `references/samples-scored.md`.
- All `audio` fields are `""`; no `voiceInstructions` field appears anywhere in the JSON.
- Every accepted-plan required concept is substantively covered, integrated naturally rather than
  forced in verbatim, with no setting/topic/purpose substitution.
- No `generationPlan`, `image`, or `focusRegion` field appears anywhere in the JSON.
- Output is JSON only, no prose wrapper.
