import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * The API's only intended client is the page this repo's Vite server serves, on the User's own
 * machine. Every other page the User has open can reach 127.0.0.1 too, so this guard refuses what a
 * browser lets a foreign page send (docs/adr/0012):
 *
 *   Host     must name the loopback interface. A page that rebinds its own DNS name to 127.0.0.1
 *            still sends its own name as Host, so this is what stops it reading responses.
 *   Origin   on a state-changing request, if present, must be a loopback origin. Browsers attach
 *            it to every cross-origin POST, including form submissions and no-cors fetches.
 *   Content-Type  a body on a JSON route must be declared application/json, and an upload
 *            multipart/form-data. text/plain is a CORS "simple" type that needs no preflight, and
 *            Hono's c.req.json() parses a body whatever its declared type.
 *
 * Uploads are also capped at UPLOAD_BODY_LIMIT_BYTES, measured on the wire so an oversized body is
 * refused before a handler buffers it.
 */

// The longest take is an Interview answer, under a minute of compressed audio: a megabyte or two.
// The cap only has to refuse something that is not a recording.
export const UPLOAD_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

// The routes that take a multipart upload. A new upload route must be added here, or its body is
// refused as not JSON.
const UPLOAD_PATHS = [
  /^\/api\/attempts\/[^/]+\/items\/[^/]+\/audio$/,
  /^\/api\/drill-lab\/items\/[^/]+\/[^/]+\/reps$/,
];

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isLocalOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTNAMES.has(url.hostname);
}

function mediaType(c: Context): string | undefined {
  const header = c.req.header("content-type");
  return header === undefined ? undefined : header.split(";")[0]!.trim().toLowerCase();
}

function hasBody(c: Context): boolean {
  const length = c.req.header("content-length");
  return c.req.header("transfer-encoding") !== undefined || (length !== undefined && length.trim() !== "0");
}

const refuse = (c: Context, status: 403 | 413 | 415, error: string) => c.json({ error }, status);

const uploadLimit = bodyLimit({
  maxSize: UPLOAD_BODY_LIMIT_BYTES,
  onError: (c) => refuse(c, 413, `recording is larger than ${UPLOAD_BODY_LIMIT_BYTES / (1024 * 1024)} MB`),
});

export function localRequestGuard(): MiddlewareHandler {
  return async (c, next) => {
    // node-server builds the URL from the Host header, except for an absolute-form request line,
    // so both are checked.
    const host = c.req.header("host");
    if ((host !== undefined && !LOCAL_HOST.test(host)) || !LOCAL_HOSTNAMES.has(new URL(c.req.url).hostname)) {
      return refuse(c, 403, "this server only answers requests addressed to localhost (Host header)");
    }

    if (READ_METHODS.has(c.req.method)) return next();

    const origin = c.req.header("origin");
    if (origin !== undefined && !isLocalOrigin(origin)) {
      return refuse(c, 403, "cross-origin requests are not accepted");
    }

    const type = mediaType(c);
    if (UPLOAD_PATHS.some((pattern) => pattern.test(c.req.path))) {
      if (type !== "multipart/form-data") return refuse(c, 415, "uploads must be multipart/form-data");
      return uploadLimit(c, next);
    }
    if (type !== undefined ? type !== "application/json" : hasBody(c)) {
      return refuse(c, 415, "request bodies must be application/json");
    }
    return next();
  };
}
