import type { Pcm } from './buffers'

/**
 * Tempo. Adjustable, defaulting to 120.
 *
 * It used to be a hard constant, on the reasoning that a sampler's output has to
 * land on a grid and guessing a source's tempo is a different product. The first
 * half of that still holds; the second turned out to be the wrong conclusion. A
 * producer working at 140 or 174 could not use the bar fitting at all, and the
 * chopper already had its own tempo, so the two halves of the tool disagreed.
 *
 * 120 stays the default because it is the value most of this was designed
 * around, and because a tempo you did not choose should be the common one.
 */
export const DEFAULT_BPM = 120

/** Tempos worth one tap, matching the chopper's row. */
export const BPM_CHOICES = [90, 100, 110, 120, 128, 140, 150, 174] as const

export const secondsPerBeat = (bpm: number = DEFAULT_BPM) => 60 / bpm
export const secondsPerBar = (bpm: number = DEFAULT_BPM) => secondsPerBeat(bpm) * 4

/** Bar lengths worth offering. Below an eighth of a bar it is a one-shot. */
export const BAR_CHOICES = [0.25, 0.5, 1, 2, 4, 8, 16] as const

export type FitMode = 'trim' | 'stretch' | 'fit'

export type FitSpec = {
  /** null means leave the length exactly as the chain produced it. */
  bars: number | null
  mode: FitMode
  /** The grid the bar count is measured against. */
  bpm: number
}

export const NO_FIT: FitSpec = { bars: null, mode: 'trim', bpm: DEFAULT_BPM }

/**
 * The nearest bar length worth snapping a sample to.
 *
 * This is a loop and vocal-chop tool, so an off-grid result is a result you
 * cannot use. Picking the closest musical length on load means the first thing
 * you hear already sits in a session, and "as is" is there for when you want
 * the raw tail back.
 */
export function nearestBars(seconds: number, bpm: number = DEFAULT_BPM): number {
  const bars = barsOf(seconds, bpm)
  let best: number = BAR_CHOICES[0]
  let bestGap = Infinity
  for (const choice of BAR_CHOICES) {
    // Compared in log space so 1 bar against 2 is judged the same way as 4
    // against 8, rather than the big lengths always winning on raw distance.
    const gap = Math.abs(Math.log2(bars / choice))
    if (gap < bestGap) {
      bestGap = gap
      best = choice
    }
  }
  return best
}

export function barsOf(seconds: number, bpm: number = DEFAULT_BPM): number {
  return seconds / secondsPerBar(bpm)
}

/** "2 bars" or "1.5 beats", whichever reads better at that length. */
export function describeLength(seconds: number, bpm: number = DEFAULT_BPM): string {
  const bars = barsOf(seconds, bpm)
  if (bars >= 1) {
    const rounded = Math.round(bars * 100) / 100
    return `${rounded} ${rounded === 1 ? 'bar' : 'bars'} @ ${bpm}`
  }
  const beats = seconds / secondsPerBeat(bpm)
  const rounded = Math.round(beats * 100) / 100
  return `${rounded} ${rounded === 1 ? 'beat' : 'beats'} @ ${bpm}`
}

export function barLabel(bars: number): string {
  if (bars >= 1) return `${bars}`
  return bars === 0.5 ? '1/2' : '1/4'
}

/**
 * Cut or pad to an exact length. No resampling, so nothing about the sound
 * changes; it just starts or stops where the grid says.
 */
export function trimTo(pcm: Pcm, seconds: number): Pcm {
  const target = Math.max(1, Math.round(seconds * pcm.sampleRate))
  const current = pcm.channels[0].length
  if (target === current) return pcm
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => {
      const out = new Float32Array(target)
      out.set(ch.subarray(0, Math.min(target, current)))
      return out
    }),
  }
}

/**
 * Cut a window of `seconds` starting wherever the material is loudest.
 *
 * The fallback for when trimming from the head would land on dead air, which
 * happens after a reverse puts a decay tail at the front. Taking the head
 * blindly would hand back silence; this hands back the part worth keeping.
 */
export function trimToLoudest(pcm: Pcm, seconds: number): Pcm {
  const want = Math.max(1, Math.round(seconds * pcm.sampleRate))
  const total = pcm.channels[0].length
  if (want >= total) return trimTo(pcm, seconds)

  // Coarse energy scan: 64 windows is plenty to find the interesting region
  // and avoids walking millions of samples per candidate offset.
  const STEPS = 64
  const stride = Math.max(1, Math.floor((total - want) / STEPS))
  let bestAt = 0
  let bestEnergy = -1
  for (let at = 0; at + want <= total; at += stride) {
    let energy = 0
    // Sample sparsely inside the window; we are ranking, not measuring.
    const step = Math.max(1, Math.floor(want / 2000))
    for (const ch of pcm.channels) {
      for (let i = at; i < at + want; i += step) energy += ch[i] * ch[i]
    }
    if (energy > bestEnergy) {
      bestEnergy = energy
      bestAt = at
    }
  }

  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => ch.slice(bestAt, bestAt + want)),
  }
}

/**
 * Resample to an exact length. Duration and pitch both move together, which is
 * what a hardware sampler does when you change the playback rate.
 *
 * Cubic Hermite rather than linear: linear interpolation on a resample audibly
 * dulls the top end, and this material is meant to keep its bite.
 */
export function resampleTo(pcm: Pcm, seconds: number): Pcm {
  const target = Math.max(2, Math.round(seconds * pcm.sampleRate))
  const current = pcm.channels[0].length
  if (target === current) return pcm
  const ratio = (current - 1) / (target - 1)

  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => {
      const out = new Float32Array(target)
      for (let i = 0; i < target; i++) {
        const pos = i * ratio
        const i1 = Math.floor(pos)
        const t = pos - i1
        const i0 = Math.max(0, i1 - 1)
        const i2 = Math.min(current - 1, i1 + 1)
        const i3 = Math.min(current - 1, i1 + 2)
        const p0 = ch[i0]
        const p1 = ch[i1]
        const p2 = ch[i2]
        const p3 = ch[i3]
        const a = 0.5 * (-p0 + 3 * p1 - 3 * p2 + p3)
        const b = 0.5 * (2 * p0 - 5 * p1 + 4 * p2 - p3)
        const c = 0.5 * (-p0 + p2)
        out[i] = ((a * t + b) * t + c) * t + p1
      }
      return out
    }),
  }
}

/**
 * Semitones of pitch shift needed to undo a resample to `seconds`.
 * Positive when the resample lowered the pitch.
 */
export function compensationSemitones(fromSeconds: number, toSeconds: number): number {
  if (fromSeconds <= 0 || toSeconds <= 0) return 0
  const speed = fromSeconds / toSeconds
  return -12 * Math.log2(speed)
}
