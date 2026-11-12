/**
 * The environment the server suite runs in, whatever shell launched it.
 *
 * `vitest run` loads no .env, but it inherits the launching shell: a developer who exports an API
 * key, a CI job with secrets in scope, or a Claude Code session (which exports CLAUDE_EFFORT into
 * every shell it starts) would otherwise hand those values to config.ts. Two things follow from
 * that and both are wrong in a test: a real credential sits in process.env where a forgotten mock
 * can spend it, and a test's outcome depends on the machine it ran on.
 *
 * So the policy is deny-by-family. Every variable whose name starts with one of the server's
 * configuration prefixes is deleted, which leaves config.ts on its own defaults, and the handful
 * the suite needs set are then pinned. `hermeticEnv.test.ts` scans server/src for every variable
 * name the server reads and fails if one is neither scrubbed nor pinned, so a new setting cannot
 * silently reopen the hole.
 */

/** Deleted from process.env before any test module loads. */
export const SCRUBBED_PREFIXES = [
  "CLAUDE_",
  "CODEX_",
  "GEMINI_",
  "OPENAI_",
  "TTS_",
  "MODEL_CALL_",
  "SHUTDOWN_",
  "REASONING_",
  "GENERATION_",
  "TOEFL_",
] as const;

/** Deleted outright: settings whose names share no prefix family. */
export const SCRUBBED_NAMES = ["PORT"] as const;

/**
 * Set to a fixed value after scrubbing.
 *
 * The two judge model ids are required settings (the judges throw a configuration error without
 * them); the audio judge's real default is replaced so no assertion can come to depend on a
 * production model id. The CLI binaries point at a path that cannot exist, so a test that forgets
 * to inject a fake runner gets an ENOENT naming that path instead of a real `claude` or `codex`
 * process. NODE_ENV keeps index.ts from booting a server when a test imports it.
 */
export const PINNED: Readonly<Record<string, string>> = {
  NODE_ENV: "test",
  GEMINI_JUDGE_MODEL: "test-gemini-judge-model",
  OPENAI_JUDGE_MODEL: "test-openai-judge-model",
  OPENAI_AUDIO_JUDGE_MODEL: "test-openai-audio-judge-model",
  CLAUDE_BIN: "/nonexistent/toefl-prep-tool-test/claude",
  CODEX_BIN: "/nonexistent/toefl-prep-tool-test/codex",
};

/**
 * Read by the server and deliberately left alone. `VITEST` is set by vitest itself in every worker.
 * `PATH` and `PATHEXT` are the operating system's executable search path: setup-status scans them
 * for ffmpeg and ffprobe, and the one suite that runs the real binaries needs them intact. They
 * carry no credential and select no provider.
 */
export const INHERITED = ["VITEST", "PATH", "PATHEXT"] as const;

export function isScrubbed(name: string): boolean {
  return (
    SCRUBBED_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    (SCRUBBED_NAMES as readonly string[]).includes(name)
  );
}

/** Applies the policy to `env` in place: scrub every family, then pin. */
export function applyHermeticEnv(env: Record<string, string | undefined>): void {
  for (const name of Object.keys(env)) {
    if (isScrubbed(name)) delete env[name];
  }
  Object.assign(env, PINNED);
}
