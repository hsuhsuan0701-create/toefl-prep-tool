# Spoken prompts are shown as text once the Attempt is complete

## Status

Accepted.

## Context

The served Set (`stripAnswers` in `shared/src/servedSet.ts`) withholds each Listen and Repeat
sentence and each Interview question as text. Listen and Repeat exists to elicit a sentence the User
has only heard, and an Interview question read before it is asked is a question prepared for. While
an Attempt can still be answered, the text must not reach the client.

After the Attempt, the review did show it, but only for a scored Item: the scorer writes the sentence
(`target`) or the question into the Score Report's `meta`, and the review read it from there. An
Item whose transcription or scoring failed has no Score Report, so its card said nothing of what was
asked. The prompt's audio plays again on a completed Attempt's review (issue #53), and the text was
still missing. The rule in practice was already "after completion, for the Items that happened to be
scored"; the Items left out were exactly the ones a User most needs to understand.

## Decision

**A spoken prompt's text is withheld while an Attempt can still be answered, and is sent with the
detail of a completed Attempt, for every Item, scored or not.**

- `GET /api/attempts/:id` for a completed Speaking Attempt, Drill or Simulation (a Full-Test Run's
  Speaking section included), carries `spokenPrompts`: for each spoken Item of the Attempt, the
  sentence (Listen and Repeat) or the Item's own question (Take an Interview; never the Interview's
  introduction, which the served Set already carries).
- The text is read from the Set on disk at request time, as `deterministicReview` reads a Reading or
  Listening key and Explanation, and is never stored. A Set that can no longer be read omits the
  field; the readback still succeeds.
- For an in-progress, unfinished or discarded Attempt the field is absent. The review page holds to
  the same rule.
- On the review, a scored Item keeps showing the text from its Score Report; an Item with none shows
  the text from `spokenPrompts`, under the same heading and in the same place. Both name the same
  sentence or question, so it is shown once.

## Considered Options

- **Serve the text in the Set once an Attempt on it is complete**: rejected. `GET /api/sets/:id` is
  per Set, not per Attempt, so it would reveal the prompts to the next Attempt on that Set while it
  is being answered, and the served-key tripwire exists to keep that route's shape fixed.
- **Write the text into a failed Item's row**: rejected. It would store Set content per Item and
  diverge from the Set when a Set's text is corrected; the detail already re-derives keys from the
  Set on each read.
- **Leave unscored Items without text**: the question this record answers. The audio alone does not
  let a User read back a sentence they could not catch, which is the point of the review.

## Consequences

What this does not change:

- **The served Set.** `GET /api/sets/:id` still strips every sentence and question, and
  `servedSetTripwire.test.ts` still guards it.
- **An unfinished Simulation**, or any Attempt that can still take a Response, gets no text. A
  restarted Full-Test Run section replaces an in-progress Attempt, which never carried it; a
  completed Full-Test section is never sat again (`checkFullTestLink` refuses it).
- **The Drill Lab's own rule.** `/drill-lab` still serves Listen and Repeat sentences in cleartext
  only for an Item with a recorded take that was scored, and its reps still reach nothing that
  scores.

A User who has read a Set's prompts on a completed Attempt can sit the Set again. That Attempt is a
Repeat: tagged, never a headline band, and the same was already true of every scored Item's text.

The Speaking Drill's results screen does not load the Attempt detail, so it is unchanged; the
Attempt's review, reached from the Attempt log, shows the text.

Pinned by `server/test/routes.attempts.spokenPrompts.test.ts` and
`client/test/AttemptReviewGroups.test.tsx`.
