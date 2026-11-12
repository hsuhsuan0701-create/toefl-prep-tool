import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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

describe("document titles", () => {
  // Every route the table can match, with a sample value for each param.
  function leafRoutes(routes: RouteObject[]): RouteObject[] {
    return routes.flatMap((r) => (r.children ? leafRoutes(r.children) : [r]));
  }
  const SAMPLE_PARAMS = { setId: "rd-1", id: "att-1", kind: "reading", runId: "ftr-1", section: "listening" };

  it("every route in the table names its page", () => {
    const leaves = leafRoutes(appRoutes);
    expect(leaves.length).toBeGreaterThan(10);
    for (const route of leaves) {
      const title: unknown = (route.handle as { title?: unknown } | undefined)?.title;
      const page = typeof title === "function" ? title(SAMPLE_PARAMS) : title;
      expect(typeof page === "string" && page.trim().length > 0, `route ${route.path} has no title`).toBe(true);
    }
    const titles = leaves.map((r) => {
      const title = (r.handle as { title: string | ((p: object) => string) }).title;
      return typeof title === "function" ? title(SAMPLE_PARAMS) : title;
    });
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("names the page first and follows navigation, Back and Forward included", async () => {
    document.title = "unchanged";
    const router = mount(appRoutes, "/nope");
    await screen.findByRole("heading", { level: 1, name: "Page not found" });
    await waitFor(() => expect(document.title).toBe("Page not found · TOEFL Prep Tool"));

    await act(() => router.navigate("/simulate/reading-ish"));
    await screen.findByText(/Unknown simulation kind/);
    await waitFor(() => expect(document.title).toBe("Simulation · TOEFL Prep Tool"));

    await act(() => router.navigate(-1));
    await screen.findByRole("heading", { level: 1, name: "Page not found" });
    await waitFor(() => expect(document.title).toBe("Page not found · TOEFL Prep Tool"));

    await act(() => router.navigate(1));
    await screen.findByText(/Unknown simulation kind/);
    await waitFor(() => expect(document.title).toBe("Simulation · TOEFL Prep Tool"));
  });

  it("titles a section's Simulation by its section, never by its Set", () => {
    const simulate = leafRoutes(appRoutes).find((r) => r.path === "/simulate/:kind")!;
    const title = (simulate.handle as { title: (p: object) => string }).title;
    expect(title({ kind: "reading" })).toBe("Reading Simulation");
    expect(title({ kind: "speaking" })).toBe("Speaking Simulation");
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
    await waitFor(() => expect(document.title).toBe("Something went wrong · TOEFL Prep Tool"));
  });
});
