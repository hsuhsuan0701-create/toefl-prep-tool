# Demo data

A fresh clone can take Reading and Listening practice straight away, but the screens that show what
the app is for (Band Estimates against Targets, trends, a Score Report with its Deductions marked in
the Response, a spoken Item's word diff, a Full-Test Run report) need API keys and weeks of practice
before they show anything. The demo data set fills them: about three weeks of practice by one
invented User, written into a data directory of its own.

Use it to see the app before setting anything up, to work on a screen without practising your way
to the state it renders, and to take the screenshots in the README.

## Running it

```sh
npm run demo
```

This seeds a demo directory under your OS temp directory (`toefl-prep-tool-demo`), or reuses the one
an earlier run seeded, and starts the server and the client against it. Open the URL it prints,
`http://localhost:5190` by default.

| Option | Effect |
|---|---|
| `--reset` | Seed the directory again from scratch. |
| `--today <date>` | With `--reset` (or on the first run), date the history to lead up to this day, e.g. `2026-11-12`, instead of now. |
| `--dir <dir>` | Use another demo directory. |
| `--port <n>`, `--api-port <n>` | The client's and the server's ports (default 5190 and 8790). |

Pass options after `--`: `npm run demo -- --reset`. To write a demo directory without starting
anything, use `npm run demo:seed -- <dir>`, which takes `--today` and `--force` (replace a directory
it filled before).

The demo uses its own ports, so it runs beside your own instance on 5173 and 8787. Its server reads
no `.env` and gets no API keys and no Claude or Codex CLI, so it needs none, and nothing you do in it
can spend anyone's quota: a Re-score fails the way it does on a clone with no keys. Reading and
Listening Simulations and Drills work normally, against the demo's copy of the bank.

To look at demo data with your own keys and CLIs, for example to watch a Re-score run, start the dev
server on it yourself: `TOEFL_DATA_DIR=<demo dir> npm run dev`. That reads your `.env`, so it is a
real scoring call that writes its result into the demo directory.

### Resetting

`npm run demo -- --reset` replaces everything in the demo directory, including anything you did in
it. Deleting the directory has the same effect on the next `npm run demo`.

## It never touches your practice data

- The demo directory gets a copy of the **tracked** question bank only (`git ls-files data`): Sets,
  their stimulus audio and their scene images. Your `db.sqlite`, recordings and backups in `data/`
  are never read.
- The seeder refuses the repository's `data/` and anything inside it, with or without `--force`.
- It writes only into a new or empty directory, or one it filled before (it leaves a
  `.toefl-demo-data` file there). A directory that holds a database it did not create is refused even
  with `--force`, because that is most likely someone's real data.
- The demo server is pointed at the demo directory alone (`TOEFL_DATA_DIR`).

## What it contains

One User, stronger at Reading and Listening than at Writing and Speaking, improving unevenly over
three weeks. Against the Targets this User set (5.5 for Reading and Listening, 5 for Writing and
Speaking) the Dashboard shows Reading 5, Listening 5.5, Writing 4 and Speaking 4, an Overall of 4.5, and the
CEFR level beside each.

| Section | Drills | Simulations | Notes |
|---|---|---|---|
| Reading | 1 | 4 | Module Paths: one Lower, three Upper. The Drill is a Repeat of the first Simulation's Set, so one Reading Set is still new and a Reading Simulation you start counts toward the band. |
| Listening | 2 | 4 | One Lower, two Upper, and one left after routing (in the Full-Test Run in progress). One flagged for leaving the tab. |
| Writing | 3 | 4 | Build a Sentence, emails and discussion posts; one Drill left unfinished, one Drill with the email only. |
| Speaking | 3 | 3 | Listen and Repeat and Interview; one Drill is a Repeat of an earlier Set. |

There are two Full-Test Runs: one completed, with all four bands and an Overall, and one started the
evening before `today` and left at its Listening section.

Every judged Response has a Score Report with dimension notes, Deductions whose quotes occur in the
Response, a 繁體中文 summary and a Model Rewrite, and two Judge Reports that mostly agree. These
states each appear at least once:

| State | Where |
|---|---|
| Disagreement Flag (Judges 1.5 apart) | Writing Simulation, 9 days before `today`: the discussion post |
| Single-Judge Score Report | Writing Drill, 2 days before: the email |
| Self-Arbitrated Score Report | The completed Full-Test Run's Writing section: the email |
| Text Fallback (scored from the transcript) | Speaking Simulation, 14 days before: Question 3 |
| Recording with no speech, scored 0 | Speaking Simulation, 8 days before: Question 3 |
| Skipped Item, scored 0 | Speaking Simulation, 14 days before: Sentence 6 |
| Item whose scoring failed, so the Attempt has no band | Writing Simulation, 4 days before: the discussion post |
| Transcription that failed every retry, with Retry offered | Speaking Drill, 11 days before: Question 2 |
| Repeat | Speaking Drill, 3 days before, and Reading Drill, 7 days before |
| Attempt left unfinished | Writing Drill, 13 days before, and the in-progress Run's Listening section |
| Flagged for leaving the tab | Listening Simulation, 10 days before |

The essays, emails and spoken answers were written for this demo in the voice of an
upper-intermediate learner. None of it comes from ETS or from anyone's practice. Listen and Repeat
transcripts depart from their sentences the way such a learner's do (dropped articles and endings,
a swapped word, a long sentence that loses its second half), and their reports are derived from the
same word diff the review page draws.

### Recordings

The review page plays each spoken Response, so every recorded Item gets a short audio file: a quiet
tone with soft edges (four seconds for a sentence, forty for an answer) and silence for the
no-speech recording. They are synthesized with `ffmpeg` when it is on your `PATH`.

Without `ffmpeg` the seeder writes everything else exactly the same and skips the files. The review
page then shows each recording's player greyed out at 0:00 with nothing to play; the transcript,
Score Report and word diff are unaffected.

### Same input, same database

The history is a fixed script. Every random choice (which Reading and Listening Items are missed,
which wrong option is chosen, the ids) comes from a generator seeded by the name of its sitting, and
every date is a fixed offset from `today`, in your machine's time zone. Seeding twice with the same
`--today`, time zone and `ffmpeg` gives the same database, which is what keeps README screenshots
reproducible: `npm run demo -- --reset --today <date>`.

## How it is built, and how to add a state

The seeder is `scripts/seed-demo-data.ts` (`npm run demo:seed`) over `scripts/demo/`:

| File | Holds |
|---|---|
| `seed.ts` | The history, as a script in date order (`writeHistory`), and the code that writes each sitting. |
| `content/writing.ts`, `content/speaking.ts` | Everything a person wrote: Responses, scores, Deductions, summaries, Model Rewrites. |
| `reports.ts` | Turns that content into Score, Judge and Delivery Reports, checked against the shared schemas. |
| `target.ts`, `bank.ts`, `recordings.ts` | Where demo data may go, the bank copy, the audio files. |
| `run-demo.ts` | `npm run demo`. |

Rows are written through the same stores and services the app uses: `scoreDeterministicItems` and
`decidePath` for Reading and Listening, `scoreBuildSentence`, the transcription job's own write
sequence for each recording, the Speaking capture-finished and reconcile path, and
`recomputeSectionEstimate` for every Band Estimate. Only model output is authored. The one direct
SQL moves timestamps: the stores stamp rows with the wall clock, so each row is re-dated to its
place in the history right after it is written.

`server/test/demoData.test.ts` seeds a data directory and reads it back through the route handlers.
It checks the Dashboard summary, the Attempt list, every Attempt's review (each report against its
schema, each Deduction quote against its Response), each state in the table above, that a live
Reading Set is left unattempted so a Reading Simulation started in the demo is not a Repeat, that
every date is before `today`, that the server's boot recovery leaves the seeded database unchanged, and that
seeding twice gives the same rows. If a schema or a store changes in a way the demo no longer fits,
that test fails.

When you add a UI state that the demo should show:

1. Add a sitting to `writeHistory` in `seed.ts`, or change an existing one, at the date where it
   fits the story. Give it a new `label`: the label names its random stream and its ids, so the
   other sittings keep theirs.
2. Write any Responses it needs in `content/`, against that Set's own prompts, and pick a Set that
   has not been retired (`data/question-sets/supersessions.json`).
3. Write the state the way the app reaches it, through the stores and services. If you have to write
   a row directly, re-date its timestamps too.
4. Assert the state in `server/test/demoData.test.ts`, and add it to the table above.
5. Keep the seeded database a state the server leaves alone at boot: no queued or running job, and
   no Item left pending without a job. The boot-recovery test fails otherwise.
