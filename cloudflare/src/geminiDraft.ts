/**
 * Gemini -> gated academic Reading draft, not yet a full TOEFL Set.
 * Drafts must never be served as assessed exam questions before review.
 */
export type Draft = {
  title: string; discipline: string; passage: string;
  questions: Array<{
    id: string; stem: string; skill: string; correctOptionId: string; explanationZh: string;
    options: Array<{ id: string; text: string }>;
  }>;
};
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const good = (x: unknown): x is string => typeof x === "string" && !!x.trim();
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const skills = new Set(["main_idea", "detail", "inference", "vocabulary", "purpose", "organization", "figurative_language", "grammatical_complexity", "rhetorical_structure"]);
export function validateDraft(x: unknown): Draft {
  if (!isObj(x) || !good(x.title) || !good(x.discipline) || !good(x.passage)) throw new Error("Missing passage metadata");
  const words = x.passage.trim().split(/\s+/).length;
  if (words < 180 || words > 320) throw new Error("Passage must contain 180-320 words");
  if (!Array.isArray(x.questions) || x.questions.length !== 5) throw new Error("Exactly five questions required");
  const used = new Set<string>();
  for (const q of x.questions) {
    if (!isObj(q) || !good(q.id) || !good(q.stem) || !good(q.skill) || !good(q.explanationZh) || !good(q.correctOptionId)) throw new Error("Incomplete question");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(q.id) || used.has(q.id)) throw new Error("Invalid or duplicate question id");
    used.add(q.id);
    if (!skills.has(q.skill)) throw new Error("Invalid skill");
    if (q.explanationZh.trim().length < 25) throw new Error("Explanation too short");
    if (!Array.isArray(q.options) || q.options.length !== 4) throw new Error("Exactly four options required");
    const optionIds = new Set<string>(), optionTexts = new Set<string>();
    for (const opt of q.options) {
      if (!isObj(opt) || !good(opt.id) || !good(opt.text)) throw new Error("Invalid option");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(opt.id)) throw new Error("Invalid option id");
      optionIds.add(opt.id); optionTexts.add(norm(opt.text));
    }
    if (optionIds.size !== 4 || optionTexts.size !== 4 || !optionIds.has(q.correctOptionId)) throw new Error("Invalid answer choices");
  }
  return x as unknown as Draft;
}
const bag = (s: string) => new Set(norm(s).split(/\s+/).filter(Boolean));
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0; for (const v of a) if (b.has(v)) n++;
  return n / (a.size + b.size - n || 1);
}
function shingles(text: string): Set<string> {
  const w = norm(text).split(/\s+/);
  return new Set(w.slice(0, -4).map((_, i) => w.slice(i, i+5).join(" ")));
}
export function nearDuplicate(d: Draft, previous: readonly Draft[]): boolean {
  return previous.some(p => norm(d.title) === norm(p.title)
    || overlap(bag(d.title), bag(p.title)) >= .8
    || overlap(shingles(d.passage), shingles(p.passage)) >= .45);
}
export async function draftHash(d: Draft): Promise<string> {
  const bytes = new TextEncoder().encode(norm(d.title + " " + d.passage));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, "0")).join("");
}
const field = (type: string) => ({ type });
const schema = {
  type: "OBJECT", required: ["title","discipline","passage","questions"],
  properties: {
    title: field("STRING"), discipline: field("STRING"), passage: field("STRING"),
    questions: { type: "ARRAY", minItems: 5, maxItems: 5,
      items: { type: "OBJECT",
        required: ["id","stem","skill","correctOptionId","explanationZh","options"],
        properties: {
          id: field("STRING"), stem: field("STRING"), skill: field("STRING"),
          correctOptionId: field("STRING"), explanationZh: field("STRING"),
          options: { type: "ARRAY", minItems: 4, maxItems: 4,
            items: { type: "OBJECT", required: ["id","text"],
              properties: { id: field("STRING"), text: field("STRING") } } }
        }
      }
    }
  }
};
export async function geminiDraft(
  key: string, model: string, recentTitles: readonly string[], doFetch: typeof fetch = fetch
): Promise<Draft> {
  if (!key) throw new Error("Gemini key is missing");
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("Unsafe model name");
  const prompt = [
    "Create an ORIGINAL 2026 TOEFL-style academic reading practice draft. Do NOT reproduce official ETS items or copyrighted articles.",
    "Provide a coherent academic passage of 180-320 English words and exactly 5 four-option MCQs.",
    "Include distinct skills: main_idea, detail, inference, vocabulary, purpose. Only one defensible correct option per question.",
    "Use question IDs q1..q5, option IDs A/B/C/D and an explanation in Traditional Chinese at least 25 chars per item.",
    "CorrectOptionId must match one option. Every distractor must be plausible and demonstrably wrong.",
    "Avoid these previously used topics and titles: " + JSON.stringify(recentTitles.slice(0,30)),
    "Return valid JSON only."
  ].join("\n");
  const response = await doFetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.7 } }),
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error("Gemini HTTP " + response.status);
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const result = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("");
  if (!result) throw new Error("Gemini returned no usable draft");
  let parsed: unknown;
  try { parsed = JSON.parse(result); } catch { throw new Error("Gemini returned invalid JSON"); }
  return validateDraft(parsed);
}
