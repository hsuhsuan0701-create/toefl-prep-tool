/**
 * Read-only Gemini credential and model check. No generateContent invocation or billable tokens.
 * Never log, return or embed the key in the response.
 */
export async function checkGeminiModel(
  key: string | undefined,
  model: string,
  doFetch: typeof fetch = fetch,
): Promise<{ keyConfigured: boolean; model: string; modelAccessible: boolean; supportsGenerateContent: boolean | null; httpStatus?: number; error?: string }> {
  if (!key) return { keyConfigured: false, model, modelAccessible: false, supportsGenerateContent: null, error: "Gemini secret missing" };
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(model)) {
    return { keyConfigured: true, model: "invalid-model-id", modelAccessible: false, supportsGenerateContent: null, error: "Invalid model ID" };
  }
  try {
    const response = await doFetch("https://generativelanguage.googleapis.com/v1beta/models/" + model, {
      method: "GET",
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      return { keyConfigured: true, model, modelAccessible: false, supportsGenerateContent: null,
        httpStatus: response.status, error: response.status === 404 ? "Model not found or unavailable" : "Gemini API refused model metadata request" };
    }
    const data = await response.json() as { name?: string; supportedGenerationMethods?: string[] };
    const methods = data.supportedGenerationMethods;
    return { keyConfigured: true, model, modelAccessible: data.name === "models/" + model,
      supportsGenerateContent: Array.isArray(methods) ? methods.includes("generateContent") : null };
  } catch {
    return { keyConfigured: true, model, modelAccessible: false, supportsGenerateContent: null, error: "Gemini request failed or timed out" };
  }
}
