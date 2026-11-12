import { z } from "zod";
import { toProviderJsonSchema } from "./reasoning/jsonSchema.js";
import { ScoreReportSchema, type DeliveryReport, type JudgeReport, type ScoreReport } from "@toefl-prep/shared";
import type { DiffOp } from "./wordDiff.js";
import {
  runSkillTask as realRunSkillTask,
  type ReasoningEventObserver,
  type SkillTaskRequest,
} from "./reasoning/router.js";
import type { RouteResult } from "./reasoning/contracts.js";

export class ArbiterError extends Error {}

export type AggregateInput = {
  taskType: "email" | "discussion"; itemId: string;
  materials: object; responseText: string; judgeReports: JudgeReport[];
  openaiJudgeProvider?: "codex" | "openai-http";
};

export type ArbitrationResult = {
  report: ScoreReport;
  provider: "claude" | "codex";
};

type ArbiterRunner = (
  request: SkillTaskRequest<ScoreReport>,
) => Promise<RouteResult<ScoreReport, "claude" | "codex">>;

export type ArbitrationOptions = {
  runSkillTask?: ArbiterRunner;
  onEvent?: ReasoningEventObserver;
  signal?: AbortSignal;
};

const ScoreReportItemSchema = ScoreReportSchema.shape.items.element;
const ArbitrationReasoningItemSchema = ScoreReportItemSchema
  .omit({
    modelRewrite: true,
    singleJudge: true,
    lowConfidence: true,
    selfArbitrated: true,
  })
  .extend({
    modelRewrite: z.string().nullable(),
  });
export const ArbitrationReasoningSchema = ScoreReportSchema.extend({
  items: z.array(ArbitrationReasoningItemSchema).min(1),
});

function parseArbitrationReasoningOutput(value: unknown): ScoreReport {
  const parsed = ArbitrationReasoningSchema.parse(value);
  return ScoreReportSchema.parse({
    ...parsed,
    items: parsed.items.map(({ modelRewrite, ...item }) => ({
      ...item,
      ...(modelRewrite === null ? {} : { modelRewrite }),
    })),
  });
}

// The three item-level flags the server derives, never the model: both aggregate paths strip any
// model-authored copy and re-apply these, so the essay and Speaking paths share one rule.
//
// - Disagreement Flag (`lowConfidence`): the two Judges' scores for this Item differ by at least
//   DISAGREEMENT_THRESHOLD. Needs exactly two scores for the Item; in a batched Speaking
//   arbitration a Judge can be missing an Item.
// - `singleJudge`: fewer than two Judge Reports survived for the run.
// - Self-Arbitration (`selfArbitrated`): Codex authored the OpenAI Judge Report and also
//   arbitrated. The one piece of provider provenance allowed into score-bearing state (ADR 0003).
const DISAGREEMENT_THRESHOLD = 1.5;

export type ItemFlagInputs = {
  judgeCount: number;
  itemScores: number[];
  arbiterProvider: "claude" | "codex";
  openaiJudgeProvider?: "codex" | "openai-http";
};

export function deriveItemFlags(input: ItemFlagInputs): {
  singleJudge?: true;
  lowConfidence?: true;
  selfArbitrated?: true;
} {
  const disagree =
    input.itemScores.length === 2 &&
    Math.abs(input.itemScores[0] - input.itemScores[1]) >= DISAGREEMENT_THRESHOLD;
  const selfArbitrated =
    input.arbiterProvider === "codex" && input.openaiJudgeProvider === "codex";
  return {
    ...(input.judgeCount < 2 ? { singleJudge: true as const } : {}),
    ...(disagree ? { lowConfidence: true as const } : {}),
    ...(selfArbitrated ? { selfArbitrated: true as const } : {}),
  };
}

// An Arbiter's Score Report may only answer for the Items it was asked about, each at most once.
// Every report item is written under its own itemId, so an id outside the request would write a
// score onto an Item nobody arbitrated, and a duplicate would let whichever copy is written last
// silently win. Either is an Arbiter failure. An Item the report leaves out is not checked here:
// the speaking adapter marks it failed on its own.
function requireRequestedItems(report: ScoreReport, requestedIds: readonly string[]): void {
  const requested = new Set(requestedIds);
  const seen = new Set<string>();
  for (const { itemId } of report.items) {
    if (!requested.has(itemId)) throw new ArbiterError("arbiter reported an item that was not requested");
    if (seen.has(itemId)) throw new ArbiterError("arbiter reported an item more than once");
    seen.add(itemId);
  }
}

export function buildAggregatePayload(input: Omit<AggregateInput, "judgeReports">, judgeReports: JudgeReport[]) {
  return {
    partA: {
      itemId: input.itemId,
      materials: input.materials,
      responseText: input.responseText,
      judges: judgeReports.map((r) => ({
        judge: r.judge,
        dimensions: r.items[0].dimensions.map(({ name, evidence }) => ({ name, evidence })),
        deductions: r.items[0].deductions,
      })),
    },
    partB: { scores: judgeReports.map((r) => ({ judge: r.judge, itemScore: r.items[0].score })) },
  };
}

/**
 * Arbitrates one essay Item through the Claude-then-Codex skill route. Throws ArbiterError when the
 * route fails or the report answers for an Item it was not asked about; the returned report carries
 * the server-derived flags in place of any the model wrote.
 */
export async function aggregate(
  input: AggregateInput,
  opts: ArbitrationOptions = {},
): Promise<ArbitrationResult> {
  const payload = buildAggregatePayload(input, input.judgeReports);
  const prompt = `/toefl-writing\nAGGREGATE ${input.taskType}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  const runSkillTask = opts.runSkillTask ?? realRunSkillTask;
  const res = await runSkillTask({
    task: { task: "aggregate", context: input.taskType },
    prompt,
    jsonSchema: toProviderJsonSchema(ArbitrationReasoningSchema),
    parse: parseArbitrationReasoningOutput,
    onEvent: opts.onEvent,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) throw new ArbiterError(`arbiter failed: ${res.error}`);
  const report = res.value;
  requireRequestedItems(report, [input.itemId]);
  // One Item per essay arbitration, so every judge report's items[0] IS this item's score.
  const flags = deriveItemFlags({
    judgeCount: input.judgeReports.length,
    itemScores: input.judgeReports.map((r) => r.items[0].score),
    arbiterProvider: res.provider,
    openaiJudgeProvider: input.openaiJudgeProvider,
  });
  return {
    provider: res.provider,
    report: {
      ...report,
      items: report.items.map((item) => {
        const { singleJudge: _s, lowConfidence: _l, selfArbitrated: _a, ...rest } = item;
        return { ...rest, ...flags };
      }),
    },
  };
}

// Speaking arbitrates every Item of the request's Task Type in one call, unlike the essay path's
// one Item per call. `target` is set for listen_repeat, `question` for interview; `diff` (the
// word-level target-vs-transcript alignment) accompanies listen_repeat Items only.
export type SpeakingAggregateItem = {
  itemId: string;
  target?: string;
  question?: string;
  transcript: string;
  deliveryReport: DeliveryReport;
  diff?: DiffOp[];
};

export type AggregateSpeakingInput = {
  taskType: "listen_repeat" | "interview";
  items: SpeakingAggregateItem[];
  judgeReports: JudgeReport[];
  openaiJudgeProvider?: "codex" | "openai-http";
  // Per-Judge mode (SpeakingJudgeResult.mode in judges/speaking.ts), passed into partA as evidence
  // framing, never a score, so the Arbiter can weigh a Text Fallback Judge's evidence accordingly.
  modes?: Record<string, "audio" | "text-fallback">;
};

/**
 * The Speaking Arbiter payload. partA carries each Item's material, transcript, Delivery Report and
 * diff, plus each Judge's evidence for it (dimension names and evidence, deductions, and that
 * Judge's mode when `input.modes` names it) with every numeric score removed, dimension scores
 * included. partB carries the numeric scores only, and comes last: the Arbiter commits its own score
 * from partA before it reconciles with partB. Both parts are in the one prompt, so this is
 * output-order commitment, not information blindness (ADR 0001).
 */
export function buildAggregateSpeakingPayload(
  input: Omit<AggregateSpeakingInput, "judgeReports">,
  judgeReports: JudgeReport[]
) {
  return {
    partA: {
      items: input.items.map((item) => ({
        itemId: item.itemId,
        ...(input.taskType === "listen_repeat" ? { target: item.target } : { question: item.question }),
        transcript: item.transcript,
        deliveryReport: item.deliveryReport,
        ...(item.diff ? { diff: item.diff } : {}),
        judges: judgeReports.flatMap((r) => {
          const judgeItem = r.items.find((i) => i.itemId === item.itemId);
          if (!judgeItem) return [];
          return [{
            judge: r.judge,
            ...(input.modes?.[r.judge] ? { mode: input.modes[r.judge] } : {}),
            dimensions: judgeItem.dimensions.map(({ name, evidence }) => ({ name, evidence })),
            deductions: judgeItem.deductions,
          }];
        }),
      })),
    },
    partB: {
      scores: input.items.flatMap((item) =>
        judgeReports.flatMap((r) => {
          const judgeItem = r.items.find((i) => i.itemId === item.itemId);
          return judgeItem ? [{ itemId: item.itemId, judge: r.judge, itemScore: judgeItem.score }] : [];
        })
      ),
    },
  };
}

/**
 * Arbitrates a Speaking Task Type's Items in one call, with the same failure and flag contract as
 * `aggregate`. An Item the report leaves out is not an error here: the caller marks it failed, or
 * keeps its committed score.
 */
export async function aggregateSpeaking(
  input: AggregateSpeakingInput,
  opts: ArbitrationOptions = {},
): Promise<ArbitrationResult> {
  const payload = buildAggregateSpeakingPayload(input, input.judgeReports);
  const prompt = `/toefl-speaking\nAGGREGATE ${input.taskType}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  const runSkillTask = opts.runSkillTask ?? realRunSkillTask;
  const res = await runSkillTask({
    task: { task: "aggregate", context: input.taskType },
    prompt,
    jsonSchema: toProviderJsonSchema(ArbitrationReasoningSchema),
    parse: parseArbitrationReasoningOutput,
    onEvent: opts.onEvent,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) throw new ArbiterError(`arbiter failed: ${res.error}`);
  const report = res.value;
  requireRequestedItems(report, input.items.map((i) => i.itemId));
  return {
    provider: res.provider,
    report: {
      ...report,
      items: report.items.map((item) => {
        const { singleJudge: _s, lowConfidence: _l, selfArbitrated: _a, ...rest } = item;
        // The Disagreement Flag is per Item, so each Item's scores are looked up by itemId (a Judge
        // can be missing an Item from the batch); singleJudge and selfArbitrated describe the run.
        return {
          ...rest,
          ...deriveItemFlags({
            judgeCount: input.judgeReports.length,
            itemScores: input.judgeReports
              .map((r) => r.items.find((i) => i.itemId === item.itemId)?.score)
              .filter((s): s is number => s !== undefined),
            arbiterProvider: res.provider,
            openaiJudgeProvider: input.openaiJudgeProvider,
          }),
        };
      }),
    },
  };
}
