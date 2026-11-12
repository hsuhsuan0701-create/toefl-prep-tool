import { describe, expect, it } from "vitest";
import { formatScore } from "../src/lib/taskTypeScale";

// Accuracy is a whole percent and never rounds up to 100%: 199 of 200 right is not a perfect
// Module, and a trend tile that says "100%" would tell the User it was.
describe("an accuracy score on a trend tile", () => {
  it("rounds down, so only a perfect score reads 100%", () => {
    expect(formatScore("complete_words", 0.995)).toBe("99%");
    expect(formatScore("listen_choose", 0.999)).toBe("99%");
    expect(formatScore("academic_talk", 1)).toBe("100%");
    expect(formatScore("build_sentence", 0.7)).toBe("70%");
  });
});
