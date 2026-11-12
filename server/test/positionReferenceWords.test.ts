import { describe, expect, it } from "vitest";
import {
  matchingPositionReferencePatterns,
  referencesOptionByPosition,
} from "../src/services/optionQuality.js";

// 前 and 後 are relative-position words only when they stand for a slot. Inside an ordinary word —
// 提前 (move earlier), 延後 (postpone), 目前 (currently), 之前/之後 (before/after) — they describe what an
// option says, which is the form the explanation rules require. An explanation in that form cannot be
// rewritten away from the detector, so a false positive here re-flags every round until the verify
// budget is gone.

const CONTENT_DESCRIPTIONS = [
  "說要提前的選項才是正確答案。",
  "提到延後的選項與原文不符。",
  "目前的選項都沒有提到費用。",
  "說要在午餐之前交件的選項才正確。",
  "說交件要在開會之前的選項才正確。",
  "說可以改到週五之後的選項與原文不符。",
  "說之後再補交的選項是錯誤的。",
  "主張以前的做法比較好的選項與錄音矛盾。",
  "提前的答案與講者說的時間不符。",
];

const SLOT_REFERENCES = [
  "前兩個選項都與原文無關。",
  "後一個選項才是正確答案。",
  "最後的選項才對。",
  "前面的選項是錯誤的。",
  "後面那個答案才對。",
  "前一個選項提到停車場，是錯誤的。",
];

describe("position-reference detector — 前/後 inside an ordinary word", () => {
  it.each(CONTENT_DESCRIPTIONS)("does not fire on %s", (phrase) => {
    expect(matchingPositionReferencePatterns(phrase)).toEqual([]);
  });

  it.each(SLOT_REFERENCES)("still fires on the slot reference %s", (phrase) => {
    expect(referencesOptionByPosition(phrase)).toBe(true);
  });
});
