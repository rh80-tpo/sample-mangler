import type { Pcm } from './buffers'

/**
 * Duck the output against a kick that is not there.
 *
 * There is no kick track in this tool, so the kick is the grid: the same tempo
 * the bar fitting already locks to. That is the case worth solving anyway —
 * you are cutting a loop to drop under a beat you already have, and what you
 * need is for the loop to leave a hole where your kick lands.
 *
 * Applied to the finished buffer rather than inside the chain, for the same
 * reason as the level trim: it produces the one Pcm that both the player and
 * the WAV encoder read, so the pocket you hear is the pocket you export.
 */

/** Kicks per bar. 4 is four-on-the-floor, which is the default for a reason. */
export type KickRate = 1 | 2 | 4 | 8

export const KICK_RATES: { rate: KickRate; label: string; hint: string }[] = [
  { rate: 1, label: '1/1', hint: 'one per bar' },
  { rate: 2, label: '1/2', hint: 'every other beat' },
  { rate: 4, label: '1/4', hint: 'four on the floor' },
  { rate: 8, label: '1/8', hint: 'eighths, for a faster pump' },
]

export type SidechainSpec = {
  /** 0 to 1. How much level is pulled out under each kick. */
  amount: number
  rate: KickRate
  /**
   * 0 to 1. How long the duck takes to recover, as a fraction of the gap
   * between kicks. Short is a tight tuck; long is a slow pump that never fully
   * comes back before the next hit.
   */
  release: number
}

export const DEFAULT_SIDECHAIN: SidechainSpec = {
  amount: 0,
  rate: 4,
  release: 0.45,
}

/**
 * How fast the gain drops when the kick lands.
 *
 * Deliberately not instant. A step change in gain is a click, and 4ms is short
 * enough to read as immediate while still letting the transient through.
 */
const ATTACK_SECONDS = 0.004

/**
 * Gain at a moment in time, 0 to 1.
 *
 * A compressor recovers by decaying its gain *reduction* exponentially rather
 * than ramping the gain up linearly, which is why a real sidechain breathes
 * instead of sounding like a gate. tau is a third of the release so the level
 * is most of the way back by the time the release is nominally over.
 */
export function duckGainAt(seconds: number, spec: SidechainSpec, bpm: number): number {
  if (spec.amount <= 0) return 1
  const interval = (60 / bpm) * (4 / spec.rate)
  if (!(interval > 0)) return 1

  // Time since the most recent kick. Kicks sit on the downbeat and every
  // interval after it, so a negative time cannot happen for seconds >= 0.
  const since = seconds - Math.floor(seconds / interval) * interval

  if (since < ATTACK_SECONDS) {
    return 1 - spec.amount * (since / ATTACK_SECONDS)
  }
  const releaseTime = Math.max(0.01, spec.release * interval)
  const tau = Math.max(0.005, releaseTime / 3)
  return 1 - spec.amount * Math.exp(-(since - ATTACK_SECONDS) / tau)
}

/** Apply the duck to the audio. Returns the same buffer when there is none. */
export function applySidechain(pcm: Pcm, spec: SidechainSpec, bpm: number): Pcm {
  if (spec.amount <= 0) return pcm
  const sr = pcm.sampleRate
  const len = pcm.channels[0].length

  // The envelope depends only on time, so it is computed once and shared across
  // channels rather than recomputed per sample per channel.
  const env = new Float32Array(len)
  for (let i = 0; i < len; i++) env[i] = duckGainAt(i / sr, spec, bpm)

  return {
    sampleRate: sr,
    channels: pcm.channels.map((ch) => {
      const out = new Float32Array(len)
      for (let i = 0; i < len; i++) out[i] = ch[i] * env[i]
      return out
    }),
  }
}

/**
 * A reference kick, for auditioning only.
 *
 * Ducking against an imaginary kick is almost impossible to judge by ear, so
 * this exists to put the kick back for as long as you are listening. It is
 * mixed in on the playback path and never reaches the Pcm, so it cannot end up
 * in an exported file — the same split as the monitor fader.
 *
 * Body is a sine whose pitch falls from 110Hz to 45Hz, which is the shape that
 * reads as a kick rather than as a low beep, plus a short noise transient so it
 * still cuts through on speakers with no bottom end.
 */
export function renderKick(
  sampleRate: number,
  seconds: number,
  bpm: number,
  rate: KickRate,
): Pcm {
  const len = Math.max(1, Math.ceil(seconds * sampleRate))
  const out = new Float32Array(len)
  const interval = (60 / bpm) * (4 / rate)
  const hits = Math.ceil(seconds / interval)

  for (let h = 0; h < hits; h++) {
    const at = Math.round(h * interval * sampleRate)
    const dur = Math.min(0.22, interval * 0.9)
    const n = Math.floor(dur * sampleRate)
    let phase = 0
    for (let i = 0; i < n && at + i < len; i++) {
      const t = i / sampleRate
      const f = 45 + (110 - 45) * Math.exp(-t * 55)
      phase += (2 * Math.PI * f) / sampleRate
      const body = Math.sin(phase) * Math.exp(-t * 14)
      // Two milliseconds of noise for the beater, gone almost immediately.
      const click = t < 0.002 ? (Math.sin(i * 12.9898) * 43758.5453) % 1 : 0
      out[at + i] += body * 0.85 + click * 0.18
    }
  }
  return { sampleRate, channels: [out] }
}
