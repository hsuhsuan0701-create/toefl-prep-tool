import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { useLeaveGuard } from "../src/hooks/useLeaveGuard";
import { leavePromptCopy, type LeaveMessage } from "../src/hooks/leaveGuardContext";
import { findLeavePrompt, renderRoutes } from "./dataRouter";

// The leave guard every Drill, Simulation and Full-Test section mounts. In-app navigation away from
// a running Attempt (the browser's Back, the screen's own Exit, a link) is held by the router's
// blocker and answered in the design system's ConfirmDialog, which LeaveGuardHost renders once for
// the whole app. These tests drive the hook through a real data router with the host mounted, the
// way App.tsx mounts it.

function GuardedPage({ active, message, leaveTo }: { active: boolean; message: LeaveMessage; leaveTo?: string }) {
  const guard = useLeaveGuard(active, message);
  return (
    <div>
      <p>running section</p>
      {leaveTo && (
        <button type="button" onClick={() => guard.leave(leaveTo)}>
          hand off
        </button>
      )}
    </div>
  );
}

function renderGuarded(props: { active: boolean; message: LeaveMessage; leaveTo?: string }) {
  return renderRoutes(
    [
      { path: "/", element: <p>home</p> },
      { path: "/report", element: <p>report</p> },
      { path: "/run", element: <GuardedPage {...props} /> },
    ],
    ["/", "/run"],
  );
}

const RESTART: LeaveMessage = "Leave the Reading section? It can't be resumed. Coming back starts the Reading section again.";

describe("the leave prompt", () => {
  it("holds a Back navigation in a dialog, and Stay keeps the User where they were", async () => {
    const user = userEvent.setup();
    const { router } = renderGuarded({ active: true, message: RESTART });

    await act(async () => {
      await router.navigate(-1);
    });
    const dialog = await findLeavePrompt();
    expect(within(dialog).getByRole("heading", { name: "Leave the Reading section?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("It can't be resumed. Coming back starts the Reading section again.");
    // Leaving loses the section, so the safe choice has focus first.
    expect(within(dialog).getByRole("button", { name: "Stay" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(screen.getByText("running section")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /^Leave/ })).toBeNull();
    expect(router.state.location.pathname).toBe("/run");
  });

  it("lets the navigation through once the User chooses Leave", async () => {
    const user = userEvent.setup();
    const { router } = renderGuarded({ active: true, message: RESTART });

    await act(async () => {
      await router.navigate(-1);
    });
    await user.click(within(await findLeavePrompt()).getByRole("button", { name: "Leave" }));

    expect(await screen.findByText("home")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /^Leave/ })).toBeNull();
  });

  it("asks nothing while the guard is inactive", async () => {
    const { router } = renderGuarded({ active: false, message: RESTART });
    await act(async () => {
      await router.navigate(-1);
    });
    expect(await screen.findByText("home")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /^Leave/ })).toBeNull();
  });

  it("lets the page's own hand-off through without asking", async () => {
    const user = userEvent.setup();
    renderGuarded({ active: true, message: RESTART, leaveTo: "/report" });

    await user.click(screen.getByRole("button", { name: "hand off" }));
    expect(await screen.findByText("report")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /^Leave/ })).toBeNull();
  });

  it("closes an open prompt when the page hands off on its own", async () => {
    const user = userEvent.setup();
    const { router } = renderGuarded({ active: true, message: RESTART, leaveTo: "/report" });

    await act(async () => {
      await router.navigate(-1);
    });
    await findLeavePrompt();
    // The section finished while the prompt was up (a Module scored, the report is ready): the
    // page's own exit wins, and no dialog is left standing over the next page.
    await user.click(screen.getByRole("button", { name: "hand off", hidden: true }));
    expect(await screen.findByText("report")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /^Leave/ })).toBeNull();
  });

  it("refuses to run without the host that draws the prompt", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The data router catches a route's render error and draws its own error page with the message.
      const router = createMemoryRouter([{ path: "/", element: <GuardedPage active message={RESTART} /> }]);
      render(<RouterProvider router={router} />);
      expect(screen.getByRole("heading", { name: /needs a <LeaveGuardHost> above it/ })).toBeInTheDocument();
      expect(screen.queryByText("running section")).toBeNull();
    } finally {
      warnings.mockRestore();
      errors.mockRestore();
    }
  });
});

describe("leavePromptCopy", () => {
  it("titles the dialog with a message's opening question", () => {
    expect(leavePromptCopy(RESTART)).toEqual({
      title: "Leave the Reading section?",
      body: "It can't be resumed. Coming back starts the Reading section again.",
    });
  });

  it("ends the title at the first question, leaving any later one in the body", () => {
    expect(leavePromptCopy("Leave before the wrap-up ends? Your recordings are still being sent. Why wait? Closing the tab could lose them.")).toEqual({
      title: "Leave before the wrap-up ends?",
      body: "Your recordings are still being sent. Why wait? Closing the tab could lose them.",
    });
  });
});
