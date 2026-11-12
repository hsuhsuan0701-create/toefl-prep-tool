# Scoring rubrics: the shipped text and ETS's official text

Writing and Speaking Responses are scored against four rubrics, one per AI-scored Task Type, and
anchored by two files of scored examples. This page explains what ships with the app, how to use
ETS's own wording on your machine instead, and what changes when you do.

## What ships, and why

The four rubrics in this repository are this project's own description of the criteria ETS
publishes for the 2026 TOEFL iBT. Each keeps ETS's 0–5 scale, the dimensions ETS says the task
measures, and what a response does at each score level, including what separates each level from
its neighbours. The wording is ours.

| Task Type | Shipped rubric |
|---|---|
| Write an Email | `.claude/skills/toefl-writing/references/rubric-email.md` |
| Write for an Academic Discussion | `.claude/skills/toefl-writing/references/rubric-academic-discussion.md` |
| Listen and Repeat | `.claude/skills/toefl-speaking/references/rubric-listen-and-repeat.md` |
| Take an Interview | `.claude/skills/toefl-speaking/references/rubric-interview.md` |

The two `samples-scored.md` files beside them hold this project's own illustrations: invented
prompts and responses at several score levels, each explained against the rubric. They are not
ETS's samples.

ETS's scoring guides, its scored sample responses and its sample tasks are ETS's text. ETS licenses
that material and does not allow it to be republished on other sites. So the rubrics and scored
examples here are written from scratch, and the copies of ETS's scored samples and of its two
sample Sets that this project used to keep are no longer tracked. The scoring criteria themselves
are not protected; ETS's wording of them is.

## Using ETS's own text on your machine

You can score with ETS's official wording on your own computer. You get the text from ETS yourself
and put it in a folder git ignores, so it is never committed or shared.

The HTTP Judges, the Codex Arbiter and the Claude Arbiter all follow one rule: **for each file, if
`references/official/<same name>` exists, it is read instead of the shipped file.** Each file is
independent, so you can install one, some or all.

### 1. Get the document

ETS, *Updated TOEFL iBT® Test Overview* (2026), a public PDF:
<https://www.ets.org/pdfs/toefl/toefl-ibt-test-overview.pdf>

### 2. Copy each part into its file

Create the `official` folders, then copy from the PDF:

| Create this file | Copy from the overview |
|---|---|
| `.claude/skills/toefl-writing/references/official/rubric-email.md` | The Write an Email scoring guide, pp. 23–24. The task description on p. 14 is useful context to include above it. |
| `.claude/skills/toefl-writing/references/official/rubric-academic-discussion.md` | The Academic Discussion scoring guide, pp. 24–25 (task description p. 15). |
| `.claude/skills/toefl-speaking/references/official/rubric-listen-and-repeat.md` | The Listen and Repeat scoring guide, pp. 26–27 (task description p. 17). |
| `.claude/skills/toefl-speaking/references/official/rubric-interview.md` | The Take an Interview scoring guide, pp. 27–28 (task description p. 19). |
| `.claude/skills/toefl-writing/references/official/samples-scored.md` | *Optional.* The Writing sample prompts, responses and scoring comments, pp. 14–17. |
| `.claude/skills/toefl-speaking/references/official/samples-scored.md` | *Optional.* The Speaking sample prompts, response transcripts and scoring comments, pp. 17–20. |

In each rubric file, put every score level on **its own heading line**, with that level's text
underneath it until the next heading:

```markdown
# Write an Email — ETS scoring guide

### Score: 5

(paste the Score 5 block here)

### Score: 4

(paste the Score 4 block here)

…and so on down to

### Score: 0

(paste the Score 0 text here)
```

The check accepts `Score 5` or `Score: 5`, with or without `#` marks or bold, as long as nothing else
is on that line. In a sample file, keep the headings that name each Task Type (for example
"Write an Email" and "Write for an Academic Discussion").

Two things to avoid. Do not paste two guides into one file: each score level must appear once. And
do not put the words `AGGREGATE`, `partA` or `partB` under a `## ` heading that contains score
levels; sections that mention them are written for the Arbiter, so they are hidden from the Judges.

### 3. Check it

```sh
npm run rubrics:check
```

For each of the six files, this prints whether the shipped file or your official copy is read, then
checks every rubric for all six score levels (each with text under it) and for each dimension the
Judges score. It exits with an error if anything is missing. Run it after every paste: the app reads
an installed copy whether or not it is complete, so a bad paste would otherwise degrade scoring
without telling you.

The setup status (`GET /api/setup-status`, shown on the dashboard) reports `rubrics.source`:

- `"official"` when all four rubrics resolve to official copies that pass the check;
- `"rewritten"` in every other case: nothing installed, only some rubrics installed, or an
  installed copy that fails the check. In those last two cases the installed files are still
  read; `npm run rubrics:check` shows which.

A change takes effect on the next scoring call; you do not need to restart the server. To refresh
the Dashboard's Setup checklist, press its **Check again** button (`POST /api/setup-status/recheck`).

To go back to the shipped text, delete the files you added.

## What changes when you switch

The Judges and the Arbiter score against whichever text they are given. The shipped rubrics keep
ETS's levels and the distinctions between them, but they are different words, and models respond
to wording. Expect scores under the two versions to differ slightly; neither has been shown here
to match ETS's own scores better than the other.

One measurement exists for the shipped text. On 2026-11-12, `scripts/calibrate-writing.ts` scored
ETS's two officially scored Writing samples against the shipped rubrics, through the whole
pipeline (both Judges and the Arbiter). The email, scored 4 by ETS, came out 4 (the Judges gave 4.5
and 3.5); the discussion post, scored 5 by ETS, came out 5 (the Judges gave 5 and 4). That is one
run over two responses: it shows the shipped text is not far off at those two levels, and nothing
about the lower levels or about Speaking.

Each Band Estimate comes from one Attempt, but the trends on Progress and the range of recent
Simulations beside a band span many. If your history spans a switch, those mix scores produced
under both texts. To compare like with like, compare Attempts scored under the same text. A
Re-score uses whichever text is installed when it runs.

## For maintainers: ETS material the scripts use

Some scripts under `scripts/` measure the app against ETS's own officially scored samples or ETS's
sample tasks. That material is not in the repository either. Each script checks for what it needs
before making any model call, and stops with a message naming the missing files.

| Script | Needs, at these paths (all ignored by git) |
|---|---|
| `calibrate-writing.ts` | `server/test/fixtures/ets-samples/email-4-1.json` and `discussion-5-1.json`, and ETS's sample Writing Set `wri-703ea6d7` served by the running server (`data/question-sets/writing/wri-703ea6d7.json`) |
| `calibrate-speaking.ts` | Layer 1: ETS's sample Speaking Set `data/question-sets/speaking/spk-8d9ee619.json` (with its audio in `data/audio/stimuli/spk-8d9ee619/` and image `data/images/scenarios/spk-8d9ee619.webp`) and `ets-samples/listen_repeat-5-1.json` … `-7.json`. Layer 2: `ets-samples/interview-5-1.json` … `-4.json` |
| `smoke-judges.ts` | `ets-samples/email-4-1.json` |
| `smoke-speaking-judges.ts` | `data/question-sets/speaking/spk-8d9ee619.json` |
| `smoke-aggregate.ts` | the fixture named on its command line |

Each fixture is one scored sample as JSON: `taskType`, the task `materials`, the `responseText`,
ETS's `officialScore` and its `scoringComment`. These scripts call real providers and cost money; run
them deliberately. Both calibrations print which rubric source they score against. To calibrate the
shipped rubrics, move your `references/official/` folders aside first.

`scripts/check-rubric-originality.ts` is for anyone editing the shipped rubrics or samples. With
official copies installed, it reports for each shipped file the longest run of consecutive words it
shares with the official copy and the share of its six-word sequences that also appear there, and
fails above 8 words or 3%. It is a local tool, never run in CI, and with nothing installed it says
there is nothing to compare.
