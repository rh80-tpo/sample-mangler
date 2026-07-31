/**
 * mulberry32. Small, fast, and good enough for parameter rolls.
 * Seeded so a roll is reproducible from its seed alone, which is what makes
 * "did reroll actually change anything" a checkable question instead of a
 * vibe.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Rng = ReturnType<typeof mulberry32>

/** Fresh seed from the platform CSPRNG, so rolls do not repeat across reloads. */
export function freshSeed(): number {
  const a = new Uint32Array(1)
  crypto.getRandomValues(a)
  return a[0]
}

export function randRange(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min)
}

export function randInt(rng: Rng, min: number, max: number): number {
  return Math.floor(randRange(rng, min, max + 1))
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]
}

export function chance(rng: Rng, p: number): boolean {
  return rng() < p
}

/** Fisher-Yates, seeded. */
export function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Draw an index from a weight table. Weights need not sum to 1. */
export function weighted(rng: Rng, weights: readonly number[]): number {
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rng() * total
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]
    if (r <= 0) return i
  }
  return weights.length - 1
}
