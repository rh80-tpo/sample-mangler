import { applyEdgeFades, type Pcm } from './buffers'

/** A region of a sample, as fractions of its total length. */
export type Region = { start: number; end: number }

/** Smallest selection worth treating as a region rather than a stray drag. */
export const MIN_REGION = 0.004

export function normaliseRegion(r: Region): Region {
  const start = Math.max(0, Math.min(1, Math.min(r.start, r.end)))
  const end = Math.max(0, Math.min(1, Math.max(r.start, r.end)))
  return { start, end }
}

export function regionIsReal(r: Region | null): r is Region {
  return r !== null && r.end - r.start >= MIN_REGION
}

export function regionSeconds(r: Region, totalSeconds: number): number {
  return (r.end - r.start) * totalSeconds
}

/**
 * Cut a region out as its own sample.
 *
 * Gets its own short edge fades, because a cut made mid-waveform starts and
 * ends on an arbitrary sample value and would click without them.
 */
export function slicePcm(pcm: Pcm, region: Region): Pcm {
  const total = pcm.channels[0].length
  const a = Math.max(0, Math.min(total - 1, Math.floor(region.start * total)))
  const b = Math.max(a + 1, Math.min(total, Math.ceil(region.end * total)))
  const out: Pcm = {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => ch.slice(a, b)),
  }
  return applyEdgeFades(out, 0.003)
}
