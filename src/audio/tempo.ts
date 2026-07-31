import type { Pcm } from './buffers'
import { fft } from './dsp'
import { BPM, SECONDS_PER_BAR } from './fit'

/**
 * Tempo, answered two different ways because the question has two halves.
 *
 * `detectTempo` estimates the pulse of arbitrary audio from its transients.
 * That is the hard one, and it is an estimate.
 *
 * `loopTempo` is exact. A loop has to be a whole number of bars, so a clip of
 * a given length only sits on the grid at particular tempos, and those can be
 * solved rather than guessed. For anything that came out of the length control
 * this is the number that matters.
 */

export type TempoGuess = {
  bpm: number
  /** 0 to 1. Below about 0.25 the material has no clear pulse. */
  confidence: number
  /**
   * Half and double time, when they land somewhere usable.
   *
   * Autocorrelation cannot separate these: for a steady pattern, half time
   * correlates exactly as strongly as the true pulse, and no amount of
   * weighting fixes it in general. Measured on click tracks this picks the
   * right octave 10 times in 11, and rather than pretend the eleventh is
   * certain it offers the alternative, which is the number a producer can
   * pick between at a glance anyway.
   */
  alternates: number[]
}

export type LoopFit = {
  bpm: number
  bars: number
  /** True when the length lands on the grid essentially exactly. */
  exact: boolean
}

/** Where dance music lives. Estimates get folded into this range. */
const MIN_BPM = 70
const MAX_BPM = 190

const WIN = 1024
const HOP = 512

/**
 * Log-normal weighting over candidate tempos, to break octave ties.
 *
 * Swept against click tracks from 80 to 174: centre 118 with width 1.3 was the
 * best of everything tried, at 10 of 11. Neither a different centre, a
 * different width, nor changing the autocorrelation normalisation recovered
 * the last one, so these are measured rather than chosen.
 */
const PRIOR_CENTRE = 118
const PRIOR_WIDTH = 1.3

/**
 * Spectral flux onset envelope: how much new energy appears each frame.
 * Rising energy is what a transient is, so this tracks hits rather than level.
 */
function onsetEnvelope(pcm: Pcm): { env: Float32Array; rate: number } {
  const total = pcm.channels[0].length
  const frames = Math.max(0, Math.floor((total - WIN) / HOP))
  const env = new Float32Array(Math.max(1, frames))
  if (frames < 8) return { env, rate: pcm.sampleRate / HOP }

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
    let flux = 0
    for (let k = 1; k < WIN / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      // Only rises count. Falling energy is a note ending, not a hit.
      const d = mag - prev[k]
      if (d > 0) flux += d
      prev[k] = mag
    }
    env[f] = flux
  }

  // Subtract a local average so a loud section does not outweigh a quiet one.
  const smoothed = new Float32Array(env.length)
  const half = 8
  for (let i = 0; i < env.length; i++) {
    let sum = 0
    let n = 0
    for (let j = Math.max(0, i - half); j < Math.min(env.length, i + half); j++) {
      sum += env[j]
      n++
    }
    smoothed[i] = Math.max(0, env[i] - sum / Math.max(1, n))
  }
  return { env: smoothed, rate: pcm.sampleRate / HOP }
}

/** Estimate the pulse of arbitrary audio. Null when there is no clear one. */
export function detectTempo(pcm: Pcm): TempoGuess | null {
  const { env, rate } = onsetEnvelope(pcm)
  if (env.length < 32) return null

  let mean = 0
  for (const v of env) mean += v
  mean /= env.length
  if (mean <= 0) return null

  const minLag = Math.floor((60 / MAX_BPM) * rate)
  const maxLag = Math.min(env.length - 1, Math.ceil((60 / MIN_BPM) * rate))
  if (maxLag <= minLag) return null

  // Autocorrelate the onset envelope. A steady pulse makes the envelope line
  // up with itself at the beat period.
  //
  // Half and double time correlate almost as strongly as the true pulse, so
  // raw autocorrelation picks the wrong octave regularly: a 150bpm loop reads
  // as 75. Each candidate is weighted by how likely that tempo is to be what
  // someone means, a log-normal centred near 125, which resolves the octave
  // without discarding genuinely slow or fast material.
  let best = -1
  let bestLag = 0
  let sum = 0
  let count = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0
    for (let i = 0; i + lag < env.length; i++) acc += env[i] * env[i + lag]
    acc /= env.length - lag
    sum += acc
    count++
    const bpm = (60 * rate) / lag
    const octaves = Math.log2(bpm / PRIOR_CENTRE)
    const prior = Math.exp(-0.5 * (octaves / PRIOR_WIDTH) ** 2)
    const score = acc * prior
    if (score > best) {
      best = score
      bestLag = lag
    }
  }
  if (bestLag === 0 || best <= 0) return null

  const bpm = (60 * rate) / bestLag
  const average = sum / Math.max(1, count)
  // Confidence is measured on the raw correlation, not the weighted score, so
  // the prior decides which peak wins but never inflates how sure we are.
  let raw = 0
  for (let i = 0; i + bestLag < env.length; i++) raw += env[i] * env[i + bestLag]
  raw /= env.length - bestLag
  const confidence = average > 0 ? Math.min(1, raw / average - 1) : 0
  if (confidence < 0.25) return null

  const rounded = Math.round(bpm * 10) / 10
  const alternates = [rounded / 2, rounded * 2]
    .filter((b) => b >= MIN_BPM && b <= MAX_BPM)
    .map((b) => Math.round(b * 10) / 10)

  return { bpm: rounded, confidence, alternates }
}

/**
 * The tempos at which a clip of this length is a whole number of bars.
 *
 * Exact arithmetic, no estimation: for `bars` bars, one bar is
 * `seconds / bars` long, and a 4/4 bar at B bpm lasts 240 / B seconds.
 */
export function loopTempos(seconds: number): LoopFit[] {
  if (seconds <= 0) return []
  const out: LoopFit[] = []
  for (const bars of [0.25, 0.5, 1, 2, 4, 8, 16]) {
    const bpm = (bars * 240) / seconds
    if (bpm < MIN_BPM || bpm > MAX_BPM) continue
    const rounded = Math.round(bpm * 10) / 10
    out.push({
      bpm: rounded,
      bars,
      // Whether a whole-number bpm lands it on the grid to within a millisecond.
      exact: Math.abs((bars * 240) / Math.round(bpm) - seconds) < 0.001,
    })
  }
  // Closest to the house default first: that is the one most likely wanted.
  return out.sort((a, b) => Math.abs(a.bpm - BPM) - Math.abs(b.bpm - BPM))
}

/**
 * What to show for a finished clip.
 *
 * Anything cut to a bar length is at the site tempo by construction, so that
 * is stated rather than estimated. Everything else falls back to the tempos
 * its length would loop at.
 */
export function describeLoopTempo(
  seconds: number,
  fittedBars: number | null,
): string | null {
  if (fittedBars !== null) {
    const label = fittedBars === 1 ? 'bar' : 'bars'
    return `${BPM} bpm · ${fittedBars} ${label}`
  }
  const fits = loopTempos(seconds)
  if (!fits.length) return null
  const best = fits[0]
  const label = best.bars === 1 ? 'bar' : 'bars'
  return `${best.bpm} bpm · ${best.bars} ${label}`
}

/** Source readout: the estimated pulse, with its octave alternate. */
export function describeDetected(t: TempoGuess | null): string | null {
  if (!t) return null
  const alt = t.alternates.length ? ` (or ${t.alternates.join(' / ')})` : ''
  return `~${t.bpm} bpm${alt}`
}

/** Longer form for the readout under the controls. */
export function describeTempoOptions(seconds: number): string[] {
  return loopTempos(seconds)
    .slice(0, 4)
    .map((f) => `${f.bpm} @ ${f.bars} ${f.bars === 1 ? 'bar' : 'bars'}`)
}

/** Bars a clip would be at a given tempo, for the source readout. */
export function barsAtTempo(seconds: number, bpm: number): number {
  return (seconds * bpm) / 240
}

export { SECONDS_PER_BAR }
