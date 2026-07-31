/**
 * Generates the test samples used to verify the mangler.
 * Plain math to 24-bit WAV, no Web Audio, so it runs in node.
 *
 *   node tools/make-test-audio.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const SR = 48000

function encodeWav(channels, sampleRate) {
  const nCh = channels.length
  const frames = channels[0].length
  const bytes = frames * nCh * 3
  const buf = Buffer.alloc(44 + bytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + bytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(nCh, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * nCh * 3, 28)
  buf.writeUInt16LE(nCh * 3, 32)
  buf.writeUInt16LE(24, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(bytes, 40)
  const MAX = 8388607
  let o = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]))
      let v = Math.round(s * MAX)
      if (v < 0) v += 0x1000000
      buf.writeUInt8(v & 0xff, o)
      buf.writeUInt8((v >> 8) & 0xff, o + 1)
      buf.writeUInt8((v >> 16) & 0xff, o + 2)
      o += 3
    }
  }
  return buf
}

const noise = (() => {
  // Deterministic noise so regenerating the fixtures does not change them.
  let s = 12345
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return (s / 0x3fffffff) - 1
  }
})()

function kick(out, at, gain = 1) {
  const len = Math.floor(0.28 * SR)
  let phase = 0
  for (let i = 0; i < len; i++) {
    const t = i / SR
    const env = Math.exp(-t * 14)
    const f = 45 + 95 * Math.exp(-t * 42)
    phase += (2 * Math.PI * f) / SR
    const v = Math.sin(phase) * env * gain
    if (at + i < out.length) out[at + i] += v
  }
}

function snare(out, at, gain = 1) {
  const len = Math.floor(0.19 * SR)
  let phase = 0
  for (let i = 0; i < len; i++) {
    const t = i / SR
    const env = Math.exp(-t * 26)
    phase += (2 * Math.PI * 185) / SR
    const v = (noise() * 0.7 + Math.sin(phase) * 0.35) * env * gain
    if (at + i < out.length) out[at + i] += v
  }
}

function hat(out, at, gain = 1, decay = 70) {
  const len = Math.floor(0.07 * SR)
  let hp = 0
  for (let i = 0; i < len; i++) {
    const t = i / SR
    const env = Math.exp(-t * decay)
    const n = noise()
    hp = 0.86 * (hp + n - (out.__prev ?? 0))
    out.__prev = n
    if (at + i < out.length) out[at + i] += hp * env * gain
  }
}

/** Two bars of 4/4 at 128bpm with a bit of swing and velocity variation. */
function makeDrums() {
  const bpm = 128
  const beat = 60 / bpm
  const bars = 2
  const len = Math.floor(beat * 4 * bars * SR)
  const l = new Float32Array(len)
  const r = new Float32Array(len)
  const step = (beat / 2) * SR

  for (let b = 0; b < bars; b++) {
    const bar = b * beat * 4 * SR
    for (let s = 0; s < 8; s++) {
      const at = Math.floor(bar + s * step)
      if (s === 0 || s === 6) kick(l, at, 1), kick(r, at, 1)
      if (s === 4) snare(l, at, 0.85), snare(r, at, 0.85)
      if (s === 2 && b === 1) snare(l, at, 0.4), snare(r, at, 0.4)
      const hg = s % 2 === 0 ? 0.5 : 0.28
      hat(l, at, hg * 0.9)
      hat(r, at, hg)
    }
  }
  // Keep a little stereo difference so channel handling gets exercised.
  return [l, r]
}

/** A tonal one-shot: detuned saw stack, filtered-ish, with a decay tail. */
function makePluck() {
  const len = Math.floor(1.4 * SR)
  const l = new Float32Array(len)
  const r = new Float32Array(len)
  const base = 110
  const detunes = [-7, -3, 0, 4, 7]
  const phases = detunes.map(() => 0)
  let lp = 0
  for (let i = 0; i < len; i++) {
    const t = i / SR
    const env = Math.exp(-t * 3.1) * Math.min(1, t * 400)
    let v = 0
    for (let d = 0; d < detunes.length; d++) {
      const f = base * Math.pow(2, detunes[d] / 12)
      phases[d] += f / SR
      if (phases[d] > 1) phases[d] -= 1
      v += (phases[d] * 2 - 1) / detunes.length
    }
    // One-pole lowpass that opens over the first 300ms.
    const cutoff = 0.04 + 0.3 * Math.min(1, t * 3.3)
    lp += cutoff * (v - lp)
    l[i] = lp * env * 0.8
    r[i] = lp * env * 0.8 * 0.94
  }
  return [l, r]
}

mkdirSync(new URL('../test-audio/', import.meta.url), { recursive: true })

const jobs = [
  ['drums.wav', makeDrums()],
  ['pluck.wav', makePluck()],
]

for (const [name, chans] of jobs) {
  // Normalise the fixture itself so the input is never clipped. A clipped
  // source would make "is the output clipped" unanswerable.
  let raw = 0
  for (const c of chans) for (const v of c) raw = Math.max(raw, Math.abs(v))
  const g = 0.89 / raw
  for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= g

  const wav = encodeWav(chans, SR)
  const url = new URL(`../test-audio/${name}`, import.meta.url)
  writeFileSync(url, wav)
  let peak = 0
  for (const c of chans) for (const v of c) peak = Math.max(peak, Math.abs(v))
  console.log(
    `${name}  ${(chans[0].length / SR).toFixed(3)}s  ${chans.length}ch  ${SR}Hz  peak ${peak.toFixed(4)}  ${wav.length} bytes`,
  )
}
