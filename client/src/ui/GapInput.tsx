import { useId, type ChangeEvent, type CompositionEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { cx } from "./cx";

// The box's padding on each side, and its 1px border: the box is border-box, so its width pays for
// both on top of the letters.
const PAD = "0.25rem";
const BORDER = "1px";

const WHITESPACE = /\s/;
const WHITESPACE_ALL = /\s/g;
const countWhitespace = (text: string) => text.match(WHITESPACE_ALL)?.length ?? 0;

type GapInputProps = {
  /** The letters the text shows before the gap ("ca" of "cat"). */
  prefix: string;
  /** How many letters are missing. Drawn as that many slot marks, and the input takes no more. */
  length: number;
  value: string;
  onChange: (value: string, event: ChangeEvent<HTMLInputElement>) => void;
  /** The accessible name, e.g. `Gap starting with "ca"`. The letter count is added as a description. */
  label: string;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onCompositionStart?: (event: CompositionEvent<HTMLInputElement>) => void;
  onCompositionEnd?: (event: CompositionEvent<HTMLInputElement>) => void;
  /** A small number before the gap, linking it to a numbered list (Drill feedback). */
  number?: number;
  /**
   * Whatever follows the box on its line: CtwGapInput's right/wrong mark once the Item is scored,
   * and the punctuation that ends the gap's word.
   */
  after?: ReactNode;
};

/**
 * One Complete the Words gap, inline in the text: the visible prefix, then a `field` box in the
 * Stimulus's own type size with one slot mark per missing letter, so the length is visible before
 * anything is typed. The box takes at most `length` letters.
 *
 * Set in the monospace face, prefix and box alike, so every letter is exactly 1ch wide: the box is
 * `length` ch of letters plus its padding and border, it holds any `length` letters whatever they
 * are, and each letter sits over its own mark. The passage around it is mono too (CtwGapInput), so a
 * word never mixes two faces. Spell-check, autocorrect and auto-capitalisation are off: the User is
 * completing a word, not writing one.
 *
 * Whitespace never enters the box, typed or pasted: no completion holds a space (the scorer trims
 * it), and a space that took a slot would fill the gap one letter early and push the rest of the
 * word into the next gap. Every other character is the User's own Response and goes in as typed.
 *
 * Moving between gaps (advancing when a gap fills, going back on Backspace in an empty one) is the
 * passage's job — CtwGapInput — since only it knows the order of the gaps.
 */
export function GapInput({
  prefix,
  length,
  value,
  onChange,
  label,
  disabled,
  inputRef,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  number,
  after,
}: GapInputProps) {
  const hintId = useId();
  const slots = Math.max(1, length);
  return (
    <span className="inline-flex items-baseline font-mono whitespace-nowrap">
      {number !== undefined && (
        <sup className="figures mr-0.5 text-caption font-semibold text-graphite" aria-hidden="true">
          {number}
        </sup>
      )}
      <span>{prefix}</span>
      <input
        ref={inputRef}
        type="text"
        aria-label={label}
        aria-describedby={hintId}
        value={value}
        maxLength={length}
        disabled={disabled}
        onChange={(e) => {
          const el = e.target;
          if (WHITESPACE.test(el.value)) {
            // Take the whitespace out of the box itself, keeping the caret where the User left it.
            const caret = (el.selectionStart ?? el.value.length) - countWhitespace(el.value.slice(0, el.selectionStart ?? 0));
            el.value = el.value.replace(WHITESPACE_ALL, "");
            el.setSelectionRange(caret, caret);
            if (el.value === value) return;
          }
          onChange(el.value, e);
        }}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text");
          if (!WHITESPACE.test(pasted)) return;
          // maxLength cuts a paste before onChange can take its spaces out ("o w s" into three
          // slots would keep "o w"), so a paste with whitespace in it is inserted here, letters only.
          e.preventDefault();
          const el = e.currentTarget;
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? start;
          const room = length - (el.value.length - (end - start));
          const letters = pasted.replace(WHITESPACE_ALL, "").slice(0, Math.max(0, room));
          if (letters === "") return;
          el.setRangeText(letters, start, end, "end");
          // The same input event typing raises, so the change goes through onChange above.
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }}
        onKeyDown={onKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="next"
        style={{
          width: `calc(${slots}ch + 2 * ${PAD} + 2 * ${BORDER})`,
          paddingInline: PAD,
          // One mark per 1ch letter cell, inset a little from each side so neighbouring marks part.
          backgroundImage:
            "repeating-linear-gradient(to right, transparent 0 0.1ch, var(--color-rule-strong) 0.1ch 0.9ch, transparent 0.9ch 1ch)",
          backgroundSize: `${slots}ch 1.5px`,
          backgroundPosition: `${PAD} calc(100% - 0.3em)`,
          backgroundRepeat: "no-repeat",
        }}
        className={cx(
          "mx-px inline-block h-[1.55em] rounded-control border border-rule-strong bg-field align-baseline text-stimulus leading-none text-ink",
          "transition-colors duration-(--duration-quick) hover:border-graphite",
          "disabled:cursor-default disabled:border-rule disabled:bg-well disabled:hover:border-rule",
        )}
      />
      <span id={hintId} className="sr-only">
        {length === 1 ? "1 missing letter" : `${length} missing letters`}
      </span>
      {after}
    </span>
  );
}
