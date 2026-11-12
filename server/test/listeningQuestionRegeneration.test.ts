import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyListeningSet } from "../src/services/listeningGenerator.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import {
  allOkListeningVerdict,
  listeningMcq,
  listeningSetForVerify,
  routed,
} from "./helpers/listeningGenerationFixture.js";

// A verify round can flag questions in several Stimuli at once, and their regenerations run side by
// side. When one fails, the remediation fails, and the loop goes on to its next verify round. A
// sibling call still running at that point would keep spending with nobody waiting on it.

afterEach(() => {
  vi.restoreAllMocks();
});

function regenerationStimulusId(prompt: string): string {
  const match = /```question-regeneration\n([\s\S]*?)\n```/.exec(prompt);
  if (!match) throw new Error("fixture error: not a question-regeneration prompt");
  return (JSON.parse(match[1]!) as { stimulusId: string }).stimulusId;
}

describe("Listening question regeneration", () => {
  it("waits for every Stimulus's call before the failed remediation hands back to the verify loop", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const set = listeningSetForVerify();
    const flagged = new Set(["conv-r1-q1", "conv-r2-q1"]);
    const events: string[] = [];
    let verifyRound = 0;
    const run = (async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "verify") {
        verifyRound += 1;
        events.push(`verify ${verifyRound}`);
        const verdict = allOkListeningVerdict(request.prompt);
        if (verifyRound > 1) return routed(request, verdict);
        return routed(request, {
          ...verdict,
          questions: verdict.questions.map((question) =>
            flagged.has(question.id) ? { id: question.id, verdict: "issue" as const, reason: "the key is not supported" } : question),
        });
      }
      const stimulusId = regenerationStimulusId(request.prompt);
      if (stimulusId === "conv-r1") {
        events.push("conv-r1 failed");
        return { ok: false as const, error: "Structured reasoning unavailable: Claude (timeout).", attempts: [] };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`${stimulusId} settled`);
      return routed(request, { questions: [listeningMcq(`${stimulusId}-q1`, "a")] });
    }) as SkillTaskRunner;

    await verifyListeningSet(set, run, undefined, set.id);

    expect(events).toEqual(["verify 1", "conv-r1 failed", "conv-r2 settled", "verify 2"]);
  });
});
