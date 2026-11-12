# Pins are retired: every section has a Target, and nothing stands in for a band

## Status

Accepted. Builds on ADR 0010: a band that does not exist is shown as missing, not approximated.

## Context

Pins came with the first stats routes, before Reading and Listening had Simulations. The app could
not estimate those two sections yet, so the User "pinned" a Reading and a Listening band, 5.5 each
by default, and a Pin stood in for that section's band on the Dashboard and in the Overall. Targets
existed only for Speaking and Writing.

Reading and Listening Simulations now produce real Band Estimates (ADR 0005), so a Pin no longer
filled a gap the app could not fill. It hid one. A fresh clone with no Attempts showed an Overall
made of two default Pins, and an Overall with one Pin in it looked as founded as one built from four
sittings. The first answer, from a review of the project in November 2026, was to badge an
Overall that contained a Pin; that keeps a number the User did not earn on the screen and asks a
label to undo it, the option ADR 0010 already rejects for partial bands.

## Decision

- **Pins are retired.** No route or view model carries one, and no stored Pin is read.
- **Every section has a Target**: a band from 1 to 6 in half steps, 5.5 until the User sets one,
  stored under `target.<section>` and edited through `PUT /api/stats/settings`. A Target is a goal
  shown beside the section's band. It never stands in for a missing Band Estimate and never enters
  the Overall.
- **A section with no Band Estimate has no number.** The Dashboard says what to score next instead.
- **The Overall is the mean-then-round of four real Band Estimates** (`deriveOverall` in
  `server/src/routes/stats.ts`), absent until all four exist, and the summary names the sections
  still missing.
- Values an older version stored under `pin.*` keys are never read and are left in place. A
  `PUT /api/stats/settings` that still carries `pins`, from a tab running an older client, succeeds
  and writes nothing, so the User's Target edit beside it is not lost.

## Considered Options

- **Keep Pins and badge an Overall that contains one**: rejected. A labelled stand-in is still read
  as the number.
- **Turn each Pin into that section's Target**: rejected. A Pin was a guess at where the User stood,
  not where they were aiming, so carrying its value over would set a goal nobody chose.

## Consequences

A first run, and any history without a band in all four sections, shows no Overall. Someone without
the CLIs and keys that Writing and Speaking scoring needs never sees one, which is accurate: the app
cannot estimate those sections for them.

The Dashboard's suggested next step reads Targets: once every section has a band, it points at the
section furthest below its Target.

Pinned by `server/test/routes.stats.honesty.test.ts` (no Overall short of four estimates; a stored
Pin is never a section's value) and `server/test/routes.stats.test.ts` (Targets for all four
sections; stored `pin.*` values and a `pins` field in a request are ignored).
