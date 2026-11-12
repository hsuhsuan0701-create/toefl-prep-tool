import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AppErrorBoundary from "../src/components/AppErrorBoundary";

// React unmounts the whole root on an uncaught render error, and several renderers throw on
// purpose when data breaks an invariant. The boundary around the app turns that into a readable
// page with a way out instead of a blank screen.

let shouldThrow = true;
function Flaky() {
  if (shouldThrow) throw new Error("rows[idx] is undefined");
  return <p>page content</p>;
}

beforeEach(() => {
  shouldThrow = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("AppErrorBoundary", () => {
  it("replaces a crashed page with a readable fallback and a way home", () => {
    render(
      <AppErrorBoundary>
        <Flaky />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("heading", { name: "Something went wrong on this page" })).toBeInTheDocument();
    expect(screen.getByText(/rows\[idx\] is undefined/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Practice" })).toHaveAttribute("href", "/");
  });

  it("tries the page again on request", async () => {
    render(
      <AppErrorBoundary>
        <Flaky />
      </AppErrorBoundary>,
    );
    shouldThrow = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("page content")).toBeInTheDocument();
  });

  it("clears itself when the browser navigates back or forward", () => {
    render(
      <AppErrorBoundary>
        <Flaky />
      </AppErrorBoundary>,
    );
    shouldThrow = false;
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByText("page content")).toBeInTheDocument();
  });
});
