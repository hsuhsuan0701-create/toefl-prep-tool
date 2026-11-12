import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProviderNotice } from "../src/components/setup/ProviderNotice";

// A CLI the server paused while in use is worth a notice; one that is not installed or not signed in
// is a setup matter, which the Setup checklist already says how to fix.

describe("ProviderNotice", () => {
  it("names a CLI paused while in use, why, and that it is tried again", () => {
    render(<ProviderNotice providers={[{ provider: "claude", availability: "circuit-open", failureKind: "rate-limit", retryAt: new Date().toISOString() }]} />);
    expect(screen.getByText("Claude is paused")).toBeInTheDocument();
    expect(screen.getByText(/Claude: it is rate limited\. It is tried again after/)).toBeInTheDocument();
  });

  it("leaves a missing or signed-out CLI to the Setup checklist", () => {
    const { container } = render(
      <ProviderNotice
        providers={[
          { provider: "claude", availability: "circuit-open", failureKind: "missing-cli" },
          { provider: "codex", availability: "circuit-open", failureKind: "authentication" },
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
