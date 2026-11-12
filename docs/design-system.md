# Design system

How this app looks, and how to build a screen so it belongs to the same product as the others.
Tokens live in `client/src/index.css`. Primitives live in `client/src/ui/`. `/design-preview` shows
them in their states and, for the exam primitives, where they are used (`?view=exam-intro`,
`exam-reading`, `exam-listening`, `exam-speaking`). Two are not drawn there on their own: a live
`Dialog` looks like the `DialogPanel` that is, and `DeadlineClock` is the `ExamClock` that is, on a
timer. The planning pages are their own reference: the recipes below describe them as built.

## Direction

The app is a study instrument for one person preparing alone for a high-stakes exam. It should
feel like an exam booklet and a teacher's marked-up paper, not like a SaaS dashboard. The page is
warm paper and the text is blue-black ink. A pencil marks anything provisional: every band is an
estimate. Corrections are in red pen. "Mind this" is ochre and "done right" is library green.
Structure comes from ruled hairlines, not from shadows or tinted cards. There is one accent
colour, and it means "you can act here". Planning screens are dense and calm. Exam screens are a
quiet room: no navigation, nothing decorative, and colour only when the clock runs low.

Four decisions carry the look. Keep them on every page:

1. **Estimates are pencilled.** Every computed band or score has a dashed graphite rule under the
   number and the word *estimate* beside it, in small capitals. Targets are plain ink. Honesty is in
   the type, not in a warning banner.
2. **The band ruler.** A section's band sits on a 1–6 ruler with its Target. Under the ruler, a
   sentence states the distance ("1 band below your Target"), so the comparison never depends on
   reading the picture.
3. **The red pen.** In a Score Report, each Deduction's quote is underlined inside the User's own
   Response and numbered to match the Deduction list. Deductions use the `correction` role, which
   is a different role from `critical` (faults).
4. **Serif only for titles and figures.** Page titles and score figures use a system serif with
   lining figures (Charter, Sitka, Cambria). Everything else, including all prose, uses the system
   sans with an explicit Traditional Chinese face.

## Tokens

All tokens are defined in `@theme` in `client/src/index.css`, so each one is also a Tailwind
utility. Code uses only these names: `client/test/uiTokens.test.ts` reads every file under
`client/src` and fails the suite on a raw palette step (`bg-blue-600`, `text-gray-500`,
`bg-white`), a default size (`text-sm`) or a hex colour in a class.

### Colour roles

| Token | Utilities | Use for | Never for |
|---|---|---|---|
| `paper` | `bg-paper` | The page background (set on `body`). Row hover. | Cards. |
| `sheet` | `bg-sheet` | A card or list laid on the page (`Card`, `List`). | Nesting inside another sheet. |
| `well` | `bg-well` | Recessed areas: the User's Response, a quote, skeletons, segmented-control track, meter tracks. | Primary content blocks. |
| `field` | `bg-field` | Text inputs, answer options, picker cards. | Static content. |
| `rule` | `border-rule`, `divide-rule` | Every hairline: card borders, row dividers, header rules. | Controls. |
| `rule-strong` | `border-rule-strong` | Outlines of things you press or type in; ruler ticks. | Decoration. |
| `ink` | `text-ink`, `bg-ink` | Primary text, figures, the Target bar. | |
| `ink-soft` | `text-ink-soft` | Secondary text: descriptions, Issue text, secondary rows. | Text that must be read first. |
| `graphite` | `text-graphite` | Meta (dates, counts), labels (`Kicker`), helper lines. | Body copy. Meets AA on paper. |
| `faint` | `text-faint` | Disabled text, ids that are deliberately recessive, decorative glyphs. | Anything a User must read (fails AA). |
| `accent`, `accent-strong`, `accent-wash`, `accent-rule`, `on-accent` | `bg-accent text-on-accent`, `text-accent`, `bg-accent-wash` | The one accent: primary buttons, links, the current nav item, selected options, the recording indicator. | Status. Decoration. Headings. |
| `focus` | via the global `:focus-visible` outline | The focus ring. Set globally; do not restyle it. | |
| `positive` (+`-wash`, `-rule`) | `text-positive`, `bg-positive-wash` | Correct answers, completed, the "Fix" label, Ready, a microphone that works. | Score direction (up/down arrows stay ink). |
| `caution` (+`-wash`, `-rule`) | `text-caution`, `bg-caution-wash` | Things that change how to read a result but are not faults: Unfinished, routed to the Lower Module, Reduced model independence, a skipped Item, a Repeat, audio that would not play, the clock under 5 minutes. | Errors. |
| `correction` (+`-wash`, `-rule`) | `text-correction`, `decoration-correction` | Pedagogy: Deduction marks and numbers, a wrong pick, "Incorrect". | System faults. |
| `critical` (+`-wash`, `-rule`, `on-critical`) | `bg-critical`, `text-critical` | Faults and destruction: scoring failed, a request that failed, the Leave and Discard buttons inside their dialogs, the clock under 1 minute. | Deductions or wrong answers (use `correction`). |
| `estimate` (+`-rule`) | `text-estimate`, `decoration-estimate-rule` | The pencil: the *estimate* word and the dashed rule under estimated figures. | Anything that is not an estimate. |
| `highlight` | `bg-highlight` | A word or phrase a question points to inside a Stimulus (vocabulary questions). | Emphasis in UI copy. |

Status is never shown by colour alone. Every status chip has words and a glyph, every Notice has an
icon and a screen-reader tone word, a result mark says Correct, Incorrect or No Response, and the
clock states its threshold in words.

### Type

Families. Every font is a system font. The app is offline and loads nothing.

- `font-sans` (the default, also applied to `html`): the platform UI face for Latin, then
  **PingFang TC → Hiragino Sans CNS → Microsoft JhengHei → Noto Sans TC / CJK TC → Source Han
  Sans TC** for Han characters. This order means Chinese text never falls back to a Simplified or
  Japanese face.
- `font-serif`: Charter → Sitka → Cambria → Iowan → Noto Serif, then Songti TC / Noto Serif TC.
  Use it **only** for the page title (`PageHeader`, an exam intro's title), the brand in the top
  nav, band and score figures, and the step numbers of the first-run "Start here" list. Every face
  listed draws lining figures.
- `font-mono`: identifiers only (Set ids, `linear-v2`, env var names, inside `InternalName`).
  Never use it for numbers a User compares. One exception: a Complete the Words passage is set in
  mono throughout (the words, each gap's visible prefix and the letters typed into it). A gap shows
  its length before anything is typed, so every letter must take the same width: the box is
  `length` ch wide and holds exactly that many letters, each over its own slot mark. The whole
  passage shares the face so no word is set in two. Its Explanations, under the passage, are not.

Scale. Each step is named by its job. Line-heights are built into each step.

| Token | Size | Use |
|---|---|---|
| `text-caption` | 12 | Chips, ruler numerals, footnotes under a stat, a Set id. |
| `text-meta` | 13 | Dates, counts, helper lines, Disclosure bodies, row meta. |
| `text-ui` | 14 | Buttons, nav, Notice bodies, Issue/Fix lines, dialog bodies. |
| `text-body` | 15 | Default running text on planning screens; row titles; exam facts. |
| `text-prose` | 16 / 1.75 | Long reading on review screens: Responses, Model Rewrites, Summaries (1.85 for Chinese via `Prose`). |
| `text-stimulus` | 17 / 1.7 | Exam Stimuli, question stems, a Complete the Words gap. |
| `text-heading` | 18 | Section headings (`SectionHeader` h2), dialog titles, an exam status screen's heading. |
| `text-title` | 28, serif | The page title. One per page. |
| `text-clock` | 22 | The exam clock and the response window's seconds. |
| `text-figure-sm` / `text-figure` / `text-figure-lg` | 22 / 40 / 56, serif | Bands and scores in rows / cards / the Overall. |

Weight: 400 for text, 500 for row titles and labels, 600 for headings and figures. Do not use 700.
Use the `figures` utility (lining, tabular numerals) on any number that is compared down a column
or that ticks: clocks, percentages, counts in progress bars. The primitives already apply it.

### Bilingual typesetting

The UI is English. Feedback prose, Explanations (錯題解析) and Score Report summaries are
繁體中文, and they often quote English.

- Wrap every block of Chinese in `<Prose lang="zh-Hant">`. The `lang` attribute selects
  Traditional glyph forms. It also turns on the `:lang(zh-Hant)` rules in `index.css`
  (`line-break: strict`, `text-autospace` for CJK/Latin spacing, `text-spacing-trim`, no italic,
  no tracking, no uppercase) and the right screen-reader voice. Mixed text that is mostly Chinese
  is `zh-Hant`.
- Chinese gets taller leading (1.85) and the same measure as English (`max-w-measure`, about 40
  Han characters per line). Do not justify.
- Never set Chinese in italic, small caps, uppercase or letter-spaced labels. `Kicker` is
  English-only.
- Short English quotes inside Chinese keep their straight quotes or 「」 as the source has them.
  Do not convert them.
- The one piece of Chinese in the interface itself is the Drill Lab's technique name, 倒序堆疊, as
  a subtitle beside its English title.

### Space, measure, radii, depth, motion

- **Unit:** Tailwind's 4 px step. Use this rhythm:
  - 48 px between page sections (`space-y-12`).
  - 16 px between a section header and its content (`space-y-4`).
  - 16–20 px card padding (`Card padding="md"`). 28 px for a featured card (`lg`).
  - Rows use `px-4 py-3`.
- **Gutter:** `px-gutter` is the page's side margin: 16 px on a phone, 32 px from 640 px up.
  Planning pages are `max-w-page` (64 rem). Reading columns are `max-w-measure` (42 rem): exam
  intros, status screens and Speaking Items use it. Exam screens are `max-w-exam` (76 rem, two
  columns on a laptop).
- **Radii:** `rounded-chip` (3 px) for chips and tiny marks, `rounded-control` (5 px) for buttons,
  inputs and options, `rounded-sheet` (8 px) for cards and lists. Round things are only the
  numbered markers, step circles, speaker silhouettes and the recording dot.
- **Depth:** borders only. The single shadow, `shadow-overlay`, is for dialogs. Do not use it on
  cards.
- **Focus:** a 2 px `focus` outline with a 2 px offset on every `:focus-visible`, set globally. Do
  not remove outlines. Hit targets are at least 40 px with a mouse and 44 px on touch: buttons,
  options and nav items grow under `pointer-coarse:`.
- **Motion:** `duration-(--duration-quick)` (120 ms) for hover and colour changes,
  `duration-(--duration-calm)` (220 ms) for size changes, easing `ease-quiet`. Nothing bounces.
  The only things that move on their own are the audio pulse, the recording ring and the spinner
  beside a word. With `prefers-reduced-motion`, all animation and transition is switched off.
- **Width:** every screen works at 390 px with no horizontal scroll. A control row that does not
  fit wraps (`SegmentedControl` wraps inside its track); it never hides an option off-screen.

### Dark theme

Dark is a token swap, not a second set of classes. `[data-theme="dark"]` in `index.css`
reassigns the same `--color-*` names, and every client file is on tokens, so shipping it is one
attribute on `<html>` (plus `prefers-color-scheme` if wanted). It is not shipped: no one has
reviewed every screen in it yet. Never write `dark:` variants. If a role looks wrong in dark, fix
its value in the dark block. The preview shows a dark sample under "Dark theme".

## Primitives

Import from `client/src/ui/<File>`. Each file opens with a comment saying when to use it.

### Page structure

| Primitive | File | Use it for | Not for |
|---|---|---|---|
| `PageShell` | `PageShell.tsx` | Every planning and reading page: Practice, Progress, Sets, Drill Lab, Attempt review, a Full-Test Run. Renders `AppNav`, a skip link and the `max-w-page` column (`width="measure"` for a single reading column). `nav={false}` only for a Full-Test Run between sections. | Exam screens. |
| `TopNav` | `TopNav.tsx` | Rendered by `components/AppNav`, which owns the four links. Pages never render `TopNav` directly. | |
| `PageHeader` | `Heading.tsx` | The top of a page: serif title, an optional one-line lede, a back link in `kicker`, facts in `meta`, and actions (at most one primary). | |
| `SectionHeader` | `Heading.tsx` | Opening a page section (h2) or a block inside a card (`as="h3"`), with an optional description and a trailing action. | |
| `Kicker` | `Heading.tsx` | Small-capital English labels: "Overall", "Reading Drill", "Question 3 of 5". | Chinese. Sentences. |
| `Card`, `Divider` | `Card.tsx` | `sheet`: a unit of content. `well`: recessed text such as a Response. `plain`: an outline inside a sheet. | Sheet inside sheet. |
| `List`, `SetRow`, `AttemptRow` | `ListRow.tsx` | Ruled lists. A `SetRow` leads with the Set's title, then its summary, source, date and the id in small mono; its advisory notes sit behind a toggle as sentences (`noteLines`). An `AttemptRow` is named "{Section} {Mode}", then the Set title and when, with the band or the status on the right. The whole row is the link; row buttons sit above it. | Tables of numbers. |
| `EmptyState` | `EmptyState.tsx` | A space with nothing in it yet. It says what will fill it and, if there is one, gives the next step. | Errors, loading. |
| `Skeleton` | `Skeleton.tsx` | The shape of content on its way. Put `aria-busy` on the region. | Failures. |

### Actions and choices

| Primitive | File | Use it for | Not for |
|---|---|---|---|
| `Button` | `Button.tsx` | Actions. `primary` is the most likely next step, one per view. `secondary` is any other action. `quiet` is for frequent or low-stakes actions ("Edit", "Discard…", "Exit"). `destructive` appears **only inside a dialog**. `loading` keeps it focusable and busy. | Navigation. |
| `ButtonLink` | `Button.tsx` | Navigation that should look like an action: "Start Simulation", "View report". | |
| `TextLink` | `Button.tsx` | Inline and secondary links: "See all 33 Writing Sets", "← Progress". Always underlined. | |
| `ConfirmDialog` (`DialogPanel`) | `ConfirmDialog.tsx` | Asking before something hard to undo or that changes scoring: Discard, "Finish and score", Submit Module, revealing a Drill Lab sentence. Built on native `<dialog>`; the confirm label is a verb. Destructive dialogs focus Cancel first. `DialogPanel` is its static body, for the preview. | Information. |
| `Dialog` | `Dialog.tsx` | A task that needs a form: Generate Sets. Closes on Escape and on its own buttons. | A yes/no question (use `ConfirmDialog`). |
| `SegmentedControl` | `Segmented.tsx` | One choice from a few, applied immediately (the trend range). A radio group with arrow keys; wraps on a narrow screen. | Switching content panels. |
| `Tabs` | `Segmented.tsx` | Panels where one shows at a time: the Sets page's sections. | Page navigation. |
| `Disclosure`, `InternalName` | `Disclosure.tsx` | Secondary detail: how a band is estimated (with `linear-v2` in `InternalName`), the Arbiter's reconciliation, Judge detail, the server's own failure text. | Anything the User needs first. |
| `BandSelect` | `BandSelect.tsx` | Choosing a band on the 1–6 half-step grid: a Target. | Free numbers. |
| `InlineEdit` | `InlineEdit.tsx` | A value edited where it is shown, behind a quiet "Edit": a section's Target on Practice. | Anything with more than one field. |
| `EssayField`, `WordCount` | `EssayEditor.tsx` | Writing an essay (`TimedEditor`): the field, and the word count against the Task's guide in words ("53 short of 80–120"). `wordCount.ts` holds the counting. | Short inputs. |

### Figures, status and progress

| Primitive | File | Use it for | Not for |
|---|---|---|---|
| `BandFigure` | `BandFigure.tsx` | **Every band.** It renders the number, "/6", the CEFR level via `CefrLevelNote`, and the kind: `estimate` (pencilled) or `target`. With `band={null}` it shows "No band yet" (or `emptyLabel`) plus `missing`, which says what stands in the way in the User's terms. `tag={false}` hides *target* when a visible label already says it. The *estimate* word cannot be hidden. | Item scores (use `ScoreFigure`). |
| `ScoreFigure` | `BandFigure.tsx` | An Item's final 0–5 score from its Score Report, pencilled. | Bands. Accuracy Task Types (show Correct/Incorrect or a percent). |
| `BandScale` | `BandFigure.tsx` | The 1–6 ruler: the estimate's caret, the Target bar, and a sentence stating the gap. No CEFR on the ruler. | |
| `StatTile`, `Sparkline` | `StatTile.tsx` | A measured number with its direction (Progress trend tiles). Direction is an arrow plus words, in ink. In `Sparkline`, Drill points are hollow circles and Simulation points are filled squares. | Bands. |
| `Chip`, `StatusChip` | `Chip.tsx` | Small printed labels. `StatusChip` takes a presentation from `labels.ts` and never a raw code. | Buttons or filters. |
| `Notice` | `Notice.tsx` | Inline callouts. `info` is context. `caution` changes how to read a result. `critical` means something failed or will be lost. `positive` sparingly ("Your microphone works"). Set `live` only for notices that appear after an action. | Page-wide banners for estimates (the pencil does that). |
| `ProgressBar` | `Progress.tsx` | A count you can name ("9 of 13 clips", "Recordings sent"). | Unknown durations. |
| `StepProgress` | `Progress.tsx` | Checkpoints of a long job (scoring: Judges → Arbiter → Score Report; generation: Plan → Write → Check → Audio). Each step has words, and the current step is announced once. | |

### Text

| Primitive | File | Use it for | Not for |
|---|---|---|---|
| `Prose` | `Prose.tsx` | Any text longer than a sentence or two. It sets `lang`, size (`body`/`prose`/`stimulus`) and measure, and keeps line breaks with `preserveLines`. | |
| `MarkedText` | `Prose.tsx` | A Response with its Deduction quotes marked and numbered (`markQuotes.ts` does the forgiving match and reports unmatched quotes). `components/ScoreCard`'s `ScoreReport` uses it; use that for a whole Score Report. | |

### Exam screens

| Primitive | File | Use it for | Not for |
|---|---|---|---|
| `ExamShell` | `ExamShell.tsx` | Every Drill, Simulation and Full-Test section screen. A header with the Section, a second line (the mode on an intro, where you are in a run), the clock and the exit; a progress hairline with words; the stage; and a sticky footer for Back/Next/Submit. | Anything with navigation. |
| `ExamExit` | `ExamShell.tsx` | The screen's one way out, in `ExamShell`'s `exit` slot. It only navigates: once an Attempt exists, the page's leave guard asks in LeaveGuardHost's dialog. `asks` sets the label: "Exit…" where it will ask, "Exit" where nothing has started. | |
| `ExamClock`, `DeadlineClock` | `ExamShell.tsx` | The exam clock: tabular figures, ochre under 5 minutes and red under 1, saying so in words. `DeadlineClock` drives it from a wall-clock deadline through `hooks/useDeadlineCountdown`, the app's one exam countdown. | A Speaking response window (`ResponseClock`). |
| `ExamIntro`, `ExamSetLine` | `ExamIntro.tsx` | The screen before an Attempt starts: kicker, the Set's title, its origin (`ExamSetLine`), notices, a list of facts (Time, Items, Moving around, Feedback, Leaving), and the start button. | Status screens mid-run. |
| `QuestionNavigator` | `QuestionNavigator.tsx` | Moving between a Reading Module's questions: one stop per screen, answered / partly / not yet in a glyph and words. | Speaking or Listening, which run in order. |
| `ExamSplit`, `PassagePane` | `PassagePane.tsx` | A reading exam screen's two panes: the text on the left, the question on the right from `lg`; stacked on a phone. | |
| `ChoiceList` | `ChoiceList.tsx` | Multiple-choice options, exam style: full-width rows with A–D over real radios. `reveal` is for feedback and review only. | Inside the Listening leak gate before the audio ends. The gate decides when this renders; this component does not. |
| `GapInput` | `GapInput.tsx` | One Complete the Words gap, inline in the Stimulus's own type size, in mono, one 1ch slot mark per missing letter. `components/CtwGapInput` moves between gaps and sets the passage in mono. | |
| `AudioStage`, `SpeakerFigure`, `AudioStatus` | `AudioStage.tsx` | A Listening Stimulus: who is speaking and where, carrying no Item content. `AudioStatus` is where any play-once clip has got ("Listen…", "Playback finished.", "Couldn't play the audio."); `components/StimulusPlayer` draws it for every clip in the app. | Anything answerable. |
| `RecordingIndicator`, `LevelMeter`, `ResponseClock` | `Recording.tsx` | Recording in the accent with the word "Recording" and a pulsing ring (never a red dot); the microphone level in words; the response window draining with its seconds. | |

### Words and numbers

| Module | Use it for |
|---|---|
| `labels.ts` | **The one place raw codes become words**: Attempt, Full-Test Run, Item scoring, scoring, transcription and generation job statuses, Set practice state, Set source, Section, mode, Module and Module Path, Band Estimate methods, Deduction categories, score cautions, setup checks, and a Set's advisory notes (`advisoryNoteLines`, which also leaves out the kinds a learner cannot act on). A table for a code `shared` defines (the Attempt, Full-Test Run and job statuses, Section, mode, Module Path) is keyed by that union, so a new value fails `tsc` until it has words. Item scoring status, estimate methods, Deduction categories, advisory notes, speech-rate roles and Set source are looked up by string, and an unknown code falls back to readable words. Task Type names come from `lib/taskTypes.ts`. |
| `format.ts` | `formatWhen` ("Today, 6:14 PM", "Sep 2, 6:14 PM"), `formatWhenRange`, `formatDay`, `formatDuration` ("7 min", never "420s"), `formatClock`, `formatPercent` (rounded down: only a perfect score reads 100%), `formatBand` ("5", never "5.0"), `coverageText` ("Complete the Words · 30 Items (2 skipped)"), `targetGapText`. |
| `lib/requestError.ts` | `requestErrorMessage`: **the one place a failed request becomes a sentence.** A 404 is a stale link, a refusal gives the server's short reason, no answer asks whether the server is running. Never print an HTTP body. |
| Icons (`icons.tsx`) | The inline glyphs. Decorative by default. `StatusGlyph` maps a `labels.ts` glyph name to a shape. No icon package. |

### Shared run components

Not primitives, but each is the one implementation of its job; reuse it rather than drawing a
second one.

- `components/StimulusQuestions.tsx`: where a Reading or Listening Stimulus's Items become DOM, in
  both modes. `ListeningStimulusQuestions` is the leak gate: nothing answerable exists before the
  audio ends.
- `components/StimulusReplay.tsx`: a Listening Stimulus played again, a labelled `<audio controls>`
  with its transcript in a `Disclosure` where it has one. Only once nothing is left to answer: a
  Drill's checked Stimulus, a completed Attempt's review.
- `components/ItemRecorder.tsx`: one Speaking Item, prompt to beep to recording to countdown, with
  the retry gate when a prompt will not play. `MicCheck.tsx` is the check before a Speaking run.
- `components/TimedEditor.tsx` and `components/buildSentence/`: the essay Tasks and Build a
  Sentence, each drawing its own `ExamShell` from the `chrome` its page passes.
- `components/ScoreCard.tsx`: a Score Report (`ScoreReport`) and its caution chips and notes.
- `components/LeaveGuardHost.tsx`: the one "Leave …?" dialog every running Drill and Simulation
  asks through.
- `pages/drill/DrillScreens.tsx` and `pages/simulation/SimulationScreens.tsx`: the Drill picker and
  intro, and the full-screen loading, error and status screens.

## Composing pages

Recipes, as the pages are built.

- **Practice** (`/`, `pages/Dashboard.tsx`):
  - `PageShell` → `PageHeader` (title "Practice", a one-line lede on estimates, secondary "Generate
    Sets", which opens a `Dialog`).
  - A first run (no Attempts) leads with a "Start here" card (Reading first, since it needs no
    keys) and the Setup list expanded: one row per piece with a `StatusChip` (Ready / Missing /
    Optional), what it does and what to do, env names in mono. There is no Overall figure.
  - Otherwise a featured `Card padding="lg"`: the Overall `BandFigure size="lg"` (or what stands in
    the way) beside "Suggested next", the page's one primary action, picked by
    `pages/dashboard/suggestNext.ts`: the first section with no band, else the one furthest below
    its Target, else a Full-Test Run; never a run this machine cannot score.
  - "Sections" in test order (Reading, Listening, Writing, Speaking): each a `Card` with a `Kicker`,
    `BandFigure`, a source line, a `BandScale`, and the Target as an `InlineEdit` over a
    `BandSelect`. One `Disclosure` below explains every method.
  - "Next up": per section a `SectionHeader` ("Writing Sets", "33 Sets · 15 new", "Start
    Simulation") over a `List` of up to three new `SetRow`s, and "See all 33 Writing Sets", which
    opens that section's tab of the Set bank. Two columns from `lg`.
  - "Full-Test Run" and "Recent Attempts" (the last five, "See all" to Progress), then Setup,
    collapsed.
- **Progress** (`/progress`): `PageHeader`; "Trends" with a `SegmentedControl` for the range and
  `StatTile`s grouped per section (the axis per Task Type through `lib/taskTypeScale`; a tile opens
  its full chart); "Weakness breakdown" (Deductions by category, and Reading and Listening skills as
  bars on a `well` track with the count in words); "Judge agreement"; "All Attempts" as a `List` of
  `AttemptRow`s with "Load more".
- **Sets** (`/sets`): `PageHeader`, then `Tabs` per section (the open one in `?section=`), each a
  `SectionHeader` with "Hide attempted" and "Start Simulation" over a `List` of `SetRow`s **with**
  state chips (New / Started / Attempted). Sets that failed to load are reported above.
- **Drill Lab** (`/drill-lab`): `PageShell` (it is not an Attempt, so it keeps the navigation);
  title "Backward buildup" with 倒序堆疊 as its subtitle; a caution `Notice` that the page shows
  sentences in full; "Practice queue" (the ten worst sentences first, "Show all"), each named by
  its Set and its place in it ("Sentence 6"); "Every sentence", one row per Set, opening to its
  numbered sentences, asking before revealing an unattempted Set's.
- **Attempt review** (`/attempts/:id`):
  - `PageShell` → `PageHeader` with kicker `TextLink` back to Progress, title "{Section} {Mode}",
    meta (Set title, time range, `StatusChip`, Repeat and Flagged chips, the Set id).
  - A band `Card`: `BandFigure` and the method's plain label with `coverageText` lines and a
    `Disclosure` holding the internal name; or "No band yet" / "No band" with the reasons in counts
    ("3 Interview Items failed scoring.") and what to do here, promising a band only where this
    page can close the gap.
  - "Items, in test order" links, then one section per Task Type (or Module) with a
    `SectionHeader` giving its tally. What belongs to the group is said once there: the Listen
    and Repeat scene, and the one Re-score that sends every Item of the Task Type that needs one
    ("Re-score 3 Items"). Each card keeps its own reason.
  - A judged Item is a `Card as="article"`: header (Kicker "Item n of N", its name, chips,
    `ScoreFigure`), then the task, the recording, `ScoringOutcome` when it has no Score Report, and
    the `ScoreReport`: Summary (`Prose lang="zh-Hant"`), Your Response in red pen beside the Model
    Rewrite, numbered Deductions, By dimension, and Disclosures for the Arbiter and the Judges.
  - Reading and Listening Items group by Stimulus, each row with its `ResultMark` (Correct /
    Incorrect / No Response) and the key and Explanation behind it. Once the Attempt is complete,
    a Reading Stimulus's own text sits under its heading (`review/ReviewStimulus`): a Complete the
    Words passage in full, in mono, each gap numbered by its Item and filled with what was typed,
    marked, with the correct word beside a wrong or empty one; a Read in Daily Life text or an
    Academic passage in a `Disclosure` ("The text", "The passage") that starts open, set as
    `PassagePane`. A
    Listening Stimulus can be played again from under its heading (`StimulusReplay`), a Listen and
    Choose a Response from its own opened row, never as text. An opened question lists its options
    (`ChoiceList`, locked) with the Response and the key marked.
- **Full-Test Run** (`/full-test/:runId`): `PageShell` without navigation while sitting;
  `PageHeader` "Full-Test Run" with its time and status; once finished, the Overall `BandFigure
  size="lg"` (method in a `Disclosure`) or which sections are still pending, never an average of
  fewer than four; then "Sections, in test order", a `Card` per section with its band or what
  stands in its way and its next step.
- **Exam screens** (Drills, Simulations, Full-Test sections; `?view=exam-*` in the preview):
  - `ExamShell`: `section` is the Section ("Writing"); `part` is "Drill", "Simulation" or
    "Full-Test Run" on an intro and where you are in a run ("Router Module · Complete the Words",
    "Drill · Build a Sentence · Task 1 of 3"); `ExamExit`; the clock where the section is timed;
    the progress hairline; the footer.
  - An intro is `ExamIntro`: kicker "{Section} {Mode}" over the Set's title, or "Full-Test Run ·
    Section n of 4" over "{Section} section"; the Set's origin; any Repeat notice; the facts; the
    start button "Start {Section} {Mode}". A Drill opens on its picker (`DrillPickerScreen`, the
    same heading over a card per Task Type) and its intro (`DrillIntroScreen`). Speaking checks the
    microphone first ("Check your microphone"), then shows a short intro with "Your microphone
    works" and the start button.
  - Stimulus in `Prose size="stimulus"` or `PassagePane`; questions as `Kicker` + stem in
    `text-stimulus` + `ChoiceList`; two columns from `lg` with a hairline between them; stacked on a
    phone.
  - Mid-run status (a Module being scored, the Module Path, wrapping up, a send that failed) is
    `SimulationStatus` inside the shell. A Drill's results screen is kicker "{Section} Drill" over
    "Results", and its finish button is the way out.
  - No chips, no estimate language, no colour except the clock and results.

## Copy

Say what the User needs first, in CONTEXT.md's words. Put internal names second, behind a
Disclosure.

- **Domain terms are capitalised and exact:** Set, Item, Attempt, Drill, Simulation, Full-Test
  Run, Response, Stimulus, Task Type names as in `lib/taskTypes.ts`, Router/Lower/Upper Module,
  Module Path, Judge, Arbiter, Score Report, Deduction, Model Rewrite, Band Estimate, Target,
  Repeat, Explanation. Never write "test", "exam" (except for the real exam), "question bank",
  "session", "submission", "grader", "Final Verdict" or "Full Test" unqualified.
- **UI labels use sentence case** ("Start Simulation" capitalises Simulation only because it is a
  domain term).
- **Naming a Set:** use its title from the listing (`SetListEntryVM.title`), derived from its
  content, never its id. With no title, "{Section} Set · {formatDay(createdAt)}"
  (`fallbackSetTitle`). The id goes in small mono after the source and date.
- **Naming an Attempt:** "{Section} {Mode}" ("Writing Simulation"), then the Set title and
  `formatWhen`. Never show a UUID. Its link carries the id.
- **Naming an Item in a list:** by its place ("Sentence 6", "Question 2", "Item 3 of 11"), never by
  its id.
- **Starting and leaving:** the button that creates an Attempt is "Start {Section} {Mode}"
  ("Start Reading Drill", "Start Writing Simulation"). The exit is "Exit" where nothing has started
  and "Exit…" where it will ask. A leave message opens with its question, which titles the dialog
  ("Leave this Drill? …", "Leave the Speaking section? …"); its buttons are "Leave" and "Stay".
- **Statuses:** only through `labels.ts`. `in_progress` → "Unfinished", `aborted` → "Discarded",
  Full-Test `in-progress` → "In progress", item `failed` → "Scoring failed". Add a row to the
  table; never `status.replace(/_/g, " ")` in a page.
- **Results:** "Correct", "Incorrect" or "No Response", with a glyph; the right answer is "Key:"
  ("Key (any of these):" when several are accepted).
- **Methods:** lead with the plain label ("Weighted average of your scored Items"). The internal
  name (`linear-v2`, `table3-v1`, `mean-of-sections-v1`) goes inside a Disclosure in
  `InternalName`, after the one-sentence detail.
- **Numbers:**
  - Bands are "5" or "5.5" with "/6" and the CEFR level, always via `BandFigure`.
  - Item scores are "4 / 5".
  - Accuracy is a whole percent, rounded down: never 100% short of perfect.
  - Durations use words ("7 min", "1 h 14 min"); a clock reads "6:50".
  - Coverage is "Complete the Words · 30 Items (2 skipped)", never `complete_words ×30`.
  - Raw values like "raw 0.80" belong only in a Disclosure.
- **Dates:** `formatWhen` for a moment, `formatWhenRange` for an Attempt's span, `formatDay` for a
  Set's creation. Timestamps arrive as ISO-8601 from the server; client code never converts them.
- **Estimates:** the pencil marks every estimate. Do not also write "unofficial estimate" on every
  card. Say it once per page in the lede ("Every band here is an unofficial estimate…") and let
  `BandFigure` carry it everywhere else. Never write a CEFR level by itself.
- **Missing bands** say what stands in the way in the User's terms: "Score an Email and an
  Academic Discussion", "3 Interview Items failed scoring". Never "insufficient coverage".
- **Failures** are one sentence from `requestErrorMessage`, under a title that says what did not
  happen ("This Attempt could not be loaded."). The server's own words, when shown at all, go in a
  Disclosure.
- **Buttons are verbs naming the act:** "Finish and score", "Discard", "Re-score 3 Items". Never
  "OK", "Yes" or "Submit" alone, and never an ampersand. A button that opens a confirmation ends in
  an ellipsis ("Discard…", "Submit Module…").
- **Confirmations state the consequence concretely:** "3 of 12 Items have no Response. As on the
  test, they will score 0". "This cannot be undone" only when it is true.
- **Language:** the UI is English. Feedback, Explanations and coaching are 繁體中文 in `Prose
  lang="zh-Hant"`. Do not put the same fact in both languages side by side. Directions on exam
  screens are this app's own words, not ETS's.

## Do not

- Do not use Tailwind palette steps (`blue-600`, `gray-500`, `white`) or default sizes (`text-sm`).
  Use roles. The suite fails if you do.
- Do not use colour as the only signal. Pair it with words, a glyph or a shape.
- Do not use shadows on cards, gradients, tinted section backgrounds, or a second accent colour.
- Do not nest a `sheet` card inside a `sheet` card.
- Do not set anything in serif except titles and figures, and nothing in mono except identifiers
  and a Complete the Words passage.
- Do not put Chinese in italic, small caps, uppercase or tracked type. Do not leave Chinese without
  `lang="zh-Hant"`.
- Do not show a band without `BandFigure`, a CEFR level outside it, or an unpencilled estimate.
- Do not show an Overall band unless all four sections have one.
- Do not put navigation, decoration, estimates or chips on exam screens. Do not render an answer
  control before the Listening gate allows it.
- Do not draw a second exit dialog, a second countdown or a second intro layout on an exam screen:
  use `ExamExit` with the leave guard, `useDeadlineCountdown` and `ExamIntro`.
- Do not make a `destructive` button outside a dialog, and do not discard without one.
- Do not use spinners without words, or percentages you cannot measure.
- Do not print an HTTP status or body to the User.
- Do not add an icon package, a web font or any network asset.

## Still open

- **Dark theme** is defined but not shipped (see above).
- **A failed Interview Item shows no question.** The served Set withholds Interview questions, and
  review reads them from the Score Report, which a failed Item does not have. Showing them needs
  the review route to carry the question text.
- **Back from review always goes to Progress**, wherever the User came from (Practice, a Full-Test
  Run). The page has no record of where it was opened from.
- **Task Type names mix two registers.** `lib/taskTypes.ts` uses ETS's names where they are verbs
  ("Write an Email", "Listen to a Conversation") and CONTEXT.md's elsewhere ("Academic Discussion",
  "Interview"). One register needs an owner decision; the trend tiles already use short names.
