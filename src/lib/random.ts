/**
 * Deterministic randomness. The mock provider, the vote policy, avatars, and the
 * seed all derive their choices from stable identifiers so a fresh checkout
 * reproduces the same demo and tests can assert exact outcomes.
 */

/** 32-bit FNV-1a hash of a string; stable across runs and platforms. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (const char of input) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Small, fast PRNG (mulberry32). Not for security; only for reproducible choices. */
export class SeededRandom {
  private state: number;

  constructor(seed: number | string) {
    const numeric = typeof seed === "string" ? fnv1a32(seed) : seed >>> 0;
    this.state = numeric === 0 ? 0x9e3779b9 : numeric;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    if (max < min) throw new RangeError(`int(): max ${max} < min ${min}`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("pick(): empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Fisher-Yates shuffle into a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = a;
    }
    return copy;
  }

  /** Picks `count` distinct items (or fewer when the list is shorter). */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, Math.max(0, count));
  }
}
