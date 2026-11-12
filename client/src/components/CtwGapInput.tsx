import { useRef, useState, type KeyboardEvent } from "react";
import type { PublicCtwSegment, ServedCtwGap } from "@toefl-prep/shared";
import { GapInput } from "../ui/GapInput";
import { IconCheck, IconCross, IconDash } from "../ui/icons";
import { Prose } from "../ui/Prose";

// A scored gap. `key` is the deleted letters, which the server sends only in a Drill's score
// response, so it is never present before the gap is scored.
export type CtwGapResult = { correct: boolean; key?: string };

export type CtwGapInputProps = {
  segments: PublicCtwSegment[];
  gaps: ServedCtwGap[];
  disabled?: boolean;
  results?: Map<string, CtwGapResult>;
  /**
   * The letters to show in each gap, by gap id. Given, the boxes show exactly these (the caller owns
   * the Responses, so letters typed into a passage survive leaving it and coming back); omitted, the
   * component keeps its own.
   */
  values?: ReadonlyMap<string, string>;
  /** Numbers each gap, to match a numbered feedback list under the passage. */
  numbered?: boolean;
  onChange: (typed: Map<string, string>) => void;
};

/**
 * A Complete the Words passage as a flow of text runs and gaps (ui/GapInput: the visible prefix,
 * then a box with one slot per missing letter, `maxLength` set to `blankLength`; the letters
 * themselves never reach the client). Every change emits this passage's whole typed map, not just
 * the gap that changed, so a parent can hand it straight to the scorer.
 *
 * Built to be typed straight through: a gap that fills hands focus to the next one, Backspace in an
 * empty gap goes back to the previous one, and Enter moves on, but never while an input method is
 * still composing a character.
 *
 * Once `results` is supplied the boxes lock and each gap is marked by a glyph (a check, or a cross
 * or dash with the completed word, prefix + key), with the words for screen readers. The Explanation
 * belongs to the passage and is listed under it by the caller.
 */
export default function CtwGapInput({ segments, gaps, disabled, results, values, numbered, onChange }: CtwGapInputProps) {
  const [own, setOwn] = useState<Map<string, string>>(new Map());
  const typed = values ?? own;
  const gapsById = new Map(gaps.map((gap) => [gap.id, gap]));
  const order = segments.flatMap((s) => (s.type === "gap" && gapsById.has(s.gapId) ? [s.gapId] : []));
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const composing = useRef(false);

  const focusGap = (gapId: string | undefined, caret: "start" | "end") => {
    if (!gapId) return;
    const el = inputs.current.get(gapId);
    if (!el) return;
    el.focus();
    const at = caret === "end" ? el.value.length : 0;
    el.setSelectionRange(at, at);
  };
  const neighbour = (gapId: string, step: 1 | -1) => order[order.indexOf(gapId) + step];

  const handleTyped = (gap: ServedCtwGap, value: string, inserted: boolean) => {
    const next = new Map<string, string>();
    for (const g of gaps) {
      const v = g.id === gap.id ? value : typed.get(g.id);
      if (v !== undefined) next.set(g.id, v);
    }
    if (!values) setOwn(next);
    onChange(next);
    if (inserted && !composing.current && value.length >= gap.blankLength) focusGap(neighbour(gap.id, 1), "start");
  };

  const handleKeyDown = (gap: ServedCtwGap, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || composing.current) return;
    const el = e.currentTarget;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    const atEnd = el.selectionStart === el.value.length;
    if (e.key === "Backspace" && el.value === "") {
      e.preventDefault();
      focusGap(neighbour(gap.id, -1), "end");
    } else if (e.key === "Enter") {
      e.preventDefault();
      focusGap(neighbour(gap.id, 1), "start");
    } else if (e.key === "ArrowLeft" && atStart) {
      const prev = neighbour(gap.id, -1);
      if (prev) {
        e.preventDefault();
        focusGap(prev, "end");
      }
    } else if (e.key === "ArrowRight" && atEnd) {
      const next = neighbour(gap.id, 1);
      if (next) {
        e.preventDefault();
        focusGap(next, "start");
      }
    }
  };

  return (
    <Prose as="p" size="stimulus" preserveLines className="leading-[2.15]">
      {segments.map((segment, i) => {
        if (segment.type === "text") return <span key={`text-${i}`}>{segment.text}</span>;

        const gap = gapsById.get(segment.gapId);
        if (!gap) return null; // defensive — a dangling reference should never reach the client
        const result = results?.get(gap.id);
        const value = typed.get(gap.id) ?? "";

        return (
          <GapInput
            key={gap.id}
            prefix={gap.prefix}
            length={gap.blankLength}
            value={value}
            label={`Gap starting with "${gap.prefix}"`}
            disabled={disabled}
            number={numbered ? order.indexOf(gap.id) + 1 : undefined}
            inputRef={(el) => {
              if (el) inputs.current.set(gap.id, el);
              else inputs.current.delete(gap.id);
            }}
            onChange={(next) => handleTyped(gap, next, next.length > value.length)}
            onKeyDown={(e) => handleKeyDown(gap, e)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            after={result && <GapMark gapId={gap.id} prefix={gap.prefix} result={result} answered={value.trim() !== ""} />}
          />
        );
      })}
    </Prose>
  );
}

/**
 * A scored gap's mark: a check when right; a cross (or a dash when nothing was typed) and the
 * completed word when wrong. Glyph and word, not colour alone, with the verdict spelled out for a
 * screen reader.
 */
function GapMark({ gapId, prefix, result, answered }: { gapId: string; prefix: string; result: CtwGapResult; answered: boolean }) {
  const word = result.key !== undefined ? `${prefix}${result.key}` : null;
  if (result.correct) {
    return (
      <span data-testid={`ctw-gap-result-${gapId}`} className="ml-0.5 inline-flex items-center self-center text-positive">
        <IconCheck size={14} />
        <span className="sr-only">Correct</span>
      </span>
    );
  }
  return (
    <span data-testid={`ctw-gap-result-${gapId}`} className="ml-1 inline-flex items-baseline gap-0.5 text-correction">
      <span className="self-center">{answered ? <IconCross size={14} /> : <IconDash size={14} />}</span>
      <span className="sr-only">{answered ? "Incorrect" : "No Response"}{word ? ". The word is " : ""}</span>
      {word && <span className="text-body font-medium underline decoration-correction decoration-1 underline-offset-[0.2em]">{word}</span>}
    </span>
  );
}
