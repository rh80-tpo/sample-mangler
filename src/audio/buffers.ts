/**
 * Plain sample data, detached from any AudioContext.
 *
 * The channels are pinned to a plain ArrayBuffer rather than ArrayBufferLike so
 * they hand straight to copyToChannel without a cast.
 */
export type Pcm = {
  channels: Float32Array<ArrayBuffer>[]
  sampleRate: number
}

export function pcmFrom(buffer: AudioBuffer): Pcm {
  const channels: Float32Array<ArrayBuffer>[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    // Copy rather than alias: every buffer op writes new arrays and we never
    // want to mutate the user's decoded original.
    channels.push(new Float32Array(buffer.getChannelData(c)))
  }
  return { channels, sampleRate: buffer.sampleRate }
}

export function pcmToBuffer(pcm: Pcm, ctx: BaseAudioContext): AudioBuffer {
  const length = pcm.channels[0].length
  const out = ctx.createBuffer(pcm.channels.length, length, pcm.sampleRate)
  for (let c = 0; c < pcm.channels.length; c++) {
    out.copyToChannel(pcm.channels[c], c)
  }
  return out
}

export function durationOf(pcm: Pcm): number {
  return pcm.channels[0].length / pcm.sampleRate
}

export function peakOf(pcm: Pcm): number {
  let peak = 0
  for (const ch of pcm.channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i])
      if (v > peak) peak = v
    }
  }
  return peak
}

export function rmsOf(pcm: Pcm): number {
  let sum = 0
  let n = 0
  for (const ch of pcm.channels) {
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i]
    n += ch.length
  }
  return n ? Math.sqrt(sum / n) : 0
}

/**
 * Normalise to a fixed ceiling rather than leaving level to chance.
 *
 * Two reasons. Distortion and bitcrush both raise level a lot, so without this
 * the loud rolls would clip and the quiet ones would be unusable. And a sample
 * tool should hand back a consistent level every time so rolls are comparable
 * and drop into a project at a predictable gain.
 *
 * -1 dBFS, which leaves headroom for the inter-sample peaks that show up after
 * any lossy encode downstream.
 */
export const CEILING = 0.891

export function normalize(pcm: Pcm, ceiling = CEILING): Pcm {
  const peak = peakOf(pcm)
  // Near-silent output means the chain ate the signal. Amplifying that just
  // turns the noise floor into the result, so leave it alone and let the
  // silence check catch it.
  if (peak < 1e-5) return pcm
  const gain = ceiling / peak
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => {
      const out = new Float32Array(ch.length)
      for (let i = 0; i < ch.length; i++) out[i] = ch[i] * gain
      return out
    }),
  }
}

/**
 * Same thing without the allocation. Only safe on a buffer we produced
 * ourselves, never on the user's decoded source. On a three minute stereo
 * sample this is 69MB not allocated.
 */
export function normalizeInPlace(pcm: Pcm, ceiling = CEILING): Pcm {
  const peak = peakOf(pcm)
  if (peak < 1e-5) return pcm
  const gain = ceiling / peak
  for (const ch of pcm.channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= gain
  }
  return pcm
}

/** Independent copy, so the caller can mutate without touching the original. */
export function clonePcm(pcm: Pcm): Pcm {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => new Float32Array(ch)),
  }
}

/**
 * Wrap the tail back over the head so the buffer joins to itself.
 *
 * A hard cut to an exact bar length lands on an arbitrary sample value, and a
 * fade to silence at both ends puts an audible hole at the loop point. This
 * crossfades the last stretch toward what the start sounds like, which is the
 * standard sampler loop crossfade and the difference between a loop you can
 * leave running and one you can hear repeating.
 */
export function applyLoopSeam(pcm: Pcm, seconds = 0.012): Pcm {
  const len = pcm.channels[0].length
  const n = Math.min(Math.floor(seconds * pcm.sampleRate), Math.floor(len / 4))
  if (n <= 1) return pcm
  for (const ch of pcm.channels) {
    // Snapshot the head first: the blend reads it while writing the tail.
    const head = ch.slice(0, n)
    for (let i = 0; i < n; i++) {
      // Equal power, so the crossfade holds level through the middle.
      const t = i / (n - 1)
      const a = Math.cos((t * Math.PI) / 2)
      const b = Math.sin((t * Math.PI) / 2)
      ch[len - n + i] = ch[len - n + i] * a + head[i] * b
    }
  }
  return pcm
}

/** Short fades at both ends so playback and looping never click. */
export function applyEdgeFades(pcm: Pcm, seconds = 0.004): Pcm {
  const n = Math.min(
    Math.floor(seconds * pcm.sampleRate),
    Math.floor(pcm.channels[0].length / 2),
  )
  if (n <= 0) return pcm
  for (const ch of pcm.channels) {
    for (let i = 0; i < n; i++) {
      const g = i / n
      ch[i] *= g
      ch[ch.length - 1 - i] *= g
    }
  }
  return pcm
}

/** Drop `count` frames from the head. Used for latency compensation. */
export function trimHead(pcm: Pcm, count: number): Pcm {
  if (count <= 0) return pcm
  const n = Math.min(count, pcm.channels[0].length - 1)
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => ch.slice(n)),
  }
}

/**
 * Trim trailing near-silence, keeping a short tail so decays are not clipped
 * off. Keeps exported files tight instead of padded with the render tail.
 */
export function trimTail(pcm: Pcm, threshold = 1e-4, tailSeconds = 0.02): Pcm {
  const len = pcm.channels[0].length
  let last = -1
  for (let i = len - 1; i >= 0; i--) {
    let loud = false
    for (const ch of pcm.channels) {
      if (Math.abs(ch[i]) > threshold) {
        loud = true
        break
      }
    }
    if (loud) {
      last = i
      break
    }
  }
  if (last < 0) return pcm
  const keep = Math.min(len, last + 1 + Math.floor(tailSeconds * pcm.sampleRate))
  if (keep >= len) return pcm
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => ch.slice(0, keep)),
  }
}
