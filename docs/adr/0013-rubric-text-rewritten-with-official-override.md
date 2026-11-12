# Rubric text ships rewritten, with an optional official override

## Status

Accepted. How to supply the official text is documented in
[`docs/official-rubrics.md`](../official-rubrics.md).

## Context

Both Judges and the Arbiter score against rubric text that lives in one place: the Markdown files
under `.claude/skills/*/references/`. `server/src/services/judges/prompts.ts` reads them into the
Judge prompts, and the Arbiter's skill reads the same files. Until now those files held ETS's
scoring guides transcribed verbatim from the *Updated TOEFL iBT Test Overview*.

ETS publishes that document free to read, but the text is ETS's. Shipping a copy in an MIT-licensed
repository would offer a license to text this project does not own. An open-source repository should
carry only text it can license.

## Decision

- **The tracked rubric files carry the scoring criteria in this project's own words.** They keep what
  scoring needs: the 0–5 scale, what separates each score point, the task facts, and the dimension
  names the Judge and Score Report schemas use. They are not a transcription.
- **A User may supply ETS's official text locally.** When present it is used in place of the
  rewritten text. It is never committed.
- Rubric text stays in `.claude/skills/*/references/` and nowhere else, so the Judges and the Arbiter
  can never score against two different rubrics. The official copy goes in `references/official/`
  under the shipped file's name. The HTTP Judges and the Codex Arbiter resolve it through
  `server/src/services/skillReferences.ts`; the Claude Arbiter follows the same rule from its
  skill's instructions.
- The same reasoning covers ETS's other material: its scored sample responses (the Calibration
  Samples) and its two sample Sets are no longer tracked. The scripts that use them read them from
  local, gitignored paths and stop with a message when they are absent.

## Considered Options

- **Keep the verbatim transcription**: rejected. It is not ours to license.
- **Ship no rubric and require the official text**: rejected. Scoring would not work from a fresh
  clone.
- **Fetch the official PDF at runtime**: rejected. It adds a network dependency to scoring and a
  parser for a document whose layout ETS can change.

## Consequences

Scores from a fresh clone are produced against a paraphrase. A paraphrase can drift from the official
criteria, so a change to a rubric file is a scoring change: re-run the calibration scripts
(`scripts/calibrate-writing.ts`, `scripts/calibrate-speaking.ts`) against the ETS Calibration Samples
before and after. Only a maintainer who holds those samples locally can, so a rubric change from
anyone else arrives uncalibrated and says so.

Scores produced with and without the official override are not strictly comparable. Every band is
an unofficial estimate either way.
