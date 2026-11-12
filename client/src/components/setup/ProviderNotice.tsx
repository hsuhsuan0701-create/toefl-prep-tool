import type { ReasoningFailureKind, ReasoningProviderStatusVM } from "@toefl-prep/shared";
import { formatWhen } from "../../ui/format";
import { Notice } from "../../ui/Notice";

// Why the server paused a CLI. A CLI that is not installed or not signed in is a setup matter, which
// the Setup checklist reports with what to do; this notice is for the ones that broke while in use.
const FAILURE: Partial<Record<ReasoningFailureKind, string>> = {
  quota: "its quota has run out",
  "rate-limit": "it is rate limited",
  provider: "the service is unavailable",
  timeout: "its calls are timing out",
  "invalid-output": "it returned answers that could not be read",
  configuration: "it is not configured correctly",
  application: "the app could not run it",
};

const SETUP_FAILURES: ReadonlySet<ReasoningFailureKind> = new Set(["missing-cli", "authentication"]);

const NAME = { claude: "Claude", codex: "Codex" } as const;

/** "1:18 AM" today, "Nov 13, 9:02 AM" on another day. */
function when(iso: string): string {
  return formatWhen(iso).replace(/^Today, /, "");
}

/**
 * A reasoning CLI the server has paused after repeated failures while in use (its circuit is open):
 * which one, why, and when it is tried again. Scoring and generation wait for it, or use the other.
 */
export function ProviderNotice({ providers }: { providers: ReasoningProviderStatusVM[] }) {
  const paused = providers.filter((p) => p.availability === "circuit-open" && !(p.failureKind && SETUP_FAILURES.has(p.failureKind)));
  if (paused.length === 0) return null;
  return (
    <Notice tone="caution" title={paused.length === 1 ? `${NAME[paused[0].provider]} is paused` : "Claude and Codex are paused"}>
      {paused.map((provider) => (
        <p key={provider.provider}>
          {NAME[provider.provider]}: {(provider.failureKind && FAILURE[provider.failureKind]) ?? "it is temporarily unavailable"}
          {provider.retryAt ? `. It is tried again after ${when(provider.retryAt)}.` : "."}
        </p>
      ))}
      <p className="mt-1">New Sets and Score Reports wait for it, or use the other CLI if that one is signed in.</p>
    </Notice>
  );
}
