# Write an Email — scoring rubric (0–5)

This file is the TOEFL Prep Tool's own description of the criteria ETS publishes for scoring this
task, written in this project's words. It is not ETS's text. The criteria come from ETS's *Updated
TOEFL iBT® Test Overview* (2026): the task is described on p. 14 and scored by the guide on
pp. 23–24, public at <https://www.ets.org/pdfs/toefl/toefl-ibt-test-overview.pdf>. A user who wants
scoring to read ETS's own wording can install it on their machine; see `docs/official-rubrics.md`.

## The task

- The test taker reads a short situation, set either in academic life or in a social setting, and
  writes an email that does something for its reader — recommends, invites, proposes a fix to a
  problem, and so on.
- The prompt names the recipient and the subject line and lists **three instructions**. Doing all
  three is part of doing the task.
- **7 minutes**, one item, scored 0–5 by AI. ETS gives **no word count** for this task: the prompt
  only asks the writer to produce as much as they can, in full sentences.

> **This app's convention, not ETS's:** the email's `wordGuidance` in `WritingSetSchema` is 80 to
> 120 words, a practice target chosen here. The one word floor ETS publishes for Writing (100)
> belongs to the Academic Discussion. Never present 80–120 as an ETS requirement.

## Dimensions

ETS describes what this task measures in four parts. The Judges report one score for each, under
these names:

| Dimension | What it covers |
|---|---|
| **communicative goal & social conventions** | Whether the email does its job for this reader: every instruction carried out, and tone, politeness, the order information arrives in, and the way requests, refusals or complaints are put, all suited to the relationship. |
| **elaboration & cohesion** | How fully each point is developed with reasons, specifics or examples, and whether the email hangs together as one clear message. |
| **grammar & vocabulary** | How wide and how accurate the writer's sentence structures and word choices are. |
| **mechanics** | Spelling, punctuation and capitalization. |

ETS's band descriptions speak to the first three directly. For **mechanics** they give one explicit
allowance, at band 5, and otherwise fold spelling and punctuation into each band's description of
errors; the mechanics lines below say where that is so rather than inventing a separate ladder.

## How the bands combine

- At **5, 4 and 3**, a band's description is a profile. Place a response at the band whose profile
  its dimensions fit as a whole.
- At **2 and 1** the logic is different: a response belongs there when it shows **any one** of the
  weaknesses listed for the band, even if another dimension looks stronger.
- The item score is a judgement of the whole email against these profiles, not an average of the
  four dimension scores.

## Score bands

### Score: 5

**In short:** the email does what it set out to do, reads clearly on a first pass, and the writer's
command of English holds from start to finish.

- **communicative goal & social conventions** — All three instructions are carried out, and the
  writer handles the reader well throughout: the register fits the relationship, requests or
  complaints are framed with suitable courtesy, and information comes in an order that serves the
  reader.
- **elaboration & cohesion** — Each point is developed enough to do real work for the purpose; the
  reader gets the reasons, specifics or examples needed to understand and respond.
- **grammar & vocabulary** — Sentence patterns vary in ways that serve the message. Words are exact
  and are used the way a fluent writer uses them.
- **mechanics** — The only slips are the kind a capable writer makes against the clock: an
  occasional typo, a commonly misspelled word, a homophone swap such as *there*/*their*.

Language errors of any other kind are close to absent.

### Score: 4

**In short:** the email mostly works and is easy to follow. The writer's English is up to the task,
with less polish than at 5.

- **communicative goal & social conventions** — The task is done and the tone is mostly right for
  the reader, with at most a minor lapse in courtesy, register or the ordering of points.
- **elaboration & cohesion** — Points are developed enough to serve the purpose, but less fully or
  less pointedly than at 5.
- **grammar & vocabulary** — There is some variety of sentence structure, and word choice is
  suitable, though less exact or idiomatic than at 5. A small number of grammar or word errors
  appear.
- **mechanics** — No separate standard: spelling, punctuation and capitalization count among the
  band's small number of errors.

**What separates 4 from 5:** development that is sufficient rather than strong, words that are
suitable rather than exact, tone that is mostly rather than consistently right, and errors that are
few rather than nearly absent.

### Score: 3

**In short:** the email broadly accomplishes the task, but limits in the writer's English leave
parts of the message less clear or less effective than they should be.

- **communicative goal & social conventions** — The core purpose is met, but tone, register or the
  way a request is put may be noticeably off in places.
- **elaboration & cohesion** — Development supports the purpose only in part: some points stay thin,
  vague or undeveloped.
- **grammar & vocabulary** — A middling range of structures and words. Errors in sentence
  structure, word forms or idiom are noticeable to a reader.
- **mechanics** — No separate standard: spelling and punctuation errors count among the band's
  noticeable errors.

**What separates 3 from 4:** at 4 the reader follows everything easily; at 3 some part of the
message is unclear or falls flat, development is partial, and the errors are noticeable rather than
few. Noticeable trouble with the social side of the email (tone, courtesy, register) also belongs
here rather than at 4.

### Score: 2

**In short:** the writer is trying to respond, but the email mostly fails at its job. What it
communicates is thin, or the reader has to work to make it out.

- **communicative goal & social conventions** — The attempt is visible, but the email does not
  achieve its purpose for the reader.

Any one of these signs is enough to place a response here:

- Little development, or development that is beside the point (**elaboration & cohesion**).
- Some sentences are connected and hold together, but the range of structures and words is narrow
  (**grammar & vocabulary**).
- Errors in how sentences are built or words are used build up across the email
  (**grammar & vocabulary**; spelling and punctuation errors count here for **mechanics**).

**What separates 2 from 3:** at 3 the purpose is met despite weaknesses; at 2 it mostly is not, and
the message itself is limited or hard to interpret.

### Score: 1

**In short:** the attempt barely engages the task, and the message may be so limited that it
cannot be understood.

- **communicative goal & social conventions** — The attempt does not get the task done.

Any one of these signs is enough to place a response here:

- Almost no development, or none (**elaboration & cohesion**).
- Clipped, disconnected phrases and short sentences, drawing on very few words
  (**grammar & vocabulary**).
- Serious errors throughout (**grammar & vocabulary**, and **mechanics** for spelling and
  punctuation).
- Little of the language is the writer's own: whatever reads coherently is mostly lifted from the
  prompt.

**What separates 1 from 2:** at 2 some connected sentences survive in the writer's own words; at 1
the writing breaks down into fragments, or what holds together was copied from the prompt.

### Score: 0

Any of these: nothing was written; the writer refuses to engage with the topic; the response is not
in English; it consists entirely of text copied from the prompt; it has no connection to the
prompt; or it is random keystrokes.

## Notes on this description

- The 5/4/3 "profile" reading versus the 2/1 "any one of these" reading follows a difference in how
  ETS's guide introduces the bands for this task. The Academic Discussion guide does not make that
  distinction; see `rubric-academic-discussion.md`.
- The dimension lines are this project's arrangement of ETS's band descriptions under the four
  measured skills, so that each Judge dimension can be scored against its own line.
