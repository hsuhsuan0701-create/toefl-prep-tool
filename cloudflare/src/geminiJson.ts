/**
 * Structured Gemini requests shared by single-passage diagnostics and full Reading refill.
 * Temporary upstream failures retry with bounded exponential backoff; provider content
 * and API keys are never logged or included in thrown errors.
 */
export async function geminiJson<T>(
  key: string,
  model: string,
  prompt: string,
  parse: (value: unknown) => T,
  doFetch: typeof fetch = fetch,
  opts: { maxOutputTokens?: number; temperature?: number; responseSchema?: object } = {},
): Promise<T> {
  if (!key) throw new Error("Gemini key is missing");
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("Unsafe model name");
  const transient = new Set([408, 429, 500, 502, 503, 504]);
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await doFetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: opts.temperature ?? 0.6,
          ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
          ...(opts.responseSchema ? { responseSchema: opts.responseSchema } : {}),
        },
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (response.ok || !transient.has(response.status) || attempt === 2) break;
    await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt) + Math.floor(Math.random() * 250)));
  }
  if (!response?.ok) throw new Error("Gemini HTTP " + (response?.status ?? "unknown"));
  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const result = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("");
  if (!result) throw new Error("Gemini returned no usable JSON");
  let parsed: unknown;
  try { parsed = JSON.parse(result); } catch { throw new Error("Gemini returned invalid JSON"); }
  try { return parse(parsed); } catch {
    // Never echo an answer-bearing candidate or potentially provider-supplied text.
    throw new Error("Gemini output failed required validation");
  }
}
