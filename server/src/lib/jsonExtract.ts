type Extracted = { ok: true; value: unknown } | { ok: false; error: string };

export function extractJsonObject(text: string): Extracted {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) {
    return { ok: false, error: "no JSON object" };
  }
  try {
    return { ok: true, value: JSON.parse(text.slice(first, last + 1)) };
  } catch {
    return { ok: false, error: "JSON parse failed" };
  }
}

export function extractClaudeJson(stdout: string): Extracted {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "stdout is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "claude envelope is not an object" };
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.subtype !== "success") {
    return { ok: false, error: `claude result subtype: ${String(envelope.subtype)}` };
  }
  if (envelope.structured_output !== undefined) {
    return { ok: true, value: envelope.structured_output };
  }
  const text = typeof envelope.result === "string" ? envelope.result : "";
  const extracted = extractJsonObject(text);
  if (!extracted.ok) {
    return {
      ok: false,
      error:
        extracted.error === "no JSON object"
          ? "no JSON object in result"
          : "result JSON parse failed",
    };
  }
  return extracted;
}
