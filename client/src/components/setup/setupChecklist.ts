import type { SetupCapability, SetupCliState, SetupPiece } from "@toefl-prep/shared";
import type { SetupStatus } from "../../lib/api";
import { joinAnd } from "../../ui/format";
import type { SetupCheckState } from "../../ui/labels";

export type { SetupStatus };

/** Running text with identifiers in it: a string is prose, `{ code }` is an env name or a command. */
export type Instruction = Array<string | { code: string }>;

export type SetupRow = {
  key: string;
  name: string;
  state: SetupCheckState;
  /** What this piece is for, in the User's terms. */
  purpose: string;
  /** Where it stands now, or exactly what to do about it. */
  detail: Instruction;
};

// What a capability is, as a noun phrase: "Writing scoring".
const CAPABILITY_PHRASE: Record<SetupCapability, string> = {
  "writing-scoring": "Writing scoring",
  "speaking-scoring": "Speaking scoring",
  "speaking-uploads": "Speaking recordings",
  "reading-writing-generation": "new Reading or Writing Sets",
  "speaking-listening-generation": "new Speaking or Listening Sets",
};

const CAPABILITY_ORDER: readonly SetupCapability[] = [
  "writing-scoring",
  "speaking-scoring",
  "speaking-uploads",
  "reading-writing-generation",
  "speaking-listening-generation",
];

const PIECE_NAME: Record<SetupPiece, string> = {
  "claude-cli": "Claude Code",
  "codex-cli": "the Codex CLI",
  "gemini-api-key": "a Gemini key",
  "openai-api-key": "an OpenAI key",
  "gemini-judge-model": "the Gemini Judge model",
  "openai-judge-model": "the OpenAI Judge model",
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
};

/** Setup pieces named in a sentence: "Claude Code, a Gemini key and ffmpeg". */
export function piecesPhrase(pieces: readonly SetupPiece[]): string {
  return joinAnd([...new Set(pieces)].map((piece) => PIECE_NAME[piece]));
}

/**
 * The state of a row made of one or more pieces: ready when every piece is present, missing when one
 * that is absent turns something off, optional when the absent ones turn nothing off (another piece
 * covers their job). A piece the server is still checking is neither present nor listed as missing.
 */
function rowState(status: SetupStatus, pieces: readonly SetupPiece[], present: boolean): SetupCheckState {
  if (present) return "ready";
  const listed = status.missing.filter((entry) => pieces.includes(entry.piece));
  if (listed.length === 0) return "checking";
  return listed.some((entry) => entry.disables.length > 0) ? "missing" : "optional";
}

function turnsOff(status: SetupStatus, pieces: readonly SetupPiece[]): string[] {
  const off = new Set(status.missing.filter((entry) => pieces.includes(entry.piece)).flatMap((entry) => entry.disables));
  return CAPABILITY_ORDER.filter((capability) => off.has(capability)).map((capability) => CAPABILITY_PHRASE[capability]);
}

function consequence(state: SetupCheckState, off: string[], coveredBy: string): string {
  if (state === "missing" && off.length > 0) return ` Until then: ${joinAnd(off.map((phrase) => `no ${phrase}`))}.`;
  if (state === "optional") return ` ${coveredBy}`;
  return "";
}

function cliRow(
  status: SetupStatus,
  piece: "claude-cli" | "codex-cli",
  cli: SetupCliState,
  other: SetupCliState,
): SetupRow {
  const claude = piece === "claude-cli";
  const name = claude ? "Claude Code" : "Codex CLI";
  const command = claude ? "claude" : "codex";
  const state = rowState(status, [piece], cli === "ready");
  const covered = claude ? "Codex is signed in and does this job instead." : "Claude is signed in and does this job.";
  // Neither is set up: say that one of the two is enough, so a User does not install both.
  const eitherIsEnough = other !== "ready" && state === "missing" ? " Either Claude Code or the Codex CLI is enough." : "";
  const tail = consequence(state, turnsOff(status, [piece]), covered) + eitherIsEnough;
  const detail: Instruction =
    cli === "ready"
      ? ["Signed in."]
      : cli === "checking"
        ? ["The server is checking whether it is installed and signed in."]
        : cli === "not-installed"
          ? [`Not found. Install it so the server can run `, { code: command }, ` (or point `, { code: claude ? "CLAUDE_BIN" : "CODEX_BIN" }, ` in `, { code: ".env" }, ` at it), then sign in.${tail}`]
          : cli === "not-logged-in"
            ? claude
              ? ["Installed, not signed in. Run ", { code: "claude" }, " in a terminal and log in; ", { code: "claude auth status" }, ` should then say you are logged in.${tail}`]
              : ["Installed, not signed in. Run ", { code: "codex login" }, `.${tail}`]
            : [`Installed, but its last check or calls failed (a quota, a time-out). It is tried again on its own; check again later.${tail}`];
  return {
    key: piece,
    name,
    state,
    purpose: claude
      ? "Writes and checks new Sets, and writes each Speaking and Writing Score Report as the Arbiter."
      : "Does Claude's work when Claude is unavailable, and runs the OpenAI Judge for essays.",
    detail,
  };
}

function judgeRow(status: SetupStatus, family: "gemini" | "openai"): SetupRow {
  const gemini = family === "gemini";
  const keyPiece: SetupPiece = gemini ? "gemini-api-key" : "openai-api-key";
  const modelPiece: SetupPiece = gemini ? "gemini-judge-model" : "openai-judge-model";
  const hasKey = gemini ? status.geminiApiKey : status.openaiApiKey;
  const hasModel = gemini ? status.geminiJudgeModel : status.openaiJudgeModel;
  const keyName = gemini ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
  const modelName = gemini ? "GEMINI_JUDGE_MODEL" : "OPENAI_JUDGE_MODEL";
  const state = rowState(status, [keyPiece, modelPiece], hasKey && hasModel);
  const covered = gemini
    ? "The other Judge is set up, so scoring still runs."
    : "Scoring runs with the Gemini Judge alone until it is added.";
  const tail = consequence(state, turnsOff(status, [keyPiece, modelPiece]), covered);
  const absent = [!hasKey && keyName, !hasModel && modelName].filter((name): name is string => Boolean(name));
  const detail: Instruction =
    absent.length === 0
      ? ["Key and Judge model are set."]
      : [
          "Add ",
          ...absent.flatMap((name, i) => (i === 0 ? [{ code: name }] : [" and ", { code: name }])),
          " to ",
          { code: ".env" },
          ` and restart the server.${tail}`,
        ];
  return {
    key: family,
    name: gemini ? "Gemini key" : "OpenAI key",
    state,
    purpose: gemini
      ? "One of the two Judges for Speaking and Writing, the transcriber for every recording, and the voices of new Speaking and Listening Sets."
      : "The second, independent Judge for Speaking and Writing.",
    detail,
  };
}

function audioToolsRow(status: SetupStatus): SetupRow {
  const state = rowState(status, ["ffmpeg", "ffprobe"], status.ffmpeg && status.ffprobe);
  const tail = consequence(state, turnsOff(status, ["ffmpeg", "ffprobe"]), "");
  const absent = [!status.ffmpeg && "ffmpeg", !status.ffprobe && "ffprobe"].filter((name): name is string => Boolean(name));
  return {
    key: "audio-tools",
    name: "ffmpeg and ffprobe",
    state,
    purpose: "Convert every Speaking recording, and measure the audio of new Speaking and Listening Sets.",
    detail:
      absent.length === 0
        ? ["Both are installed."]
        : [
            `${joinAnd(absent)} ${absent.length === 1 ? "is" : "are"} not on the server's PATH. Install ffmpeg (it includes ffprobe), then check again.${tail}`,
          ],
  };
}

/**
 * The Setup checklist, one row per thing a User can set up, in the order that matters most to a new
 * User: what works already, then what scoring needs, then what generation needs.
 */
export function setupRows(status: SetupStatus): SetupRow[] {
  const rows: SetupRow[] = [
    {
      key: "reading-listening",
      name: "Reading and Listening",
      state: "ready",
      purpose: "Practise them and get a band right away.",
      detail: ["Scored on this machine against each Set's key. Needs no key and no sign-in."],
    },
    judgeRow(status, "gemini"),
    judgeRow(status, "openai"),
    cliRow(status, "claude-cli", status.claudeCli, status.codexCli),
    cliRow(status, "codex-cli", status.codexCli, status.claudeCli),
    audioToolsRow(status),
  ];
  rows.push(
    status.rubrics.source === "official"
      ? {
          key: "rubrics",
          name: "Scoring rubrics",
          state: "ready",
          purpose: "What the Judges and the Arbiter score Speaking and Writing against.",
          detail: ["ETS's official rubric text, from the copies on this machine."],
        }
      : {
          key: "rubrics",
          name: "Scoring rubrics",
          state: "optional",
          purpose: "What the Judges and the Arbiter score Speaking and Writing against.",
          detail: [
            "This project's own description of ETS's published criteria. Optional: docs/official-rubrics.md says how to score against ETS's official text instead.",
          ],
        },
  );
  return rows;
}

/** One line for the collapsed checklist: what this machine cannot do yet, or that nothing is missing. */
export function setupSummary(status: SetupStatus): string {
  const off = CAPABILITY_ORDER.filter((capability) => !status.capabilities[capability]);
  if (off.length === 0) return "Everything is set up.";
  const known = status.missing.some((entry) => entry.disables.length > 0);
  if (!known) return "Still checking what this machine can do.";
  return `Not available on this machine yet: ${joinAnd(off.map((capability) => CAPABILITY_PHRASE[capability]))}.`;
}
