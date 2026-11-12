import { describe, expect, it } from "vitest";
import { MCQ_UNANSWERED_SENTINEL } from "@toefl-prep/shared";
import { scoreMcq } from "../src/services/mcqScorer.js";

describe("scoreMcq", () => {
  it("scores the key correct and others wrong", () => {
    const q = { options: [{ id: "a" }, { id: "b" }], correctOptionId: "b" };
    expect(scoreMcq(q, "b")).toEqual({ correct: true, valid: true });
    expect(scoreMcq(q, "a")).toEqual({ correct: false, valid: true });
  });
  it("flags unknown options (incl. the unanswered sentinel) invalid and wrong", () => {
    const q = { options: [{ id: "a" }], correctOptionId: "a" };
    expect(scoreMcq(q, MCQ_UNANSWERED_SENTINEL)).toEqual({ correct: false, valid: false });
    expect(scoreMcq(q, "z")).toEqual({ correct: false, valid: false });
  });
  it("reads the unanswered sentinel as unanswered even if an option carried the same id", () => {
    const q = { options: [{ id: MCQ_UNANSWERED_SENTINEL }, { id: "b" }], correctOptionId: MCQ_UNANSWERED_SENTINEL };
    expect(scoreMcq(q, MCQ_UNANSWERED_SENTINEL)).toEqual({ correct: false, valid: false });
  });
});
