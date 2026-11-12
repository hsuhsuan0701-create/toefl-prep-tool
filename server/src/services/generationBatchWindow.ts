/** How many children of one batch run at once. `generationCost.ts` on the client mirrors it. */
export const GENERATION_BATCH_WINDOW = 7;

/**
 * The batch runner's concurrency window: at most `concurrency` children in flight at once, admitted
 * in array order, each `runChild` awaited by exactly one worker. Its own module so the window is a
 * testable seam rather than a shape inside runGenerationBatch's control flow.
 *
 * Two properties the callers depend on:
 *  - `shouldAdmit` is consulted BEFORE each admission, never mid-child. A cancel therefore stops
 *    children that have not started; stopping the ones already running is the caller's job (it holds
 *    the abort handles), and this function still waits for every child it did admit to settle.
 *  - `runChild` is not expected to reject: runGenerationJob records its child's failure on that
 *    child's row and returns normally, so a failed Set never disturbs the rest of the window. A
 *    rejection here is an invariant breaking rather than a Set failing; it abandons the whole run,
 *    which is why routes/generate.ts puts a .catch on the batch call.
 */
export async function runGenerationBatchWindow<T, R>(
  children: readonly T[],
  runChild: (child: T, index: number) => Promise<R>,
  options: {
    concurrency?: number;
    shouldAdmit?: () => boolean;
  } = {},
): Promise<(R | undefined)[]> {
  const concurrency = options.concurrency ?? GENERATION_BATCH_WINDOW;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("generation batch concurrency must be a positive integer");
  }
  const results: (R | undefined)[] = Array.from({ length: children.length });
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < children.length) {
      if (options.shouldAdmit && !options.shouldAdmit()) return;
      const index = nextIndex++;
      results[index] = await runChild(children[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, children.length) },
      () => worker(),
    ),
  );
  return results;
}
