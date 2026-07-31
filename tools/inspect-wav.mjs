/**
 * Parse a WAV off disk and report what is actually in it.
 * Used to check an exported file against what the browser previewed.
 *
 *   node tools/inspect-wav.mjs <file.wav>
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) {
  console.error('usage: node tools/inspect-wav.mjs <file.wav>')
  process.exit(1)
}

const buf = readFileSync(path)
if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
  console.error('not a RIFF/WAVE file')
  process.exit(1)
}

// Walk the chunk list rather than assuming a 44-byte header.
let pos = 12
let fmt = null
let data = null
while (pos + 8 <= buf.length) {
  const id = buf.toString('ascii', pos, pos + 4)
  const size = buf.readUInt32LE(pos + 4)
  const body = pos + 8
  if (id === 'fmt ') {
    fmt = {
      format: buf.readUInt16LE(body),
      channels: buf.readUInt16LE(body + 2),
      sampleRate: buf.readUInt32LE(body + 4),
      byteRate: buf.readUInt32LE(body + 8),
      blockAlign: buf.readUInt16LE(body + 12),
      bits: buf.readUInt16LE(body + 14),
    }
  } else if (id === 'data') {
    data = { start: body, size }
  }
  pos = body + size + (size % 2)
}

if (!fmt || !data) {
  console.error('missing fmt or data chunk')
  process.exit(1)
}

const bytesPer = fmt.bits / 8
const frames = data.size / (bytesPer * fmt.channels)
const duration = frames / fmt.sampleRate

// Decode to float and measure.
let peak = 0
let sumSq = 0
let n = 0
let clipped = 0
let dcSum = 0
const MAX = 2 ** (fmt.bits - 1)
for (let i = 0; i < frames; i++) {
  for (let c = 0; c < fmt.channels; c++) {
    const o = data.start + (i * fmt.channels + c) * bytesPer
    let v
    if (fmt.bits === 24) {
      v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)
      if (v & 0x800000) v -= 0x1000000
    } else if (fmt.bits === 16) {
      v = buf.readInt16LE(o)
    } else {
      throw new Error(`unhandled bit depth ${fmt.bits}`)
    }
    const f = v / MAX
    const a = Math.abs(f)
    if (a > peak) peak = a
    if (a >= 0.9999) clipped++
    sumSq += f * f
    dcSum += f
    n++
  }
}

const rms = Math.sqrt(sumSq / n)
const out = {
  file: path.split('/').pop(),
  bytes: buf.length,
  codec: fmt.format === 1 ? 'PCM integer' : `format ${fmt.format}`,
  bitDepth: fmt.bits,
  channels: fmt.channels,
  sampleRate: fmt.sampleRate,
  frames,
  duration: +duration.toFixed(4),
  peak: +peak.toFixed(6),
  peakDbfs: +(20 * Math.log10(peak)).toFixed(2),
  rms: +rms.toFixed(6),
  dcOffset: +(dcSum / n).toFixed(6),
  clippedSamples: clipped,
  headerConsistent:
    fmt.byteRate === fmt.sampleRate * fmt.channels * bytesPer &&
    fmt.blockAlign === fmt.channels * bytesPer,
}
console.log(JSON.stringify(out, null, 2))
