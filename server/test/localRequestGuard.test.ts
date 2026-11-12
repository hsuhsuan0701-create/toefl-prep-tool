import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import { localRequestGuard, UPLOAD_BODY_LIMIT_BYTES } from "../src/lib/localRequestGuard.js";
import { app as composedApp } from "../src/index.js";

// The API runs on the User's own machine and is meant for exactly one client: the page served
// by this repo's Vite server. Any other web page the User has open can also reach 127.0.0.1, so
// the guard has to refuse what a browser lets a foreign page send without a CORS preflight.

function guardedApp() {
  const app = new Hono();
  app.use("/api/*", localRequestGuard());
  app.get("/api/thing", (c) => c.json({ ok: true }));
  app.post("/api/attempts", async (c) => c.json({ received: await c.req.json() }, 201));
  app.post("/api/attempts/:id/flag", (c) => c.json({ flagged: c.req.param("id") }));
  const upload = async (c: Context) => {
    const file = (await c.req.parseBody()).file;
    return c.json({ bytes: file instanceof File ? file.size : null });
  };
  app.post("/api/attempts/:id/items/:itemId/audio", upload);
  app.post("/api/drill-lab/items/:setId/:itemId/reps", upload);
  return app;
}

const JSON_BODY = JSON.stringify({ kind: "reading", mode: "drill", setId: "rd-1" });
const VITE_PAGE = { Host: "localhost:5173", Origin: "http://localhost:5173" };

function recording(bytes: number): FormData {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], "recording.webm", { type: "audio/webm" }));
  return form;
}

describe("Host", () => {
  it.each(["localhost:5173", "localhost", "127.0.0.1:8787", "[::1]:8787", "LOCALHOST:5173"])(
    "answers a local Host (%s)",
    async (host) => {
      const res = await guardedApp().request("/api/thing", { headers: { Host: host } });
      expect(res.status).toBe(200);
    },
  );

  it.each([
    "attacker.example:8787",
    "attacker.example",
    "localhost.attacker.example:8787",
    "127.0.0.1.nip.io:8787",
    "192.168.1.20:5173",
  ])("refuses a foreign Host (%s), which is what a DNS-rebound page sends", async (host) => {
    const res = await guardedApp().request("/api/thing", { headers: { Host: host } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.stringContaining("Host") });
  });

  it("falls back to the request URL when no Host header is present", async () => {
    expect((await guardedApp().request("/api/thing")).status).toBe(200);
    expect((await guardedApp().request("http://attacker.example/api/thing")).status).toBe(403);
  });
});

describe("Origin on state-changing requests", () => {
  it.each(["http://localhost:5173", "http://127.0.0.1:8787", "http://[::1]:5173", "https://localhost:4173"])(
    "accepts a local Origin (%s)",
    async (origin) => {
      const res = await guardedApp().request("/api/attempts", {
        method: "POST",
        headers: { Host: "localhost:5173", Origin: origin, "Content-Type": "application/json" },
        body: JSON_BODY,
      });
      expect(res.status).toBe(201);
    },
  );

  it.each(["http://evil.example", "null", "http://localhost.evil.example", "file://", "not a url"])(
    "refuses a foreign Origin (%s) even with a JSON body",
    async (origin) => {
      const res = await guardedApp().request("/api/attempts", {
        method: "POST",
        headers: { Host: "localhost:5173", Origin: origin, "Content-Type": "application/json" },
        body: JSON_BODY,
      });
      expect(res.status).toBe(403);
    },
  );

  it("refuses a foreign Origin on a body-less POST", async () => {
    const res = await guardedApp().request("/api/attempts/a1/flag", {
      method: "POST",
      headers: { Host: "localhost:5173", Origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("does not gate reads on Origin", async () => {
    const res = await guardedApp().request("/api/thing", {
      headers: { Host: "localhost:5173", Origin: "http://evil.example" },
    });
    expect(res.status).toBe(200);
  });
});

describe("declared body type", () => {
  it("refuses the cross-site 'simple' POST: a JSON-shaped text/plain body", async () => {
    const res = await guardedApp().request("/api/attempts", {
      method: "POST",
      headers: { Host: "localhost:5173", "Content-Type": "text/plain" },
      body: JSON_BODY,
    });
    expect(res.status).toBe(415);
  });

  it("reads the media type, not a substring of the header", async () => {
    const res = await guardedApp().request("/api/attempts", {
      method: "POST",
      headers: { ...VITE_PAGE, "Content-Type": "text/plain; x=application/json" },
      body: JSON_BODY,
    });
    expect(res.status).toBe(415);
  });

  it("refuses a body with no declared type", async () => {
    const res = await guardedApp().request("/api/attempts", {
      method: "POST",
      headers: { ...VITE_PAGE, "Content-Length": String(JSON_BODY.length) },
      body: new Blob([JSON_BODY]),
    });
    expect(res.status).toBe(415);
  });

  it("refuses multipart on a JSON route", async () => {
    const res = await guardedApp().request("/api/attempts", { method: "POST", headers: VITE_PAGE, body: recording(1024) });
    expect(res.status).toBe(415);
  });

  it("accepts what the client sends: JSON with a charset, and body-less POSTs", async () => {
    const json = await guardedApp().request("/api/attempts", {
      method: "POST",
      headers: { ...VITE_PAGE, "Content-Type": "application/json; charset=utf-8" },
      body: JSON_BODY,
    });
    expect(json.status).toBe(201);
    const bodyless = await guardedApp().request("/api/attempts/a1/flag", { method: "POST", headers: VITE_PAGE });
    expect(bodyless.status).toBe(200);
    expect(await bodyless.json()).toEqual({ flagged: "a1" });
  });

  it.each(["/api/attempts/a1/items/lr-1/audio", "/api/drill-lab/items/spk-1/lr-1/reps?phase=baseline"])(
    "requires multipart on the upload route %s, and passes the recording through",
    async (url) => {
      const asJson = await guardedApp().request(url, {
        method: "POST",
        headers: { ...VITE_PAGE, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(asJson.status).toBe(415);
      const asForm = await guardedApp().request(url, { method: "POST", headers: VITE_PAGE, body: recording(4096) });
      expect(asForm.status).toBe(200);
      expect(await asForm.json()).toEqual({ bytes: 4096 });
    },
  );
});

describe("upload size cap", () => {
  it("is about 25 MB", () => {
    expect(UPLOAD_BODY_LIMIT_BYTES).toBe(25 * 1024 * 1024);
  });

  it("refuses an upload whose declared length is over the cap without reading it", async () => {
    const res = await guardedApp().request("/api/attempts/a1/items/lr-1/audio", {
      method: "POST",
      headers: {
        ...VITE_PAGE,
        "Content-Type": "multipart/form-data; boundary=x",
        "Content-Length": String(UPLOAD_BODY_LIMIT_BYTES + 1),
      },
      body: "--x--",
    });
    expect(res.status).toBe(413);
  });

  it("refuses a streamed upload once it passes the cap", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > UPLOAD_BODY_LIMIT_BYTES) {
          controller.close();
          return;
        }
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const res = await guardedApp().request("/api/drill-lab/items/spk-1/lr-1/reps?phase=post", {
      method: "POST",
      headers: { ...VITE_PAGE, "Content-Type": "multipart/form-data; boundary=x" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });
});

describe("the composed server app", () => {
  it("puts the guard in front of every /api route", async () => {
    const foreignHost = await composedApp.request("/api/health", { headers: { Host: "attacker.example:8787" } });
    expect(foreignHost.status).toBe(403);
    const crossSite = await composedApp.request("/api/attempts", {
      method: "POST",
      headers: { Host: "127.0.0.1:8787", Origin: "http://evil.example", "Content-Type": "text/plain" },
      body: JSON_BODY,
    });
    expect(crossSite.status).toBe(403);
    expect((await composedApp.request("/api/health", { headers: VITE_PAGE })).status).toBe(200);
  });
});
