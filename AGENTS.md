# Instructions for coding agents

This project keeps its agent instructions in one file: [`CLAUDE.md`](CLAUDE.md). Read it before
changing anything. It has the commands, and the invariants with the test that pins each one.

Then read:

- [`CONTEXT.md`](CONTEXT.md): the vocabulary. Use its terms exactly, in code, tests and comments.
- [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md): how to verify a change, where code goes and
  what a review looks for.
- [`docs/architecture.md`](docs/architecture.md) for the map, and the ADR in [`docs/adr/`](docs/adr/)
  for the area you are about to change.

Done means all four of these pass:

```sh
npm test && npm run typecheck && npm run build -w client && npm run lint -w client
```

Both test suites are hermetic and need no API key. Do not read or print `.env`, and do not run a
script under `scripts/` that makes a paid call (`calibrate-*`, `smoke-*`) unless asked to.
