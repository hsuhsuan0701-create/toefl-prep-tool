# Security

## Reporting a problem

Please report a security problem privately, not in a public issue. Use GitHub's private
vulnerability reporting: on the repository's **Security** tab, choose **Report a vulnerability**.
Say what an attacker can do, what they need first (another page open in the browser, a process on
the same machine, a crafted Set file…), and how to reproduce it. If that option is not shown, open
an issue that asks for a private contact and leave the details out of it.

Fixes land on `main`; there are no release branches to backport to.

## What the app is, for a threat model

A single-user practice app that runs on your own computer. The API server binds `127.0.0.1` only,
and the client is served on `localhost`. There are no accounts, no passwords, no hosted service and
no analytics. What it holds:

- **Your API keys** in `.env`, which git ignores.
- **Your practice data** in `data/`: the SQLite database (Attempts, scores, Targets, model-call
  diagnostics) and your recordings. Git ignores both, and neither is encrypted.
- **Paid access**: a request that starts generation or scoring spends your provider quota or money.

### What it defends against

**Other web pages open in your browser.** Any page can send requests to `127.0.0.1`. One
middleware, `localRequestGuard` (`server/src/lib/localRequestGuard.ts`), runs in front of every
`/api` route ([ADR 0012](../docs/adr/0012-server-answers-only-local-requests.md)):

- **Host** must be `localhost`, `127.0.0.1` or `[::1]`, on any port. A page that points its own DNS
  name at `127.0.0.1` still sends that name as Host, so its requests are refused.
- **Origin**, on any request other than `GET`, `HEAD` or `OPTIONS`, must be a loopback origin when
  present. Browsers attach it to every cross-origin `POST`, form submissions included.
- **Content-Type** must be declared: `application/json` for a body on a JSON route,
  `multipart/form-data` for the two recording uploads. A cross-site `text/plain` `POST` needs no
  CORS preflight, so this is what refuses it.
- **Uploads** are capped at 25 MB, measured on the wire before a handler buffers the body.

The server sends no CORS headers, so the browser keeps a foreign page from reading any response.

**Leaking keys.** Keys are read on the server only. `GET /api/setup-status` reports whether each
piece is present as a boolean, never a value. The model-call diagnostics redact credentials before
storing a prompt or response, and no route serves them
([ADR 0004](../docs/adr/0004-model-call-transcript-log.md)). The Claude and Codex CLIs are started
with a short allow-list of environment variables, not the server's environment.

**The spawned Claude CLI reading the project.** `claude -p` runs with only its `Read` and `Skill`
tools, no MCP servers, and a Read deny list covering every project entry except the skills it needs
(`CLI_PERMISSIONS_SETTINGS` in `server/src/services/claudeRunner.ts`), so it cannot open `.env` or
the code. A test fails when a new top-level entry is not covered.

**Paths.** A file route serves only files that resolve, symlinks followed, inside the data directory
(`server/src/lib/paths.ts`).

### What it does not defend against

- **Anything already running as you on the same machine.** A local process can send requests with
  any headers, and it can read `.env` and `data/` directly. The guard is about browser pages, not
  local users or malware.
- **The Codex CLI reading files.** Codex runs in an empty temporary directory with a read-only
  sandbox, which blocks writes and network access but not reads. A command the model chose to run
  could read any file you can, `.env` included. Nothing points it at the project; that is the whole
  of its isolation ([ADR 0003](../docs/adr/0003-cli-first-structured-reasoning-routes.md)).
- **Serving the app to another device**, on your network or behind a reverse proxy. The guard
  refuses a non-loopback Host, and there is no authentication. Changing that is a design decision,
  not a configuration step.
- **What the model providers do with what you send.** Scoring sends each Response, a recording or
  an essay, to the providers you configured, and generation sends prompts to them. Their terms
  apply.

A report about anything in the first list is welcome. A report about the second list is welcome too
when it shows a way to cross the line it draws.
