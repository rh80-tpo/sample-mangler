import * as Tone from 'tone'
import { planOps, planPasses } from './chain'
import {
  applyEdgeFades,
  applyLoopSeam,
  clonePcm,
  durationOf,
  normalizeInPlace,
  pcmFrom,
  peakOf,
  trimTail,
  type Pcm,
} from './buffers'
import { applyChop, applyDecimate, applyReverse } from './effects'
import {
  NO_FIT,
  SECONDS_PER_BAR,
  compensationSemitones,
  resampleTo,
  trimTo,
  trimToLoudest,
  type FitSpec,
} from './fit'
import type { ChainSpec, EffectSpec, Op } from './types'

/**
 * Extra render time so a pass is not cut off mid-tail.
 *
 * Tone's PitchShift is a pair of delay lines sweeping 0 to windowSize, so its
 * output lags the input by a time-varying amount rather than a fixed latency.
 * There is nothing to compensate for at the head; there is a tail to catch at
 * the end. trimTail cleans up whatever slack is left over.
 */
function tailFor(ops: Op[], sourceSeconds: number): number {
  let tail = 0.05
  for (const op of ops) {
    if (op.spec.id === 'pitch') {
      tail = Math.max(tail, op.spec.windowSize * 3 + 0.15)
    }
    if (op.spec.id === 'reverb') {
      // Freeverb has no explicit decay time, so the tail is estimated from
      // room size. Cutting a reverb off mid-decay is the most obvious render
      // artefact there is.
      tail = Math.max(tail, 0.6 + op.spec.size * 5)
    }
  }
  // Capped against the source. Left uncapped, a big room turns a two second
  // sample into a seven second buffer that is mostly decay, and any structural
  // effect after it (reverse especially) then treats that decay as the
  // material. Trimming to a bar length after a reverse would hand back the
  // quiet end of the tail, which is how this produced silence.
  return Math.min(tail, sourceSeconds * 1.2 + 0.35)
}

function makeNode(spec: EffectSpec): Tone.ToneAudioNode {
  switch (spec.id) {
    case 'bitcrush':
      // BitCrusher's worklet options do not carry `wet`; it inherits the
      // Effect default of fully wet, which is what we want anyway.
      return new Tone.BitCrusher({ bits: spec.bits })
    case 'pitch':
      return new Tone.PitchShift({
        pitch: spec.semitones,
        windowSize: spec.windowSize,
        delayTime: 0,
        feedback: 0,
        wet: 1,
      })
    case 'drive':
      return new Tone.Distortion({
        distortion: spec.amount,
        oversample: spec.oversample,
        wet: 1,
      })
    case 'reverb':
      // Freeverb rather than Tone.Reverb: it is algorithmic and ready the
      // moment it is constructed, where Tone.Reverb has to generate an
      // impulse response first and then convolve it, which on a three minute
      // sample is a lot of work for a result nobody asked to be pristine.
      return new Tone.Freeverb({
        roomSize: spec.size,
        dampening: spec.damp,
        wet: spec.mix,
      })
    default:
      throw new Error(`${spec.id} is not a node-stage effect`)
  }
}

/**
 * One offline render pass through a run of Tone nodes.
 *
 * This drives an OfflineContext directly rather than going through
 * Tone.Offline. Tone.Offline advances its render clock asynchronously,
 * yielding to setTimeout as it goes, which costs about a second per pass no
 * matter how little work there is. Measured on a 1.4s stereo sample:
 * Tone.Offline 1002ms, this 16ms. Nothing about the output changes, only how
 * the clock is stepped.
 *
 * The chain has no scheduled automation, so there is nothing for the async
 * clock to buy us.
 */
async function renderNodePass(pcm: Pcm, ops: Op[]): Promise<Pcm> {
  const channels = pcm.channels.length
  const duration = durationOf(pcm) + tailFor(ops, durationOf(pcm))

  const offline = new Tone.OfflineContext(channels, duration, pcm.sampleRate)
  const previous = Tone.getContext()
  Tone.setContext(offline)

  const created: { dispose: () => unknown }[] = []
  try {
    const buf = new Tone.ToneAudioBuffer()
    buf.fromArray(pcm.channels.length === 1 ? pcm.channels[0] : pcm.channels)

    const source = new Tone.ToneBufferSource(buf)
    created.push(source, buf)
    let node: Tone.ToneAudioNode = source
    for (const op of ops) {
      const fx = makeNode(op.spec)
      created.push(fx)
      node.connect(fx)
      node = fx
    }
    node.toDestination()
    source.start(0)

    const rendered = await offline.render(false)
    const audioBuffer =
      rendered instanceof AudioBuffer ? rendered : (rendered.get() as AudioBuffer)
    // Copy out before the context goes away: pcmFrom clones every channel, so
    // nothing downstream still points into the offline context's buffer.
    return pcmFrom(audioBuffer)
  } finally {
    Tone.setContext(previous)
    // Every pass builds a whole context and node graph. Without this they stay
    // reachable, and a few rolls on a long sample push the heap past a
    // gigabyte. Measured: 1382MB after three rolls on a 60s stereo file.
    for (const node of created) {
      try {
        node.dispose()
      } catch {
        // Already gone. Nothing to do.
      }
    }
    try {
      offline.dispose()
    } catch {
      // Already gone. Nothing to do.
    }
  }
}

function applyBufferOp(pcm: Pcm, op: Op, seed: number): Pcm {
  switch (op.spec.id) {
    case 'reverse':
      return applyReverse(pcm)
    case 'chop':
      return applyChop(pcm, op.spec, seed)
    case 'bitcrush':
      return applyDecimate(pcm, op.spec)
    default:
      throw new Error(`${op.spec.id} is not a buffer-stage effect`)
  }
}

export type RenderResult = {
  pcm: Pcm
  /** Wall-clock render time, used to pace the reveal sweep honestly. */
  elapsedMs: number
}

/**
 * Run a chain and hand back the finished sample data.
 *
 * Everything downstream (preview playback and the WAV export) reads this one
 * result. There is no second, live signal path, so preview and export cannot
 * drift apart.
 */
export async function renderChain(
  original: Pcm,
  chain: ChainSpec,
  fit: FitSpec = NO_FIT,
): Promise<RenderResult> {
  const started = performance.now()
  const ops = planOps(chain)
  const passes = planPasses(ops)

  let pcm = original
  // Tracks whether `pcm` is still the caller's buffer. Every pass produces a
  // fresh one, so after the first pass we own it and the finishing steps can
  // work in place. On a three minute stereo sample that is 69MB per copy not
  // allocated.
  let owned = false
  let opIndex = 0
  for (const pass of passes) {
    if (pass.kind === 'buffer') {
      pcm = applyBufferOp(pcm, pass.op, chain.seed + opIndex * 7919)
      opIndex += 1
    } else {
      pcm = await renderNodePass(pcm, pass.ops)
      // Drop the dead air a pass leaves behind before the next stage sees it.
      // Otherwise a decay tail becomes structural material for whatever chops
      // or reverses next.
      pcm = trimTail(pcm)
      opIndex += pass.ops.length
    }
    owned = true
  }

  // Every effect bypassed means we never copied, and the finishing steps must
  // not write into the source.
  if (!owned) pcm = clonePcm(pcm)

  pcm = trimTail(pcm)

  // --- length ---------------------------------------------------------
  // Applied after the chain and before the final normalise, so whatever the
  // stretch does to level is accounted for in the output ceiling.
  if (fit.bars !== null) {
    const target = fit.bars * SECONDS_PER_BAR
    const before = durationOf(pcm)
    if (fit.mode === 'trim') {
      const untrimmed = pcm
      const hadSignal = peakOf(untrimmed) >= 1e-4
      const head = trimTo(untrimmed, target)
      // If cutting from the head landed on dead air, take the loudest window
      // of the same length out of the original instead of handing back silence.
      pcm =
        hadSignal && peakOf(head) < 1e-4
          ? trimToLoudest(untrimmed, target)
          : head
    } else {
      pcm = resampleTo(pcm, target)
      if (fit.mode === 'fit') {
        // Resampling moved the pitch along with the length. Shift it back so
        // only the duration changed.
        const semitones = compensationSemitones(before, target)
        if (Math.abs(semitones) > 0.02) {
          pcm = await renderNodePass(pcm, [
            {
              stage: 'node',
              spec: {
                id: 'pitch',
                enabled: true,
                semitones,
                windowSize: 0.06,
              },
            },
          ])
          // The shifter adds a tail; the length is the whole point here.
          pcm = trimTo(pcm, target)
        }
      }
    }
  }
  pcm = normalizeInPlace(pcm)

  // A result cut to a bar length exists to be looped, so its ends are joined
  // to each other instead of faded to silence. Left at its natural length it
  // is a one-shot, and gets ordinary edge fades.
  if (fit.bars !== null) {
    pcm = applyLoopSeam(pcm)
    pcm = applyEdgeFades(pcm, 0.0015)
  } else {
    pcm = applyEdgeFades(pcm)
  }

  return { pcm, elapsedMs: performance.now() - started }
}
