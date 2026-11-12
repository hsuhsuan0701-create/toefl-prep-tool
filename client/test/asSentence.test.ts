import { describe, expect, it } from "vitest";
import { asSentence } from "../src/ui/format";

// A server's job error ("this recording was saved but never transcribed") is printed as a sentence.
describe("asSentence", () => {
  it("capitalises and closes a bare clause, and leaves a finished sentence alone", () => {
    expect(asSentence("this recording was saved but never transcribed")).toBe("This recording was saved but never transcribed.");
    expect(asSentence("Arbiter failed.")).toBe("Arbiter failed.");
    expect(asSentence("is the server running?")).toBe("Is the server running?");
    expect(asSentence("  ")).toBe("");
  });
});
