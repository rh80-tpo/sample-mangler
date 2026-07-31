import { applyEdgeFades, normalize, type Pcm } from './buffers'
import { Biquad, VOWELS, adsr, midi, polyBlepSaw, reverb } from './dsp'
import { mulberry32, pick, randInt, randRange, type Rng } from './rng'

export type GeneratorId =
  | 'synth'
  | 'choir'
  | 'vocal'
  | 'bass'
  | 'keys'
  | 'drums'
  | 'pad'
  | 'noise'

export const GENERATORS: { id: GeneratorId; label: string }[] = [
  { id: 'synth', label: 'synth' },
  { id: 'choir', label: 'choir' },
  { id: 'vocal', label: 'vocal' },
  { id: 'bass', label: 'bass' },
  { id: 'keys', label: 'keys' },
  { id: 'drums', label: 'drums' },
  { id: 'pad', label: 'pad' },
  { id: 'noise', label: 'noise' },
]

/** Minor and major triads plus a couple of wider voicings. */
const CHORDS = [
  [0, 3, 7],
  [0, 4, 7],
  [0, 3, 7, 10],
  [0, 4, 7, 11],
  [0, 5, 7],
  [0, 3, 7, 14],
]

type Ctx = { sr: number; rng: Rng; n: number }

function blank(n: number): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  return [new Float32Array(n), new Float32Array(n)]
}

function finish(l: Float32Array<ArrayBuffer>, r: Float32Array<ArrayBuffer>, sr: number): Pcm {
  let pcm: Pcm = { channels: [l, r], sampleRate: sr }
  pcm = normalize(pcm, 0.89)
  return applyEdgeFades(pcm, 0.006)
}

/** Detuned saw stack. The workhorse behind synth, bass, pad and choir. */
function sawStack(
  ctx: Ctx,
  freq: number,
  voices: number,
  detuneCents: number,
  spread: number,
): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const [l, r] = blank(ctx.n)
  for (let v = 0; v < voices; v++) {
    const off = voices === 1 ? 0 : (v / (voices - 1) - 0.5) * 2
    const f = freq * Math.pow(2, (off * detuneCents) / 1200)
    const inc = f / ctx.sr
    let phase = ctx.rng()
    // Pan each voice across the field so the detune reads as width.
    const pan = 0.5 + off * 0.5 * spread
    const gl = Math.cos((pan * Math.PI) / 2)
    const gr = Math.sin((pan * Math.PI) / 2)
    for (let i = 0; i < ctx.n; i++) {
      const s = polyBlepSaw(phase, inc)
      phase += inc
      if (phase >= 1) phase -= 1
      l[i] += s * gl
      r[i] += s * gr
    }
  }
  const g = 1 / Math.sqrt(voices)
  for (let i = 0; i < ctx.n; i++) {
    l[i] *= g
    r[i] *= g
  }
  return [l, r]
}

/** A plucked or stabbed chord with a filter envelope. */
function makeSynth(ctx: Ctx): Pcm {
  const root = randInt(ctx.rng, 45, 60)
  const chord = pick(ctx.rng, CHORDS)
  const dur = ctx.n / ctx.sr
  const stab = ctx.rng() < 0.45
  const decay = stab ? randRange(ctx.rng, 0.18, 0.4) : randRange(ctx.rng, 0.7, 1.6)
  const [l, r] = blank(ctx.n)

  for (const step of chord) {
    const [vl, vr] = sawStack(ctx, midi(root + step), 5, randRange(ctx.rng, 9, 26), 0.9)
    for (let i = 0; i < ctx.n; i++) {
      l[i] += vl[i]
      r[i] += vr[i]
    }
  }

  const base = randRange(ctx.rng, 280, 700)
  const peak = randRange(ctx.rng, 3200, 7000)
  const q = randRange(ctx.rng, 2.5, 7)
  const fl = new Biquad('lowpass', base, q, ctx.sr)
  const fr = new Biquad('lowpass', base, q, ctx.sr)
  for (let i = 0; i < ctx.n; i++) {
    const t = i / ctx.sr
    const env = adsr(t, dur, 0.004, decay, stab ? 0 : 0.25, 0.12)
    const cutoff = base + (peak - base) * Math.pow(env, 1.7)
    if (i % 32 === 0) {
      fl.set('lowpass', cutoff, q, ctx.sr)
      fr.set('lowpass', cutoff, q, ctx.sr)
    }
    l[i] = fl.process(l[i]) * env
    r[i] = fr.process(r[i]) * env
  }
  return finish(l, r, ctx.sr)
}

/**
 * A choir is a stack of voices that never quite agree: each one sits on its
 * own vowel, its own drift, and its own vibrato phase. That disagreement is
 * the whole sound.
 */
function makeChoir(ctx: Ctx): Pcm {
  const root = randInt(ctx.rng, 48, 60)
  const chord = pick(ctx.rng, CHORDS)
  const dur = ctx.n / ctx.sr
  const [l, r] = blank(ctx.n)
  const singersPerNote = 3

  for (const step of chord) {
    for (let s = 0; s < singersPerNote; s++) {
      const f0 = midi(root + step) * Math.pow(2, randRange(ctx.rng, -14, 14) / 1200)
      const vowel = VOWELS[pick(ctx.rng, ['a', 'o', 'u', 'e'])]
      const bands = vowel.map(
        ([f, , q]) => [new Biquad('bandpass', f, q, ctx.sr), new Biquad('bandpass', f, q, ctx.sr)] as const,
      )
      const gains = vowel.map(([, g]) => g)
      const vibRate = randRange(ctx.rng, 4.2, 6.4)
      const vibDepth = randRange(ctx.rng, 0.004, 0.012)
      const vibPhase = ctx.rng() * Math.PI * 2
      const pan = ctx.rng()
      const gl = Math.cos((pan * Math.PI) / 2)
      const gr = Math.sin((pan * Math.PI) / 2)
      const attack = randRange(ctx.rng, 0.25, 0.6)
      let phase = ctx.rng()

      for (let i = 0; i < ctx.n; i++) {
        const t = i / ctx.sr
        const vib = 1 + Math.sin(t * vibRate * Math.PI * 2 + vibPhase) * vibDepth
        const inc = (f0 * vib) / ctx.sr
        // A saw is close enough to a glottal pulse once the formants are on it.
        const src = polyBlepSaw(phase, inc)
        phase += inc
        if (phase >= 1) phase -= 1
        let vl = 0
        let vr = 0
        for (let b = 0; b < bands.length; b++) {
          vl += bands[b][0].process(src) * gains[b]
          vr += bands[b][1].process(src) * gains[b]
        }
        const env = adsr(t, dur, attack, 0.3, 0.85, dur * 0.35)
        l[i] += vl * env * gl
        r[i] += vr * env * gr
      }
    }
  }

  const g = 1 / (chord.length * singersPerNote)
  for (let i = 0; i < ctx.n; i++) {
    l[i] *= g
    r[i] *= g
  }
  return finish(
    reverb(l, ctx.sr, 0.42, 0.82) as Float32Array<ArrayBuffer>,
    reverb(r, ctx.sr, 0.42, 0.83) as Float32Array<ArrayBuffer>,
    ctx.sr,
  )
}

/** One voice moving between vowels, with breath. Reads as a sung syllable. */
function makeVocal(ctx: Ctx): Pcm {
  const note = randInt(ctx.rng, 52, 67)
  const f0 = midi(note)
  const dur = ctx.n / ctx.sr
  const [l, r] = blank(ctx.n)
  const seq = [pick(ctx.rng, ['a', 'e', 'i', 'o', 'u']), pick(ctx.rng, ['a', 'e', 'i', 'o', 'u'])]
  const bandsL = [0, 1, 2].map(() => new Biquad('bandpass', 700, 10, ctx.sr))
  const bandsR = [0, 1, 2].map(() => new Biquad('bandpass', 700, 10, ctx.sr))
  const vibRate = randRange(ctx.rng, 4.8, 6.6)
  const vibDepth = randRange(ctx.rng, 0.008, 0.02)
  const breath = randRange(ctx.rng, 0.02, 0.07)
  const slide = randRange(ctx.rng, -2, 2)
  let phase = 0

  for (let i = 0; i < ctx.n; i++) {
    const t = i / ctx.sr
    const p = t / dur
    // Crossfade the formant targets so the vowel actually moves.
    const from = VOWELS[seq[0]]
    const to = VOWELS[seq[1]]
    const m = Math.min(1, Math.max(0, (p - 0.25) / 0.45))
    if (i % 64 === 0) {
      for (let b = 0; b < 3; b++) {
        const f = from[b][0] * (1 - m) + to[b][0] * m
        const q = from[b][2] * (1 - m) + to[b][2] * m
        bandsL[b].set('bandpass', f, q, ctx.sr)
        bandsR[b].set('bandpass', f, q, ctx.sr)
      }
    }
    const vib = 1 + Math.sin(t * vibRate * Math.PI * 2) * vibDepth * Math.min(1, p * 3)
    const f = f0 * vib * Math.pow(2, (slide * p) / 12)
    const inc = f / ctx.sr
    const src = polyBlepSaw(phase, inc) + (ctx.rng() * 2 - 1) * breath
    phase += inc
    if (phase >= 1) phase -= 1
    let v = 0
    let w = 0
    for (let b = 0; b < 3; b++) {
      const g = from[b][1] * (1 - m) + to[b][1] * m
      v += bandsL[b].process(src) * g
      w += bandsR[b].process(src) * g
    }
    const env = adsr(t, dur, 0.09, 0.2, 0.8, dur * 0.3)
    l[i] = v * env
    r[i] = w * env * 0.97
  }
  return finish(
    reverb(l, ctx.sr, 0.24, 0.72) as Float32Array<ArrayBuffer>,
    reverb(r, ctx.sr, 0.24, 0.73) as Float32Array<ArrayBuffer>,
    ctx.sr,
  )
}

/** Sub sine under a filtered saw. */
function makeBass(ctx: Ctx): Pcm {
  const note = randInt(ctx.rng, 28, 40)
  const f = midi(note)
  const dur = ctx.n / ctx.sr
  const [l, r] = blank(ctx.n)
  const [sl, sr] = sawStack(ctx, f, 3, randRange(ctx.rng, 5, 16), 0.4)
  const cutBase = randRange(ctx.rng, 90, 220)
  const cutPeak = randRange(ctx.rng, 900, 3200)
  const q = randRange(ctx.rng, 3, 9)
  const fl = new Biquad('lowpass', cutBase, q, ctx.sr)
  const fr = new Biquad('lowpass', cutBase, q, ctx.sr)
  const decay = randRange(ctx.rng, 0.3, 0.9)
  let sub = 0

  for (let i = 0; i < ctx.n; i++) {
    const t = i / ctx.sr
    const env = adsr(t, dur, 0.006, decay, 0.35, 0.15)
    if (i % 32 === 0) {
      const c = cutBase + (cutPeak - cutBase) * Math.pow(env, 2)
      fl.set('lowpass', c, q, ctx.sr)
      fr.set('lowpass', c, q, ctx.sr)
    }
    sub += (2 * Math.PI * f) / ctx.sr
    const sine = Math.sin(sub) * 0.6
    l[i] = (fl.process(sl[i]) * 0.7 + sine) * env
    r[i] = (fr.process(sr[i]) * 0.7 + sine) * env
  }
  return finish(l, r, ctx.sr)
}

/** Inharmonic partials with independent decays. Bells, mallets, plucked metal. */
function makeKeys(ctx: Ctx): Pcm {
  const root = randInt(ctx.rng, 55, 72)
  const chord = ctx.rng() < 0.5 ? pick(ctx.rng, CHORDS) : [0]
  const dur = ctx.n / ctx.sr
  const [l, r] = blank(ctx.n)
  const ratios = [1, 2.0, 2.76, 3.0, 4.07, 5.43, 6.79]

  for (const step of chord) {
    const f0 = midi(root + step)
    const pan = randRange(ctx.rng, 0.25, 0.75)
    const gl = Math.cos((pan * Math.PI) / 2)
    const gr = Math.sin((pan * Math.PI) / 2)
    for (let p = 0; p < ratios.length; p++) {
      const f = f0 * ratios[p] * (1 + randRange(ctx.rng, -0.004, 0.004))
      if (f > ctx.sr * 0.45) continue
      const amp = Math.pow(0.62, p) * randRange(ctx.rng, 0.7, 1.2)
      const dec = randRange(ctx.rng, 1.6, 5.5) / (1 + p * 0.45)
      const ph = ctx.rng() * Math.PI * 2
      const w = (2 * Math.PI * f) / ctx.sr
      for (let i = 0; i < ctx.n; i++) {
        const t = i / ctx.sr
        const e = Math.exp(-t * dec) * Math.min(1, t * 900)
        const s = Math.sin(i * w + ph) * amp * e
        l[i] += s * gl
        r[i] += s * gr
      }
    }
  }
  const tail = adsr
  for (let i = 0; i < ctx.n; i++) {
    const e = tail(i / ctx.sr, dur, 0.001, 0.01, 1, dur * 0.18)
    l[i] *= e
    r[i] *= e
  }
  return finish(l, r, ctx.sr)
}

/** Two bars of drums with a bit of variation, so it is loopable. */
function makeDrums(ctx: Ctx): Pcm {
  const bpm = randInt(ctx.rng, 118, 152)
  const beat = 60 / bpm
  const n = Math.floor(beat * 8 * ctx.sr)
  const [l, r] = blank(n)
  const step = (beat / 2) * ctx.sr
  const rng = ctx.rng

  const kick = (at: number, g: number) => {
    const len = Math.floor(randRange(rng, 0.2, 0.35) * ctx.sr)
    const f1 = randRange(rng, 110, 170)
    const f0 = randRange(rng, 40, 52)
    let ph = 0
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sr
      const f = f0 + (f1 - f0) * Math.exp(-t * 38)
      ph += (2 * Math.PI * f) / ctx.sr
      const v = Math.sin(ph) * Math.exp(-t * 13) * g
      if (at + i < n) {
        l[at + i] += v
        r[at + i] += v
      }
    }
  }
  const snare = (at: number, g: number) => {
    const len = Math.floor(randRange(rng, 0.12, 0.24) * ctx.sr)
    const tone = randRange(rng, 165, 215)
    let ph = 0
    const hp = new Biquad('highpass', 900, 0.8, ctx.sr)
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sr
      ph += (2 * Math.PI * tone) / ctx.sr
      const noise = hp.process(rng() * 2 - 1)
      const v = (noise * 0.8 + Math.sin(ph) * 0.35) * Math.exp(-t * 24) * g
      if (at + i < n) {
        l[at + i] += v * 0.96
        r[at + i] += v
      }
    }
  }
  const hat = (at: number, g: number, open: boolean) => {
    const len = Math.floor((open ? 0.16 : 0.05) * ctx.sr)
    const hp = new Biquad('highpass', 7000, 0.7, ctx.sr)
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sr
      const v = hp.process(rng() * 2 - 1) * Math.exp(-t * (open ? 16 : 70)) * g
      if (at + i < n) {
        l[at + i] += v
        r[at + i] += v * 0.9
      }
    }
  }

  const kickPattern = pick(rng, [[0, 6], [0, 5, 6], [0, 3, 6], [0, 6, 7]])
  for (let bar = 0; bar < 2; bar++) {
    const base = bar * beat * 4 * ctx.sr
    for (let s = 0; s < 8; s++) {
      const at = Math.floor(base + s * step)
      if (kickPattern.includes(s)) kick(at, randRange(rng, 0.85, 1))
      if (s === 4) snare(at, randRange(rng, 0.75, 0.9))
      if (bar === 1 && s === 7 && rng() < 0.5) snare(at, 0.45)
      if (rng() < 0.92) hat(at, s % 2 === 0 ? 0.42 : 0.24, s === 7 && rng() < 0.4)
    }
  }
  return finish(l, r, ctx.sr)
}

/** Slow, wide, evolving. Long attack and a lot of space. */
function makePad(ctx: Ctx): Pcm {
  const root = randInt(ctx.rng, 40, 55)
  const chord = pick(ctx.rng, CHORDS)
  const dur = ctx.n / ctx.sr
  const [l, r] = blank(ctx.n)

  for (const step of chord) {
    const [vl, vr] = sawStack(ctx, midi(root + step), 6, randRange(ctx.rng, 14, 34), 1)
    for (let i = 0; i < ctx.n; i++) {
      l[i] += vl[i]
      r[i] += vr[i]
    }
  }
  const q = randRange(ctx.rng, 1.2, 3)
  const lfoRate = randRange(ctx.rng, 0.08, 0.32)
  const fl = new Biquad('lowpass', 600, q, ctx.sr)
  const fr = new Biquad('lowpass', 600, q, ctx.sr)
  const g = 1 / chord.length
  for (let i = 0; i < ctx.n; i++) {
    const t = i / ctx.sr
    if (i % 64 === 0) {
      const c = 420 + 2400 * (0.5 + 0.5 * Math.sin(t * lfoRate * Math.PI * 2))
      fl.set('lowpass', c, q, ctx.sr)
      fr.set('lowpass', c * 1.04, q, ctx.sr)
    }
    const env = adsr(t, dur, dur * 0.35, 0.4, 0.9, dur * 0.4)
    l[i] = fl.process(l[i] * g) * env
    r[i] = fr.process(r[i] * g) * env
  }
  return finish(
    reverb(l, ctx.sr, 0.5, 0.86) as Float32Array<ArrayBuffer>,
    reverb(r, ctx.sr, 0.5, 0.87) as Float32Array<ArrayBuffer>,
    ctx.sr,
  )
}

/** Resonant filtered noise: risers, sweeps, impacts, texture. */
function makeNoise(ctx: Ctx): Pcm {
  const dur = ctx.n / ctx.sr
  const [l, r] = blank(ctx.n)
  const rise = ctx.rng() < 0.55
  const q = randRange(ctx.rng, 6, 22)
  const lo = randRange(ctx.rng, 180, 700)
  const hi = randRange(ctx.rng, 4000, 11000)
  const bl = new Biquad('bandpass', lo, q, ctx.sr)
  const br = new Biquad('bandpass', lo, q, ctx.sr)
  const wobble = randRange(ctx.rng, 0.6, 4)

  for (let i = 0; i < ctx.n; i++) {
    const t = i / ctx.sr
    const p = t / dur
    if (i % 32 === 0) {
      const shape = rise ? Math.pow(p, 1.6) : Math.pow(1 - p, 1.6)
      const wob = 1 + 0.25 * Math.sin(t * wobble * Math.PI * 2)
      const f = (lo + (hi - lo) * shape) * wob
      bl.set('bandpass', f, q, ctx.sr)
      br.set('bandpass', f * 1.03, q, ctx.sr)
    }
    const env = rise
      ? Math.pow(p, 0.7) * adsr(t, dur, 0.01, 0.05, 1, dur * 0.12)
      : adsr(t, dur, 0.004, dur * 0.5, 0.25, dur * 0.4)
    l[i] = bl.process(ctx.rng() * 2 - 1) * env
    r[i] = br.process(ctx.rng() * 2 - 1) * env
  }
  return finish(
    reverb(l, ctx.sr, 0.3, 0.8) as Float32Array<ArrayBuffer>,
    reverb(r, ctx.sr, 0.3, 0.81) as Float32Array<ArrayBuffer>,
    ctx.sr,
  )
}

/** Roughly how long each kind of sample wants to be. */
const LENGTHS: Record<GeneratorId, [number, number]> = {
  synth: [1.6, 2.6],
  choir: [3.0, 4.5],
  vocal: [1.8, 3.0],
  bass: [1.2, 2.2],
  keys: [2.4, 4.0],
  drums: [0, 0], // set by tempo
  pad: [3.5, 5.0],
  noise: [1.6, 3.2],
}

/**
 * Build a fresh sample. Seeded, so pressing the same generator twice gives two
 * different results rather than the same one.
 */
export function generateSample(
  id: GeneratorId,
  sampleRate: number,
  seed: number,
): Pcm {
  const rng = mulberry32(seed)
  const [lo, hi] = LENGTHS[id]
  const seconds = id === 'drums' ? 4 : randRange(rng, lo, hi)
  const ctx: Ctx = { sr: sampleRate, rng, n: Math.floor(seconds * sampleRate) }

  switch (id) {
    case 'synth':
      return makeSynth(ctx)
    case 'choir':
      return makeChoir(ctx)
    case 'vocal':
      return makeVocal(ctx)
    case 'bass':
      return makeBass(ctx)
    case 'keys':
      return makeKeys(ctx)
    case 'drums':
      return makeDrums(ctx)
    case 'pad':
      return makePad(ctx)
    case 'noise':
      return makeNoise(ctx)
  }
}
