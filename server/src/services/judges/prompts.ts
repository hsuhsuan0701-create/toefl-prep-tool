import fs from "node:fs";
import path from "node:path";
import type { DeliveryReport } from "@toefl-prep/shared";
import { config } from "../../lib/config.js";
import type { DiffOp } from "../wordDiff.js";
import { RUBRIC_DIMENSIONS, judgeVisibleText, resolveSkillReference } from "../skillReferences.js";

const RUBRIC_FILE = { email: "rubric-email.md", discussion: "rubric-academic-discussion.md" } as const;
export const DIMENSIONS = { email: RUBRIC_DIMENSIONS.email, discussion: RUBRIC_DIMENSIONS.discussion } as const;

const SPEAKING_RUBRIC_FILE = { listen_repeat: "rubric-listen-and-repeat.md", interview: "rubric-interview.md" } as const;
export const SPEAKING_DIMENSIONS = {
  listen_repeat: RUBRIC_DIMENSIONS.listen_repeat,
  interview: RUBRIC_DIMENSIONS.interview,
} as const;

// Read on every prompt rather than cached, through the same official-copy rule the Arbiter's two
// routes apply (skillReferences.ts): a copy installed while the server runs is what the next Judge
// sees, and what GET /api/setup-status reports is what the Judges are scoring with. The text goes
// through judgeVisibleText, which drops the sections written for the skill's own Arbiter.
function loadRubric(skillDir: string, filename: string): string {
  const resolved = resolveSkillReference(`.claude/skills/${skillDir}/references/${filename}`, config.projectRoot);
  return judgeVisibleText(fs.readFileSync(path.join(config.projectRoot, resolved.relativePath), "utf8"));
}

function rubric(taskType: keyof typeof RUBRIC_FILE): string {
  return loadRubric("toefl-writing", RUBRIC_FILE[taskType]);
}

function speakingRubric(taskType: keyof typeof SPEAKING_RUBRIC_FILE): string {
  return loadRubric("toefl-speaking", SPEAKING_RUBRIC_FILE[taskType]);
}

export function composeJudgePrompt(taskType: "email" | "discussion", materials: object, responseText: string): string {
  const dims = DIMENSIONS[taskType];
  return [
    `You are an independent TOEFL iBT 2026 Writing rater. Score the response below on the 0–5 scale of the rubric that follows, strictly and on your own judgment.`,
    `## Rubric\n${rubric(taskType)}`,
    `## Task materials\n\`\`\`json\n${JSON.stringify(materials, null, 2)}\n\`\`\``,
    `## Test taker's response\n${responseText}`,
    `## Output`,
    `Return ONLY a JSON object, no prose, matching exactly:`,
    `{"judge":"gemini|openai","taskType":"${taskType}","items":[{"itemId":"<the item id from materials>","score":<0-5 in 0.5 steps>,"dimensions":[{"name":<one of ${JSON.stringify(dims)}>,"score":<0-5 in 0.5 steps>,"evidence":"<short quote-grounded justification>"}],"deductions":[{"quote":"<verbatim from the response>","issue":"...","fix":"...","category":"grammar|vocab|elaboration|register|coherence|pronunciation-proxy|content|completeness"}]}]}`,
    `Provide all four dimensions in the order given. Every deduction quote must appear verbatim in the response.`,
  ].join("\n\n");
}

// audioPath: the webm for the Gemini call, the mp3 for the OpenAI call (the Gemini call declares its
// mime from the file extension; the OpenAI call always declares mp3). `target` is set for
// listen_repeat Items, `question` for interview Items; `diff` (wordDiff's target-vs-transcript
// alignment) only for listen_repeat.
export type SpeakingJudgeItem = {
  itemId: string;
  audioPath: string;
  transcript: string;
  deliveryReport: DeliveryReport;
  target?: string;
  question?: string;
  diff?: DiffOp[];
};

// mode "audio" (the default) tells the Judge the attached recordings are the primary evidence, over
// the ASR transcript (ADR 0002). mode "text-fallback" is for Text Fallback, where no audio is sent:
// it replaces that sentence with a no-audio note, so the Judge cannot claim to have listened.
export function composeSpeakingJudgePrompt(
  taskType: "listen_repeat" | "interview",
  items: SpeakingJudgeItem[],
  mode: "audio" | "text-fallback" = "audio"
): string {
  const dims = SPEAKING_DIMENSIONS[taskType];
  const itemBlocks = items.map((item) => {
    const lines = [`### Item ${item.itemId}`];
    lines.push(
      taskType === "listen_repeat"
        ? `Target sentence (what the speaker was asked to repeat exactly): "${item.target ?? ""}"`
        : `Interview question the speaker was answering: "${item.question ?? ""}"`
    );
    lines.push(`ASR transcript (an automatic speech-to-text approximation — NOT ground truth): "${item.transcript}"`);
    lines.push(`Delivery report, describing HOW it was said (not what it means): ${JSON.stringify(item.deliveryReport)}`);
    if (taskType === "listen_repeat" && item.diff) {
      lines.push(`Word-level diff, target vs transcript (match/substitution/omission/insertion): ${JSON.stringify(item.diff)}`);
    }
    return lines.join("\n");
  });
  const evidenceFraming =
    mode === "audio"
      ? `The audio parts accompanying this prompt (each labeled "Item <id> audio:") are the PRIMARY evidence for your scoring. The transcript given per item below is only an ASR approximation and can contain transcription errors — listen to the audio yourself and trust what you actually hear over the transcript text when the two disagree.`
      : `No audio is available for this evaluation — score from the transcript and Delivery Report only.`;
  return [
    `You are an independent TOEFL iBT 2026 Speaking rater. Score the responses below on the 0–5 scale of the rubric that follows, strictly and on your own judgment.`,
    evidenceFraming,
    `## Rubric\n${speakingRubric(taskType)}`,
    `## Items\n${itemBlocks.join("\n\n")}`,
    `## Output`,
    `Return ONLY a JSON object, no prose, matching exactly:`,
    `{"judge":"gemini|openai","taskType":"${taskType}","items":[{"itemId":"<the item id above>","score":<0-5 in 0.5 steps>,"dimensions":[{"name":<one of ${JSON.stringify(dims)}>,"score":<0-5 in 0.5 steps>,"evidence":"<short quote-grounded justification>"}],"deductions":[{"quote":"<verbatim from the transcript>","issue":"...","fix":"...","category":"grammar|vocab|elaboration|register|coherence|pronunciation-proxy|content|completeness"}]}]}`,
    `Provide exactly one item entry per item listed above, in the same order, with itemId matching exactly. Provide all ${dims.length} dimensions in the order given for each item. Every deduction quote must appear verbatim in that item's transcript.`,
  ].join("\n\n");
}
