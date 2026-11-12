# Contributing

Pull requests are welcome: bug fixes, new Sets, UI work, documentation. This page covers how to check
a change, where it goes, and what a review will ask for. The README covers running the app.

## Prerequisites

- Node.js at the version in `.nvmrc` (24), then `npm ci` at the repo root. `npm start`, `npm run dev`,
  `npm run demo` and `npm test` refuse to run under another major version, because the SQLite driver
  is a native module built for one (`scripts/check-node.mjs`).
- `ffmpeg` and `ffprobe` on your `PATH`. `server/test/transcode.test.ts` runs them for real.
- No API key and no Claude or Codex login. Both test suites are hermetic.

## Verify a change

```sh
npm test && npm run typecheck && npm run build -w client && npm run lint -w client
```

CI runs the same four steps on every push and pull request (`.github/workflows/ci.yml`).

- **`npm test`** runs the server suite, then the client suite, with Vitest.
  - The server suite never sees your environment. It scrubs every server setting and API key
    (`server/test/helpers/hermeticEnv.ts`), points the Claude and Codex binaries at a path that does
    not exist, and fails any test that makes an unmocked `fetch`. Each run works in its own
    directory under the OS temp dir, removed when it ends, and each test file gets its own copy of
    the committed bank there. It is built so that no test can reach a paid API or write to
    `data/`.
  - The client suite renders real components in jsdom. It is the only automated coverage of the
    browser side, so never skip it.
- **`npm run typecheck`** runs `tsc` over server, shared and client, client tests included.
- **`npm run build -w client`** is the production build.
- **`npm run lint -w client`** runs oxlint.

To run one file, use `npx vitest run test/<file>.test.ts` from `server/` or `client/`.

A change to recording, playback, drag-and-drop or timing also needs a pass through
[`docs/human-checklist.md`](../docs/human-checklist.md) in a real browser with a microphone. Say in
the pull request which sections you ran.

## Working with a coding agent

Much of this project was built with coding agents, and it is set up for one to work in.

- **Claude Code** reads [`CLAUDE.md`](../CLAUDE.md) on its own. **Codex and other agents** read
  [`AGENTS.md`](../AGENTS.md), which points to the same file. Nothing else needs configuring.
- `CLAUDE.md` holds the commands and the invariants, each with the test that pins it.
  [`CONTEXT.md`](../CONTEXT.md) holds the vocabulary, and [`docs/adr/`](../docs/adr/) the reasons
  behind decisions that are hard to reverse. An agent that reads those three before touching code
  rarely undoes something on purpose.
- **The agent can run the whole check loop by itself, with no keys.** Both suites are hermetic: a
  test cannot reach a paid API or write to `data/`. `npm run demo` gives it every screen filled with
  invented data, for UI work.
- **What it cannot check:** anything that needs a real microphone, speakers or drag-and-drop. That
  is [`docs/human-checklist.md`](../docs/human-checklist.md), and a person runs it.
- **Keep keys out of the chat.** `.env` stays on your machine; fill it in yourself. The scripts
  `scripts/calibrate-*.ts` and `scripts/smoke-*.ts` make paid calls, so an agent should run them
  only when you ask for exactly that.
- **`.claude/skills/toefl-*` is product code, not agent tooling.** Those skills are the prompts and
  rubrics the app's own Judges, Arbiter and generators run. Editing one changes scores or generated
  Sets (see "Larger changes").

A prompt that works as a starting point:

```text
Read CLAUDE.md, CONTEXT.md and .github/CONTRIBUTING.md first. I want to <describe the change>.
Find the invariant and the test that cover this area, and tell me your plan before editing. Make
the change with a test that fails without it, then run
`npm test && npm run typecheck && npm run build -w client && npm run lint -w client`
and show me the output. Do not read or print .env, and do not run anything under scripts/ that
makes a paid call.
```

`docs/agents/` configures optional issue-triage skills (where issues live, which labels mean what).
You only need it if you use an agent to triage issues.

## Where a change goes

Start with [`docs/architecture.md`](../docs/architecture.md) for the map.

| Change | Where |
|---|---|
| A field on a Set, a request or a response | `shared/src/schemas/<area>.ts` or `shared/src/viewModels.ts` first; server and client follow the type. `shared/src/schemas.ts` lists every public schema name, so a new one needs a line there |
| An API route | `server/src/routes/<area>.ts`, with persistence behind a store in `server/src/db/stores/` |
| A database table or column | a new last entry in `MIGRATIONS` (`server/src/db/migrations.ts`) and the same change in `server/src/db/schema.sql`, in one commit ([ADR 0016](../docs/adr/0016-versioned-migrations-with-backup.md)) |
| A setting | `server/src/lib/config.ts`, `.env.example`, and `server/test/helpers/hermeticEnv.ts` |
| Scoring or Band Estimates | `server/src/services/` (`judgeEnsemble.ts`, `bandEstimator.ts`, `sectionEstimates.ts`) |
| A generation check | the check in its section's generator, its tier in `generationCheckPolicy.ts` |
| A rubric, prompt guidance or generation guide | `.claude/skills/toefl-<section>/`; rubric text only in `references/` |
| A page or component | `client/src/pages/` or `client/src/components/`, built from `client/src/ui/` |
| Words for a status or code | `client/src/ui/labels.ts` |
| A new domain term | `CONTEXT.md` |
| A decision that is hard to reverse | a new ADR in `docs/adr/` |

## What a review checks

`CLAUDE.md` lists the invariants and the test that pins each one. Read it before changing scoring,
Sets, durability, the reasoning route or a run flow. Beyond those:

- **Use the domain vocabulary.** Set, Item, Attempt, Response, Stimulus, Judge, Arbiter, Score
  Report, Band Estimate, and the rest as defined in [`CONTEXT.md`](../CONTEXT.md), in code, tests,
  comments, UI copy and issues. Each entry lists the synonyms to avoid.
- **Shapes come from `shared/`.** The zod schemas and view models are the single source of truth.
  Derive a type from them; never declare a second copy of a shape on either side.
- **Comments say what and why, never history.** No issue numbers, review rounds or "this used to".
  History belongs in the commit message.
- **Tests go through a real seam and fail without the change.** Test a route through the app, a store
  over a real SQLite database (`server/test/helpers/sqliteStores.ts`, not a hand-written fake), a
  page by mounting the real component. Before you push, check that the new test fails with your
  change reverted.
- **Generation checks block only an unusable Set.** A check is fatal only when the Set would be
  unusable or would teach a wrong answer. Similarity and taste are advisory notes on the Set. Every
  tier the policy holds lives in `generationCheckPolicy.ts` and is pinned by
  `generationCheckPolicy.test.ts`; [ADR 0006](../docs/adr/0006-generation-check-policy.md) lists
  the few checks that still decide in their own stage.
- **A new top-level file or folder needs a deny-list line.** The server runs `claude -p` with the
  project root as its working directory and the `Read` tool, so it denies reading every top-level
  entry except `.claude/skills/` and `CLAUDE.md`. That keeps `.env` and the code's own grading
  thresholds out of the model's reach. Add a `Read(<name>)` or `Read(<dir>/**)` line to
  `CLI_PERMISSIONS_SETTINGS` in `server/src/services/claudeRunner.ts`; `claudeRunner.test.ts` fails
  until you do. The same goes for a new entry under `.claude/`.
- **UI goes through the design system.** Use the tokens and primitives in `client/src/ui/`, render
  every band through `BandFigure`, and follow the copy rules in
  [`docs/design-system.md`](../docs/design-system.md). `/design-preview` shows every primitive.
  `client/test/uiTokens.test.ts` fails on a raw palette class anywhere under `client/src`. Include
  before and after screenshots at phone and desktop width.
- **A published Set is never edited.** Past Attempts are reviewed against the file. Replace it and
  retire the old one ([ADR 0011](../docs/adr/0011-supersession-is-repo-data.md)). The one exception
  is an Explanation that names a different option than its Item's key: correct that text in place,
  and change nothing else in the file.

## Contributing Sets

The bank in `data/question-sets/` grows by contribution. A generated Set you would rate as good
practice is worth a pull request.

1. **Generate it** from the Dashboard.
2. **Only `"source": "generated"`.** Nothing transcribed or adapted from ETS or any other publisher,
   whatever its format.
3. **Commit exactly that Set's files:**
   - Reading or Writing: `data/question-sets/<section>/<setId>.json`.
   - Listening: the JSON and `data/audio/stimuli/<setId>/`.
   - Speaking: the JSON, `data/audio/stimuli/<setId>/` and `data/images/scenarios/<setId>.webp`.

   Add those paths by name rather than with `git add -A`. A Listening or Speaking render writes its
   audio into a tracked directory clip by clip, so a broad add during another render captures half
   of that render's Set.
4. **Check that it loads.** The Set appears on `/sets` with no "could not be loaded" notice
   (`GET /api/sets/unloadable` reports a count of 0). Its audio plays. Attempt at least one Item.
   Then run `npm test`; several suites read the whole bank.
5. **Commit the file as generated, `advisoryNotes` included.** Do not edit or remove a note, even
   one the app does not show: which kinds a learner sees is decided in the client
   (`advisoryNoteLines` in `client/src/ui/labels.ts`), and the rest stay in the file for whoever
   maintains the bank. If a note describes a Set you would not practise on, do not contribute that
   Set.

To replace a Speaking, Reading or Listening Set, pass `supersedesSetId` in the `POST /api/generate`
body. Once the replacement publishes, the server records the retirement in
`data/question-sets/supersessions.json`; commit that file with the new Set.

## Larger changes

- **Open an issue first** for anything bigger than a fix: a new feature, a scoring change, a new
  dependency. Agreeing on the shape before the code saves a rewrite.
- **Write an ADR** when a decision is hard to reverse, or when a later reader will ask why: a scoring
  rule, a data format, a provider route. Copy the structure of an existing one in `docs/adr/`
  (Status, Context, Decision, Considered Options, Consequences) and take the next number.
- **Changing scoring prompts or rubrics changes scores.** The calibration scripts,
  `scripts/calibrate-writing.ts` and `scripts/calibrate-speaking.ts`, compare scores with ETS's own
  on ETS's scored samples. Those samples are not in the repository, so the scripts run only for
  someone who holds them locally ([`docs/official-rubrics.md`](../docs/official-rubrics.md#for-maintainers-ets-material-the-scripts-use))
  and stop with a message otherwise. If you can, run them before and after and put the numbers in
  the pull request (both make paid calls); if you cannot, say the change is uncalibrated.

Issues are triaged with five labels, `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human` and `wontfix`. `docs/agents/` describes how coding agents read and update them.

## Security problems

Report a vulnerability privately, as [`SECURITY.md`](SECURITY.md) describes, not in a public issue.

## What will not be accepted

- **Content transcribed or adapted from ETS or other publishers**, including Sets, rubric text,
  sample responses and audio. ETS's official rubrics can be used locally
  ([`docs/official-rubrics.md`](../docs/official-rubrics.md)) but never committed.
- **Changes that send practice data anywhere.** That means telemetry, analytics, remote storage or
  accounts. Your Responses go to the model providers that score them and nowhere else.
