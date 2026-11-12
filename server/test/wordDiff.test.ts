import { describe, expect, it } from "vitest";
import { wordDiff } from "../src/services/wordDiff.js";

describe("wordDiff", () => {
  it("marks an exact match as all matches", () => {
    const result = wordDiff("the bakery sells fresh bread", "the bakery sells fresh bread");
    expect(result.every((op) => op.op === "match")).toBe(true);
    expect(result).toHaveLength(5);
  });

  it("pairs a single wrong word as an adjacent substitution", () => {
    const result = wordDiff("the bakery sells fresh bread", "the bakery sells fresh rolls");
    expect(result.slice(0, 4).every((op) => op.op === "match")).toBe(true);
    expect(result[4]).toEqual({ op: "substitution", targetWord: "bread", saidWord: "rolls" });
    expect(result).toHaveLength(5);
  });

  it("marks a missing trailing clause as omissions", () => {
    const result = wordDiff("the bakery sells fresh bread and pastries", "the bakery sells fresh bread");
    expect(result.slice(0, 5).every((op) => op.op === "match")).toBe(true);
    expect(result[5]).toEqual({ op: "omission", targetWord: "and" });
    expect(result[6]).toEqual({ op: "omission", targetWord: "pastries" });
    expect(result).toHaveLength(7);
  });

  it("marks an extra filler word as an insertion", () => {
    const result = wordDiff("the bakery sells fresh bread", "the um bakery sells fresh bread");
    expect(result[0]).toEqual({ op: "match", targetWord: "the", saidWord: "the" });
    expect(result[1]).toEqual({ op: "insertion", saidWord: "um" });
    expect(result.slice(2)).toHaveLength(4);
    expect(result.slice(2).every((op) => op.op === "match")).toBe(true);
  });

  it("marks every target word as an omission for an empty transcript", () => {
    const result = wordDiff("the bakery sells fresh bread", "");
    expect(result).toHaveLength(5);
    expect(result.every((op) => op.op === "omission")).toBe(true);
    expect(result.map((op) => (op.op === "omission" ? op.targetWord : undefined))).toEqual(["the", "bakery", "sells", "fresh", "bread"]);
  });

  it("normalizes punctuation and case before comparing, but keeps original casing on the match", () => {
    const result = wordDiff("Hello, world!", "hello world");
    expect(result).toEqual([
      { op: "match", targetWord: "Hello,", saidWord: "hello" },
      { op: "match", targetWord: "world!", saidWord: "world" },
    ]);
  });

  it("pairs a two-word wrong run positionally, not boundary-only", () => {
    const result = wordDiff("A B", "C D");
    expect(result).toEqual([
      { op: "substitution", targetWord: "A", saidWord: "C" },
      { op: "substitution", targetWord: "B", saidWord: "D" },
    ]);
  });

  it("pairs an asymmetric run positionally and leaves the excess as a plain omission", () => {
    const result = wordDiff("A B C", "X Y");
    expect(result).toEqual([
      { op: "substitution", targetWord: "A", saidWord: "X" },
      { op: "substitution", targetWord: "B", saidWord: "Y" },
      { op: "omission", targetWord: "C" },
    ]);
  });
});
