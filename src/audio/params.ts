import type { EffectSpec } from './types'

/**
 * Every knob, switch and selector the rack can show, described as data.
 *
 * Each entry maps one control to one field on an EffectSpec. If a parameter
 * changes the audio, it is in here, and the rack is generated from this rather
 * than hand-built per effect.
 *
 * Ranges here are deliberately wider than the ranges a roll draws from. A roll
 * stays inside the musical band on purpose; a hand on a knob should be able to
 * go past it.
 */
export type Continuous = {
  kind: 'knob'
  key: string
  label: string
  min: number
  max: number
  step: number
  /** Value as it reads on the face of the control. */
  format: (v: number) => string
  /** Skews the taper so the useful part of the range is not bunched up. */
  curve?: number
}

export type Choice = {
  kind: 'choice'
  key: string
  label: string
  options: readonly string[]
}

export type Param = Continuous | Choice

const pct = (v: number) => `${Math.round(v * 100)}`
const one = (v: number) => v.toFixed(1)
const int = (v: number) => `${Math.round(v)}`

export const EFFECT_LABELS: Record<EffectSpec['id'], string> = {
  reverse: 'reverse',
  chop: 'chop',
  bitcrush: 'bitcrush',
  pitch: 'pitch',
  drive: 'drive',
}

export function paramsFor(spec: EffectSpec): Param[] {
  switch (spec.id) {
    case 'reverse':
      // Reversing is all or nothing. Its only control is the bypass switch,
      // which every module has.
      return []

    case 'chop':
      return [
        {
          kind: 'knob',
          key: 'segments',
          label: 'slices',
          min: 2,
          max: 64,
          step: 1,
          format: int,
          curve: 0.6,
        },
        { kind: 'knob', key: 'reorder', label: 'scatter', min: 0, max: 1, step: 0.01, format: pct },
        { kind: 'knob', key: 'repeat', label: 'stutter', min: 0, max: 1, step: 0.01, format: pct },
        { kind: 'knob', key: 'gate', label: 'gate', min: 0, max: 1, step: 0.01, format: pct },
      ]

    case 'bitcrush':
      return [
        {
          kind: 'knob',
          key: 'bits',
          label: 'bits',
          min: 1,
          max: 16,
          step: 1,
          format: int,
        },
        {
          kind: 'knob',
          key: 'divisor',
          label: 'rate',
          min: 1,
          max: 32,
          step: 1,
          format: (v) => `1/${Math.round(v)}`,
          curve: 0.6,
        },
      ]

    case 'pitch':
      return [
        {
          kind: 'knob',
          key: 'semitones',
          label: 'pitch',
          min: -24,
          max: 24,
          step: 0.5,
          format: (v) => `${v > 0 ? '+' : ''}${one(v)}`,
        },
        {
          kind: 'knob',
          key: 'windowSize',
          label: 'grain',
          min: 0.01,
          max: 0.25,
          step: 0.005,
          format: (v) => `${Math.round(v * 1000)}ms`,
        },
      ]

    case 'drive':
      return [
        { kind: 'knob', key: 'amount', label: 'drive', min: 0, max: 1, step: 0.01, format: pct },
        {
          kind: 'choice',
          key: 'oversample',
          label: 'alias',
          options: ['none', '2x', '4x'] as const,
        },
      ]
  }
}

/** Read a parameter off a spec without widening every call site to `any`. */
export function readParam(spec: EffectSpec, key: string): number | string {
  return (spec as unknown as Record<string, number | string>)[key]
}

/** Return a copy of `spec` with one parameter changed. */
export function writeParam(
  spec: EffectSpec,
  key: string,
  value: number | string,
): EffectSpec {
  return { ...spec, [key]: value } as EffectSpec
}
