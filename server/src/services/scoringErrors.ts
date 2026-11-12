// The scoring error classes, in their own module so the Judge ensemble (judgeEnsemble.ts) and the
// dispatcher above it (scoreItems.ts) can both throw them without an import cycle. scoreItems.ts
// re-exports all three; the routes map errors by `instanceof`, so each class has exactly one
// definition.

/** The request names something that does not exist or cannot be scored as asked. The routes answer 404. */
export class NotFound extends Error {}

/**
 * Scoring failed after the Response was on file. The run's Items without a committed score are
 * marked failed (unless its job was superseded meanwhile), so a Re-score can retry them; an Item
 * with one keeps it. Inside a scoring job it fails the job like any other error.
 */
export class Rescorable extends Error {}

/**
 * A spoken Response is on file but has no transcript yet: the recording is kept, and its
 * transcription is still retrying or waits on the User's Retry. The /score route answers 409 with the
 * pending Item ids.
 */
export class TranscriptionPending extends Error {
  constructor(public itemIds: string[]) {
    super("transcription pending");
  }
}
