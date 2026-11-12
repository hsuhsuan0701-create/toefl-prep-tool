# Listen and Repeat — scoring rubric (0–5)

This file is the TOEFL Prep Tool's own description of the criteria ETS publishes for scoring this
task, written in this project's words. It is not ETS's text. The criteria come from ETS's *Updated
TOEFL iBT® Test Overview* (2026): the task is described on p. 17 and scored by the guide on
pp. 26–27, public at <https://www.ets.org/pdfs/toefl/toefl-ibt-test-overview.pdf>. A user who wants
scoring to read ETS's own wording can install it on their machine; see `docs/official-rubrics.md`.

## The task

- Seven sentences, all from one scenario on campus or in academic life, which gives the test taker
  a reason to listen — learning a job, being shown around a place, and the like.
- A picture of the setting accompanies the sentences, and each new sentence moves the focus to
  another part of the picture.
- Each sentence plays **once**. After a short pause the test taker says it back, aiming to
  reproduce exactly what they heard.
- The sentences grow longer and more complex from the first to the seventh. All seven are scored
  0–5 by AI.

> **How this app times it — not a verified ETS fact:** the response windows are 8 / 8 / 10 / 10 /
> 10 / 12 / 12 seconds, one per item (`SpeakingSetSchema`), inside an overall range of 8 to 12
> seconds. That range is attributed to p. 17 of the *Updated TOEFL iBT Test Overview*, a document this
> repository does not keep a copy of. ETS's blueprint and its technical manual, RR-25-12, are both
> silent on per-item response time (see §2.6 and §4.5 of
> `docs/research/2026-08-23-listen-and-repeat-speech-rate.md`). Tell a learner the range and the
> ramp are this app's timing.

## Dimensions

ETS measures two things here. The Judges report one score for each, under these names:

| Dimension | What it covers |
|---|---|
| **accuracy of repetition** | How closely the spoken words match the sentence: which words are kept, dropped, changed, added or reordered, and above all whether the sentence's meaning survives. |
| **intelligibility** | Whether a listener can make out the words, judged from how the response sounds. |

The question that settles most items is whether the meaning survived. A response can change
several small things and keep it (4), or keep most of the words and lose it (3).

## Score bands

### Score: 5

**In short:** the sentence comes back exactly as it was heard.

- **accuracy of repetition** — Every word is there, in order, with nothing added, dropped or
  changed.
- **intelligibility** — Every word is clear.

Any departure from the sentence, however small, puts the response below 5.

### Score: 4

**In short:** not word-for-word, but the meaning is intact.

- **accuracy of repetition** — The differences are small changes to words or grammar that leave the
  meaning essentially as it was. Typical of this band:
  - one or two small grammatical words (articles, prepositions, auxiliaries, pronouns) left out or
    swapped for others;
  - in a longer sentence, one content word left out; or a content word replaced by a related one;
  - a tense, aspect or plural/singular ending missed or wrong;
  - two of the words said in swapped order.
- **intelligibility** — Clear overall; at most one or two content words are hard to make out
  because they were pronounced imprecisely.
- The speaker may stop and correct themselves, provided they go on to finish the sentence.

**What separates 4 from 5:** exactness. **What separates 4 from 3:** at 4 the meaning is still the
one the sentence had; at 3 it is not.

### Score: 3

**In short:** the response is close to complete, yet what it says is no longer quite what the
sentence said.

- **accuracy of repetition** — Most content words, or most of the ideas, are kept, and what comes
  back still forms a complete sentence. But several small grammatical words are changed or missing,
  or at least one content word is missing or changed in a way that alters the meaning.
- **intelligibility** — Sometimes a listener has trouble catching the meaning: the speaker may
  stumble on a word or phrase, or blur words into one another.

**What separates 3 from 2:** at 3 the response is still a whole sentence carrying most of the
content; at 2 a large part is gone and what remains is not a sentence on its own.

### Score: 2

**In short:** a large part of the sentence is missing, or much of what is said is wrong.

- **accuracy of repetition** — Important parts of the meaning are lost with the missing words. A
  common pattern: the opening of the sentence comes back correctly, and then the speaker stops,
  substitutes words that were not there, or jumps to the last few words. The result does not stand
  as a sentence; the meaning comes through in fragments.
- **intelligibility** — Low: someone who had not heard the original sentence would struggle to
  understand the response.

### Score: 1

**In short:** almost nothing of the sentence is captured, or almost nothing can be understood.

- **accuracy of repetition** — Only a few words are produced; most of the sentence is missing.
- **intelligibility** — The response can be recognised as an attempt to say the sentence back, but
  most of it cannot be understood.

**What separates 1 from 2:** at 2 enough comes back that parts of the meaning are recognisable; at
1 only a few words do, or the words cannot be made out.

### Score: 0

Any of these: no response; nothing in it can be understood; it contains no English; it has nothing
to do with the sentence; or it consists only of remarks such as "I don't know".

## Notes on this description

- The same five conditions decide a 0 for Take an Interview.
- The four kinds of small change listed at band 4 are ETS's examples, not a closed list: any change
  of the same weight that leaves the meaning intact belongs there.
