import { Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider, type RouteObject } from "react-router-dom";
import LeaveGuardHost from "../src/components/LeaveGuardHost";

/**
 * Renders `routes` in a memory data router under the same LeaveGuardHost and Suspense boundary
 * App.tsx mounts (a section's Simulation is a lazy chunk). Anything that calls useBlocker (every
 * Drill and Simulation, through useLeaveGuard) throws under a plain <MemoryRouter>, and
 * useLeaveGuard throws without the host, so pages that guard against leaving are rendered through
 * this. Pass several entries to give the history a page to go Back to; the last one is where the
 * router starts.
 */
export function renderRoutes(routes: RouteObject[], initialEntries: string | string[]) {
  const entries = typeof initialEntries === "string" ? [initialEntries] : initialEntries;
  const router = createMemoryRouter(
    [
      {
        element: (
          <LeaveGuardHost>
            <Suspense fallback={null}>
              <Outlet />
            </Suspense>
          </LeaveGuardHost>
        ),
        children: routes,
      },
    ],
    { initialEntries: entries, initialIndex: entries.length - 1 },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}

/** Fires a real beforeunload and reports whether anything asked the browser to stop. */
export function unload(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** The dialog LeaveGuardHost opens when the leave guard holds a navigation. */
export function findLeavePrompt() {
  return screen.findByRole("dialog", { name: /^Leave/ });
}
