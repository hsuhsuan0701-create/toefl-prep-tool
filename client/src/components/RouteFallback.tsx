import { useEffect, useState } from "react";

// How long a page's code may take to arrive before the fallback says anything. Chunks come from the
// local server, so almost every load finishes well inside this and the User sees no flash at all.
const QUIET_MS = 400;

/**
 * What shows while a page's code is still loading (App.tsx's Suspense boundary): a blank page in
 * the page's own colour, then, only if the wait is long enough to notice, one line saying so. No
 * spinner, no layout: the page about to appear may be an exam screen with no navigation, so this
 * draws nothing that page would not.
 */
export default function RouteFallback() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), QUIET_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div aria-busy="true" className="flex min-h-dvh items-center justify-center bg-paper px-gutter">
      <p className="text-ui text-graphite">{slow ? "Loading…" : null}</p>
    </div>
  );
}
