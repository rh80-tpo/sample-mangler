import * as Tone from 'tone'
import { planOps, planPasses } from './chain'
import {
  applyEdgeFades,
  durationOf,
  normalize,
  pcmFrom,
  trimTail,
  type Pcm,
} from './buffers'
import { applyChop, applyDecimate, applyReverse } from './effects'
import type { ChainSpec, EffectSpec, Op } from './types'

/**
 * Extra render time so a pass is not cut off mid-tail.
 *
 * Tone's PitchShift is a pair of delay lines sweeping 0 to windowSize, so its
 * output lags the input by a time-varying amount rather than a fixed latency.
 * There is nothing to compensate for at the head; there is a tail to catch at
 * the end. trimTail cleans up whatever slack is left over.
 */
function tailFor(ops: Op[]): number {
  let tail = 0.05
  for (const op of ops) {
    if (op.spec.id === 'pitch') tail = Math.max(tail, op.spec.windowSize * 3 + 0.15)
  }
  return tail
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
  const duration = durationOf(pcm) + tailFor(ops)

  const offline = new Tone.OfflineContext(channels, duration, pcm.sampleRate)
  const previous = Tone.getContext()
  Tone.setContext(offline)
  try {
    const buf = new Tone.ToneAudioBuffer()
    buf.fromArray(pcm.channels.length === 1 ? pcm.channels[0] : pcm.channels)

    const source = new Tone.ToneBufferSource(buf)
    let node: Tone.ToneAudioNode = source
    for (const op of ops) {
      const fx = makeNode(op.spec)
      node.connect(fx)
      node = fx
    }
    node.toDestination()
    source.start(0)

    const rendered = await offline.render(false)
    const audioBuffer =
      rendered instanceof AudioBuffer ? rendered : (rendered.get() as AudioBuffer)
    return pcmFrom(audioBuffer)
  } finally {
    Tone.setContext(previous)
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
): Promise<RenderResult> {
  const started = performance.now()
  const ops = planOps(chain)
  const passes = planPasses(ops)

  let pcm = original
  let opIndex = 0
  for (const pass of passes) {
    if (pass.kind === 'buffer') {
      pcm = applyBufferOp(pcm, pass.op, chain.seed + opIndex * 7919)
      opIndex += 1
    } else {
      pcm = await renderNodePass(pcm, pass.ops)
      opIndex += pass.ops.length
    }
  }

  pcm = trimTail(pcm)
  pcm = normalize(pcm)
  pcm = applyEdgeFades(pcm)

  return { pcm, elapsedMs: performance.now() - started }
}
