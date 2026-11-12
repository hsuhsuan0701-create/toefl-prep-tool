import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ScoreReport, type ScoreReportItem } from "../components/ScoreCard";
import { AudioStage, AudioStatus, SpeakerFigure } from "../ui/AudioStage";
import { BandFigure, BandScale, ScoreFigure } from "../ui/BandFigure";
import { BandSelect } from "../ui/BandSelect";
import { Button, ButtonLink, TextLink } from "../ui/Button";
import { Card, Divider } from "../ui/Card";
import { Chip, StatusChip } from "../ui/Chip";
import { ChoiceList } from "../ui/ChoiceList";
import { ConfirmDialog, DialogPanel } from "../ui/ConfirmDialog";
import { cx } from "../ui/cx";
import { Disclosure, InternalName } from "../ui/Disclosure";
import { EmptyState } from "../ui/EmptyState";
import { EssayField, WordCount } from "../ui/EssayEditor";
import { ExamIntro, ExamSetLine } from "../ui/ExamIntro";
import { ExamClock, ExamExit, ExamShell } from "../ui/ExamShell";
import { formatDay, formatPercent, formatWhen } from "../ui/format";
import { GapInput } from "../ui/GapInput";
import { Kicker, PageHeader, SectionHeader } from "../ui/Heading";
import { IconArrowLeft, IconArrowRight, IconRepeat } from "../ui/icons";
import {
  ATTEMPT_STATUS,
  ESTIMATE_METHOD,
  FULL_TEST_RUN_STATUS,
  GENERATION_BATCH_STATUS,
  ITEM_SCORING_STATUS,
  SET_PRACTICE_STATE,
  TRANSCRIPTION_JOB_STATUS,
  type StatusPresentation,
} from "../ui/labels";
import { InlineEdit } from "../ui/InlineEdit";
import { AttemptRow, List, SetRow } from "../ui/ListRow";
import { Notice } from "../ui/Notice";
import { PageShell } from "../ui/PageShell";
import { ExamSplit, PassagePane } from "../ui/PassagePane";
import { ProgressBar, StepProgress } from "../ui/Progress";
import { Prose } from "../ui/Prose";
import { QuestionNavigator, type NavigatorStop } from "../ui/QuestionNavigator";
import { LevelMeter, RecordingIndicator, ResponseClock } from "../ui/Recording";
import { SegmentedControl, Tabs } from "../ui/Segmented";
import { Skeleton } from "../ui/Skeleton";
import { Sparkline, StatTile } from "../ui/StatTile";
import { countWords } from "../ui/wordCount";

// /design-preview: the design system on one route (docs/design-system.md). Every primitive in its
// states (?view=primitives, the default), then the exam primitives where they are used: an intro, a
// Reading Module question, a Listening Stimulus and a Speaking Item (?view=exam-intro, exam-reading,
// exam-listening, exam-speaking). Planning pages are not mocked here: the pages themselves are their
// reference, and a copy of one would drift from it. Nothing here calls the API, runs a clock, plays
// audio or records. The sample data is invented; no real User's Responses.

type View = "primitives" | "exam-intro" | "exam-reading" | "exam-listening" | "exam-speaking";
const VIEWS: { id: View; label: string }[] = [
  { id: "primitives", label: "Primitives" },
  { id: "exam-intro", label: "Exam intro" },
  { id: "exam-reading", label: "Reading question" },
  { id: "exam-listening", label: "Listening Stimulus" },
  { id: "exam-speaking", label: "Speaking Item" },
];

// A fixed "now" so relative dates in the sample data never drift.
const NOW = new Date(2026, 10, 12, 20, 30);
const at = (daysAgo: number, hour: number, minute: number) => new Date(2026, 10, 12 - daysAgo, hour, minute).toISOString();
const when = (iso: string) => formatWhen(iso, NOW);
const day = (iso: string) => formatDay(iso, NOW);

export default function DesignPreview() {
  const [params] = useSearchParams();
  const requested = params.get("view") as View | null;
  const view: View = VIEWS.some((v) => v.id === requested) ? (requested as View) : "primitives";

  // An exam screen is a whole page with no navigation, so the bar sits above its shell.
  return (
    <>
      <PreviewBar current={view} />
      {view === "primitives" && <PrimitivesView />}
      {view === "exam-intro" && <ExamIntroView />}
      {view === "exam-reading" && <ExamReadingView />}
      {view === "exam-listening" && <ExamListeningView />}
      {view === "exam-speaking" && <ExamSpeakingView />}
    </>
  );
}

function PreviewBar({ current }: { current: View }) {
  return (
    <div className="border-b border-rule bg-well">
      <div className="mx-auto flex max-w-page flex-wrap items-center gap-x-4 gap-y-1 px-gutter py-2 text-meta">
        <span className="font-semibold text-graphite">Design preview</span>
        <nav aria-label="Preview views" className="flex flex-wrap gap-x-3 gap-y-1">
          {VIEWS.map((v) => (
            <Link
              key={v.id}
              to={`?view=${v.id}`}
              aria-current={v.id === current ? "page" : undefined}
              className={cx("rounded-chip", v.id === current ? "font-semibold text-ink" : "text-accent underline decoration-accent-rule underline-offset-2")}
            >
              {v.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}

function Gallery({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <SectionHeader title={title} description={description} />
      {children}
    </section>
  );
}

function Swatch({ token, role }: { token: string; role: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="h-9 w-9 shrink-0 rounded-control border border-rule" style={{ background: `var(--color-${token})` }} />
      <div className="min-w-0">
        <p className="font-mono text-caption text-ink">{token}</p>
        <p className="text-meta text-graphite">{role}</p>
      </div>
    </div>
  );
}

const SWATCHES: { group: string; items: [string, string][] }[] = [
  {
    group: "Surfaces and rules",
    items: [
      ["paper", "The page"],
      ["sheet", "A card laid on the page"],
      ["well", "Recessed: Responses, quotes"],
      ["field", "Inputs and answer options"],
      ["rule", "Hairline separators"],
      ["rule-strong", "Outlines of controls"],
    ],
  },
  {
    group: "Ink",
    items: [
      ["ink", "Primary text, figures"],
      ["ink-soft", "Secondary text"],
      ["graphite", "Meta, labels; the pencil"],
      ["faint", "Disabled, decorative only"],
      ["accent", "Actions, links, current place"],
      ["accent-wash", "Selected background"],
    ],
  },
  {
    group: "Meaning",
    items: [
      ["positive", "Correct, completed"],
      ["caution", "Read with care; time low"],
      ["correction", "A Deduction, a wrong answer"],
      ["critical", "A fault; destructive acts"],
      ["estimate", "Every estimated figure"],
      ["highlight", "A phrase pointed to in a Stimulus"],
    ],
  },
];

const TYPE_SPECIMENS: { token: string; className: string; sample: ReactNode; lang?: "zh-Hant" }[] = [
  { token: "title · serif", className: "font-serif text-title font-semibold", sample: "Writing Simulation" },
  { token: "heading", className: "text-heading font-semibold", sample: "Recent Attempts" },
  { token: "body", className: "text-body", sample: "Sets you have not attempted yet, three per section." },
  { token: "ui", className: "text-ui", sample: "Start Simulation · Finish and score · Discard" },
  { token: "meta", className: "text-meta text-graphite", sample: "Generated · Nov 9 · Router, Lower and Upper Modules" },
  { token: "caption", className: "text-caption text-graphite", sample: "LAST 20 ATTEMPTS · n = 36" },
  {
    token: "prose · zh-Hant",
    className: "text-prose leading-[1.85]",
    lang: "zh-Hant",
    sample: "主要扣分在用字的精準度：「request to fix this issue」讀起來像是你要自己修，後半句又換了主詞，兩個請求失去平行結構。",
  },
  {
    token: "stimulus",
    className: "text-stimulus",
    sample: "Salmon lay their eggs in the beds of cold, fast-moving streams, but not just anywhere.",
  },
  { token: "figure · serif", className: "font-serif figures text-figure font-semibold", sample: "4.5  5.5  6  0.86  12:04" },
  { token: "clock", className: "figures text-clock font-semibold", sample: "12:04  4:59  0:58" },
];

function PrimitivesView() {
  const [range, setRange] = useState<"10" | "20" | "all">("20");
  const [choice, setChoice] = useState<string | null>("b");
  const [target, setTarget] = useState(5.5);
  const [essay, setEssay] = useState("Dear Ms. Rivera,\n\nI am writing about the reimbursement for last month's conference.");
  return (
    <PageShell>
      <PageHeader
        title="Design system"
        lede="Tokens and primitives for the planning pages and the exam screens, each in its states. The exam primitives are also shown where they are used, under the views above."
        meta={
          <>
            <span>client/src/index.css</span>
            <span aria-hidden="true">·</span>
            <span>client/src/ui/</span>
            <span aria-hidden="true">·</span>
            <span>docs/design-system.md</span>
          </>
        }
      />

      <div className="space-y-14">
        <Gallery title="Colour roles" description="Named by what they mean. Pages never use Tailwind's palette steps (blue-600) directly.">
          <div className="grid gap-6 md:grid-cols-3">
            {SWATCHES.map((g) => (
              <Card key={g.group} className="space-y-3">
                <Kicker as="h3">{g.group}</Kicker>
                {g.items.map(([token, role]) => (
                  <Swatch key={token} token={token} role={role} />
                ))}
              </Card>
            ))}
          </div>
        </Gallery>

        <Gallery title="Type" description="System fonts only. Sans for everything you read; serif only for page titles and score figures.">
          <Card padding="none">
            <ul className="divide-y divide-rule">
              {TYPE_SPECIMENS.map((s) => (
                <li key={s.token} className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-baseline sm:gap-4">
                  <span className="font-mono text-caption text-graphite">{s.token}</span>
                  <span lang={s.lang} className={cx("min-w-0 text-ink", s.className)}>
                    {s.sample}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </Gallery>

        <Gallery title="Buttons and links" description="One primary per view. Destructive appears only inside a confirmation.">
          <Card className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary">Start Simulation</Button>
              <Button variant="secondary">Generate Sets</Button>
              <Button variant="quiet">Edit</Button>
              <Button variant="destructive">Discard</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" loading>
                Submitting
              </Button>
              <Button variant="secondary" loading>
                Re-scoring
              </Button>
              <Button variant="primary" disabled>
                Next
              </Button>
              <Button variant="secondary" disabled>
                Finish and score
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" size="sm">
                Finish and score
              </Button>
              <Button variant="quiet" size="sm">
                Discard…
              </Button>
              <ButtonLink to="?view=exam-intro" variant="secondary" size="sm" iconEnd={<IconArrowRight size={14} />}>
                Start Simulation
              </ButtonLink>
              <span className="text-ui text-ink-soft">
                Inline: <TextLink to="?view=primitives">See all 33 Writing Sets</TextLink>
              </span>
            </div>
          </Card>
        </Gallery>

        <Gallery title="Status chips" description="Every raw status goes through ui/labels.ts. Words and a glyph, never colour alone.">
          <Card className="space-y-4">
            <ChipRow label="Attempt" items={Object.values(ATTEMPT_STATUS)} />
            <ChipRow label="Item scoring" items={Object.values(ITEM_SCORING_STATUS)} />
            <ChipRow label="Set" items={Object.values(SET_PRACTICE_STATE)} />
            <ChipRow label="Full-Test Run" items={Object.values(FULL_TEST_RUN_STATUS)} />
            <ChipRow label="Transcription" items={Object.values(TRANSCRIPTION_JOB_STATUS).slice(0, 5)} />
            <ChipRow label="Generation" items={Object.values(GENERATION_BATCH_STATUS).slice(1, 5)} />
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-28 text-meta text-graphite">Tags</span>
              <Chip>Grammar</Chip>
              <Chip>Vocabulary</Chip>
              <Chip>
                <IconRepeat size={12} />
                Repeat
              </Chip>
              <Chip tone="caution" glyph="caution">
                Disagreement
              </Chip>
            </div>
          </Card>
        </Gallery>

        <Gallery
          title="Bands"
          description="A band is always a BandFigure: the number, /6, its CEFR level (through CefrLevelNote) and what kind of number it is. Estimates are pencilled: a dashed rule and the word."
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="space-y-5">
              <BandFigure band={5.5} size="lg" />
              <BandFigure band={4.5} />
              <div className="flex flex-wrap gap-x-8 gap-y-3">
                <BandFigure band={5.5} kind="target" size="sm" />
                <BandFigure band={6} size="sm" />
              </div>
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <ScoreFigure score={4} />
                <ScoreFigure score={3} size="sm" />
              </div>
            </Card>
            <Card className="space-y-5">
              <BandFigure band={null} missing="Score an Email and an Academic Discussion — every weighted Task Type needs one scored Item." />
              <BandScale label="Speaking" band={4.5} target={5.5} />
              <BandScale label="Writing" band={5.5} target={5.5} />
              <BandScale label="Listening" band={5.5} target={5} />
            </Card>
          </div>
        </Gallery>

        <Gallery title="Stat tiles" description="A measured number and its direction. Drill points are hollow circles, Simulation points filled squares.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile
              label="Interview"
              value="4.0 / 5"
              delta={{ direction: "up", text: "from 3.25 / 5" }}
              footnote="Last 8 Attempts"
              sparkline={<Sparkline min={0} max={5} label="Interview, last 8 Attempts, from 3.25 to 4.0" points={spark([3.25, 3.5, 3.0, 3.5, 3.75, 3.5, 4.0, 4.0], [1, 4, 7])} />}
            />
            <StatTile
              label="Listen and Repeat"
              value="3.1 / 5"
              delta={{ direction: "down", text: "from 3.3 / 5" }}
              footnote="Last 10 Attempts"
              sparkline={<Sparkline min={0} max={5} label="Listen and Repeat, last 10 Attempts" points={spark([3.4, 3.1, 3.3, 2.9, 3.2, 3.3, 3.0, 3.2, 3.3, 3.1], [2, 5, 9])} />}
            />
            <StatTile
              label="Complete the Words"
              value={formatPercent(0.97)}
              delta={{ direction: "up", text: "from 80%" }}
              footnote="Last 6 Attempts"
              sparkline={<Sparkline min={0} max={1} label="Complete the Words accuracy" points={spark([0.8, 0.86, 0.9, 0.93, 0.9, 0.97], [3, 5])} />}
            />
          </div>
        </Gallery>

        <Gallery title="Rows" description="A Set is named by its title; an Attempt by what it was. Ids are secondary; UUIDs never appear.">
          <div className="space-y-4">
            <List label="Sets">
              <SetRow
                title="How Gravel Beds Shelter Young Salmon"
                setId="rd-170e6bf3"
                to="?view=exam-intro"
                state="new"
                source="generated"
                created={day(at(3, 9, 0))}
                summary="Freshwater ecology · Router, Lower and Upper Modules"
                noteLines={[
                  "One Academic Passage reads easier or harder than the real exam's for its Module.",
                  "The right answer is often the longest option, which makes guessing easier than on the real exam.",
                ]}
                action={<ButtonLink to="?view=exam-intro" variant="quiet" size="sm">Drill</ButtonLink>}
              />
              <SetRow
                title="Ad-free plan still shows ads"
                setId="wri-03fd69a4"
                to="?view=primitives"
                state="started"
                source="generated"
                created={day(at(5, 9, 0))}
                summary="Email · Academic Discussion: Urban Planning · 10 Build a Sentence Items"
              />
              <SetRow
                title="At the Campus Library"
                setId="spk-0c4f9a21"
                to="?view=primitives"
                state="attempted"
                source="ets-sample"
                created="Jul 27"
                summary="Listen and Repeat · 7 sentences · Interview · 4 questions"
              />
            </List>
            <AttemptList />
          </div>
        </Gallery>

        <Gallery title="Empty, notices, progress" description="Empty is a dashed blank that says what will fill it. Notices carry an icon and a hidden tone word.">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <EmptyState title="No Attempts yet" action={<ButtonLink to="?view=exam-intro" variant="secondary" size="sm">Start a Reading Simulation</ButtonLink>}>
                Your Attempts appear here as soon as you start one.
              </EmptyState>
              <Notice tone="info" title="Feedback comes at the end">
                A Simulation keeps every score and Explanation until the whole section is submitted, as on the test.
              </Notice>
              <Notice tone="caution" title="Routed to the Lower Module">
                Your Router Module score was under 60%, so the second Module was the easier one. That caps this band at 4.5. The 60% line is this app's assumption, not ETS policy.
              </Notice>
              <Notice tone="critical" title="Scoring failed for this Item" action={<Button variant="secondary" size="sm">Re-score</Button>}>
                Both Judges timed out. Nothing was scored, and this Item is left out of the band until it is.
              </Notice>
              <Notice tone="positive" title="Target saved">Listening is now measured against 5.5.</Notice>
            </div>
            <Card className="space-y-6">
              <StepProgress
                label="Scoring your Email"
                steps={[
                  { key: "judges", label: "Judges", state: "done", detail: "Both scored" },
                  { key: "arbiter", label: "Arbiter", state: "active", detail: "Reconciling — about a minute" },
                  { key: "save", label: "Score Report", state: "pending" },
                ]}
              />
              <Divider />
              <StepProgress
                label="Generating a Listening Set"
                steps={[
                  { key: "plan", label: "Plan", state: "done" },
                  { key: "write", label: "Write", state: "done" },
                  { key: "check", label: "Check", state: "failed", detail: "Verifier rejected it; retrying" },
                  { key: "audio", label: "Audio", state: "pending" },
                ]}
              />
              <Divider />
              <ProgressBar label="Rendering audio" value={9} max={13} valueText="9 of 13 clips" />
            </Card>
          </div>
        </Gallery>

        <Gallery title="Confirmation" description="Asks before what cannot be undone or changes what gets scored. Live dialogs use the native <dialog>; these panels are shown in place.">
          <div className="grid gap-4 md:grid-cols-2">
            <DialogPanel
              className="max-w-none"
              title="Finish and score this Drill?"
              actions={
                <>
                  <Button>Keep working</Button>
                  <Button variant="primary">Finish and score</Button>
                </>
              }
            >
              <p>3 of 12 Items have no Response. As on the test, they will score 0 and count toward this Attempt.</p>
            </DialogPanel>
            <DialogPanel
              className="max-w-none"
              title="Discard this Attempt?"
              actions={
                <>
                  <Button>Cancel</Button>
                  <Button variant="destructive">Discard</Button>
                </>
              }
            >
              <p>Its Responses and recordings are deleted and it counts toward nothing. This cannot be undone.</p>
            </DialogPanel>
          </div>
        </Gallery>

        <Gallery title="Choosing and disclosing" description="Segmented control for a setting applied at once; tabs for panels; disclosure for detail you may want second.">
          <Card className="space-y-6">
            <SegmentedControl
              label="Trend range"
              value={range}
              onChange={setRange}
              options={[
                { value: "10", label: "Last 10" },
                { value: "20", label: "Last 20" },
                { value: "all", label: "All time" },
              ]}
            />
            <Tabs
              label="Response and rewrite"
              items={[
                { id: "response", label: "Your Response", panel: <Prose size="body">I would like to kindly request to fix this issue, or I should receive a refund.</Prose> },
                { id: "rewrite", label: "Model Rewrite", panel: <Prose size="body">Could you either fix this problem or refund this month's payment?</Prose> },
              ]}
            />
            <Disclosure summary="How this band is estimated">
              <p>{ESTIMATE_METHOD["linear-v2"].detail}</p>
              <p className="mt-1">
                Method: <InternalName>linear-v2</InternalName>
              </p>
            </Disclosure>
            <div aria-busy="true" className="grid gap-4 sm:grid-cols-[6rem_minmax(0,1fr)]">
              <Skeleton shape="block" className="h-12 w-24" />
              <Skeleton lines={3} />
            </div>
          </Card>
        </Gallery>

        <Gallery title="Exam controls" description="The clock turns ochre, then red, and says so in words. Options are full-width rows over real radio inputs.">
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="flex flex-wrap content-center items-center gap-x-8 gap-y-5">
              <ExamClock secondsLeft={724} />
              <ExamClock secondsLeft={281} />
              <ExamClock secondsLeft={42} />
            </Card>
            <Card className="space-y-4">
              <ChoiceList
                label="Closest in meaning to scour"
                value={choice}
                onChange={setChoice}
                choices={[
                  { id: "a", label: "flood" },
                  { id: "b", label: "strip away" },
                ]}
              />
              <ChoiceList
                label="Reviewed question"
                value="a"
                reveal={{ correctId: "b" }}
                disabled
                choices={[
                  { id: "a", label: "warm up" },
                  { id: "b", label: "strip away" },
                ]}
              />
            </Card>
          </div>
        </Gallery>

        <Gallery title="Forms" description="A band is chosen from the half-step grid; a value is edited in place; an essay is written in a field with its word count beside the guide.">
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="space-y-5">
              <BandSelect label="Speaking Target" value={target} onChange={setTarget} />
              <InlineEdit
                label="Writing Target"
                value={target}
                onSave={async (next) => setTarget(next)}
                display={
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-meta text-graphite">Target</span>
                    <BandFigure band={target} kind="target" size="sm" tag={false} />
                  </span>
                }
                field={(draft, setDraft) => <BandSelect label="Writing Target" hideLabel value={draft} onChange={setDraft} />}
              />
            </Card>
            <Card className="space-y-3">
              <EssayField value={essay} onChange={setEssay} aria-label="Your email" placeholder="Write your email here." className="min-h-32" />
              <WordCount count={countWords(essay)} guide={{ min: 80, max: 120 }} />
            </Card>
          </div>
        </Gallery>

        <Gallery title="The red pen" description="A Score Report as Attempt review draws it (components/ScoreCard): each Deduction's quote marked in the Response and numbered to the list, beside the Model Rewrite.">
          <Card>
            <ScoreReport item={SAMPLE_REPORT} judges={[]} responseText={RESPONSE} />
          </Card>
        </Gallery>

        <Gallery title="Dark theme" description="Not shipped. The same role names re-inked under data-theme=&quot;dark&quot; — a token swap, no dark: variants.">
          <div data-theme="dark" className="grid gap-4 rounded-sheet p-4 sm:p-6 md:grid-cols-2">
            <Card className="space-y-4">
              <Kicker as="h3">Speaking</Kicker>
              <BandFigure band={4.5} />
              <BandScale label="Speaking" band={4.5} target={5.5} />
              <div className="flex flex-wrap gap-2">
                <Button variant="primary">Start Simulation</Button>
                <Button>Generate Sets</Button>
              </div>
            </Card>
            <div className="space-y-3">
              <Notice tone="caution" title="Reduced model independence">
                One model wrote a Judge Report and also arbitrated. The score still counts.
              </Notice>
              <Prose lang="zh-Hant" size="body">
                這封信三個要點都有交代，語氣也符合寫給客服的禮貌程度。
              </Prose>
              <div className="flex flex-wrap gap-2">
                <StatusChip status={ATTEMPT_STATUS.completed} />
                <StatusChip status={ATTEMPT_STATUS.in_progress} />
                <StatusChip status={ITEM_SCORING_STATUS.failed} />
              </div>
            </div>
          </div>
        </Gallery>
      </div>
    </PageShell>
  );
}

function ChipRow({ label, items }: { label: string; items: StatusPresentation[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-28 text-meta text-graphite">{label}</span>
      {items.map((s) => (
        <StatusChip key={s.label} status={s} />
      ))}
    </div>
  );
}

/** Builds sparkline points; indices in `sims` are Simulation Attempts, the rest Drills. */
function spark(values: number[], sims: number[]) {
  return values.map((value, i) => ({ value, mode: sims.includes(i) ? ("simulation" as const) : ("drill" as const) }));
}

// The sample Attempt rows and the sample Score Report the primitives view draws.

function AttemptList() {
  const [confirm, setConfirm] = useState<null | "finish" | "discard">(null);
  return (
    <>
      <List label="Recent Attempts">
        <AttemptRow
          section="writing"
          mode="simulation"
          setTitle="Ad-free plan still shows ads"
          when={when(at(0, 18, 14))}
          to="?view=primitives"
          status="completed"
          band={5}
        />
        <AttemptRow
          section="writing"
          mode="drill"
          setTitle="Request to move a lab session"
          when={when(at(1, 21, 3))}
          to="?view=primitives"
          status="in_progress"
          actions={
            <>
              <Button size="sm" onClick={() => setConfirm("finish")}>
                Finish and score
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setConfirm("discard")}>
                Discard…
              </Button>
            </>
          }
        />
        <AttemptRow
          section="speaking"
          mode="simulation"
          setTitle="Orientation at the Science Museum"
          when={when(at(2, 20, 50))}
          to="?view=primitives"
          status="completed"
          band={4.5}
          flagged
        />
        <AttemptRow
          section="listening"
          mode="drill"
          setTitle="Neuroscience Talk"
          when={when(at(4, 16, 59))}
          to="?view=primitives"
          status="completed"
          repeat
          summary="8 of 9 correct · no band from a Drill"
        />
        <AttemptRow
          section="reading"
          mode="simulation"
          setTitle="Why Sunlight Fades Outdoor Murals"
          when={when(at(18, 16, 41))}
          to="?view=primitives"
          status="completed"
          band={6}
          modulePath="upper"
        />
      </List>
      <ConfirmDialog
        open={confirm === "finish"}
        title="Finish and score this Drill?"
        confirmLabel="Finish and score"
        cancelLabel="Keep working"
        onConfirm={() => setConfirm(null)}
        onCancel={() => setConfirm(null)}
      >
        <p>3 of 12 Items have no Response. As on the test, they will score 0 and count toward this Attempt.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "discard"}
        title="Discard this Attempt?"
        confirmLabel="Discard"
        tone="destructive"
        onConfirm={() => setConfirm(null)}
        onCancel={() => setConfirm(null)}
      >
        <p>Its Responses and recordings are deleted and it counts toward nothing. This cannot be undone.</p>
      </ConfirmDialog>
    </>
  );
}

/* Sample Response for the red-pen gallery: invented text, no real User's writing. */
const RESPONSE = `Dear Customer Support,

I am writing about my subscription. Last week I upgraded to the ad-free plan, but the advertisement still plays in every episode I downloaded for offline listening. I have checked that my account shows an active plan and the payment was successful. I also deleted the episodes and downloaded them again, but nothing changed.

I would like to kindly request to fix this issue, or I should receive a refund for this month. Could you also let me know when the problem is solved?

Thank you for your help.

Best regards,
Lin`;

const REWRITE = `Dear Customer Support,

I am writing about my subscription. Last week I upgraded to the ad-free plan, but ads still play in every episode I download for offline listening. I have confirmed that my account shows the plan as active and that the payment went through. I have also deleted and re-downloaded the episodes, with no change.

Could you either fix this problem or refund this month's payment? I would also appreciate it if you could let me know once the issue has been resolved.

Thank you for your help.

Best regards,
Lin`;

const DEDUCTIONS = [
  {
    id: 1,
    category: "grammar",
    quote: "the advertisement still plays",
    issue: "The singular “the advertisement” points to one specific ad, but the ads recur in every episode.",
    fix: "ads still play",
  },
  {
    id: 2,
    category: "register",
    quote: "I would like to kindly request to fix this issue, or I should receive a refund",
    issue: "“Request to fix” reads as asking permission to fix it yourself, and the sentence switches subject halfway, so the two requests are no longer parallel.",
    fix: "Could you either fix this problem or refund this month's payment?",
  },
  {
    id: 3,
    category: "vocab",
    quote: "when the problem is solved",
    issue: "Understandable, but a support case is “resolved”; “once” fits a request better than “when”.",
    fix: "once the issue has been resolved",
  },
];

const SAMPLE_REPORT: ScoreReportItem = {
  itemId: "em-1",
  ownScore: 4,
  finalScore: 4,
  maxScore: 5,
  feedbackZh:
    "這封信三個要點都有交代，語氣也符合寫給客服的禮貌程度。主要扣分在用字的精準度：「request to fix this issue」讀起來像是你要自己修，後半句又換了主詞，兩個請求失去平行結構。把請求句改成「Could you either … or …?」的句型，就能往 5 分靠近。",
  modelRewrite: REWRITE,
  reconciliationNote: "Both Judges gave 4; the Arbiter agrees: the requests are clear but not consistently idiomatic.",
  deductions: DEDUCTIONS.map(({ quote, issue, fix, category }) => ({ quote, issue, fix, category })),
  dimensions: [
    { name: "Communicative goal", note: "All three points are covered, with a greeting and sign-off suited to customer support." },
    { name: "Language use", note: "Mostly accurate, but appropriate rather than consistently idiomatic." },
  ],
};

// The exam views: the exam primitives where they are used. Static: nothing here runs a clock, plays
// audio or records, and every Exit goes back to the primitives.

const PASSAGE = `Salmon lay their eggs in the beds of cold, fast-moving streams, but not just anywhere. A female salmon searches for a stretch of loose gravel, then uses her tail to dig a shallow pit called a redd. The choice matters because the eggs will spend the winter buried there, and only a narrow range of conditions keeps them alive.

The most important of these conditions is the flow of water through the gravel itself. Eggs need a steady supply of oxygen, and they produce waste that must be carried away. When fine sediment from eroded banks fills the spaces between the stones, the flow slows, oxygen drops, and many eggs suffocate.

Floods present the opposite danger. A powerful flood can scour the streambed, lifting the gravel and the eggs with it.`;

const EXIT = <ExamExit to="?view=primitives" asks={false} />;

/** The intro before every Drill and Simulation starts, inside ExamShell. */
function ExamIntroView() {
  return (
    <ExamShell section="Reading" part="Simulation" exit={EXIT}>
      <ExamIntro
        kicker="Reading Simulation"
        title="How Gravel Beds Shelter Young Salmon"
        meta={<ExamSetLine source="generated" createdAt={at(3, 9, 0)} setId="rd-170e6bf3" />}
        notice={<Notice tone="caution">You have practised this Set before, so this Attempt is a Repeat. It will not change your Reading Band Estimate.</Notice>}
        facts={[
          { term: "Time", detail: "29 min in all: 20 min for the Router Module, then 9 min for the next Module. Each Module has its own clock." },
          { term: "Items", detail: "32 Items in the Router Module, then 19 in the Lower Module or 15 in the Upper Module." },
          { term: "Moving around", detail: "Within a Module, go back to any question and change your Response until you submit the Module." },
          { term: "Feedback", detail: "After the last Module: your Band Estimate, then the key and the Explanation for every Item." },
          { term: "Leaving", detail: "Switching to another tab is noted on the Attempt. Leaving the section ends it; it can't be resumed." },
        ]}
        actions={
          <Button variant="primary" iconEnd={<IconArrowRight size={16} />}>
            Start Reading Simulation
          </Button>
        }
      >
        <Disclosure summary="How the second Module is chosen">
          <p>60% correct or more in the Router Module routes to the Upper Module. That threshold is this app's assumption.</p>
        </Disclosure>
      </ExamIntro>
    </ExamShell>
  );
}

const STOPS: NavigatorStop[] = [
  { key: "ctw", label: "1–10", name: "Questions 1 to 10", answered: 10, total: 10 },
  { key: "q11", label: "11", name: "Question 11", answered: 1, total: 1 },
  { key: "q12", label: "12", name: "Question 12", answered: 0, total: 1 },
  { key: "q13", label: "13", name: "Question 13", answered: 1, total: 1 },
  { key: "q14", label: "14", name: "Question 14", answered: 0, total: 1 },
];

/** A Reading Module question: the clock, the progress hairline, the navigator, passage and options. */
function ExamReadingView() {
  const [answer, setAnswer] = useState<string | null>("b");
  const [stop, setStop] = useState(3);
  const [gap, setGap] = useState("ren");
  return (
    <ExamShell
      section="Reading"
      part="Router Module · Read an Academic Passage"
      clock={<ExamClock secondsLeft={281} label="Time remaining in this Module" />}
      exit={<ExamExit to="?view=primitives" asks />}
      progress={{ current: 13, total: 32, label: "Question 13 of 32" }}
      footer={
        <>
          <Button icon={<IconArrowLeft size={16} />}>Back</Button>
          <div className="flex items-center gap-2">
            <Button variant="quiet">Submit Module…</Button>
            <Button variant="primary" iconEnd={<IconArrowRight size={16} />}>
              Next
            </Button>
          </div>
        </>
      }
    >
      <QuestionNavigator stops={STOPS} current={stop} onSelect={setStop} className="mb-8 sm:mb-10" />
      <ExamSplit passage={<PassagePane label="Read an Academic Passage" title="How Gravel Beds Shelter Young Salmon" text={PASSAGE} />}>
        <Kicker as="p">Question 13 of 32</Kicker>
        <p id="preview-stem" className="mt-2 text-stimulus text-ink">
          The word <span className="rounded-chip bg-highlight px-0.5">scour</span> in the passage is closest in meaning to
        </p>
        <div className="mt-5">
          <ChoiceList
            labelledBy="preview-stem"
            value={answer}
            onChange={setAnswer}
            choices={[
              { id: "a", label: "flood" },
              { id: "b", label: "strip away" },
              { id: "c", label: "warm up" },
              { id: "d", label: "fill in" },
            ]}
          />
        </div>
        <div className="mt-10 border-t border-rule pt-6">
          <Kicker as="p">A Complete the Words gap</Kicker>
          <p className="mt-2 text-stimulus text-ink">
            Gravel beds shelter the eggs from a strong{" "}
            <GapInput prefix="cur" length={4} value={gap} onChange={(value) => setGap(value)} label="Gap 4, starting cur" number={4} />.
          </p>
        </div>
      </ExamSplit>
    </ExamShell>
  );
}

/** A Listening Stimulus: who is speaking while the audio plays, and the Question once it has ended. */
function ExamListeningView() {
  const [answer, setAnswer] = useState<string | null>(null);
  return (
    <ExamShell
      section="Listening"
      part="Router Module · Listen to a Conversation"
      exit={<ExamExit to="?view=primitives" asks />}
      progress={{ current: 4, total: 17, label: "Stimulus 4 of 17" }}
    >
      <div className="mx-auto max-w-measure space-y-8">
        <AudioStage setting="campus bookstore">
          <SpeakerFigure role="student" accent="north-american" gender="female" />
          <SpeakerFigure role="bookstore clerk" accent="british" gender="male" />
        </AudioStage>
        <div className="grid gap-2 sm:grid-cols-3">
          <AudioStatus state="playing" />
          <AudioStatus state="done" />
          <AudioStatus state="failed" />
        </div>
        <p className="text-meta text-graphite">
          Nothing answerable is in the page until the audio ends: StimulusQuestions.tsx decides when the Question below renders.
        </p>
        <div>
          <Kicker as="p">Question 1 of 2</Kicker>
          <p id="preview-listen-stem" className="mt-2 text-stimulus text-ink">
            Why does the student go to the bookstore?
          </p>
          <div className="mt-5">
            <ChoiceList
              labelledBy="preview-listen-stem"
              value={answer}
              onChange={setAnswer}
              choices={[
                { id: "a", label: "To return a textbook she ordered twice" },
                { id: "b", label: "To ask when a course reader will arrive" },
                { id: "c", label: "To sell back last term's books" },
                { id: "d", label: "To apply for a job at the counter" },
              ]}
            />
          </div>
        </div>
      </div>
    </ExamShell>
  );
}

/** A Speaking Item: the scene with the sentence's focus, and the recorder's three states. */
function ExamSpeakingView() {
  return (
    <ExamShell
      section="Speaking"
      part="Listen and Repeat · Task 1 of 2"
      exit={<ExamExit to="?view=primitives" asks />}
      progress={{ current: 3, total: 7, label: "Item 3 of 7" }}
    >
      <div className="mx-auto max-w-measure space-y-6">
        <Card className="space-y-5">
          <Kicker as="h2">The prompt plays</Kicker>
          <AudioStatus state="playing" />
        </Card>
        <Card className="space-y-5">
          <Kicker as="h2">Recording</Kicker>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <RecordingIndicator />
            <Button size="sm">Stop recording</Button>
          </div>
          <ResponseClock secondsLeft={6.4} totalSeconds={10} />
          <p className="text-meta text-graphite">Speak now. Recording stops by itself when the time is up.</p>
        </Card>
        <Card className="space-y-4">
          <Kicker as="h2">The microphone check</Kicker>
          <LevelMeter level={0.42} />
          <LevelMeter level={0.02} />
        </Card>
      </div>
    </ExamShell>
  );
}
