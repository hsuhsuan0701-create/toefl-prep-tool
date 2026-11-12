import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FocusRegionSchema, type FocusRegion, type SpeakingSet } from "@toefl-prep/shared";
import { config } from "../lib/config.js";
import { resolveRealPathWithinBase } from "../lib/paths.js";
import {
  JudgeError,
  safeResponseJson,
  withJudgeRetries,
  type JudgeCallResult,
} from "./judges/index.js";

// The illustrated scene a Listen and Repeat Set shows while its sentences play (ADR 0014). Two
// independent steps, so the caller can survive a failure in either (a Set with audio and no picture
// is still fully practisable): generateSceneImage paints the scene, and locateFocusRegions asks a
// vision model where each sentence's object ended up in it.

export type Region = FocusRegion;

// Not configurable: the STYLE prompt below was validated against this model.
export const SCENE_IMAGE_MODEL = "gpt-image-2";

// VERBATIM FIXTURE: do not reword. This text was validated live against the official ETS reference
// illustration (ADR 0014). "WATER AND SWIMMING POOLS ARE GRAY, NOT BLUE OR CYAN" and the "COMPLETELY
// FLAT FILL ... NO gradients" clause each fix a failure seen in live generation (a blue pool,
// gradient shading). sceneImage.test.ts fails on any change to the composed prompt, but no test can
// tell whether a reworded prompt still produces the validated style.
const STYLE = `FLAT VECTOR INFOGRAPHIC ILLUSTRATION, one square image.

VIEW: elevated three-quarter "illustrated map" view of the whole location at once, quasi-isometric — the ground/floor is drawn as flattened foreshortened shapes seen from above at an angle, while furniture, equipment and people are drawn in near-side elevation. The entire setting is visible in one frame, like a hand-drawn guide map of the place.

COLOR — this is the most important rule. The environment is STRICTLY GRAYSCALE / ACHROMATIC: near-white background (#FAFAFA), pale gray surfaces (#E6E6E6), mid grays (#D2D2D2, #C8C8C8), darker gray for the nearest foreground (#A0A0A0), and dark gray to near-black line work (#505050). NO color anywhere in the environment — no blue, no green, no brown floors, no colored walls. This applies without exception to things that are normally colored: WATER AND SWIMMING POOLS ARE GRAY, NOT BLUE OR CYAN; glass is gray; plants, trees and grass are gray, not green; sky is near-white.

SPOT COLOR: exactly one accent hue, a soft muted teal (#00A082), used ONLY as a rounded organic highlight blob sitting behind and hugging the silhouette of each KEY OBJECT listed below, making those objects pop out of the gray scene. The key objects themselves may be muted golden-tan (#FABE50) or rust brown (#965A32). Nothing else in the picture carries any hue.

LINE: crisp, clean, uniform thin line weight throughout, like a printed vector diagram rather than a pencil sketch. Every surface is a COMPLETELY FLAT FILL of one single solid tone — NO gradients, NO soft shading, NO drop shadows, NO ambient occlusion, NO texture, NO hatching, NO photorealism, NO 3D rendering. Depth is conveyed only by stacking flat bands of different gray tones.

PEOPLE: a few small, simple, FACELESS grayscale figures in candid poses — plain oval heads with no facial features at all, no skin tone, no clothing color.

FRAMING: the illustration sits inside a thin black rectangular border with a generous clean margin. Uncluttered and airy, not crowded.

ABSOLUTELY NO TEXT: no letters, no words, no numbers, no labels, no captions, no signage text, no logos, no watermarks, no arrows. Any sign must be blank or a wordless pictogram only.`;

// Everything after the sentence list; as much a validated fixture as STYLE.
const CLOSING =
  "Depict the physical places and things named above (the counter, the doors, the rooms, the equipment) " +
  "as recognizable drawn objects in their spatial relationship to each other. Do not write any of these " +
  "words in the image — show them as pictures only.";

const KEY_OBJECTS_LEAD_IN =
  "Draw the location as a single connected scene. These are the KEY OBJECTS and areas that must be " +
  "clearly visible and individually recognizable, each marked with the teal highlight blob:";

// setId becomes a filename here, so it is constrained before it is joined onto a path.
const SET_ID_RE = /^[A-Za-z0-9_-]+$/;

// WebP at quality 80: about a ninth of PNG's size with no visible loss on flat vector art, which
// matters because these files are committed with the Set (measurements in ADR 0014).
const IMAGE_EXT = "webp";
const IMAGE_COMPRESSION = 80;

// A WebP file is a RIFF container: "RIFF" at offset 0, then a 4-byte size, then "WEBP" at offset 8.
// Both markers are checked because "RIFF" alone also matches WAV/AVI.
const RIFF_MAGIC = Buffer.from("RIFF", "ascii");
const WEBP_MAGIC = Buffer.from("WEBP", "ascii");
const WEBP_HEADER_LEN = 12;

/** True when `bytes` start with a WebP file header. */
export function isWebp(bytes: Buffer): boolean {
  return (
    bytes.length >= WEBP_HEADER_LEN &&
    bytes.subarray(0, 4).equals(RIFF_MAGIC) &&
    bytes.subarray(8, 12).equals(WEBP_MAGIC)
  );
}

// The mime type Gemini is told for the uploaded image, from its extension: locateFocusRegions takes
// any image path, and an older scene may be a .png.
function imageMimeType(imagePath: string): string {
  return path.extname(imagePath).toLowerCase() === ".png" ? "image/png" : "image/webp";
}

// The canonical location of one Set's scene image: `file` is what the Set JSON stores
// (dataDir-relative, forward slashes; it is also the URL path under /api/, see routes/images.ts), and
// `path` is the filesystem path.
export function sceneImageLocation(
  setId: string,
  dataDir = config.dataDir,
): { file: string; path: string } {
  const name = `${setId}.${IMAGE_EXT}`;
  return { file: `images/scenarios/${name}`, path: path.join(dataDir, "images", "scenarios", name) };
}

type FileIdentity = Pick<fs.Stats, "dev" | "ino">;

function regularFileIdentity(file: string): FileIdentity | null {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? { dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

// Whether `file` holds exactly `bytes`. Identity by inode alone cannot prove ownership: a file
// system that hands a freed inode number straight to the next file (ext4 does, APFS does not) gives
// a file deleted and recreated at the same path the same `dev` and `ino`, and a file rewritten in
// place keeps them on every file system. The bytes this attempt wrote are what it owns.
function fileHoldsBytes(file: string, bytes: Buffer): boolean {
  try {
    return fs.lstatSync(file).size === bytes.length && fs.readFileSync(file).equals(bytes);
  } catch {
    return false;
  }
}

function assertOwnedSceneFile(
  file: string,
  expectedIdentity: FileIdentity,
  stage: string,
  expectedBytes?: Buffer,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    // Missing means the publication transaction lost ownership. Preserve other filesystem errors
    // (permissions, I/O failure) as the originating failure instead of disguising them.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    throw new SceneImageError("unsafe-publication", `${stage}: owned file disappeared`);
  }
  if (
    !stat.isFile() ||
    stat.dev !== expectedIdentity.dev ||
    stat.ino !== expectedIdentity.ino
  ) {
    throw new SceneImageError("unsafe-publication", `${stage}: owned file identity changed`);
  }
  if (expectedBytes && !fileHoldsBytes(file, expectedBytes)) {
    throw new SceneImageError("unsafe-publication", `${stage}: owned file content changed`);
  }
}

function removeOwnedSceneFile(file: string, expectedIdentity?: FileIdentity, expectedBytes?: Buffer): boolean {
  try {
    // The atomic writer owns regular files only. Never recurse through or unlink a directory,
    // symlink, FIFO, or other unresolved collision that happens to use one of its exact names.
    const identity = regularFileIdentity(file);
    if (!identity) return false;
    if (
      expectedIdentity &&
      (identity.dev !== expectedIdentity.dev || identity.ino !== expectedIdentity.ino)
    ) return false;
    if (expectedBytes && !fileHoldsBytes(file, expectedBytes)) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

function listSceneDirectory(dir: string): string[] {
  try {
    // lstat avoids following an unrelated symlink at the shared scenarios-directory boundary.
    if (!fs.lstatSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function existingOwnedSceneDirectory(dataDir: string): string | null {
  try {
    const base = path.resolve(dataDir);
    const images = path.join(base, "images");
    const scenarios = path.join(images, "scenarios");
    // Every existing component is checked with lstat before realpath containment. This rejects a
    // symlink at dataDir, images, or scenarios even when it happens to point back inside.
    if (!fs.lstatSync(base).isDirectory()) return null;
    if (!fs.lstatSync(images).isDirectory()) return null;
    if (!fs.lstatSync(scenarios).isDirectory()) return null;
    return resolveRealPathWithinBase(scenarios, base);
  } catch {
    return null;
  }
}

function ensureOwnedSceneDirectory(dataDir: string): string {
  const base = path.resolve(dataDir);
  try {
    if (!fs.lstatSync(base).isDirectory()) throw new Error("dataDir is not a real directory");
    for (const dir of [path.join(base, "images"), path.join(base, "images", "scenarios")]) {
      try {
        const stat = fs.lstatSync(dir);
        if (!stat.isDirectory()) throw new Error(`${dir} is not a real directory`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        fs.mkdirSync(dir);
        if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a real directory`);
      }
    }
    const verified = existingOwnedSceneDirectory(base);
    if (!verified) throw new Error("scene directory containment could not be proven");
    return verified;
  } catch (err) {
    throw new SceneImageError(
      "unsafe-path",
      `${base}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Removes every file the scene-image writer can own for exactly one Set id: the canonical WebP and
 * any temp files a hard kill left in the same directory. Returns whether anything was removed. The
 * `.${setId}.` boundary keeps `spk-one` from sweeping `spk-one-more`, and the id check keeps a
 * malformed id from widening the scan. Whether the Set is safe to clean (not yet published) is the
 * caller's check (setArtifacts.ts).
 */
export function cleanupSceneImageArtifacts(setId: string, dataDir = config.dataDir): boolean {
  if (!SET_ID_RE.test(setId)) return false;

  // Validate the complete parent chain BEFORE even lstat'ing the canonical child: lstat follows
  // symlinked parents, so doing this second could unlink an external same-named file.
  const dir = existingOwnedSceneDirectory(dataDir);
  if (!dir) return false;
  const canonical = path.join(dir, `${setId}.${IMAGE_EXT}`);
  let removedAnything = removeOwnedSceneFile(canonical);

  for (const temp of sceneTempFiles(dir, setId)) {
    // Each matching temp gets its own boundary: one collision or permission failure cannot stop
    // later exact-set temps from being removed.
    if (removeOwnedSceneFile(temp)) removedAnything = true;
  }
  return removedAnything;
}

/**
 * The temp files a scene write for exactly `setId` left in `dir`, the owned scenarios directory. The
 * `.${setId}.` boundary keeps `spk-one` from matching `spk-one-more`.
 */
function sceneTempFiles(dir: string, setId: string): string[] {
  const prefix = `.${setId}.`;
  const suffix = `.${IMAGE_EXT}.tmp`;
  return listSceneDirectory(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => path.join(dir, name));
}

/**
 * The temp files a scene write for `setId` has left, for recording as cleanup debt beside the
 * canonical WebP (sceneImageLocation). Their names carry a random suffix, so only a listing finds
 * them; it is taken once the run has stopped, so no write can add one afterwards. Empty when the
 * scenarios directory is missing or not this writer's, which is also when cleanupSceneImageArtifacts
 * would remove nothing.
 */
export function sceneImageTempPaths(setId: string, dataDir = config.dataDir): string[] {
  if (!SET_ID_RE.test(setId)) return [];
  const dir = existingOwnedSceneDirectory(dataDir);
  return dir ? sceneTempFiles(dir, setId) : [];
}

export class SceneImageError extends Error {
  constructor(public status: number | string, msg: string) {
    super(`scene image ${status}: ${msg}`);
  }
}

export type Deps = {
  fetch?: typeof fetch;
  // Where the canonical bytes are written. The stored `file` stays data-relative either way.
  dataDir?: string;
  // The generation job's cancellation. Each request takes it, and the vision call's retry backoff
  // ends on it, so a cancelled job stops waiting on either paid call.
  signal?: AbortSignal;
};

// Structural rather than SpeakingSet["listenAndRepeat"] so a prompt can be composed from a Set that
// is still being built and has no image field yet.
export type ScenePromptInput = Pick<
  SpeakingSet["listenAndRepeat"],
  "scenarioTitle" | "scenarioDescription"
> & { items: readonly { sentence: string }[] };

/**
 * Attaches a generated scene to a Set: the image on listenAndRepeat, and each located region on its
 * own item (replacing any region the item had). `regions` is index-aligned with the items, as
 * locateFocusRegions returns them; an off-by-one would put every ring on the wrong object and
 * nothing in the types would notice. null means no ring, and a shorter array leaves the tail without
 * regions.
 */
export function applyScene(
  set: SpeakingSet,
  image: SpeakingSet["listenAndRepeat"]["image"],
  regions: readonly (Region | null)[]
): SpeakingSet {
  return {
    ...set,
    listenAndRepeat: {
      ...set.listenAndRepeat,
      image,
      items: set.listenAndRepeat.items.map((item, i) => {
        const { focusRegion: _focusRegion, ...withoutRegion } = item;
        const region = regions[i];
        return region ? { ...withoutRegion, focusRegion: region } : withoutRegion;
      }),
    },
  };
}

/**
 * The full image prompt for a scene: the fixed STYLE, the scenario, the Listen and Repeat sentences
 * as the key objects to draw, and the fixed closing. sceneImage.test.ts pins its output.
 */
export function composeScenePrompt(lr: ScenePromptInput): string {
  const keyObjects = lr.items.map((item) => `- ${item.sentence}`).join("\n");
  return [
    STYLE,
    `SCENE TO ILLUSTRATE: ${lr.scenarioTitle}. ${lr.scenarioDescription}`,
    `${KEY_OBJECTS_LEAD_IN}\n${keyObjects}`,
    CLOSING,
  ].join("\n\n");
}

/**
 * Generates the scene with OpenAI's image model, writes it atomically to its canonical location, and
 * returns exactly the object that goes into the Set's listenAndRepeat.image field. Throws
 * SceneImageError on a failed request or a reply that is not a WebP, removing whatever file this
 * call wrote.
 */
export async function generateSceneImage(
  setId: string,
  lr: ScenePromptInput,
  deps: Deps = {}
): Promise<{ file: string; prompt: string; model: typeof SCENE_IMAGE_MODEL }> {
  if (!SET_ID_RE.test(setId)) {
    throw new SceneImageError("bad-set-id", `set id "${setId}" contains characters outside [A-Za-z0-9_-]`);
  }
  const doFetch = deps.fetch ?? fetch;
  const prompt = composeScenePrompt(lr);

  deps.signal?.throwIfAborted();
  const res = await doFetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    ...(deps.signal ? { signal: deps.signal } : {}),
    headers: { Authorization: `Bearer ${config.openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: SCENE_IMAGE_MODEL,
      prompt,
      size: "1024x1024",
      n: 1,
      output_format: IMAGE_EXT,
      output_compression: IMAGE_COMPRESSION,
    }),
  });
  if (!res.ok) throw new SceneImageError(res.status, (await res.text()).slice(0, 300));

  const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const first = json.data?.[0];
  let bytes: Buffer;
  if (first?.b64_json) {
    bytes = Buffer.from(first.b64_json, "base64");
  } else if (first?.url) {
    // The images API returns either inline base64 or a short-lived URL depending on account/model
    // settings; handle both rather than depending on one being configured.
    const img = await doFetch(first.url, deps.signal ? { signal: deps.signal } : undefined);
    if (!img.ok) throw new SceneImageError(img.status, `fetching generated image url failed`);
    bytes = Buffer.from(await img.arrayBuffer());
  } else {
    throw new SceneImageError("no-image", "response contained neither b64_json nor url");
  }

  // Checked before anything touches the filesystem: Buffer.from(x, "base64") silently drops what it
  // cannot decode, so a truncated or non-base64 payload would otherwise be published as a broken
  // image with no error anywhere.
  if (!isWebp(bytes)) {
    throw new SceneImageError("bad-webp", `decoded ${bytes.length} bytes that are not a WebP`);
  }

  const dataDir = deps.dataDir ?? config.dataDir;
  const { file } = sceneImageLocation(setId, dataDir);
  const dir = ensureOwnedSceneDirectory(dataDir);
  const dest = path.join(dir, `${setId}.${IMAGE_EXT}`);
  // Temp file in the same directory (rename is atomic only within one filesystem), with a random
  // suffix so two concurrent generations cannot collide. A half-written image is never visible at the
  // final path.
  const tmp = path.join(dir, `.${setId}.${crypto.randomUUID().slice(0, 8)}.${IMAGE_EXT}.tmp`);
  let tmpFd: number | null = null;
  let tmpIdentity: FileIdentity | null = null;
  let canonicalPublished = false;
  const closeTemp = () => {
    if (tmpFd === null) return;
    // Clear first so even a close failure cannot make the catch branch attempt the same descriptor
    // twice (and potentially close an unrelated descriptor if the OS has already reused its number).
    const fd = tmpFd;
    tmpFd = null;
    fs.closeSync(fd);
  };
  try {
    // "wx" atomically creates a brand-new name and rejects any existing file or symlink. Capture
    // identity from the open descriptor before writing a byte: if a write partially succeeds and
    // then throws, cleanup can prove that the pathname still names this attempt's inode.
    tmpFd = fs.openSync(tmp, "wx");
    const tmpStat = fs.fstatSync(tmpFd);
    if (!tmpStat.isFile()) {
      throw new SceneImageError("unsafe-temp", "scene temp descriptor is not a regular file");
    }
    tmpIdentity = { dev: tmpStat.dev, ino: tmpStat.ino };
    fs.writeFileSync(tmpFd, bytes);
    closeTemp();
    assertOwnedSceneFile(tmp, tmpIdentity, "before scene publication", bytes);
    fs.renameSync(tmp, dest);
    canonicalPublished = true;
    assertOwnedSceneFile(dest, tmpIdentity, "after renamed scene publication", bytes);
  } catch (err) {
    // A failure can come after the owned file is already at the canonical path. Roll it back only
    // while it is still the file this attempt wrote, by identity and by content; replacements and
    // pre-existing paths are not ours. The temp file is checked by identity alone, because a write
    // that failed part-way leaves it short of the bytes. Every recovery attempt is best-effort so
    // the transaction's original failure wins.
    try {
      closeTemp();
    } catch {
      // Preserve the operation's original failure; pathname cleanup below remains identity-guarded.
    }
    const stillOwnedDir = existingOwnedSceneDirectory(dataDir);
    if (stillOwnedDir === dir && tmpIdentity) {
      if (canonicalPublished) removeOwnedSceneFile(dest, tmpIdentity, bytes);
      removeOwnedSceneFile(tmp, tmpIdentity);
    }
    throw err;
  }
  return { file, prompt, model: SCENE_IMAGE_MODEL };
}

// Wire shape only — the 0–1 range check and the "is this box usable" decision are
// FocusRegionSchema's job in toRegions below, so a single out-of-range number costs that one
// sentence its ring instead of failing the whole reply and burning the repair retry.
const VisionReplySchema = z.object({
  regions: z.array(
    z.object({
      index: z.number(),
      depicted: z.boolean(),
      x: z.number().optional(),
      y: z.number().optional(),
      w: z.number().optional(),
      h: z.number().optional(),
    })
  ).superRefine((regions, ctx) => {
    const seen = new Set<number>();
    regions.forEach((region, i) => {
      if (seen.has(region.index)) {
        ctx.addIssue({ code: "custom", path: [i, "index"], message: `duplicate index ${region.index}` });
      }
      seen.add(region.index);
    });
  }),
});

// Gemini structured-output schema (OpenAPI subset). x/y/w/h are deliberately NOT required: the
// model omits them for a sentence the illustration does not depict, which is a normal outcome.
const VISION_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    regions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          index: { type: "INTEGER" },
          depicted: { type: "BOOLEAN" },
          x: { type: "NUMBER" },
          y: { type: "NUMBER" },
          w: { type: "NUMBER" },
          h: { type: "NUMBER" },
        },
        required: ["index", "depicted"],
      },
    },
  },
  required: ["regions"],
};

const INVALID_JSON_NUDGE = "Your previous output was invalid. Output ONLY the JSON object.";

/**
 * Asks a Gemini vision call where each sentence's object sits in the scene image, as a normalised
 * box. Always returns sentences.length entries; null means "no ring for this sentence" and is a
 * normal result: ETS's own illustrations do not depict every noun their sentences name. imagePath is a
 * filesystem path; callers join a Set's image.file onto config.dataDir.
 *
 * Throws exactly two error types, and a caller must handle both:
 *   - JudgeError("gemini-vision", …) for the model call: an HTTP status, or "invalid-json" for a
 *     reply still malformed after the one repair. The label tells these apart from Judge calls in
 *     logs.
 *   - SceneImageError("unreadable-image", …) when imagePath cannot be read. The read is wrapped so
 *     a bare ENOENT never escapes to fail a generation job.
 */
export async function locateFocusRegions(
  imagePath: string,
  sentences: string[],
  deps: Deps = {}
): Promise<(Region | null)[]> {
  if (sentences.length === 0) return [];
  const doFetch = deps.fetch ?? fetch;
  let base64: string;
  try {
    base64 = fs.readFileSync(imagePath).toString("base64");
  } catch (err) {
    throw new SceneImageError("unreadable-image", `${imagePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // withJudgeRetries handles 429/5xx backoff; one further retry re-sends the prompt and image with a
  // correction note when the reply is structurally invalid. A valid reply returns at once, even one
  // that locates nothing: retrying it would pressure the model into inventing boxes (ADR 0014).
  const mimeType = imageMimeType(imagePath);
  let p = composeVisionPrompt(sentences);
  for (let attempt = 0; ; attempt++) {
    const text = await withJudgeRetries("gemini-vision", () => geminiVisionCall(p, base64, mimeType, doFetch, deps.signal), deps.signal);
    const reply = safeParseReply(text);
    if (reply) return toRegions(reply, sentences.length);
    if (attempt >= 1) {
      throw new JudgeError("gemini-vision", "invalid-json");
    }
    p = `${p}\n\n${INVALID_JSON_NUDGE}`;
  }
}

function composeVisionPrompt(sentences: string[]): string {
  const numbered = sentences.map((s, i) => `${i}. ${s}`).join("\n");
  return `You are looking at one illustrated scene from a TOEFL Listen and Repeat task, and the sentences a test taker hears while it is on screen.

The illustration is grayscale except for a soft teal (#00A082) highlight blob drawn behind each focal object. Those blobs mark the objects the sentences are about, so they are your intended targets.

For each numbered sentence below, find the object, place or piece of equipment in the image that the sentence refers to, and report its bounding box in NORMALISED coordinates: x and y are the top-left corner as fractions of the image width and height, w and h are the width and height as fractions. All four are between 0 and 1.

If the illustration does not depict that sentence's object, set "depicted" to false and omit x, y, w and h. Do NOT guess a box — a missing box is a normal, correct answer, and a wrong one puts a highlight on the wrong thing.

Return ONLY this JSON object, with exactly one entry per sentence, in order:
{"regions":[{"index":0,"depicted":true,"x":0.0,"y":0.0,"w":0.0,"h":0.0}]}

SENTENCES:
${numbered}`;
}

function safeParseReply(text: string): z.infer<typeof VisionReplySchema> | null {
  try {
    const first = text.indexOf("{"), last = text.lastIndexOf("}");
    if (first === -1 || last <= first) return null;
    return VisionReplySchema.parse(JSON.parse(text.slice(first, last + 1)));
  } catch { return null; }
}

function toRegions(reply: z.infer<typeof VisionReplySchema>, count: number): (Region | null)[] {
  const out: (Region | null)[] = Array.from({ length: count }, () => null);
  for (const r of reply.regions) {
    if (!Number.isInteger(r.index) || r.index < 0 || r.index >= count) continue;
    if (r.depicted === false) continue;
    const parsed = FocusRegionSchema.safeParse({ x: r.x, y: r.y, w: r.w, h: r.h });
    // A box the model got wrong (a missing coordinate, pixels instead of fractions, a negative
    // size) costs that sentence its ring, not the other six. The geometry checks are
    // FocusRegionSchema's, so stored Sets and vision output obey the same rules.
    if (!parsed.success) continue;
    out[r.index] = parsed.data;
  }
  return out;
}

async function geminiVisionCall(
  prompt: string,
  base64Image: string,
  mimeType: string,
  doFetch: typeof fetch,
  signal?: AbortSignal,
): Promise<JudgeCallResult> {
  if (!config.geminiJudgeModel) throw new JudgeError("gemini-vision", "config", "GEMINI_JUDGE_MODEL not set");
  const res = await doFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiJudgeModel}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.geminiKey ?? "" },
      ...(signal ? { signal } : {}),
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Image } }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: VISION_RESPONSE_SCHEMA,
        },
      }),
    }
  );
  if (!res.ok) {
    return { ok: false as const, status: res.status };
  }
  const json = await safeResponseJson<{
    candidates?: {
      content?: { parts?: { text?: string }[] };
    }[];
  }>(res);
  return {
    ok: true as const,
    text: json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
  };
}
