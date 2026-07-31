import { mulberry32, type Rng } from './rng'
import type { Pcm } from './buffers'
import type { BitcrushSpec, ChopSpec } from './types'

/** Reverse every channel in place-safe fashion. */
export function applyReverse(pcm: Pcm): Pcm {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => {
      const out = new Float32Array(ch.length)
      for (let i = 0; i < ch.length; i++) out[i] = ch[ch.length - 1 - i]
      return out
    }),
  }
}

/** 3ms equal-power-ish ramp at each seam. Without this, every splice ticks. */
const SEAM_SECONDS = 0.003

/**
 * Slice into segments, shuffle some of them, repeat some, gate a few to
 * silence. Output length is held near the input length so a chopped roll is
 * still the same musical size as what went in.
 */
export function applyChop(pcm: Pcm, spec: ChopSpec, seed: number): Pcm {
  const len = pcm.channels[0].length
  const segCount = Math.max(2, Math.min(spec.segments, Math.floor(len / 64)))
  if (segCount < 2) return pcm

  const rng: Rng = mulberry32(seed)
  const segLen = Math.floor(len / segCount)
  const seam = Math.min(
    Math.floor(SEAM_SECONDS * pcm.sampleRate),
    Math.floor(segLen / 3),
  )

  // Source index for each output slot, plus whether that slot is gated.
  const order: number[] = []
  for (let i = 0; i < segCount; i++) order.push(i)

  // Reorder: swap a fraction of positions rather than fully shuffling, so the
  // result still tracks the shape of the original.
  const swaps = Math.floor((spec.reorder * segCount) / 2)
  for (let s = 0; s < swaps; s++) {
    const a = Math.floor(rng() * segCount)
    const b = Math.floor(rng() * segCount)
    ;[order[a], order[b]] = [order[b], order[a]]
  }

  const slots: { src: number; gated: boolean }[] = []
  for (let i = 0; i < order.length; i++) {
    slots.push({ src: order[i], gated: false })
    if (rng() < spec.repeat) {
      // A repeat steals the next slot instead of extending the file, which is
      // what keeps total length stable.
      slots.push({ src: order[i], gated: rng() < spec.gate })
    }
  }
  // Hold output length to the input length.
  while (slots.length > segCount) slots.pop()
  while (slots.length < segCount) slots.push({ src: slots.length, gated: false })

  const outLen = slots.length * segLen
  const channels = pcm.channels.map((ch) => {
    const out = new Float32Array(outLen)
    for (let i = 0; i < slots.length; i++) {
      const { src, gated } = slots[i]
      if (gated) continue
      const from = src * segLen
      const to = i * segLen
      for (let j = 0; j < segLen; j++) {
        let v = ch[from + j] ?? 0
        if (seam > 0) {
          if (j < seam) v *= j / seam
          else if (j >= segLen - seam) v *= (segLen - j) / seam
        }
        out[to + j] = v
      }
    }
    return out
  })

  return { sampleRate: pcm.sampleRate, channels }
}

/**
 * Sample-and-hold decimation. This is the sample-rate half of bitcrush; the
 * bit-depth half is Tone.BitCrusher in the node pass. Holding each sample for
 * `divisor` frames is what produces the aliasing that makes a crushed sample
 * sound like a cheap sampler rather than just a quiet one.
 */
export function applyDecimate(pcm: Pcm, spec: BitcrushSpec): Pcm {
  const d = Math.max(1, Math.floor(spec.divisor))
  if (d === 1) return pcm
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => {
      const out = new Float32Array(ch.length)
      let held = 0
      for (let i = 0; i < ch.length; i++) {
        if (i % d === 0) held = ch[i]
        out[i] = held
      }
      return out
    }),
  }
}
