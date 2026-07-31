import type { Pcm } from './buffers'

/**
 * Per-column peak data for drawing. Min/max gives the true envelope, rms gives
 * a density core so the waveform reads as loud or thin rather than just tall.
 */
export type Peaks = {
  min: Float32Array
  max: Float32Array
  rms: Float32Array
  columns: number
}

export function computePeaks(pcm: Pcm, columns: number): Peaks {
  const n = Math.max(1, Math.floor(columns))
  const min = new Float32Array(n)
  const max = new Float32Array(n)
  const rms = new Float32Array(n)
  const frames = pcm.channels[0].length
  const per = frames / n
  const chans = pcm.channels
  const nCh = chans.length

  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * per)
    const end = Math.min(frames, Math.max(start + 1, Math.floor((i + 1) * per)))
    let lo = 1
    let hi = -1
    let sum = 0
    let count = 0
    for (let s = start; s < end; s++) {
      // Mixdown for display only. The audio itself stays untouched.
      let v = 0
      for (let c = 0; c < nCh; c++) v += chans[c][s]
      v /= nCh
      if (v < lo) lo = v
      if (v > hi) hi = v
      sum += v * v
      count++
    }
    if (count === 0) {
      lo = 0
      hi = 0
    }
    min[i] = lo
    max[i] = hi
    rms[i] = count ? Math.sqrt(sum / count) : 0
  }

  return { min, max, rms, columns: n }
}
