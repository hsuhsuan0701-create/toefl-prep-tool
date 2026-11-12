import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { config } from "../lib/config.js";
import { resolvePathWithinBase, resolveRealPathWithinBase } from "../lib/paths.js";
import { isWebp } from "../services/sceneImage.js";

// Serves the Listen and Repeat scene illustrations (data/images/scenarios/<setId>.webp). Mounted at
// /api/images, so a Set's stored listenAndRepeat.image.file ("images/scenarios/<setId>.webp",
// dataDir-relative) is served at exactly `/api/${image.file}`, as audio paths are under /api/audio.
// Only a file that really is a WebP is served.
export const imageRoutes = new Hono().get("/scenarios/:file", (c) => {
  const base = path.join(config.dataDir, "images/scenarios");
  const file = c.req.param("file");

  // Runs before the filename check so traversal answers 403, distinct from a missing or invalid
  // image's 404.
  try {
    resolvePathWithinBase(file, base);
  } catch {
    return c.body(null, 403);
  }
  if (path.basename(file) !== file || path.extname(file) !== ".webp") return c.body(null, 404);

  try {
    const target = resolveRealPathWithinBase(file, base);
    if (!fs.statSync(target).isFile()) return c.body(null, 404);
    const bytes = fs.readFileSync(target);
    // The same header check the scene writer applies before it publishes a file here.
    if (!isWebp(bytes)) return c.body(null, 404);
    return c.body(bytes, 200, {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  } catch {
    // Missing files, broken/escaping symlinks, and filesystem errors all fail closed without
    // exposing local paths or file contents.
    return c.body(null, 404);
  }
});
