import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { config } from "../lib/config.js";
import { resolvePathWithinBase, resolveRealPathWithinBase } from "../lib/paths.js";

// Serves the two kinds of audio file the app plays: generated stimulus clips, always
// `stimuli/<setId>/<file>.mp3` (every player fetches `/api/audio/${item.audio}` verbatim), and
// recorded responses, whose path spans segments (`responses/<attemptId>/<itemId>.webm`, and the
// Drill Lab's `responses/drill-lab/<setId>/<itemId>/<repId>.webm`).
//
// Three guards, each tested in routes.sets.test.ts:
//   1. lexical containment (resolvePathWithinBase), which also keeps a sibling directory such as
//      "stimuli-evil" from passing as inside "stimuli". Answered 403, distinct from a missing file.
//   2. canonical containment (resolveRealPathWithinBase): the lexical check cannot see through a
//      symlink, so the resolved target must also sit under the canonical base.
//   3. an extension allow-list. Both renderers write audio-manifest.json into the served directory,
//      and its per-clip wordCount gives away the length of every Listen and Repeat sentence and
//      interview question. It also keeps the upload route's `.tmp-<uuid>` staging files unservable.
// Everything else fails closed as 404 without revealing a path or a filesystem error.
const CONTENT_TYPES: Record<string, string> = { ".mp3": "audio/mpeg", ".webm": "audio/webm" };

function serveAudio(c: Context, baseRelative: string, requested: string, allowedExtensions: readonly string[]) {
  const base = path.join(config.dataDir, baseRelative);
  try {
    resolvePathWithinBase(requested, base);
  } catch {
    return c.body(null, 403);
  }
  const extension = path.extname(requested);
  if (!allowedExtensions.includes(extension)) return c.body(null, 404);
  try {
    const target = resolveRealPathWithinBase(requested, base);
    if (!fs.statSync(target).isFile()) return c.body(null, 404);
    return c.body(fs.readFileSync(target), 200, { "Content-Type": CONTENT_TYPES[extension] });
  } catch {
    return c.body(null, 404);
  }
}

export const audioRoutes = new Hono()
  // Only .mp3: the renderers write nothing else a client is meant to fetch.
  .get("/stimuli/:setId/:file", (c) =>
    serveAudio(c, "audio/stimuli", `${c.req.param("setId")}/${c.req.param("file")}`, [".mp3"]))
  // Recorded responses plus each one's transcoded .mp3 sibling.
  .get("/responses/:mediaPath{.+}", (c) => serveAudio(c, "audio/responses", c.req.param("mediaPath"), [".webm", ".mp3"]));
