# Retiring a Set is repo data, applied at boot

## Status

Accepted.

## Context

Question Sets are immutable JSON. Persisted Responses point at a Set's Item ids, tile orders and
frames, and the Attempt review renders a past Attempt against the Set file on disk, so editing a
published Set changes what old Attempts mean. Where it happened (four in-place edits to banked Sets),
three real Attempts started reviewing as garbled text.

A defective or outdated Set is therefore replaced, never edited: a new Set is generated and the old
one is retired. Which Sets are retired lived only in the `superseded_sets` table of the gitignored
database. A fresh clone listed every tracked Set, the 40 the bank's history had retired included,
and two of those retirements were recorded by no script at all.

## Decision

**`data/question-sets/supersessions.json` is the record of which Sets are retired and what replaced
each one.** It is tracked in git and travels with the bank. `superseded_sets` is a runtime index of
it.

- **At boot**, a housekeeping pass inserts every manifest pair the table does not already hold. It
  never replaces or deletes a row, because the local database may know a newer replacement than the
  checkout's manifest. It skips a pair whose replacement Set is missing or of another kind, so a
  slot is never left with no Set.
- **At runtime**, retiring a Set writes the row and the manifest in one SQLite transaction (the
  manifest via a temp file and rename). A failed manifest write rolls the row back.
- The manifest has one canonical form: pairs sorted by `setId`, validated by
  `SupersessionManifestSchema` in `shared/src/supersessions.ts`, so adding a pair is a one-entry
  diff.
- A replacement is recorded only after it has published (`recordSupersessionOnPublication` in
  `server/src/services/supersession.ts`), so a crashed render leaves the original live.
- A retired Set leaves the Set listing and the Novelty Catalog but stays readable, so its past
  Attempts still review.

## Considered Options

- **Keep it in the database and ship apply scripts**: rejected. That is what failed; the scripts
  drifted from the table and had to be remembered.
- **Delete retired Sets from the repo**: rejected. Past Attempts against them would stop reviewing.
- **A `retired` field on the Set itself**: rejected. It is an edit to an immutable file.

## Consequences

A fresh clone retires the same Sets the bank's history retired, with no step to remember. A
contributor retiring a Set commits the manifest change alongside the replacement Set.

Pinned by `server/test/supersessionManifest.test.ts` (the boot pass and the manifest format) and
`server/test/supersession.test.ts` (the only path to retirement runs after publication; retired Sets
leave the Catalog and the picker).

## One exception: an Explanation that contradicts its own key

"Never edited" protects what a past Response is compared with: Item ids, options, keys, tile orders
and frames. An Explanation (錯題解析) is none of those. It is commentary shown after an Item is
scored, and a wrong one misleads every later reader of it.

So an Explanation that names a different option than its Item's key may be corrected in place, and
nothing else in the file may change with it. On 2026-11-12 nine Explanations in three banked Sets
(`lsn-03948a55`, `lsn-7c5cf3f6`, `rd-1d6486b7`) were corrected this way: each had been written
against the option order before the options were shuffled, and named by letter an option that was
no longer the key. They now name options by what they say. The generator catches the form since the
same day (`referencesOptionByPosition`), so a new Set should not need this.

A Set with any other defect is still replaced and retired.
