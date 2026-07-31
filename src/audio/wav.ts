import type { Pcm } from './buffers'

/**
 * 24-bit PCM. Deep enough that the float-to-int quantisation is inaudible and
 * standard enough that every DAW opens it without a conversion step.
 */
const BIT_DEPTH = 24
const BYTES_PER_SAMPLE = BIT_DEPTH / 8

export function encodeWav(pcm: Pcm): Blob {
  const channels = pcm.channels.length
  const frames = pcm.channels[0].length
  const dataBytes = frames * channels * BYTES_PER_SAMPLE
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // format: PCM integer
  view.setUint16(22, channels, true)
  view.setUint32(24, pcm.sampleRate, true)
  view.setUint32(28, pcm.sampleRate * channels * BYTES_PER_SAMPLE, true)
  view.setUint16(32, channels * BYTES_PER_SAMPLE, true) // block align
  view.setUint16(34, BIT_DEPTH, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)

  const MAX = 8388607 // 2^23 - 1
  let offset = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, pcm.channels[c][i]))
      // Asymmetric clamp: -1.0 maps to -2^23, +1.0 maps to 2^23-1.
      const int = Math.max(-MAX - 1, Math.min(MAX, Math.round(s * MAX)))
      const u = int < 0 ? int + 0x1000000 : int
      view.setUint8(offset, u & 0xff)
      view.setUint8(offset + 1, (u >> 8) & 0xff)
      view.setUint8(offset + 2, (u >> 16) & 0xff)
      offset += 3
    }
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

/** Largest error the 24-bit round trip can introduce on a single sample. */
export const QUANTISATION_STEP = 1 / 8388607
