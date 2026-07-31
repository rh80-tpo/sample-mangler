/** The five effects in the pool. */
export type EffectId = 'reverse' | 'chop' | 'bitcrush' | 'pitch' | 'drive'

export type ReverseSpec = { id: 'reverse' }

export type ChopSpec = {
  id: 'chop'
  segments: number
  /** Fraction of segments that get shuffled out of position. */
  reorder: number
  /** Chance any given segment repeats. */
  repeat: number
  /** Chance a repeated segment gets a hard gate instead of a copy. */
  gate: number
}

export type BitcrushSpec = {
  id: 'bitcrush'
  /** Bit depth to quantize to. */
  bits: number
  /** Sample-and-hold divisor. 1 means no rate reduction. */
  divisor: number
}

export type PitchSpec = {
  id: 'pitch'
  semitones: number
  windowSize: number
}

export type DriveSpec = {
  id: 'drive'
  amount: number
  oversample: 'none' | '2x' | '4x'
}

export type EffectSpec =
  | ReverseSpec
  | ChopSpec
  | BitcrushSpec
  | PitchSpec
  | DriveSpec

/** A single roll: an ordered list of effects with locked-in parameters. */
export type ChainSpec = {
  seed: number
  effects: EffectSpec[]
}

/**
 * One unit of work in the render plan. `buffer` ops rewrite sample data
 * directly; `node` ops are Tone nodes that need an offline render pass.
 */
export type Op =
  | { stage: 'buffer'; spec: EffectSpec }
  | { stage: 'node'; spec: EffectSpec }

/** Consecutive node ops collapse into one offline render pass. */
export type Pass =
  | { kind: 'buffer'; op: Op }
  | { kind: 'render'; ops: Op[] }
