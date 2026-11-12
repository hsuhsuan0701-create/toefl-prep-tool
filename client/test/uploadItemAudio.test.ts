import { describe, expect, it, vi, afterEach } from "vitest";
import { uploadItemAudio } from "../src/lib/api";

// Only HTTP 400 means "the server looked at these bytes and rejected them" (the upload route in
// server/src/routes/attempts.ts). Every other non-2xx is about the request or the server, and the
// recording in memory is still perfectly good. Classifying them all as `needs-rerecord` tells the
// User their answer is unusable and removes the retry affordance, so a `tsx watch` reload or a
// transient 5xx during upload costs them a take they have to speak again.
function respond(status: number, body?: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

const blob = () => new Blob(["audio"], { type: "audio/webm" });

afterEach(() => vi.unstubAllGlobals());

describe("uploadItemAudio failure classification", () => {
  it("treats a 400 as a genuinely unusable recording", async () => {
    vi.stubGlobal("fetch", respond(400, { error: "recording too short" }));

    const result = await uploadItemAudio("att-1", "lr-1", blob());

    expect(result).toMatchObject({ ok: false, kind: "needs-rerecord", message: "recording too short" });
  });

  it.each([
    [500, "the server threw while saving"],
    [502, "the dev proxy answered while the server was restarting"],
    [409, "another upload for this item was in flight"],
    [404, "the attempt or item id was not recognised"],
  ])("keeps a good recording retryable on HTTP %i (%s)", async (status) => {
    vi.stubGlobal("fetch", respond(status, { error: "server side" }));

    const result = await uploadItemAudio("att-1", "lr-1", blob());

    // The blob is fine; the User must not be told to re-speak the item.
    expect(result).toMatchObject({ ok: false, kind: "retryable" });
  });

  // A 200 means the server stored and transcribed the recording. Sending it again because its body
  // could not be read would transcribe it twice, so the upload is done, with no transcript in hand.
  it("counts a 200 whose body cannot be read as done, without resolving to a failure", async () => {
    // A body cut off after the server committed (only the API answers /api; Vite proxies it).
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"transcript":"the lib', { status: 200 })) as unknown as typeof fetch);

    const result = await uploadItemAudio("att-1", "lr-1", blob());

    expect(result).toEqual({ ok: true, data: null });
  });

  it("keeps a network failure retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

    const result = await uploadItemAudio("att-1", "lr-1", blob());

    expect(result).toMatchObject({ ok: false, kind: "retryable" });
  });
});
