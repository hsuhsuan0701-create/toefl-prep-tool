import type { ItemVM } from "@toefl-prep/shared";
import { buildSentenceComposition, sentencePromptFor, sentenceTilesFor, type AttemptSetSnapshot } from "../../pages/attemptSetSnapshot";
import { Card } from "../../ui/Card";
import { StatusChip } from "../../ui/Chip";
import { IconChevronRight } from "../../ui/icons";
import { ITEM_MARK_DEFERRED, itemScoringStatus } from "../../ui/labels";
import { ComposedSentence, OfferedTiles, PLACED_WORDS_NOTE, SentenceResponse } from "./BuildSentenceParts";
import { ResultMark } from "./ReviewParts";
import { isBuildSentenceScoreJson } from "./reviewItems";
import { failureText, itemsWord, type IndexedItem } from "./reviewText";

/**
 * A Writing Attempt's Build a Sentence Items as one list that opens on demand, so ten short Items
 * do not push the essays below the fold. Native <details>: closed, every row is still in the
 * document, so search and the jump list reach it.
 */
// `showMarks` is false for a Writing Simulation still in progress: its Items show no Correct or
// Incorrect mark until it completes (issue #48).
export default function BuildSentenceGroup({ items, setSnapshot, showMarks = true }: { items: IndexedItem[]; setSnapshot: AttemptSetSnapshot | null; showMarks?: boolean }) {
  return (
    <Card padding="none">
      <details className="group">
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-sheet px-4 py-3 text-ui font-medium text-ink select-none hover:bg-paper [&::-webkit-details-marker]:hidden">
          <span className="text-graphite transition-transform duration-(--duration-quick) group-open:rotate-90" aria-hidden="true">
            <IconChevronRight size={16} />
          </span>
          <span>
            <span className="group-open:hidden">Show</span>
            <span className="hidden group-open:inline">Hide</span> the {itemsWord(items.length)}
          </span>
        </summary>
        <p className="border-t border-rule px-4 py-2 text-meta text-graphite">{PLACED_WORDS_NOTE}</p>
        <ol className="divide-y divide-rule border-t border-rule">
          {items.map(({ item, position }) => (
            <BuildSentenceRow key={item.itemId} item={item} position={position} setSnapshot={setSnapshot} showMark={showMarks} />
          ))}
        </ol>
      </details>
    </Card>
  );
}

// `responseText` is the placed tile texts in blank order and `correctAnswers` has the same shape, so
// both are only ever an arrangement. A frame Item keeps its fixed words out of the tiles, so each is
// written out through ComposedSentence — the same composer the Writing Drill's results use — with
// the frame buildSentenceComposition picks: the one persisted with the Response, else the Set file's
// current one when the Response still fits that Item, else none (tiles in order) with a note that
// the Set changed.
function BuildSentenceRow({ item, position, setSnapshot, showMark }: { item: ItemVM; position: number; setSnapshot: AttemptSetSnapshot | null; showMark: boolean }) {
  let tileOrder: string[] = [];
  try {
    if (item.responseText) tileOrder = JSON.parse(item.responseText) as string[];
  } catch {
    tileOrder = [];
  }
  const scored = item.scoringStatus === "scored" && isBuildSentenceScoreJson(item.scoreJson) ? item.scoreJson : null;
  // A Simulation not yet completed has no key here: the server withholds it until completion.
  const keyArrangements = (isBuildSentenceScoreJson(item.scoreJson) ? item.scoreJson.correctAnswers : undefined) ?? [];
  const arrangements = [tileOrder, ...keyArrangements];
  const { frame, revised } = buildSentenceComposition(setSnapshot, item.itemId, item.scoreJson, arrangements);
  // The tiles come from the Set as served today, so they are listed only when the Response and the
  // key are drawn from them; the extra one is marked only beside a key the server has shown.
  const tiles = revised ? undefined : sentenceTilesFor(setSnapshot, item.itemId, arrangements);
  const prompt = sentencePromptFor(setSnapshot, item.itemId);

  return (
    <li id={`item-${item.itemId}`} data-testid={`item-${item.itemId}`} className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-meta text-graphite">
          <span className="figures">Item {position}</span>
          {prompt && <span className="text-ink-soft"> · {prompt}</span>}
        </p>
        {scored && showMark ? <ResultMark correct={scored.correct} /> : <StatusChip status={scored ? ITEM_MARK_DEFERRED : itemScoringStatus(item.scoringStatus)} />}
      </div>
      <p data-testid={`bas-answer-${item.itemId}`} className="text-body text-ink">
        <span className="text-graphite">Your Response: </span>
        {/* An Item nobody touched says so outright rather than echoing the bare frame back, and a
            partly filled one is listed rather than composed (see SentenceResponse). */}
        <SentenceResponse frame={frame} tiles={tileOrder} keyArrangements={scored?.correctAnswers ?? null} />
      </p>
      {scored?.correctAnswers && (
        // Labelled apart from the Response: the two sit one above the other and must not be confused.
        <p data-testid={`bas-key-${item.itemId}`} className="text-ui text-ink-soft">
          <span className="text-graphite">{scored.correctAnswers.length > 1 ? "Key (any of these): " : "Key: "}</span>
          {scored.correctAnswers.map((a, i) => (
            <span key={i}>
              {i > 0 && " / "}
              <ComposedSentence frame={frame} tiles={a} />
            </span>
          ))}
        </p>
      )}
      {tiles && (
        <OfferedTiles testId={`bas-tiles-${item.itemId}`} tiles={tiles} keyArrangements={scored?.correctAnswers ?? null} />
      )}
      {item.scoringStatus === "failed" && <p className="text-ui text-critical">{failureText(item.scoreJson).summary}</p>}
      {revised && (
        <p data-testid={`bas-revised-${item.itemId}`} className="text-meta text-graphite">
          This Set was revised after this Attempt, so your Response is shown as the tiles you placed, in order.
        </p>
      )}
    </li>
  );
}
