import {
  chance,
  mulberry32,
  pick,
  randInt,
  randRange,
  shuffled,
  weighted,
  type Rng,
} from './rng'
import type { ChainSpec, EffectId, EffectSpec, Op, Pass } from './types'

const POOL: readonly EffectId[] = [
  'reverse',
  'chop',
  'bitcrush',
  'pitch',
  'drive',
]

/**
 * How many effects land in a roll.
 * Index 0 is one effect, index 4 is all five.
 *
 * Two and three dominate because that is where results stay recognisable as
 * the source. All five at once is deliberately rare: it is the roll that
 * comes back genuinely destroyed, and it should feel like it cost something
 * to get.
 */
const SUBSET_WEIGHTS = [0.1, 0.31, 0.32, 0.21, 0.06]

/**
 * Intervals that stay in tune with the source. Fifths, fourths, thirds and
 * octaves. Used most of the time so a pitched roll is still droppable in a
 * project without retuning it.
 */
const MUSICAL_INTERVALS = [-12, -12, -7, -5, -5, -4, -3, 3, 4, 5, 7, 12]

function rollReverse(): EffectSpec {
  return { id: 'reverse' }
}

/**
 * Segment length is what actually decides the character here, not segment
 * count, because a fixed count means something different on a 0.4s one-shot
 * than on a 6s loop. Target 45ms to 320ms: above ~320ms the reorder stops
 * reading as an effect and just sounds like a bad edit, below ~45ms it stops
 * being a chop and becomes a buzz.
 */
function rollChop(rng: Rng, duration: number): EffectSpec {
  const targetLen = Math.exp(
    randRange(rng, Math.log(0.045), Math.log(0.32)),
  )
  const segments = Math.max(3, Math.min(48, Math.round(duration / targetLen)))
  return {
    id: 'chop',
    segments,
    reorder: randRange(rng, 0.15, 0.65),
    repeat: randRange(rng, 0.12, 0.45),
    gate: randRange(rng, 0.0, 0.3),
  }
}

/**
 * Bit depth and rate reduction roll together because they are one pedal in
 * anyone's head.
 *
 * 7 to 12 bits is the lo-fi band: audible grit, source intact. 4 to 6 bits is
 * where it starts to fall apart. Below 4 bits everything becomes the same
 * square-wave fizz regardless of input, which is not interesting, so 4 is the
 * floor.
 *
 * Divisor is sample-and-hold. At 48k, divisor 6 lands near 8kHz, which is the
 * classic sampler sound. 16 lands near 3kHz and is very broken but still
 * readable as the original. Weighted toward the usable end.
 */
function rollBitcrush(rng: Rng): EffectSpec {
  const wrecked = chance(rng, 0.3)
  const bits = wrecked ? randInt(rng, 4, 6) : randInt(rng, 7, 12)
  const divisorRoll = weighted(rng, [0.28, 0.34, 0.24, 0.14])
  const divisor = [
    1,
    randInt(rng, 2, 4),
    randInt(rng, 5, 9),
    randInt(rng, 10, 16),
  ][divisorRoll]
  return { id: 'bitcrush', bits, divisor }
}

/**
 * Down is more useful than up. Pitching a sample down adds weight and keeps
 * the transient; pitching it up past an octave thins it out and gets
 * cartoonish fast. So the floor is -24 and the ceiling is +12.
 *
 * Window size drives the grain artefacts in Tone's shifter. Small windows
 * sound rougher, which is on-brief here, so the range sits low.
 */
function rollPitch(rng: Rng): EffectSpec {
  const semitones = chance(rng, 0.7)
    ? pick(rng, MUSICAL_INTERVALS)
    : Math.round(randRange(rng, -24, 12) * 2) / 2
  return {
    id: 'pitch',
    semitones,
    windowSize: randRange(rng, 0.03, 0.09),
  }
}

/**
 * Tone.Distortion is aggressive. Past ~0.7 it is mostly square wave, under
 * ~0.15 it is inaudible. The usable band is 0.18 to 0.62, with a smaller tail
 * up to 0.92 for the rolls that are meant to hurt.
 *
 * Oversampling is on most of the time because the aliasing without it reads as
 * a bug rather than a choice. It gets switched off occasionally on purpose.
 */
function rollDrive(rng: Rng): EffectSpec {
  const hard = chance(rng, 0.25)
  return {
    id: 'drive',
    amount: hard ? randRange(rng, 0.62, 0.92) : randRange(rng, 0.18, 0.62),
    oversample: chance(rng, 0.8) ? pick(rng, ['2x', '4x'] as const) : 'none',
  }
}

function rollEffect(rng: Rng, id: EffectId, duration: number): EffectSpec {
  switch (id) {
    case 'reverse':
      return rollReverse()
    case 'chop':
      return rollChop(rng, duration)
    case 'bitcrush':
      return rollBitcrush(rng)
    case 'pitch':
      return rollPitch(rng)
    case 'drive':
      return rollDrive(rng)
  }
}

/** Roll a full chain: which effects, in what order, with what settings. */
export function rollChain(seed: number, duration: number): ChainSpec {
  const rng = mulberry32(seed)
  const count = weighted(rng, SUBSET_WEIGHTS) + 1
  const chosen = shuffled(rng, POOL).slice(0, count)
  return {
    seed,
    effects: chosen.map((id) => rollEffect(rng, id, duration)),
  }
}

/**
 * Expand a chain into ordered ops. Bitcrush is the one effect that spans both
 * stages: the sample-and-hold is a buffer rewrite, the bit depth is a Tone
 * node. They stay adjacent so the pair still reads as one pedal in the chain.
 */
export function planOps(chain: ChainSpec): Op[] {
  const ops: Op[] = []
  for (const spec of chain.effects) {
    switch (spec.id) {
      case 'reverse':
      case 'chop':
        ops.push({ stage: 'buffer', spec })
        break
      case 'bitcrush':
        if (spec.divisor > 1) ops.push({ stage: 'buffer', spec })
        ops.push({ stage: 'node', spec })
        break
      case 'pitch':
      case 'drive':
        ops.push({ stage: 'node', spec })
        break
    }
  }
  return ops
}

/**
 * Group ops into passes. Runs of node ops collapse into a single offline
 * render; buffer ops split them. This is what lets order be genuinely random
 * across all five effects instead of "buffer effects first, then the chain".
 */
export function planPasses(ops: Op[]): Pass[] {
  const passes: Pass[] = []
  let run: Op[] = []
  const flush = () => {
    if (run.length) {
      passes.push({ kind: 'render', ops: run })
      run = []
    }
  }
  for (const op of ops) {
    if (op.stage === 'node') run.push(op)
    else {
      flush()
      passes.push({ kind: 'buffer', op })
    }
  }
  flush()
  return passes
}

/** Debug/verification only. Never rendered in the UI: the chain stays hidden. */
export function describeChain(chain: ChainSpec): string {
  return chain.effects
    .map((e) => {
      switch (e.id) {
        case 'reverse':
          return 'reverse'
        case 'chop':
          return `chop(${e.segments}seg r${e.reorder.toFixed(2)} rp${e.repeat.toFixed(2)})`
        case 'bitcrush':
          return `crush(${e.bits}bit /${e.divisor})`
        case 'pitch':
          return `pitch(${e.semitones > 0 ? '+' : ''}${e.semitones}st w${e.windowSize.toFixed(3)})`
        case 'drive':
          return `drive(${e.amount.toFixed(2)} ${e.oversample})`
      }
    })
    .join(' > ')
}
