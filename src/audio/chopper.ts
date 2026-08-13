import { applyEdgeFades, foldLoopSeam, normalizeInPlace, type Pcm } from './buffers'
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

/**
 * Where the source gets cut.
 *
 * `transient` cuts on detected onsets, which follows the delivery — slices
 * start on consonants and are all different lengths. A number cuts on a grid
 * instead, that many divisions per bar, so every slice is exactly one slot long
 * and the rhythm is dead tight rather than sung.
 */
export type Quantize = 'transient' | 1 | 2 | 4 | 8 | 16

export const QUANTIZE_CHOICES: { id: Quantize; label: string; hint: string }[] = [
  { id: 'transient', label: 'transients', hint: 'cut on the consonants, as sung' },
  { id: 1, label: '1/1', hint: 'one bar per slice' },
  { id: 2, label: '1/2', hint: 'half notes' },
  { id: 4, label: '1/4', hint: 'quarter notes' },
  { id: 8, label: '1/8', hint: 'eighth notes' },
  { id: 16, label: '1/16', hint: 'sixteenths, very choppy' },
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
  /**
   * Where to cut the source. See `Quantize`.
   *
   * Cut on the *chop's* tempo, not the vocal's own detected tempo. That is the
   * deliberate choice: it makes every slice exactly one grid slot long, so the
   * slices tile the output rhythm instead of almost fitting it. Cutting on the
   * source's tempo would preserve how it was sung, which is what `transient`
   * is already for.
   */
  quantize: Quantize
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
  quantize: 'transient',
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
 * Cut the source on a grid instead of on its transients.
 *
 * Only whole slices are kept, so every one is exactly the same length and lands
 * on a grid multiple — a trailing part-slice would be the one piece that did not
 * fit the rhythm.
 *
 * Near-silent slices are dropped. With transients that never happens, because a
 * slice starts where energy appeared; on a grid, a chunk can land in a gap
 * between phrases, and offering silence as chop material just puts holes in the
 * loop. Dropping them keeps every remaining slice on the grid.
 */
export function slicesFromGrid(pcm: Pcm, bpm: number, perBar: number): Slice[] {
  const total = pcm.channels[0].length
  const secPerBar = (60 / bpm) * 4
  const len = Math.max(1, Math.round((secPerBar / perBar) * pcm.sampleRate))
  const whole: Slice[] = []
  for (let start = 0; start + len <= total; start += len) {
    whole.push({ start, end: start + len })
  }
  if (!whole.length) return [{ start: 0, end: total }]

  const level = (sl: Slice) => {
    let sum = 0
    let n = 0
    for (const ch of pcm.channels) {
      for (let i = sl.start; i < sl.end; i += 4) {
        sum += ch[i] * ch[i]
        n++
      }
    }
    return n ? Math.sqrt(sum / n) : 0
  }
  const levels = whole.map(level)
  const loudest = Math.max(...levels)
  // A twentieth of the loudest slice: quiet enough to keep a soft tail, low
  // enough to reject a gap.
  const floor = loudest * 0.05
  const kept = whole.filter((_, i) => levels[i] > floor)
  return kept.length ? kept : whole
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

type Placement = { step: number; slice: Slice; gain: number; sliceIndex: number }

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

    let sliceIndex: number
    if (opts.inOrder) {
      sliceIndex = cursor % slices.length
      cursor++
    } else {
      // Mostly walk forward through the phrase, sometimes jump. Keeps some of
      // the original delivery instead of scrambling it completely.
      if (rng() < 0.7 + (1 - spice) * 0.2) cursor += 1
      else cursor = Math.floor(rng() * slices.length)
      sliceIndex = ((cursor % slices.length) + slices.length) % slices.length
    }
    out.push({ step, slice: slices[sliceIndex], gain: 0.82 + rng() * 0.18, sliceIndex })
  }
  return out
}

/**
 * Lay phrases out in pattern order.
 *
 * Each phrase is folded back to `frames` first, so a phrase that grew under an
 * effect — a reverb tail, a pitch shifter's overhang — wraps onto its own head
 * rather than pushing the loop off the grid. The fold is why a treated phrase
 * still joins to itself, and because every repeat of a letter is the same buffer,
 * the arrangement survives whatever the rack did.
 */
export function stitchPhrases(
  phrases: Record<string, Pcm>,
  order: string[],
  frames: number,
): Pcm {
  const first = phrases[order[0]]
  const channels = first.channels.length
  const total = frames * order.length
  const out: Pcm = {
    sampleRate: first.sampleRate,
    channels: Array.from({ length: channels }, () => new Float32Array(total)),
  }
  const folded: Record<string, Pcm> = {}
  for (const letter of Object.keys(phrases)) {
    const p = phrases[letter]
    folded[letter] =
      p.channels[0].length > frames
        ? foldLoopSeam(p, frames)
        : {
            sampleRate: p.sampleRate,
            channels: p.channels.map((ch) => {
              const padded = new Float32Array(frames)
              padded.set(ch.subarray(0, Math.min(ch.length, frames)))
              return padded
            }),
          }
  }
  order.forEach((letter, idx) => {
    const src = folded[letter]
    for (let c = 0; c < channels; c++) {
      out.channels[c].set(src.channels[Math.min(c, src.channels.length - 1)], idx * frames)
    }
  })
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
  /**
   * The distinct phrases, keyed by letter, before arrangement.
   *
   * Exposed so effects can be applied per phrase and the loop restitched. Run
   * over the whole 16 bars instead, a chop reorders material across phrase
   * boundaries and a reverb tail or a pitch grain smears through them, and the
   * arrangement the pattern exists to create is destroyed — measured: a dry AAAB
   * read back as ABCD once any of those was in the rack.
   */
  phrases: Record<string, Pcm>
  /** The four letters, in order. */
  order: string[]
  /**
   * Every voice in the finished loop, as fractions of the whole.
   *
   * `slice` is which source slice it came from, so the same syllable can be
   * given the same colour wherever it lands. This is what lets you see the
   * pattern repeat rather than having to infer it from the waveform.
   */
  voices: { start: number; end: number; slice: number }[]
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
  // Onset detection is an FFT over the whole file, so it is skipped entirely
  // when the cuts are coming from the grid instead.
  const onsets = options.quantize === 'transient' ? detectOnsets(pcm) : []
  const slices =
    options.quantize === 'transient'
      ? slicesFromOnsets(pcm, onsets)
      : slicesFromGrid(pcm, options.bpm, options.quantize)

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
  const voicesByLetter: Record<string, { start: number; end: number; slice: number }[]> = {}

  for (const letter of unique) {
    // A is the main idea; later letters get progressively more variation.
    const spice = letter === 'A' ? 0 : options.variation * (letter === 'B' ? 1 : 1.25)
    const placements = buildPhrase(slices, PHRASE_BARS, options, rng, spice)
    const chans: Float32Array<ArrayBuffer>[] = pcm.channels.map(
      () => new Float32Array(phraseSamples),
    )
    const voices: { start: number; end: number; slice: number }[] = []

    for (let p = 0; p < placements.length; p++) {
      const { step, slice, gain, sliceIndex } = placements[p]
      const at = step * stepSamples
      // A slice runs until the next placement, so by default nothing overlaps
      // into mush. `hold` extends that window and lets slices ring over each
      // other, which is the difference between a stutter and a held vowel.
      const nextStep =
        p + 1 < placements.length ? placements[p + 1].step : PHRASE_BARS * options.resolution
      // One voice at a time.
      //
      // A chop is a mono instrument: the next hit takes the voice, the way a
      // sampler in mono mode or a singer's throat does. Letting slices ring
      // over each other turns a rhythm into a smear, and the rhythm is the
      // whole point of this page. So a slice never outlives the next one.
      const slot = Math.max(stepSamples, (nextStep - step) * stepSamples)

      // What is left to lift is how much *material* the voice gets. A slice
      // normally stops at the next transient, which is usually well short of
      // its own slot, so it stops early and leaves a gap. Hold lets it keep
      // reading past that boundary into whatever came next in the take, up to
      // the moment the next hit steals the voice — a held vowel instead of a
      // clipped syllable, without ever becoming two voices.
      const natural = slice.end - slice.start
      const toEnd = total - slice.start
      const reach = Math.round(natural + (toEnd - natural) * options.hold)
      const len = Math.min(reach, slot, phraseSamples - at)
      if (len <= 0) continue

      // The tail fade is the voice being released rather than cut. Short enough
      // to stay tight, long enough that a steal mid-vowel is not a click.
      const fade = Math.min(Math.floor(0.004 * sr), Math.floor(len / 2))
      const release = Math.min(Math.floor(0.006 * sr), Math.floor(len / 2))
      for (let c = 0; c < chans.length; c++) {
        const src = pcm.channels[Math.min(c, pcm.channels.length - 1)]
        const dst = chans[c]
        for (let i = 0; i < len; i++) {
          let v = src[slice.start + i] * gain
          if (i < fade) v *= i / fade
          else if (i > len - release) v *= (len - i) / release
          // Assignment, not accumulation: nothing else owns these frames.
          dst[at + i] = v
        }
      }
      voices.push({ start: at, end: at + len, slice: sliceIndex })
    }
    rendered[letter] = chans
    voicesByLetter[letter] = voices
  }

  // Stitch the arrangement.
  const totalSamples = phraseSamples * letters.length
  const out: Pcm = {
    sampleRate: sr,
    channels: pcm.channels.map(() => new Float32Array(totalSamples)),
  }
  const sections: { bar: number; letter: string }[] = []
  const voices: { start: number; end: number; slice: number }[] = []
  letters.forEach((letter, idx) => {
    sections.push({ bar: idx * PHRASE_BARS, letter })
    const src = rendered[letter]
    const at = idx * phraseSamples
    for (let c = 0; c < out.channels.length; c++) {
      out.channels[c].set(src[Math.min(c, src.length - 1)], at)
    }
    // The same phrase stamped twice gets the same colours twice, which is the
    // repeat made visible.
    for (const v of voicesByLetter[letter]) {
      voices.push({
        start: (at + v.start) / totalSamples,
        end: (at + v.end) / totalSamples,
        slice: v.slice,
      })
    }
  })

  normalizeInPlace(out)
  applyEdgeFades(out, 0.002)

  const phrases: Record<string, Pcm> = {}
  for (const letter of unique) {
    phrases[letter] = { sampleRate: sr, channels: rendered[letter] }
  }

  return {
    pcm: out,
    slices: slices.length,
    onsets: onsets.length,
    sections,
    bars: PHRASE_BARS * letters.length,
    voices,
    phrases,
    order: letters,
  }
}
