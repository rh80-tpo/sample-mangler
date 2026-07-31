/**
 * A three minute stereo fixture, for measuring the long-sample path honestly.
 *   node tools/make-long.mjs [seconds]
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const SR = 48000
const SECONDS = Number(process.argv[2] || 180)
const n = Math.floor(SECONDS * SR)

const header = Buffer.alloc(44)
const bytes = n * 2 * 3
header.write('RIFF', 0)
header.writeUInt32LE(36 + bytes, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(2, 22)
header.writeUInt32LE(SR, 24)
header.writeUInt32LE(SR * 2 * 3, 28)
header.writeUInt16LE(6, 32)
header.writeUInt16LE(24, 34)
header.write('data', 36)
header.writeUInt32LE(bytes, 40)

// Written in chunks so a three minute file does not need one giant buffer.
const CHUNK = SR * 5
const parts = [header]
let ph1 = 0
let ph2 = 0
for (let start = 0; start < n; start += CHUNK) {
  const len = Math.min(CHUNK, n - start)
  const buf = Buffer.alloc(len * 6)
  let o = 0
  for (let i = 0; i < len; i++) {
    const t = (start + i) / SR
    // A moving chord plus a pulse, so peaks and transients both exist.
    ph1 += (2 * Math.PI * (110 + 30 * Math.sin(t * 0.13))) / SR
    ph2 += (2 * Math.PI * (165 + 20 * Math.sin(t * 0.21))) / SR
    const pulse = Math.exp(-((t % 0.5) * 12)) * 0.5
    const v = (Math.sin(ph1) * 0.35 + Math.sin(ph2) * 0.25 + pulse) * 0.7
    for (let c = 0; c < 2; c++) {
      let x = Math.round(Math.max(-1, Math.min(1, v * (c ? 0.94 : 1))) * 8388607)
      if (x < 0) x += 0x1000000
      buf.writeUInt8(x & 0xff, o)
      buf.writeUInt8((x >> 8) & 0xff, o + 1)
      buf.writeUInt8((x >> 16) & 0xff, o + 2)
      o += 3
    }
  }
  parts.push(buf)
}

mkdirSync(new URL('../test-audio/edge/', import.meta.url), { recursive: true })
const out = Buffer.concat(parts)
writeFileSync(new URL('../test-audio/edge/long-180s.wav', import.meta.url), out)
console.log(`long-180s.wav  ${SECONDS}s  2ch  ${SR}Hz  ${(out.length / 1048576).toFixed(1)} MB`)
