/**
 * Small DSP toolkit for the built-in sample generators.
 *
 * Deliberately hand-rolled rather than routed through Tone: these run once to
 * make source material, they never touch the mangling chain, and keeping them
 * as plain math means no context juggling and no worklet setup just to build a
 * two second sample.
 */

/**
 * In-place iterative radix-2 FFT. `re` and `im` must be a power of two long.
 * Shared by the key and tempo detectors.
 */
export function fft(re: Float32Array, im: Float32Array): void {
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

/** RBJ biquad. One instance holds one filter's state. */
export class Biquad {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  constructor(
    kind: 'lowpass' | 'highpass' | 'bandpass',
    freq: number,
    q: number,
    sampleRate: number,
  ) {
    this.set(kind, freq, q, sampleRate)
  }

  set(
    kind: 'lowpass' | 'highpass' | 'bandpass',
    freq: number,
    q: number,
    sampleRate: number,
  ) {
    const f = Math.max(20, Math.min(sampleRate * 0.45, freq))
    const w0 = (2 * Math.PI * f) / sampleRate
    const cos = Math.cos(w0)
    const sin = Math.sin(w0)
    const alpha = sin / (2 * Math.max(0.05, q))
    let b0: number
    let b1: number
    let b2: number
    if (kind === 'lowpass') {
      b0 = (1 - cos) / 2
      b1 = 1 - cos
      b2 = (1 - cos) / 2
    } else if (kind === 'highpass') {
      b0 = (1 + cos) / 2
      b1 = -(1 + cos)
      b2 = (1 + cos) / 2
    } else {
      b0 = alpha
      b1 = 0
      b2 = -alpha
    }
    const a0 = 1 + alpha
    this.b0 = b0 / a0
    this.b1 = b1 / a0
    this.b2 = b2 / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
  }

  process(x: number): number {
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }
}

/** Attack/decay/sustain/release, evaluated per sample. */
export function adsr(
  t: number,
  dur: number,
  a: number,
  d: number,
  s: number,
  r: number,
): number {
  if (t < 0) return 0
  const rel = Math.max(0, dur - r)
  if (t < a) return t / a
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d)
  if (t < rel) return s
  if (t < dur) return s * (1 - (t - rel) / r)
  return 0
}

/** Polynomial transition band, removes the worst of the saw aliasing. */
export function polyBlepSaw(phase: number, inc: number): number {
  let v = 2 * phase - 1
  if (phase < inc) {
    const t = phase / inc
    v -= t + t - t * t - 1
  } else if (phase > 1 - inc) {
    const t = (phase - 1) / inc
    v -= t * t + t + t + 1
  }
  return v
}

/**
 * Schroeder reverb: four parallel combs into two series allpasses.
 * Cheap, slightly metallic, and exactly the right amount of space for a choir
 * or a pad without pulling in a convolution impulse.
 */
export function reverb(
  input: Float32Array,
  sampleRate: number,
  mix: number,
  decay: number,
): Float32Array {
  const combDelays = [1557, 1617, 1491, 1422].map((d) =>
    Math.floor((d * sampleRate) / 44100),
  )
  const apDelays = [225, 556].map((d) => Math.floor((d * sampleRate) / 44100))
  const out = new Float32Array(input.length)

  const combs = combDelays.map((n) => ({ buf: new Float32Array(n), i: 0, n }))
  for (const c of combs) {
    for (let i = 0; i < input.length; i++) {
      const y = c.buf[c.i]
      c.buf[c.i] = input[i] + y * decay
      c.i = (c.i + 1) % c.n
      out[i] += y * 0.25
    }
  }

  for (const n of apDelays) {
    const buf = new Float32Array(n)
    let i = 0
    const g = 0.5
    for (let k = 0; k < out.length; k++) {
      const bufOut = buf[i]
      const x = out[k]
      buf[i] = x + bufOut * g
      out[k] = bufOut - x * g
      i = (i + 1) % n
    }
  }

  const res = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) {
    res[i] = input[i] * (1 - mix) + out[i] * mix
  }
  return res
}

/** Equal-tempered frequency for a MIDI note number. */
export function midi(n: number): number {
  return 440 * Math.pow(2, (n - 69) / 12)
}

/**
 * Vowel formants, roughly an alto voice. Each entry is three
 * [frequency, gain, Q] bands. These are what make a filtered buzz read as a
 * voice rather than a synth.
 */
export const VOWELS: Record<string, [number, number, number][]> = {
  a: [
    [730, 1.0, 9],
    [1090, 0.5, 11],
    [2440, 0.18, 13],
  ],
  e: [
    [530, 1.0, 10],
    [1840, 0.45, 12],
    [2480, 0.2, 13],
  ],
  i: [
    [270, 1.0, 11],
    [2290, 0.4, 13],
    [3010, 0.22, 14],
  ],
  o: [
    [570, 1.0, 9],
    [840, 0.55, 10],
    [2410, 0.12, 13],
  ],
  u: [
    [300, 1.0, 10],
    [870, 0.4, 11],
    [2240, 0.1, 13],
  ],
}
