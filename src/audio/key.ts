import type { Pcm } from './buffers'

/**
 * Musical key detection.
 *
 * Chromagram into Krumhansl-Schmuckler profile matching, which is the standard
 * approach and holds up well on real material. The audio is folded into twelve
 * pitch classes, then that shape is correlated against all twenty four keys.
 *
 * It reports a confidence and will say it does not know rather than guess. A
 * drum loop has no key, and claiming one would be worse than useless in a tool
 * whose whole job is fitting a chop into a track.
 */

export type KeyResult = {
  /** 0 = C, 1 = C#, ... 11 = B */
  tonic: number
  mode: 'major' | 'minor'
  /** How well the best key fit, 0 to 1. */
  confidence: number
  /** How far clear of the runner-up, 0 to 1. */
  margin: number
  label: string
  /** Camelot wheel position, the notation actually used for mixing. */
  camelot: string
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/**
 * Krumhansl-Schmuckler profiles, from listener ratings of how well each pitch
 * class fits a key. Rotating these to each tonic gives the 24 candidates.
 */
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

/** Camelot: major keys are B, minor are A, numbered round the fifths circle. */
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]

/** In-place iterative radix-2 FFT. `re` and `im` must be a power of two long. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]
        const ai = im[i + k]
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ar + br
        im[i + k] = ai + bi
        re[i + k + len / 2] = ar - br
        im[i + k + len / 2] = ai - bi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

const SIZE = 4096
/**
 * Analysis band. Below ~65Hz the bass fundamental smears across pitch classes
 * and above ~2kHz it is mostly harmonics and cymbals, neither of which helps
 * decide a key.
 */
const F_MIN = 65
const F_MAX = 2100
/**
 * Above this, a frame is broadband enough to be percussion or noise rather
 * than a note, and it does not get a vote. Measured: sustained tonal frames
 * sit well under 0.1, drum hits and white noise well above 0.2.
 */
const FLATNESS_LIMIT = 0.16

function pearson(a: number[], b: number[]): number {
  const n = a.length
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db)
}

/**
 * Fold audio into twelve pitch classes.
 *
 * Frames are spread across the whole sample rather than taken from the front,
 * so a long track is judged on all of it without analysing every window.
 */
export function chromagram(pcm: Pcm, maxFrames = 900): number[] {
  const sr = pcm.sampleRate
  const total = pcm.channels[0].length
  const chroma = new Array(12).fill(0)
  if (total < SIZE) return chroma

  const hop = SIZE / 2
  const possible = Math.max(1, Math.floor((total - SIZE) / hop))
  const stride = Math.max(1, Math.floor(possible / maxFrames))

  const re = new Float32Array(SIZE)
  const im = new Float32Array(SIZE)
  const window = new Float32Array(SIZE)
  for (let i = 0; i < SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SIZE - 1))
  }

  const kMin = Math.max(1, Math.floor((F_MIN * SIZE) / sr))
  const kMax = Math.min(SIZE / 2 - 1, Math.ceil((F_MAX * SIZE) / sr))
  const chans = pcm.channels

  // Which pitch class each bin belongs to, and how many bins each class got.
  //
  // The count matters: an FFT is linear in frequency, so an octave up has
  // twice the bins per semitone. Without dividing this out, a flat spectrum
  // folds into a lopsided chroma and white noise gets confidently named a key.
  const binPc = new Int8Array(kMax + 1).fill(-1)
  const binsPerPc = new Float64Array(12)
  for (let k = kMin; k <= kMax; k++) {
    const freq = (k * sr) / SIZE
    const midi = 69 + 12 * Math.log2(freq / 440)
    const pc = ((Math.round(midi) % 12) + 12) % 12
    binPc[k] = pc
    binsPerPc[pc] += 1
  }

  for (let f = 0; f < possible; f += stride) {
    const at = f * hop
    for (let i = 0; i < SIZE; i++) {
      let v = 0
      for (let c = 0; c < chans.length; c++) v += chans[c][at + i]
      re[i] = (v / chans.length) * window[i]
      im[i] = 0
    }
    fft(re, im)

    // Per-frame normalisation, so a loud bar does not outvote a quiet one.
    const frame = new Array(12).fill(0)
    let peak = 0
    // Spectral flatness, as the geometric mean over the arithmetic mean.
    // A held note is peaky and scores low; a snare or a hat is broadband and
    // scores high. Gating on it means percussion stops voting, which is what
    // lets a vocal sitting over a drum loop still report the vocal's key.
    let logSum = 0
    let linSum = 0
    let count = 0
    for (let k = kMin; k <= kMax; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      if (mag > peak) peak = mag
      logSum += Math.log(mag + 1e-10)
      linSum += mag
      count++
    }
    if (peak <= 0 || count === 0) continue
    const flatness = Math.exp(logSum / count) / (linSum / count + 1e-10)
    if (flatness > FLATNESS_LIMIT) continue
    for (let k = kMin; k <= kMax; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      // Ignore the noise floor: it is spread evenly across pitch classes and
      // only ever blurs the answer.
      if (mag < peak * 0.06) continue
      const pc = binPc[k]
      if (pc < 0) continue
      frame[pc] += mag
    }
    // Divide out the uneven bin counts so each pitch class is on equal terms.
    for (let i = 0; i < 12; i++) {
      if (binsPerPc[i] > 0) frame[i] /= binsPerPc[i]
    }
    let sum = 0
    for (let i = 0; i < 12; i++) sum += frame[i]
    if (sum <= 0) continue
    for (let i = 0; i < 12; i++) chroma[i] += frame[i] / sum
  }

  return chroma
}

/** Best-fitting key, or null when nothing fits well enough to name. */
export function detectKey(pcm: Pcm): KeyResult | null {
  const chroma = chromagram(pcm)
  const total = chroma.reduce((a, b) => a + b, 0)
  if (total <= 0) return null

  // Tonality gate. Pitched material concentrates energy in a few classes;
  // percussion and noise spread it evenly. Correlation alone cannot tell those
  // apart, because a nearly flat chroma can still lean slightly toward some
  // profile, so the shape is checked before the fit is trusted.
  const mean = total / 12
  const peak = Math.max(...chroma)
  const peakRatio = mean > 0 ? peak / mean : 0
  if (peakRatio < 1.6) return null

  const scored: { tonic: number; mode: 'major' | 'minor'; score: number }[] = []
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const profile = mode === 'major' ? MAJOR : MINOR
      const rotated = profile.map((_, i) => profile[(i - tonic + 144) % 12])
      scored.push({ tonic, mode, score: pearson(chroma, rotated) })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  const margin = best.score - scored[1].score

  // Percussion and noise correlate weakly with every profile. Naming a key
  // there would be confidently wrong, which is worse than saying nothing.
  if (best.score < 0.5) return null

  return {
    tonic: best.tonic,
    mode: best.mode,
    confidence: Math.max(0, Math.min(1, best.score)),
    margin,
    label: `${NAMES[best.tonic]} ${best.mode === 'major' ? 'maj' : 'min'}`,
    camelot: `${best.mode === 'major' ? CAMELOT_MAJOR[best.tonic] : CAMELOT_MINOR[best.tonic]}${best.mode === 'major' ? 'B' : 'A'}`,
  }
}

/** One short string for the interface, or null when there is no key to show. */
export function describeKey(k: KeyResult | null): string | null {
  if (!k) return null
  // A weak margin means the runner-up was nearly as good, usually the relative
  // major or minor. Marking it is more honest than picking silently.
  return k.margin < 0.035 ? `${k.label}? · ${k.camelot}` : `${k.label} · ${k.camelot}`
}
