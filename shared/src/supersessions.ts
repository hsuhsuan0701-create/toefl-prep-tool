import { z } from "zod";
import { SafeIdSchema } from "./schemas.js";

// `data/question-sets/supersessions.json`: which banked Sets are retired and which Set replaced
// each one (ADR 0011). Question Sets are immutable JSON, so retirement cannot be written onto the Set itself;
// this file is the record that travels with the bank in git. The server's `superseded_sets` table
// is a runtime index of it, filled from this file at boot and kept in step with it whenever the app
// retires a Set.

/**
 * `supersededAt` is in the same "YYYY-MM-DD HH:MM:SS" UTC form as every SQLite `*_at` column,
 * because the boot pass copies it verbatim into `superseded_sets.superseded_at`.
 */
const SqliteTimestampTextSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "supersededAt must be UTC \"YYYY-MM-DD HH:MM:SS\"");

export const SupersessionSchema = z
  .object({
    /** The retired Set. */
    setId: SafeIdSchema,
    /** The Set that replaced it. May itself be retired by a later pair. */
    supersededBy: SafeIdSchema,
    supersededAt: SqliteTimestampTextSchema,
  })
  .strict()
  .refine((pair) => pair.setId !== pair.supersededBy, { message: "a Set cannot supersede itself" });

export type Supersession = z.infer<typeof SupersessionSchema>;

export const SupersessionManifestSchema = z
  .object({ supersessions: z.array(SupersessionSchema) })
  .strict()
  .superRefine((manifest, ctx) => {
    // One row per retired Set, exactly as `superseded_sets` keys it.
    const seen = new Set<string>();
    manifest.supersessions.forEach((pair, index) => {
      if (seen.has(pair.setId)) {
        ctx.addIssue({ code: "custom", path: ["supersessions", index, "setId"], message: "duplicate setId" });
      }
      seen.add(pair.setId);
    });
  });

export type SupersessionManifest = z.infer<typeof SupersessionManifestSchema>;

/**
 * The manifest's one on-disk form: pairs sorted by `setId` in code-unit order, two-space JSON, and a
 * trailing newline. Every writer goes through this so an added pair is a one-entry diff.
 * Validates before formatting, so nothing malformed is ever written.
 */
export function formatSupersessionManifest(pairs: readonly Supersession[]): string {
  const sorted = [...pairs].sort((a, b) => (a.setId < b.setId ? -1 : a.setId > b.setId ? 1 : 0));
  const manifest = SupersessionManifestSchema.parse({ supersessions: sorted });
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
