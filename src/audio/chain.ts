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

/**
 * How likely each effect is to be drawn into a chain.
 *
 * Not uniform, because the effects are not equally loud in the result. Drive
 * and bitcrush are broadband: once either is in the chain it colours
 * everything downstream of it, so picking them as often as the others made
 * every roll sound like the same fizz. Reverse, chop and pitch rearrange the
 * sample while leaving its character intact, which is what keeps a roll
 * recognisable as the thing you fed in.
 *
 * These are relative weights, not probabilities.
 */
const POOL_WEIGHTS: Record<EffectId, number> = {
  chop: 1.35,
  pitch: 1.25,
  reverse: 1.15,
  reverb: 1.1,
  drive: 0.46,
  bitcrush: 0.42,
}

const POOL = Object.keys(POOL_WEIGHTS) as EffectId[]

/** Draw `count` distinct effects, respecting the weights above. */
function drawEffects(rng: Rng, count: number): EffectId[] {
  const remaining = POOL.slice()
  const picked: EffectId[] = []
  for (let i = 0; i < count && remaining.length; i++) {
    const weights = remaining.map((id) => POOL_WEIGHTS[id])
    const [chosen] = remaining.splice(weighted(rng, weights), 1)
    picked.push(chosen)
  }
  // Position in the chain still gets to be arbitrary.
  return shuffled(rng, picked)
}

/**
 * How many effects land in a roll.
 * Index 0 is one effect, index 5 is all six.
 *
 * Two and three dominate because that is where results stay recognisable as
 * the source. The full stack is deliberately rare: it is the roll that comes
 * back genuinely destroyed, and it should feel like it cost something to get.
 */
const SUBSET_WEIGHTS = [0.09, 0.27, 0.29, 0.2, 0.11, 0.04]

/**
 * Intervals that stay in tune with the source. Fifths, fourths, thirds and
 * octaves. Used most of the time so a pitched roll is still droppable in a
 * project without retuning it.
 */
const MUSICAL_INTERVALS = [-12, -12, -7, -5, -5, -4, -3, 3, 4, 5, 7, 12]

function rollReverse(): EffectSpec {
  return { id: 'reverse', enabled: true }
}

/**
 * Segment length is what actually decides the character here, not segment
 * count, because a fixed count means something different on a 0.4s one-shot
 * than on a 6s loop. Target 45ms to 320ms: above ~320ms the reorder stops
 * reading as an effect and just sounds like a bad edit, below ~45ms it stops
 * being a chop and becomes a buzz.
 */
function rollChop(rng: Rng, duration: number, solo: boolean): EffectSpec {
  const targetLen = Math.exp(
    randRange(rng, Math.log(0.045), Math.log(0.32)),
  )
  const segments = Math.max(3, Math.min(48, Math.round(duration / targetLen)))
  return {
    id: 'chop',
    enabled: true,
    segments,
    reorder: randRange(rng, solo ? 0.35 : 0.15, 0.65),
    repeat: randRange(rng, solo ? 0.25 : 0.12, 0.45),
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
function rollBitcrush(rng: Rng, solo: boolean): EffectSpec {
  const wrecked = chance(rng, solo ? 0.55 : 0.3)
  const bits = wrecked ? randInt(rng, 4, 6) : randInt(rng, 7, solo ? 10 : 12)
  // Divisor 1 means no rate reduction at all, which combined with a high bit
  // depth is close to transparent. Fine when other effects carry the roll,
  // not fine when this is the whole roll.
  const divisorRoll = weighted(
    rng,
    solo ? [0, 0.3, 0.42, 0.28] : [0.28, 0.34, 0.24, 0.14],
  )
  const divisor = [
    1,
    randInt(rng, 2, 4),
    randInt(rng, 5, 9),
    randInt(rng, 10, 16),
  ][divisorRoll]
  return { id: 'bitcrush', enabled: true, bits, divisor }
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
    enabled: true,
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
function rollDrive(rng: Rng, solo: boolean): EffectSpec {
  // The hard branch is rarer than it was. Full-tilt distortion is a choice you
  // reach for on a knob, not something a roll should hand you every fourth
  // time it picks drive at all.
  const hard = chance(rng, solo ? 0.4 : 0.16)
  return {
    id: 'drive',
    enabled: true,
    amount: hard
      ? randRange(rng, 0.62, 0.92)
      : randRange(rng, solo ? 0.35 : 0.18, 0.62),
    oversample: chance(rng, 0.8) ? pick(rng, ['2x', '4x'] as const) : 'none',
  }
}

/**
 * Reverb here is a space to throw the wreckage into, not a polish. Mix sits
 * mostly between a fifth and a half so the transient survives; the drowned
 * branch pushes past that for the rolls that turn a one-shot into a wash.
 *
 * Damping is the character control. Below about 2kHz it reads as a dark
 * chamber, up near 12kHz it is bright and splashy. Solo reverb has to be
 * obviously present, so it never rolls a nearly-dry mix.
 */
function rollReverb(rng: Rng, solo: boolean): EffectSpec {
  const drowned = chance(rng, solo ? 0.4 : 0.22)
  return {
    id: 'reverb',
    enabled: true,
    size: randRange(rng, solo ? 0.55 : 0.3, 0.92),
    damp: Math.exp(randRange(rng, Math.log(900), Math.log(12000))),
    mix: drowned
      ? randRange(rng, 0.6, 0.92)
      : randRange(rng, solo ? 0.35 : 0.18, 0.55),
  }
}

function rollEffect(
  rng: Rng,
  id: EffectId,
  duration: number,
  solo: boolean,
): EffectSpec {
  switch (id) {
    case 'reverse':
      return rollReverse()
    case 'chop':
      return rollChop(rng, duration, solo)
    case 'bitcrush':
      return rollBitcrush(rng, solo)
    case 'pitch':
      return rollPitch(rng)
    case 'drive':
      return rollDrive(rng, solo)
    case 'reverb':
      return rollReverb(rng, solo)
  }
}

/**
 * Roll a full chain: which effects, in what order, with what settings.
 *
 * When only one effect comes up it has to carry the whole roll, so its
 * parameters are drawn from the more committed part of the range. Without
 * that, a one-effect roll can land somewhere close to transparent and the
 * reroll feels broken even though it worked.
 */
export function rollChain(seed: number, duration: number): ChainSpec {
  const rng = mulberry32(seed)
  const count = weighted(rng, SUBSET_WEIGHTS) + 1
  const chosen = drawEffects(rng, count)
  const solo = count === 1
  const effects = chosen.map((id) => rollEffect(rng, id, duration, solo))
  return { seed, effects: restrain(effects) }
}

/**
 * Drive and bitcrush stacked on the same sample is the fizz that made every
 * roll sound alike. They are still allowed to co-occur, because sometimes that
 * is exactly the roll you want, but when they do they both give ground: the
 * drive backs off and the crush keeps more bits.
 */
function restrain(effects: EffectSpec[]): EffectSpec[] {
  const hasDrive = effects.some((e) => e.id === 'drive')
  const hasCrush = effects.some((e) => e.id === 'bitcrush')
  if (!hasDrive || !hasCrush) return effects

  return effects.map((e) => {
    if (e.id === 'drive') {
      return { ...e, amount: Math.min(e.amount, 0.45) }
    }
    if (e.id === 'bitcrush') {
      return { ...e, bits: Math.max(e.bits, 8) }
    }
    return e
  })
}

/**
 * Expand a chain into ordered ops. Bitcrush is the one effect that spans both
 * stages: the sample-and-hold is a buffer rewrite, the bit depth is a Tone
 * node. They stay adjacent so the pair still reads as one pedal in the chain.
 */
export function planOps(chain: ChainSpec): Op[] {
  const ops: Op[] = []
  for (const spec of chain.effects) {
    // A bypassed effect keeps its settings but contributes nothing to the
    // render, so switching it back on restores exactly what it was doing.
    if (!spec.enabled) continue
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
      case 'reverb':
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

/**
 * A sensible starting point for an effect added by hand.
 *
 * Deliberately not a random roll: reaching for an effect yourself means you
 * want a known, usable setting to work from, not another surprise.
 */
export function defaultEffect(id: EffectId, duration: number): EffectSpec {
  switch (id) {
    case 'reverse':
      return { id: 'reverse', enabled: true }
    case 'chop':
      return {
        id: 'chop',
        enabled: true,
        // Eighth notes at 120, which is where a chop reads as rhythmic.
        segments: Math.max(4, Math.min(32, Math.round(duration / 0.25))),
        reorder: 0.3,
        repeat: 0.25,
        gate: 0.1,
      }
    case 'bitcrush':
      return { id: 'bitcrush', enabled: true, bits: 8, divisor: 4 }
    case 'pitch':
      return { id: 'pitch', enabled: true, semitones: -12, windowSize: 0.05 }
    case 'drive':
      return { id: 'drive', enabled: true, amount: 0.35, oversample: '2x' }
    case 'reverb':
      return { id: 'reverb', enabled: true, size: 0.6, damp: 5000, mix: 0.35 }
  }
}

/** Every effect, for the add menu. */
export const ALL_EFFECTS: readonly EffectId[] = [
  'reverse',
  'chop',
  'bitcrush',
  'pitch',
  'drive',
  'reverb',
]

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
        case 'reverb':
          return `verb(sz${e.size.toFixed(2)} ${Math.round(e.damp)}Hz mix${e.mix.toFixed(2)})`
      }
    })
    .join(' > ')
}
