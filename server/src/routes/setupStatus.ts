import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type {
  ReasoningFailureKind,
  RubricSource,
  SetupCapability,
  SetupCliState,
  SetupPiece,
  SetupStatusVM,
} from "@toefl-prep/shared";
import type { CliProvider } from "../services/reasoning/contracts.js";
import type { PreflightOutcome, ProviderAvailabilitySnapshot } from "../services/reasoning/providerState.js";

// GET /api/setup-status — which optional pieces of this installation are present, and which
// capabilities each missing one turns off. Nothing here is required to boot: Reading and Listening
// practice runs with no key and no CLI. Every answer is a boolean or an enum; key values, model ids
// and paths never leave this module.
//
// POST /api/setup-status/recheck — the same answer after re-running what can change while the
// server is up. PATH lookups and rubric resolution are re-read on every request anyway; the recheck
// adds a fresh run of both CLIs' auth checks, which otherwise run once, at boot.

export type SetupSettings = {
  geminiApiKey: string | undefined;
  openaiApiKey: string | undefined;
  geminiJudgeModel: string;
  openaiJudgeModel: string;
  openaiTextPrimary: "codex" | "http";
};

/**
 * A CLI auth check's outcome, and whether it is still the newest evidence about that CLI: `current`
 * stays true until the provider records a live call outcome after the check answered.
 */
export type RecordedPreflight = PreflightOutcome & { readonly current?: boolean };

export type SetupStatusDeps = {
  /** The reasoning router's live view of each CLI (providerState.snapshot). */
  providers: () => readonly ProviderAvailabilitySnapshot[];
  /** What each CLI's most recent auth check answered (createCliPreflightRecord). */
  preflight: () => Partial<Record<CliProvider, RecordedPreflight>>;
  settings: () => SetupSettings;
  /** Whether an executable of this name is on the server process's PATH. */
  onPath: (bin: string) => boolean;
  /** Which copy of the rubrics scoring reads (skillReferences.rubricsSource). */
  rubricsSource: () => RubricSource;
  /** Runs both CLIs' auth checks again; resolves once both outcomes are recorded. */
  recheckClis: () => Promise<void>;
};

/**
 * Keeps what each CLI's auth check answered, for the boot check and every recheck alike.
 *
 * The router's own availability cannot always say. A check that fails with a kind that opens no
 * circuit (a configuration error, say) leaves it reading "checking" for good. And a check that
 * succeeds never closes a circuit already open — only a real request's probe does — so after a
 * user logs in, the router keeps reporting the login failure until that probe runs. So each
 * outcome is stamped with the provider's activity version at the moment it was applied, and reads
 * as `current` until a live call outcome advances that version.
 *
 * `run` is single-flight: a recheck pressed while a check is already running joins it.
 */
export function createCliPreflightRecord(deps: {
  activityVersion: (provider: CliProvider) => number;
  /** Runs both checks, telling `onChecked` each outcome as it is applied (preflightProviders). */
  runChecks: (onChecked: (provider: CliProvider, outcome: PreflightOutcome) => void) => Promise<void>;
}) {
  const checks: Partial<Record<CliProvider, { outcome: PreflightOutcome; version: number }>> = {};
  const onChecked = (provider: CliProvider, outcome: PreflightOutcome) => {
    checks[provider] = { outcome, version: deps.activityVersion(provider) };
  };
  let inFlight: Promise<void> | undefined;
  return {
    run(): Promise<void> {
      inFlight ??= deps.runChecks(onChecked).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    outcomes(): Partial<Record<CliProvider, RecordedPreflight>> {
      const recorded: Partial<Record<CliProvider, RecordedPreflight>> = {};
      for (const provider of ["claude", "codex"] as const) {
        const check = checks[provider];
        if (check) recorded[provider] = { ...check.outcome, current: deps.activityVersion(provider) === check.version };
      }
      return recorded;
    },
  };
}

/** A PATH lookup without spawning: the same resolution `spawn("ffmpeg")` would make. */
export function isOnPath(
  bin: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, bin + extension);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // Not here, or not executable: keep looking.
      }
    }
  }
  return false;
}

const CAPABILITIES: readonly SetupCapability[] = [
  "reading-writing-generation",
  "speaking-listening-generation",
  "writing-scoring",
  "speaking-scoring",
  "speaking-uploads",
];

const PIECES: readonly SetupPiece[] = [
  "claude-cli",
  "codex-cli",
  "gemini-api-key",
  "openai-api-key",
  "gemini-judge-model",
  "openai-judge-model",
  "ffmpeg",
  "ffprobe",
];

type Requirement = SetupPiece | { all: Requirement[] } | { any: Requirement[] };

// What each capability needs, read off the code paths that use each piece:
// - Skill-backed reasoning (generation, verification, the Arbiter) routes Claude, then Codex.
// - Speaking and Listening audio is Gemini TTS, converted by ffmpeg and measured with ffprobe.
//   Scene images can fail without failing a Set, so the OpenAI key is not a generation requirement.
// - Essay scoring proceeds with one Judge ("both judges failed" is the only Judge failure that
//   stops it). The OpenAI text Judge runs on Codex first unless OPENAI_TEXT_PRIMARY=http, then on
//   OpenAI HTTP with OPENAI_JUDGE_MODEL.
// - Speaking scoring needs a transcript from Ears (Gemini key and Judge model). The Gemini speaking
//   Judge needs the same pair, so with Ears present one Judge always is.
// - Every Speaking upload is transcoded by ffmpeg before it is stored; ffprobe only reads its
//   duration, and a failure there is tolerated.
function requirements(openaiTextPrimary: SetupSettings["openaiTextPrimary"]): Record<SetupCapability, Requirement> {
  const reasoningCli: Requirement = { any: ["claude-cli", "codex-cli"] };
  const geminiJudge: Requirement = { all: ["gemini-api-key", "gemini-judge-model"] };
  const openaiHttpJudge: Requirement = { all: ["openai-api-key", "openai-judge-model"] };
  const openaiTextJudge: Requirement = openaiTextPrimary === "codex" ? { any: ["codex-cli", openaiHttpJudge] } : openaiHttpJudge;
  return {
    "reading-writing-generation": reasoningCli,
    "speaking-listening-generation": { all: [reasoningCli, "gemini-api-key", "ffmpeg", "ffprobe"] },
    "writing-scoring": { all: [reasoningCli, { any: [geminiJudge, openaiTextJudge] }] },
    "speaking-scoring": { all: [reasoningCli, geminiJudge, "ffmpeg"] },
    "speaking-uploads": "ffmpeg",
  };
}

function satisfied(requirement: Requirement, present: (piece: SetupPiece) => boolean): boolean {
  if (typeof requirement === "string") return present(requirement);
  if ("all" in requirement) return requirement.all.every((r) => satisfied(r, present));
  return requirement.any.some((r) => satisfied(r, present));
}

/** The pieces that make an unsatisfied requirement fail: every failing branch of it. */
function blockers(requirement: Requirement, present: (piece: SetupPiece) => boolean): SetupPiece[] {
  if (satisfied(requirement, present)) return [];
  if (typeof requirement === "string") return [requirement];
  const children = "all" in requirement ? requirement.all : requirement.any;
  return children.flatMap((child) => blockers(child, present));
}

function cliStateForFailure(kind: ReasoningFailureKind | undefined): SetupCliState {
  if (kind === "missing-cli") return "not-installed";
  if (kind === "authentication") return "not-logged-in";
  return "unavailable";
}

// What an auth check can see for itself: whether the CLI is installed and whether it is logged in.
// A circuit opened for anything else (a quota, timeouts, provider errors) is not something a check
// that merely finds the CLI logged in can refute.
const CHECK_OBSERVABLE: ReadonlySet<ReasoningFailureKind | undefined> = new Set(["missing-cli", "authentication"]);

function cliState(
  provider: CliProvider,
  snapshot: readonly ProviderAvailabilitySnapshot[],
  preflight: Partial<Record<CliProvider, RecordedPreflight>>,
): SetupCliState {
  const live = snapshot.find((entry) => entry.provider === provider);
  const checked = preflight[provider];
  // A check with no live call outcome since it answered is the newest word on what it observes.
  if (checked?.current) {
    if (!checked.ok) return cliStateForFailure(checked.kind);
    if (live?.availability === "circuit-open" && !CHECK_OBSERVABLE.has(live.failureKind)) return "unavailable";
    return "ready";
  }
  if (live?.availability === "available") return "ready";
  if (live?.availability === "circuit-open") return cliStateForFailure(live.failureKind);
  if (!checked) return "checking";
  return checked.ok ? "ready" : cliStateForFailure(checked.kind);
}

const isSet = (value: string | undefined) => value !== undefined && value.trim().length > 0;

export function setupStatus(deps: SetupStatusDeps): SetupStatusVM {
  const settings = deps.settings();
  const snapshot = deps.providers();
  const preflight = deps.preflight();
  const claudeCli = cliState("claude", snapshot, preflight);
  const codexCli = cliState("codex", snapshot, preflight);
  const pieces: Record<SetupPiece, boolean | "unknown"> = {
    "claude-cli": claudeCli === "checking" ? "unknown" : claudeCli === "ready",
    "codex-cli": codexCli === "checking" ? "unknown" : codexCli === "ready",
    "gemini-api-key": isSet(settings.geminiApiKey),
    "openai-api-key": isSet(settings.openaiApiKey),
    "gemini-judge-model": isSet(settings.geminiJudgeModel),
    "openai-judge-model": isSet(settings.openaiJudgeModel),
    ffmpeg: deps.onPath("ffmpeg"),
    ffprobe: deps.onPath("ffprobe"),
  };
  // A capability is on only when everything it needs is known to be present; a piece is blamed
  // only when it is known to be missing. A CLI still being checked counts against neither.
  const knownPresent = (piece: SetupPiece) => pieces[piece] === true;
  const notKnownMissing = (piece: SetupPiece) => pieces[piece] !== false;

  const needs = requirements(settings.openaiTextPrimary);
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((capability) => [capability, satisfied(needs[capability], knownPresent)]),
  ) as Record<SetupCapability, boolean>;
  const missing = PIECES.filter((piece) => pieces[piece] === false).map((piece) => ({
    piece,
    disables: CAPABILITIES.filter((capability) => blockers(needs[capability], notKnownMissing).includes(piece)),
  }));

  return {
    claudeCli,
    codexCli,
    geminiApiKey: pieces["gemini-api-key"] === true,
    openaiApiKey: pieces["openai-api-key"] === true,
    geminiJudgeModel: pieces["gemini-judge-model"] === true,
    openaiJudgeModel: pieces["openai-judge-model"] === true,
    ffmpeg: pieces.ffmpeg === true,
    ffprobe: pieces.ffprobe === true,
    capabilities,
    missing,
    rubrics: { source: deps.rubricsSource() },
  };
}

export function buildSetupStatusRoutes(deps: SetupStatusDeps) {
  return new Hono()
    .get("/", (c) => c.json(setupStatus(deps)))
    .post("/recheck", async (c) => {
      await deps.recheckClis();
      return c.json(setupStatus(deps));
    });
}
