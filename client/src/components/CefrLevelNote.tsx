import { cefrForBand } from "@toefl-prep/shared";

export type CefrLevelNoteProps = {
  band: number;
  /** Type styling for the surrounding figure. Defaults to the muted treatment BandFigure gives the
   *  "/6" beside a band. */
  className?: string;
};

// The CEFR level a band maps to, rendered as the tail of the band itself ("4.5/6 · B2") rather than
// as a figure of its own. BandFigure renders it, so every band on screen (estimates, Targets, the
// Overall) carries its level in the same words.
//
// The mapping is `cefrForBand` in shared/src/cefr.ts, which holds the ETS table and says why the
// level is derived where the band renders instead of riding along in the view models.
//
// A band is a Band Estimate or a Target the User set, never an official score, and the level
// inherits that status: it stays attached to the band it came from and carries the caveat in its
// tooltip. Lifted out into a standalone "CEFR: B2", it would read as a certification.
const CEFR_TITLE =
  "CEFR level this band maps to on ETS's published band–CEFR concordance. The band it comes from is " +
  "an unofficial estimate (or a Target you set), so this level is not an official certification.";

export default function CefrLevelNote({ band, className }: CefrLevelNoteProps) {
  return (
    <span data-testid="cefr-level" title={CEFR_TITLE} className={className ?? "font-medium text-graphite"}>
      {" · "}
      {cefrForBand(band)}
    </span>
  );
}
