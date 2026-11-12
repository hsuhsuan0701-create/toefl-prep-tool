# The server answers only local requests

## Status

Accepted.

## Context

The API's only intended client is the page this repo's Vite server serves, on the learner's own
machine. But every other page the learner has open can reach `127.0.0.1` too. With no Host or Origin
check, a foreign page's `text/plain` POST (a CORS "simple" request, so no preflight) created an
Attempt, and a request carrying a foreign Host was answered. `POST /api/generate` queues paid work.
Hono parses a JSON body whatever its declared Content-Type, so the content type was no defence.

## Decision

The server binds `127.0.0.1` only, and one middleware, `localRequestGuard`
(`server/src/lib/localRequestGuard.ts`), runs in front of every `/api/*` route:

- **Host** must be `localhost`, `127.0.0.1` or `[::1]`, on any port. A DNS-rebinding page sends its
  own name as Host, so this stops it reading responses.
- **Origin**, on a state-changing request, must be a loopback origin when present. Browsers attach
  it to every cross-origin POST.
- **Content-Type**: a body on a JSON route must be `application/json`, and an upload
  `multipart/form-data`, compared on the media type.
- **Uploads** are capped at 25 MB on the wire, before a handler buffers them.

The Vite proxy (`client/vite.config.ts`) forwards to `127.0.0.1` without changing the origin, so the
server sees the browser's own Host and Origin.

## Considered Options

- **A shared secret or token in the page**: not adopted. It adds setup for a single-user local
  tool, and the guard closes the cross-site paths without one.
- **CORS headers alone**: rejected. CORS restricts reading responses, not sending simple requests,
  and the damage here (queued paid work, a created Attempt) is done by the request.

## Consequences

The app works only from the machine it runs on. Serving it to another device on the network, or
behind a reverse proxy with its own Host, is unsupported; doing so needs a deliberate change to the
guard and a decision about authentication.

Pinned by `server/test/localRequestGuard.test.ts`.
