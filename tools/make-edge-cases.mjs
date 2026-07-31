/**
 * Adversarial fixtures for the critique pass.
 *   node tools/make-edge-cases.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'

function wav(channels, sampleRate) {
  const nCh = channels.length
  const frames = channels[0].length
  const bytes = frames * nCh * 3
  const b = Buffer.alloc(44 + bytes)
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20)
  b.writeUInt16LE(nCh, 22); b.writeUInt32LE(sampleRate, 24)
  b.writeUInt32LE(sampleRate * nCh * 3, 28); b.writeUInt16LE(nCh * 3, 32)
  b.writeUInt16LE(24, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40)
  let o = 44
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nCh; c++) {
      let v = Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 8388607)
      if (v < 0) v += 0x1000000
      b.writeUInt8(v & 0xff, o); b.writeUInt8((v >> 8) & 0xff, o + 1)
      b.writeUInt8((v >> 16) & 0xff, o + 2); o += 3
    }
  return b
}

const dir = new URL('../test-audio/edge/', import.meta.url)
mkdirSync(dir, { recursive: true })
const put = (n, buf) => { writeFileSync(new URL(n, dir), buf); console.log(n, buf.length, 'bytes') }

// 1. Mono, 48k. Exercises single-channel paths and the 48k -> context-rate path.
{
  const SR = 48000, len = SR * 1
  const c = new Float32Array(len)
  for (let i = 0; i < len; i++) c[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * Math.exp(-i / SR * 3) * 0.8
  put('mono-48k.wav', wav([c], SR))
}

// 2. Very short: 12ms. Chop wants many segments out of almost no frames.
{
  const SR = 44100, len = Math.floor(SR * 0.012)
  const c = new Float32Array(len)
  for (let i = 0; i < len; i++) c[i] = Math.sin((2 * Math.PI * 900 * i) / SR) * 0.7
  put('tiny-12ms.wav', wav([c, c], SR))
}

// 3. Digital silence. Normalisation must not amplify the noise floor.
{
  const SR = 44100, len = SR
  put('silence.wav', wav([new Float32Array(len), new Float32Array(len)], SR))
}

// 4. Already at full scale, so any gain would clip.
{
  const SR = 44100, len = SR
  const c = new Float32Array(len)
  for (let i = 0; i < len; i++) c[i] = i % 2 ? 1 : -1
  put('fullscale-square.wav', wav([c, c], SR))
}

// 5. Long: 60s, twice the stated comfortable length.
{
  const SR = 44100, len = SR * 60
  const l = new Float32Array(len), r = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const t = i / SR
    const v = Math.sin(2 * Math.PI * 110 * t) * 0.5 * (0.5 + 0.5 * Math.sin(t * 2))
    l[i] = v; r[i] = v * 0.9
  }
  put('long-60s.wav', wav([l, r], SR))
}

// 6. Not audio at all.
writeFileSync(new URL('not-audio.wav', dir), Buffer.from('this is not a wav file, it is text pretending to be one.'))
console.log('not-audio.wav (garbage)')
