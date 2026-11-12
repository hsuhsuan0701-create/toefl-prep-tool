import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router-dom";
import { appRoutes } from "../src/App";

// The app's real route table, mounted in a memory router. A path no route matches used to fall
// through to the router's own default error page: no navigation, no way back, and a note to the
// developer.

const ROUTER_DEFAULT_TEXT = /Unexpected Application Error|Hey developer/;

function mount(routes: RouteObject[], path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => vi.restoreAllMocks());

describe("an unmatched path", () => {
  it.each(["/nope", "/attempts", "/full-test", "/progress/x"])("%s shows the app's not-found screen with the nav", async (path) => {
    mount(appRoutes, path);
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toHaveTextContent("Practice");
    expect(screen.getByRole("link", { name: "Back to Practice" })).toHaveAttribute("href", "/");
    expect(screen.getByText(path)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(ROUTER_DEFAULT_TEXT);
  });
});

describe("an error the router catches itself", () => {
  it("ends on the app's error screen, not the router's default page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The real root route, with one child whose loader throws: a loader's error never reaches the
    // page's error boundary, so only the root route's error element stands between it and the
    // router's default page.
    const [root] = appRoutes;
    const failing: RouteObject = {
      path: "/broken",
      loader: () => {
        throw new Error("the loader broke");
      },
      element: <p>never shown</p>,
    };
    mount([{ ...root, children: [failing] } as RouteObject], "/broken");
    expect(await screen.findByRole("heading", { name: "Something went wrong on this page" })).toBeInTheDocument();
    expect(screen.getByText("the loader broke")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Practice" })).toHaveAttribute("href", "/");
    expect(document.body).not.toHaveTextContent(ROUTER_DEFAULT_TEXT);
  });
});
