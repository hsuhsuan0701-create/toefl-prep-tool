import { useEffect, useRef } from "react";
import { useLocation, useParams } from "react-router-dom";
import type { ItemVM } from "@toefl-prep/shared";
import { pollReasons, useAttemptReview } from "../hooks/useAttemptReview";
import { taskTypeEntry, taskTypeLabel } from "../lib/taskTypes";
import { Chip, StatusChip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { PageHeader, SectionHeader } from "../ui/Heading";
import { IconArrowLeft } from "../ui/icons";
import { Notice } from "../ui/Notice";
import { PageShell } from "../ui/PageShell";
import { Skeleton } from "../ui/Skeleton";
import { TextLink } from "../ui/Button";
import { formatWhenRange } from "../ui/format";
import { ATTEMPT_FLAG, ATTEMPT_MODE_LABEL, ATTEMPT_STATUS, SECTION_LABEL } from "../ui/labels";
import BandSummary from "../components/review/BandSummary";
import BuildSentenceGroup from "../components/review/BuildSentenceGroup";
import DeterministicModuleGroup from "../components/review/DeterministicModuleGroup";
import EssayItemReview from "../components/review/EssayItemReview";
import { GroupRescoreAction, HashLink } from "../components/review/ReviewParts";
import SpokenItemReview from "../components/review/SpokenItemReview";
import SceneImage from "../components/SceneImage";
import TaskJobController from "../components/review/TaskJobController";
import { rescoreCandidates } from "../components/review/reviewItems";
import { correctSummary, judgedSummary, moduleName, reviewGroups, unmarkedSummary, type ReviewGroup } from "../components/review/reviewText";
import { spokenNumberFor, spokenPromptAudioFor } from "./attemptSetSnapshot";

// Attempt review (/attempts/:id): what the User did, how it scored and what to do next, Item by Item
// in test order. The page is composition only — state, polling and the scoring-job controllers live
// in useAttemptReview, each kind of Item has its own renderer under components/review/, and the
// sentences that explain a band's or an Item's state come from components/review/reviewText.ts.
//
// Everything renders from GET /api/attempts/:id. The Set is fetched separately and best-effort, for
// display only (a scene image, Build a Sentence frames, question and option text, an essay's task);
// a Set that cannot be read never breaks the page.

function groupTitle(group: ReviewGroup): string {
  return group.kind === "module" ? moduleName(group.module) : taskTypeLabel(group.taskType);
}

function groupSummary(group: ReviewGroup, showMarks: boolean): string {
  if (group.kind === "judged") return judgedSummary(group.items);
  return showMarks ? correctSummary(group.items) : unmarkedSummary(group.items);
}

function isSpoken(taskType: string): boolean {
  return taskTypeEntry(taskType)?.review === "speaking";
}

/**
 * A link to a place in the review (`#group-…`, `#item-…`) names an element that renders only once
 * the Attempt has loaded, after the browser has already looked for it and found nothing. So scroll
 * to it then, and once more when the Set's text lands, since that text changes the height of what
 * sits above it. Only on those two moments: the fragment an in-page link sets is the browser's to
 * follow, and a fragment that names nothing leaves the page at the top.
 */
function useScrollToFragmentOnLoad(attemptId: string | undefined, setLanded: boolean) {
  const { hash } = useLocation();
  const hashRef = useRef(hash);
  hashRef.current = hash;
  useEffect(() => {
    if (!attemptId || hashRef.current.length < 2) return;
    let targetId: string;
    try {
      targetId = decodeURIComponent(hashRef.current.slice(1));
    } catch {
      return;
    }
    document.getElementById(targetId)?.scrollIntoView();
  }, [attemptId, setLanded]);
}

export default function AttemptReview() {
  const { id } = useParams<{ id: string }>();
  const review = useAttemptReview(id);
  const { detail, error, finalizingStalled, setSnapshot } = review;
  useScrollToFragmentOnLoad(detail?.attempt.id, setSnapshot !== null);

  if (error) {
    return (
      <PageShell>
        <PageHeader kicker={<BackLink />} title="Attempt" />
        <Notice tone="critical" title="This Attempt could not be loaded.">
          {error}
        </Notice>
      </PageShell>
    );
  }

  if (!detail) {
    return (
      <PageShell>
        <div aria-busy="true" aria-label="Loading the Attempt" className="space-y-6">
          <Skeleton className="h-9 w-64" shape="block" />
          <Skeleton lines={2} className="max-w-measure" />
          <Skeleton className="h-36 w-full" shape="block" />
        </div>
      </PageShell>
    );
  }

  const { attempt, items, judgeReports, estimate, bandStatus, deterministicReview, spokenPrompts } = detail;
  const reasons = pollReasons(detail);
  const settled = !reasons.transcriptionActive && !reasons.scoringActive && !reasons.captureFinalizing;
  const section = SECTION_LABEL[attempt.kind];
  const groups = reviewGroups(items, (taskType) => taskTypeEntry(taskType)?.review);
  const reviewByItemId = new Map((deterministicReview ?? []).map((r) => [r.itemId, r]));
  // The server sends these only with a completed Speaking Attempt (docs/adr/0017); the page holds to
  // the same rule, as it does for the prompt audio, so a sentence still being answered is never shown.
  const spokenPromptByItemId = new Map(attempt.status === "completed" ? (spokenPrompts ?? []).map((p) => [p.itemId, p.text]) : []);
  const deterministic = attempt.kind === "reading" || attempt.kind === "listening";
  // The server builds the key review for every Item of a completed Attempt, and for each scored Item
  // of a Drill whatever its status. When the review is owed and still absent, the Set could not be
  // read or two of its Items share an id; otherwise it is withheld by rule and the notice says why.
  const reviewOwed = attempt.status === "completed" || (attempt.mode === "drill" && items.some((item) => item.scoringStatus === "scored"));
  // A Simulation defers its feedback: while it can still be answered or finished, its review shows
  // each Response with no Correct or Incorrect mark and no "n of m correct" tally, as it shows no key
  // (issue #48). The server still sends bare correctness; a Drill and a discarded Attempt keep theirs.
  const showMarks = !(attempt.mode === "simulation" && attempt.status === "in_progress");

  const judgedProps = (item: ItemVM) => ({
    judgeReports,
    jobView: review.coveredJobView(item),
    taskBusy: review.taskBusy(item.taskType),
    rescoreCount: rescoreCandidates(items, item.taskType).length,
    onRescore: () => review.rescore(item.taskType),
    settled,
    discarded: attempt.status === "aborted",
  });

  return (
    <PageShell>
      <PageHeader
        kicker={<BackLink />}
        title={`${section} ${ATTEMPT_MODE_LABEL[attempt.mode]}`}
        meta={
          <>
            <span className="text-ink-soft">{attempt.setTitle ?? `${section} Set`}</span>
            <span aria-hidden="true">·</span>
            <span>{formatWhenRange(attempt.startedAt, attempt.completedAt)}</span>
            <StatusChip status={ATTEMPT_STATUS[attempt.status]} />
            {attempt.isRepeat && (
              <Chip glyph="dash" title="An Attempt on a Set you had already attempted. Left out of Band Estimates by default.">
                Repeat
              </Chip>
            )}
            {attempt.flagged && (
              <Chip tone="caution" glyph="caution">
                {ATTEMPT_FLAG.heading}
              </Chip>
            )}
            <span className="font-mono text-caption text-faint">{attempt.setId}</span>
          </>
        }
      />

      {/* One headless controller per in-flight Task Type, keyed on the jobId it follows, or on its
          arm count while no jobId has been observed. A controller mounted without a jobId starts
          a job, so the key changes by itself only onto a jobId, which only polls; a new arm count
          comes only from an explicit Re-score after the last job settled. */}
      {Object.entries(review.controllers).map(([taskType, entry]) => (
        <TaskJobController
          key={`${taskType}:${entry.jobId ?? `armed-${entry.arm}`}`}
          attemptId={attempt.id}
          taskType={taskType}
          jobId={entry.jobId}
          rescoreItems={rescoreCandidates(items, taskType)}
          onView={review.onJobView}
          onUnmounted={review.onJobUnmounted}
          onLanded={review.onJobLanded}
          onFailed={review.onJobFailed}
        />
      ))}

      <div className="space-y-12">
        <div className="space-y-4">
          {attempt.flagged && (
            <Notice tone="caution" title={ATTEMPT_FLAG.heading}>
              {attempt.mode === "simulation" ? ATTEMPT_FLAG.simulationNote : ATTEMPT_FLAG.otherNote}
            </Notice>
          )}
          {reasons.captureFinalizing && (
            <Notice tone="info" live="polite" title="Finishing this Attempt">
              {finalizingStalled
                ? "Your Responses are saved, but finishing this Attempt is taking longer than expected. Reload this page to check again."
                : "Your Responses are saved; transcription and scoring are finishing, and the band appears when they do. This page updates itself."}
            </Notice>
          )}
          <BandSummary attempt={attempt} estimate={estimate} bandStatus={bandStatus} items={items} rescoring={detail.activeJobs.length > 0} />
        </div>

        {groups.length > 1 && (
          <nav aria-label="Items in this Attempt" className="flex flex-wrap items-baseline gap-x-4 gap-y-2 text-meta">
            <span className="text-graphite">Items, in test order:</span>
            {groups.map((group) => (
              <HashLink key={group.key} href={`#group-${group.key}`}>
                {groupTitle(group)} · {groupSummary(group, showMarks)}
              </HashLink>
            ))}
          </nav>
        )}

        {deterministic &&
          items.length > 0 &&
          !deterministicReview &&
          (reviewOwed ? (
            <Notice tone="info">The key and Explanations aren't available for this Attempt: its Set could not be read.</Notice>
          ) : attempt.status === "aborted" ? (
            // Here the key review waits for completion (a Simulation, or a Drill with no scored
            // Item), and a discard is final.
            <Notice tone="info">This Attempt was discarded, so its key and Explanations are not shown.</Notice>
          ) : showMarks ? (
            <Notice tone="info">The key and Explanations appear once this Attempt is complete.</Notice>
          ) : (
            <Notice tone="info">Whether each Response is correct, the key and the Explanations appear once this Attempt is complete.</Notice>
          ))}

        {items.length === 0 && <EmptyState title="No Items were recorded for this Attempt.">Nothing in it reached the server.</EmptyState>}

        {groups.map((group) => {
          const headingId = `group-heading-${group.key}`;
          if (group.kind === "judged" && group.items.length === 1 && !isSpoken(group.taskType)) {
            const { item, position } = group.items[0];
            return (
              <div key={group.key} id={`group-${group.key}`} className="scroll-mt-6">
                <EssayItemReview item={item} position={position} total={items.length} setSnapshot={setSnapshot} {...judgedProps(item)} />
              </div>
            );
          }
          const scene = group.kind === "judged" && group.taskType === "listen_repeat" ? setSnapshot?.scene : null;
          return (
            <section key={group.key} id={`group-${group.key}`} aria-labelledby={headingId} className="scroll-mt-6 space-y-4">
              <SectionHeader
                id={headingId}
                title={groupTitle(group)}
                description={groupSummary(group, showMarks)}
                action={
                  group.kind === "judged" && (
                    <GroupRescoreAction
                      count={rescoreCandidates(items, group.taskType).length}
                      onRescore={() => review.rescore(group.taskType)}
                      taskBusy={review.taskBusy(group.taskType)}
                      discarded={attempt.status === "aborted"}
                    />
                  )
                }
              />
              {/* The scene the sentences were spoken against: one picture for the whole Task. */}
              {scene && (
                <div className="w-full max-w-56">
                  <SceneImage file={scene.file} />
                </div>
              )}
              {group.kind === "build_sentence" && <BuildSentenceGroup items={group.items} setSnapshot={setSnapshot} showMarks={showMarks} />}
              {group.kind === "module" && <DeterministicModuleGroup items={group.items} setSnapshot={setSnapshot} reviewByItemId={reviewByItemId} showStimulus={attempt.status === "completed"} showMarks={showMarks} />}
              {group.kind === "judged" && (
                <div className="space-y-6">
                  {group.items.map(({ item, position }, i) =>
                    isSpoken(item.taskType) ? (
                      <SpokenItemReview
                        key={item.itemId}
                        item={item}
                        position={position}
                        total={items.length}
                        // Its place in the Set, so an Item with no row leaves a gap rather than
                        // renumbering the rest; the row position only when the Set can't be read.
                        ordinal={spokenNumberFor(setSnapshot, item.itemId) ?? i + 1}
                        attemptId={attempt.id}
                        // Played again only once the Attempt is over: before that, a prompt plays
                        // as its run decides, and a sentence still being answered stays unheard.
                        promptAudio={attempt.status === "completed" ? spokenPromptAudioFor(setSnapshot, item.itemId) : undefined}
                        promptText={spokenPromptByItemId.get(item.itemId)}
                        onTranscriptionRetried={review.refresh}
                        {...judgedProps(item)}
                      />
                    ) : (
                      <EssayItemReview key={item.itemId} item={item} position={position} total={items.length} setSnapshot={setSnapshot} {...judgedProps(item)} />
                    ),
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </PageShell>
  );
}

function BackLink() {
  return (
    <TextLink to="/progress" className="inline-flex items-center gap-1">
      <IconArrowLeft size={14} />
      Progress
    </TextLink>
  );
}
