/**
 * The demo's only source of randomness: a seeded generator, so the same `today` produces the same
 * rows. Each sitting draws from streams named after its label, so adding a sitting to the history
 * does not reshuffle the ones already there.
 */

export type Rng = {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** `count` distinct items, in their original order. */
  sample<T>(items: readonly T[], count: number): T[];
  /** A version-4-shaped UUID, so ids in URLs look like the ones the app mints. */
  uuid(): string;
};

const DEMO_SEED = "toefl-prep-tool demo history v1";

function hash(text: string): number {
  // FNV-1a, 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A generator for one named stream of the demo history. */
export function rngFor(stream: string): Rng {
  // mulberry32
  let state = hash(`${DEMO_SEED}:${stream}`);
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: (items) => items[int(0, items.length - 1)],
    sample(items, count) {
      const chosen = new Set<number>();
      while (chosen.size < Math.min(count, items.length)) chosen.add(int(0, items.length - 1));
      return items.filter((_, i) => chosen.has(i));
    },
    uuid() {
      const hex = Array.from({ length: 32 }, () => int(0, 15).toString(16));
      hex[12] = "4";
      hex[16] = ((int(0, 15) & 0x3) | 0x8).toString(16);
      const s = hex.join("");
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    },
  };
}
