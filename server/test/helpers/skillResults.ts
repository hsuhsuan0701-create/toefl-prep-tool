import type { SkillTaskRequest } from "../../src/services/reasoning/router.js";

/** What the reasoning router resolves with when a skill task succeeded on `provider`. */
export function skillSuccess<T, P extends "claude" | "codex" = "claude">(value: T, provider: P = "claude" as P) {
  return { ok: true as const, value, provider, attempts: [] };
}

/**
 * What the reasoning router does with a `parse` that throws: it is an invalid-output failure, never
 * a rejected promise. A fake that calls `request.parse` bare would turn every parse-time check into
 * an exception the loop never sees as a failed call.
 */
export function routed<T>(request: SkillTaskRequest<T>, value: unknown) {
  try {
    return skillSuccess(request.parse(value));
  } catch (error) {
    return {
      ok: false as const,
      error: `invalid output: ${error instanceof Error ? error.message : String(error)}`,
      attempts: [{ provider: "claude" as const, kind: "invalid-output" as const }],
    };
  }
}
