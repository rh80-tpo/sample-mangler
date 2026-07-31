/** The effects pool. */
export type EffectId =
  | 'reverse'
  | 'chop'
  | 'bitcrush'
  | 'pitch'
  | 'drive'
  | 'reverb'

/** Every effect can be switched out of the chain without losing its settings. */
type Bypassable = { enabled: boolean }

export type ReverseSpec = Bypassable & { id: 'reverse' }

export type ChopSpec = Bypassable & {
  id: 'chop'
  segments: number
  /** Fraction of segments that get shuffled out of position. */
  reorder: number
  /** Chance any given segment repeats. */
  repeat: number
  /** Chance a repeated segment gets a hard gate instead of a copy. */
  gate: number
}

export type BitcrushSpec = Bypassable & {
  id: 'bitcrush'
  /** Bit depth to quantize to. */
  bits: number
  /** Sample-and-hold divisor. 1 means no rate reduction. */
  divisor: number
}

export type PitchSpec = Bypassable & {
  id: 'pitch'
  semitones: number
  windowSize: number
}

export type DriveSpec = Bypassable & {
  id: 'drive'
  amount: number
  oversample: 'none' | '2x' | '4x'
}

export type ReverbSpec = Bypassable & {
  id: 'reverb'
  /** Freeverb room size, 0 to 1. */
  size: number
  /** High-frequency damping in Hz. Lower is darker. */
  damp: number
  /** Wet/dry. */
  mix: number
}

export type EffectSpec =
  | ReverseSpec
  | ChopSpec
  | BitcrushSpec
  | PitchSpec
  | DriveSpec
  | ReverbSpec

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
