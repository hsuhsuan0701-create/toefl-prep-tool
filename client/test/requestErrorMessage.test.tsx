import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderRoutes } from "./dataRouter";
import { requestErrorMessage } from "../src/lib/requestError";
import ReadingDrill from "../src/pages/ReadingDrill";

// A failed request reaches the User as one sentence they can act on, never as an HTTP body. The
// helper is the one place that wording lives; the Drill error screen is also checked through the
// real page, since that screen is where a raw `404: {"error":…}` would otherwise reach the User.

// The shape lib/api.ts throws: status, and a message of "<status>: <body>".
class FakeHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

vi.mock("../src/lib/api", () => ({
  getSet: vi.fn(async () => {
    // Read at call time, by when the class above exists (vi.mock itself is hoisted above it).
    throw new FakeHttpError(404, '404: {"error":"unknown set"}');
  }),
  listSets: vi.fn(async () => []),
  createAttempt: vi.fn(),
  completeAttempt: vi.fn(),
}));

describe("requestErrorMessage", () => {
  it("says a 404 is a stale link, without the body", () => {
    const text = requestErrorMessage(new FakeHttpError(404, '404: {"error":"not found"}'));
    expect(text).toBe("Not found. The link may be out of date, or what it points to has been removed.");
  });

  it("gives a refusal's short reason, and only the reason", () => {
    expect(requestErrorMessage(new FakeHttpError(409, '409: {"error":"attempt is already completed"}'))).toBe(
      "The request was refused: attempt is already completed.",
    );
    expect(requestErrorMessage(new FakeHttpError(400, "400: <html>a whole error page</html>"))).toBe("The request was refused (HTTP 400).");
  });

  it("asks whether the server is running when nothing answered", () => {
    expect(requestErrorMessage(new TypeError("Failed to fetch"))).toBe("Can't reach the server. Is it running?");
    expect(requestErrorMessage(new TypeError("NetworkError when attempting to fetch resource."))).toBe("Can't reach the server. Is it running?");
    expect(requestErrorMessage(new TypeError("Load failed"))).toBe("Can't reach the server. Is it running?");
    expect(requestErrorMessage(new FakeHttpError(502, "502: "))).toBe("The server didn't answer (HTTP 502). Is it running?");
  });

  it("does not blame the server for a fault in this app's own code", () => {
    expect(requestErrorMessage(new TypeError("Cannot read properties of undefined (reading 'items')"))).toBe("Something went wrong.");
  });

  it("names a server failure without dumping its body", () => {
    expect(requestErrorMessage(new FakeHttpError(500, "500: Internal Server Error\n at stack"))).toBe(
      "The server hit an error (HTTP 500). Its terminal shows what went wrong.",
    );
  });

  it("keeps a sentence this app wrote itself", () => {
    expect(requestErrorMessage(new Error("The served Set is not a reading Set (got listening)."))).toBe(
      "The served Set is not a reading Set (got listening).",
    );
    expect(requestErrorMessage("weird")).toBe("Something went wrong.");
  });
});

describe("the Drill error screen", () => {
  it("shows a missing Set as a sentence, not as the response body", async () => {
    renderRoutes([{ path: "/reading/:setId", element: <ReadingDrill /> }], "/reading/rd-gone");
    expect(await screen.findByText("Not found. The link may be out of date, or what it points to has been removed.")).toBeInTheDocument();
    expect(screen.queryByText(/\{"error"/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Practice" })).toHaveAttribute("href", "/");
  });
});
