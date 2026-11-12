import { afterEach, describe, expect, it, vi } from "vitest";
import { DeterministicAlreadyScoredError, HttpError, scoreDeterministicTask } from "../src/lib/api";
import { requestErrorMessage } from "../src/lib/requestError";

// scoreDeterministicTask tells a 409 whose body carries `alreadyScored: true` (positive evidence the
// server already has this Task Type's Responses, which a retried Module submit may treat as
// accepted) apart from every other non-2xx response (a genuine conflict or failure, which stays a
// failure).
function respond(status: number, body?: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("scoreDeterministicTask", () => {
  it("resolves normally on 200", async () => {
    vi.stubGlobal("fetch", respond(200, { taskType: "daily_life", items: [{ itemId: "dl-1-q1", correct: true }] }));
    const result = await scoreDeterministicTask("att-1", { taskType: "daily_life", items: [] });
    expect(result).toEqual({ taskType: "daily_life", items: [{ itemId: "dl-1-q1", correct: true }] });
  });

  it("throws DeterministicAlreadyScoredError on a 409 marked alreadyScored:true", async () => {
    vi.stubGlobal("fetch", respond(409, { error: "already scored: dl-1-q1", alreadyScored: true }));

    await expect(scoreDeterministicTask("att-1", { taskType: "daily_life", items: [] })).rejects.toBeInstanceOf(
      DeterministicAlreadyScoredError,
    );
  });

  it("throws a plain HttpError on a 409 NOT marked alreadyScored:true (KindMismatchError/ModuleLockedError) — never silently swallowed", async () => {
    vi.stubGlobal("fetch", respond(409, { error: "attempt already routed — module locked" }));

    const promise = scoreDeterministicTask("att-1", { taskType: "daily_life", items: [] });
    await expect(promise).rejects.not.toBeInstanceOf(DeterministicAlreadyScoredError);
    await expect(promise).rejects.toBeInstanceOf(HttpError);
    await expect(promise).rejects.toMatchObject({ status: 409 });
  });

  it("throws a plain HttpError on other non-2xx statuses (e.g. 404 unknown item)", async () => {
    vi.stubGlobal("fetch", respond(404, { error: "unknown item no-such-item" }));

    const promise = scoreDeterministicTask("att-1", { taskType: "daily_life", items: [] });
    await expect(promise).rejects.toBeInstanceOf(HttpError);
    await expect(promise).rejects.not.toBeInstanceOf(DeterministicAlreadyScoredError);
  });

  it("degrades to a plain HttpError (never alreadyScored) when the error body is unparseable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 409 })) as unknown as typeof fetch,
    );

    const promise = scoreDeterministicTask("att-1", { taskType: "daily_life", items: [] });
    await expect(promise).rejects.toBeInstanceOf(HttpError);
    await expect(promise).rejects.not.toBeInstanceOf(DeterministicAlreadyScoredError);
  });

  // A refusal is the HttpError every other call in lib/api.ts throws, "<status>: <body>", so the
  // error screens can say why the server refused.
  it("carries the server's reason for a refusal through to requestErrorMessage", async () => {
    vi.stubGlobal("fetch", respond(409, { error: "attempt already routed" }));

    const error = await scoreDeterministicTask("att-1", { taskType: "daily_life", items: [] }).catch((e: unknown) => e);

    expect(requestErrorMessage(error)).toBe("The request was refused: attempt already routed.");
  });

  it("reads an empty 5xx as a server that did not answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 502 })) as unknown as typeof fetch);

    const error = await scoreDeterministicTask("att-1", { taskType: "daily_life", items: [] }).catch((e: unknown) => e);

    expect(requestErrorMessage(error)).toBe("The server didn't answer (HTTP 502). Is it running?");
  });

  // Only the server's own `alreadyScored` marker counts as "scored". A 2xx whose body is cut off
  // stays a failure the User can retry, and the retry is what the server answers with that marker.
  it("fails on a 2xx whose body cannot be read, in words, and never as already scored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"taskType":"daily_life","items":[', { status: 200 })) as unknown as typeof fetch);

    const error = await scoreDeterministicTask("att-1", { taskType: "daily_life", items: [] }).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(DeterministicAlreadyScoredError);
    expect(requestErrorMessage(error)).toBe(
      "The server's answer could not be read. Try again: Responses it has already scored are not scored twice.",
    );
  });
});
