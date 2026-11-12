export type DiffOp =
  | { op: "match"; targetWord: string; saidWord: string }
  | { op: "substitution"; targetWord: string; saidWord: string }
  | { op: "omission"; targetWord: string }
  | { op: "insertion"; saidWord: string };

function tokenize(text: string): string[] {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed === "" ? [] : trimmed.split(" ");
}

function normalize(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

type RawOp =
  | { op: "match"; targetWord: string; saidWord: string }
  | { op: "omission"; targetWord: string }
  | { op: "insertion"; saidWord: string };

/**
 * Merges adjacent edit runs positionally: when a maximal run of k omissions is
 * immediately followed (or preceded) by a maximal run of m insertions, the first
 * min(k, m) of each pair up index-by-index into substitutions (run[0] with
 * otherRun[0], run[1] with otherRun[1], ...); any excess — the tail of whichever
 * run is longer — is emitted after the substitutions as plain omissions/insertions.
 * Matches, and omission/insertion runs with nothing adjacent to pair against, pass
 * through unchanged.
 */
function mergeAdjacentEdits(ops: RawOp[]): DiffOp[] {
  const result: DiffOp[] = [];
  let idx = 0;
  while (idx < ops.length) {
    const cur = ops[idx];
    if (cur.op === "match") {
      result.push(cur);
      idx++;
      continue;
    }

    const runOp = cur.op;
    let runEnd = idx;
    while (runEnd < ops.length && ops[runEnd].op === runOp) runEnd++;

    const otherOp = runOp === "omission" ? "insertion" : "omission";
    let otherEnd = runEnd;
    while (otherEnd < ops.length && ops[otherEnd].op === otherOp) otherEnd++;

    if (otherEnd === runEnd) {
      // No adjacent run of the opposite edit type to pair against.
      for (let p = idx; p < runEnd; p++) result.push(ops[p]);
      idx = runEnd;
      continue;
    }

    const omissions: Extract<RawOp, { op: "omission" }>[] = [];
    const insertions: Extract<RawOp, { op: "insertion" }>[] = [];
    for (let p = idx; p < otherEnd; p++) {
      const op = ops[p];
      if (op.op === "omission") omissions.push(op);
      else if (op.op === "insertion") insertions.push(op);
    }

    const pairCount = Math.min(omissions.length, insertions.length);
    for (let p = 0; p < pairCount; p++) {
      result.push({ op: "substitution", targetWord: omissions[p].targetWord, saidWord: insertions[p].saidWord });
    }
    for (let p = pairCount; p < omissions.length; p++) result.push(omissions[p]);
    for (let p = pairCount; p < insertions.length; p++) result.push(insertions[p]);

    idx = otherEnd;
  }
  return result;
}

/**
 * Word-level diff between a target sentence and a transcript, via a standard
 * LCS dynamic-programming alignment over normalized tokens (lowercase, punctuation
 * stripped, whitespace collapsed). Output preserves each side's original casing
 * and punctuation. Adjacent omission/insertion runs (in either backtrack order)
 * are paired positionally into substitutions — see mergeAdjacentEdits.
 */
export function wordDiff(target: string, transcript: string): DiffOp[] {
  const targetWords = tokenize(target);
  const saidWords = tokenize(transcript);
  const targetNorm = targetWords.map(normalize);
  const saidNorm = saidWords.map(normalize);

  const n = targetWords.length;
  const m = saidWords.length;

  // dp[i][j] = length of the LCS of targetNorm[0..i) and saidNorm[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = targetNorm[i - 1] === saidNorm[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack from (n, m) to (0, 0). On a tie, prefer consuming an insertion
  // before an omission — since backtracking walks the sequence in reverse,
  // this yields the conventional "omissions before insertions" reading order
  // within a mismatched run once the trace is reversed below.
  const reversedOps: RawOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && targetNorm[i - 1] === saidNorm[j - 1]) {
      reversedOps.push({ op: "match", targetWord: targetWords[i - 1], saidWord: saidWords[j - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      reversedOps.push({ op: "insertion", saidWord: saidWords[j - 1] });
      j--;
    } else {
      reversedOps.push({ op: "omission", targetWord: targetWords[i - 1] });
      i--;
    }
  }
  const ops = reversedOps.reverse();
  return mergeAdjacentEdits(ops);
}
