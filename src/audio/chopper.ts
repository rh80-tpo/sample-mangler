import { applyEdgeFades, normalizeInPlace, type Pcm } from './buffers'
import { fft } from './dsp'
import { mulberry32, type Rng } from './rng'

/**
 * Turn a vocal into a 16 bar chopped loop.
 *
 * Three stages, deliberately separate:
 *   1. find the transients, so slices land on syllables rather than a grid
 *   2. build a 4 bar phrase by placing slices on a 16th grid
 *   3. arrange four phrases into 16 bars by a pattern like AAAB
 *
 * The pattern is the point. A 4 bar idea repeated with a variation at the end
 * is how a vocal chop actually sits in a track, and it is the thing that takes
 * longest to do by hand.
 */

export type Pattern = 'AAAB' | 'ABAB' | 'AABA' | 'ABAC' | 'AAAA' | 'ABCB'

export const PATTERNS: { id: Pattern; label: string; hint: string }[] = [
  { id: 'AAAB', label: 'AAAB', hint: 'three the same, then a variation' },
  { id: 'ABAB', label: 'ABAB', hint: 'call and response' },
  { id: 'AABA', label: 'AABA', hint: 'variation in the third phrase' },
  { id: 'ABAC', label: 'ABAC', hint: 'two different answers' },
  { id: 'AAAA', label: 'AAAA', hint: 'flat repeat, no variation' },
  { id: 'ABCB', label: 'ABCB', hint: 'builds, then settles back' },
]

export type ChopOptions = {
  bpm: number
  pattern: Pattern
  /** 0 to 1. How many grid positions get a slice. */
  density: number
  /** 0 to 1. How much the variation phrase departs from the main one. */
  variation: number
  /** Sixteenths per bar position grid. 16 = sixteenths, 8 = eighths. */
  resolution: 8 | 16
  seed: number
  /** Keep slices in the order they were sung rather than shuffling. */
  inOrder: boolean
  /**
   * Bars per phrase. The pattern always covers four phrases, so 4 gives a
   * 16 bar loop and 1 gives a 4 bar one with the same AAAB shape.
   */
  phraseBars: 1 | 2 | 4
  /**
   * 0 to 1. How long a slice is allowed to ring.
   *
   * At 0 a slice stops at the next transient, which is tight and stuttery.
   * Turning it up does two things at once: it gives the slice more room before
   * the next hit, and it lets the slice keep reading past its own onset
   * boundary into the rest of the take. Both are needed — a chop is usually
   * shorter than its grid slot, so extra room on its own changes nothing.
   */
  hold: number
}

export const DEFAULT_CHOP: Omit<ChopOptions, 'seed'> = {
  bpm: 120,
  pattern: 'AAAB',
  density: 0.55,
  variation: 0.6,
  resolution: 16,
  inOrder: false,
  phraseBars: 4,
  hold: 0.25,
}

const WIN = 1024
const HOP = 256

/**
 * Transient positions, as sample indices.
 *
 * Spectral flux with a moving-average threshold. A vocal's consonants are the
 * onsets worth cutting on, and they show up as broadband energy appearing
 * where there was none.
 */
export function detectOnsets(pcm: Pcm, sensitivity = 1.4): number[] {
  const total = pcm.channels[0].length
  const frames = Math.floor((total - WIN) / HOP)
  if (frames < 4) return [0]

  const flux = new Float32Array(frames)
  const re = new Float32Array(WIN)
  const im = new Float32Array(WIN)
  const prev = new Float32Array(WIN / 2)
  const win = new Float32Array(WIN)
  for (let i = 0; i < WIN; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1))
  }
  const chans = pcm.channels

  for (let f = 0; f < frames; f++) {
    const at = f * HOP
    for (let i = 0; i < WIN; i++) {
      let v = 0
      for (let c = 0; c < chans.length; c++) v += chans[c][at + i]
      re[i] = (v / chans.length) * win[i]
      im[i] = 0
    }
    fft(re, im)
    let sum = 0
    for (let k = 1; k < WIN / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      const d = mag - prev[k]
      if (d > 0) sum += d
      prev[k] = mag
    }
    flux[f] = sum
  }

  // Peak pick against a local mean, so a quiet passage still yields onsets.
  const onsets: number[] = []
  const span = 12
  // Roughly 60ms, which is about as close as two syllables get.
  const minGap = Math.floor((0.06 * pcm.sampleRate) / HOP)
  let lastPeak = -minGap
  for (let f = 1; f < frames - 1; f++) {
    let mean = 0
    let n = 0
    for (let j = Math.max(0, f - span); j < Math.min(frames, f + span); j++) {
      mean += flux[j]
      n++
    }
    mean /= Math.max(1, n)
    const isPeak = flux[f] > flux[f - 1] && flux[f] >= flux[f + 1]
    if (isPeak && flux[f] > mean * sensitivity && f - lastPeak >= minGap) {
      onsets.push(f * HOP)
      lastPeak = f
    }
  }

  if (!onsets.length || onsets[0] > pcm.sampleRate * 0.05) onsets.unshift(0)
  return onsets
}

export type Slice = { start: number; end: number }

/** Cut the sample at the onsets. Each slice runs to the next one. */
export function slicesFromOnsets(pcm: Pcm, onsets: number[]): Slice[] {
  const total = pcm.channels[0].length
  const out: Slice[] = []
  for (let i = 0; i < onsets.length; i++) {
    const start = onsets[i]
    const end = i + 1 < onsets.length ? onsets[i + 1] : total
    // Anything under 30ms is a click, not a syllable.
    if (end - start > pcm.sampleRate * 0.03) out.push({ start, end })
  }
  return out.length ? out : [{ start: 0, end: total }]
}

/**
 * Rhythmic weight per position in a bar of sixteenths.
 *
 * Downbeats carry most, the backbeat next, offbeat sixteenths least. Placing
 * slices against this rather than uniformly is the difference between a groove
 * and a stutter.
 */
function gridWeight(step: number, resolution: number): number {
  const perBeat = resolution / 4
  if (step % resolution === 0) return 1
  if (step % perBeat === 0) {
    const beat = step / perBeat
    return beat % 2 === 0 ? 0.85 : 0.7
  }
  if (perBeat >= 4 && step % (perBeat / 2) === 0) return 0.45
  return 0.28
}

type Placement = { step: number; slice: Slice; gain: number }

/** Place slices across `bars` bars on the grid. */
function buildPhrase(
  slices: Slice[],
  bars: number,
  opts: ChopOptions,
  rng: Rng,
  spice: number,
): Placement[] {
  const perBar = opts.resolution
  const steps = bars * perBar
  const out: Placement[] = []
  let cursor = Math.floor(rng() * slices.length)

  for (let step = 0; step < steps; step++) {
    const inBar = step % perBar
    const weight = gridWeight(inBar, perBar)
    // Downbeat of the phrase always lands, so it has an anchor.
    const force = step === 0
    // `spice` pushes extra hits into the back half, which is what makes a
    // variation phrase read as a fill rather than a different loop.
    const late = step / steps > 0.6 ? spice * 0.5 : 0
    const chance = Math.min(1, opts.density * weight + late)
    if (!force && rng() > chance) continue

    let slice: Slice
    if (opts.inOrder) {
      slice = slices[cursor % slices.length]
      cursor++
    } else {
      // Mostly walk forward through the phrase, sometimes jump. Keeps some of
      // the original delivery instead of scrambling it completely.
      if (rng() < 0.7 + (1 - spice) * 0.2) cursor += 1
      else cursor = Math.floor(rng() * slices.length)
      slice = slices[((cursor % slices.length) + slices.length) % slices.length]
    }
    out.push({ step, slice, gain: 0.82 + rng() * 0.18 })
  }
  return out
}

const LETTERS: Record<Pattern, string[]> = {
  AAAB: ['A', 'A', 'A', 'B'],
  ABAB: ['A', 'B', 'A', 'B'],
  AABA: ['A', 'A', 'B', 'A'],
  ABAC: ['A', 'B', 'A', 'C'],
  AAAA: ['A', 'A', 'A', 'A'],
  ABCB: ['A', 'B', 'C', 'B'],
}

export type ChopResult = {
  pcm: Pcm
  slices: number
  onsets: number
  /** Bar index where each phrase starts, and which letter it is. */
  sections: { bar: number; letter: string }[]
  bars: number
}

/**
 * Build the loop.
 *
 * Always 16 bars: four 4-bar phrases arranged by the pattern. The phrases are
 * rendered once each and stamped repeatedly, so a repeat is bit-identical the
 * way a real loop is.
 */
export function buildChop(pcm: Pcm, options: ChopOptions): ChopResult {
  const rng = mulberry32(options.seed)
  const onsets = detectOnsets(pcm)
  const slices = slicesFromOnsets(pcm, onsets)

  const sr = pcm.sampleRate
  const total = pcm.channels[0].length
  const secPerBar = (60 / options.bpm) * 4
  const stepSeconds = secPerBar / options.resolution
  const stepSamples = Math.max(1, Math.round(stepSeconds * sr))
  const PHRASE_BARS = options.phraseBars
  const phraseSamples = Math.round(PHRASE_BARS * secPerBar * sr)

  // One render per distinct letter, so repeats are exact.
  const letters = LETTERS[options.pattern]
  const unique = [...new Set(letters)]
  const rendered: Record<string, Float32Array<ArrayBuffer>[]> = {}

  for (const letter of unique) {
    // A is the main idea; later letters get progressively more variation.
    const spice = letter === 'A' ? 0 : options.variation * (letter === 'B' ? 1 : 1.25)
    const placements = buildPhrase(slices, PHRASE_BARS, options, rng, spice)
    const chans: Float32Array<ArrayBuffer>[] = pcm.channels.map(
      () => new Float32Array(phraseSamples),
    )

    for (let p = 0; p < placements.length; p++) {
      const { step, slice, gain } = placements[p]
      const at = step * stepSamples
      // A slice runs until the next placement, so by default nothing overlaps
      // into mush. `hold` extends that window and lets slices ring over each
      // other, which is the difference between a stutter and a held vowel.
      const nextStep =
        p + 1 < placements.length ? placements[p + 1].step : PHRASE_BARS * options.resolution
      const slot = Math.max(stepSamples, (nextStep - step) * stepSamples)
      const room = Math.round(slot * (1 + options.hold * 5))
      // Two separate limits, and hold lifts both.
      //
      // `room` is how long the rhythm leaves free. `reach` is how much material
      // there is to play: a slice normally stops at the next onset, which is
      // what makes a chop a chop, but that also means it is usually shorter
      // than its own slot — so widening `room` alone changes nothing at all.
      // Hold has to also let the slice read past its onset boundary into
      // whatever came next in the take. That is the difference between a
      // clipped syllable and a held vowel.
      const natural = slice.end - slice.start
      const toEnd = total - slice.start
      const reach = Math.round(natural + (toEnd - natural) * options.hold)
      const len = Math.min(reach, room, phraseSamples - at)
      if (len <= 0) continue

      const fade = Math.min(Math.floor(0.004 * sr), Math.floor(len / 2))
      for (let c = 0; c < chans.length; c++) {
        const src = pcm.channels[Math.min(c, pcm.channels.length - 1)]
        const dst = chans[c]
        for (let i = 0; i < len; i++) {
          let v = src[slice.start + i] * gain
          if (i < fade) v *= i / fade
          else if (i > len - fade) v *= (len - i) / fade
          dst[at + i] += v
        }
      }
    }
    rendered[letter] = chans
  }

  // Stitch the arrangement.
  const totalSamples = phraseSamples * letters.length
  const out: Pcm = {
    sampleRate: sr,
    channels: pcm.channels.map(() => new Float32Array(totalSamples)),
  }
  const sections: { bar: number; letter: string }[] = []
  letters.forEach((letter, idx) => {
    sections.push({ bar: idx * PHRASE_BARS, letter })
    const src = rendered[letter]
    const at = idx * phraseSamples
    for (let c = 0; c < out.channels.length; c++) {
      out.channels[c].set(src[Math.min(c, src.length - 1)], at)
    }
  })

  normalizeInPlace(out)
  applyEdgeFades(out, 0.002)

  return {
    pcm: out,
    slices: slices.length,
    onsets: onsets.length,
    sections,
    bars: PHRASE_BARS * letters.length,
  }
}
