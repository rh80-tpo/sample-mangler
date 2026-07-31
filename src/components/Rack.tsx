import {
  EFFECT_LABELS,
  paramsFor,
  readParam,
  writeParam,
  type Choice,
} from '../audio/params'
import { ALL_EFFECTS, defaultEffect } from '../audio/chain'
import type { ChainSpec, EffectId, EffectSpec } from '../audio/types'
import { Knob } from './Knob'

type Props = {
  chain: ChainSpec
  onChange: (chain: ChainSpec) => void
  /** Fires when an interaction settles, so playback can resync once. */
  onCommit?: () => void
  busy?: boolean
  /** Length of the material, used to size a hand-added chop sensibly. */
  seconds: number
}

function Selector({
  param,
  value,
  disabled,
  onChange,
}: {
  param: Choice
  value: string
  disabled?: boolean
  onChange: (v: string) => void
}) {
  return (
    <div className={`sel${disabled ? ' sel--off' : ''}`}>
      <div className="sel__row" role="group" aria-label={param.label}>
        {param.options.map((opt) => (
          <button
            key={opt}
            type="button"
            className="sel__opt"
            aria-pressed={value === opt}
            disabled={disabled}
            onClick={() => onChange(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
      <span className="sel__label">{param.label}</span>
    </div>
  )
}

/**
 * The rack. One module per effect in the current chain, in chain order, with a
 * control for every parameter that changes the audio.
 *
 * Order is fixed here on purpose: reordering the chain is a different
 * interaction and belongs to the reroll, not to a knob.
 */
export function Rack({ chain, onChange, onCommit, busy, seconds }: Props) {
  const update = (index: number, next: EffectSpec) => {
    const effects = chain.effects.slice()
    effects[index] = next
    onChange({ ...chain, effects })
  }

  const add = (id: EffectId) => {
    onChange({
      ...chain,
      effects: [...chain.effects, defaultEffect(id, seconds)],
    })
    onCommit?.()
  }

  const remove = (index: number) => {
    onChange({
      ...chain,
      effects: chain.effects.filter((_, i) => i !== index),
    })
    onCommit?.()
  }

  return (
    <section className="rack" aria-label="Effect controls for the current chain">
      {chain.effects.map((spec, i) => {
        const params = paramsFor(spec)
        const off = !spec.enabled
        return (
          <div
            key={`${spec.id}-${i}`}
            className={`mod${off ? ' mod--off' : ''}`}
          >
            <div className="mod__head">
              <span className="mod__index" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <button
                type="button"
                className="mod__power"
                aria-pressed={spec.enabled}
                onClick={() => {
                  update(i, { ...spec, enabled: !spec.enabled })
                  onCommit?.()
                }}
              >
                <span className="mod__name">{EFFECT_LABELS[spec.id]}</span>
                <span className="sr-only">
                  {spec.enabled ? ' is on. Turn it off.' : ' is off. Turn it on.'}
                </span>
              </button>
              <button
                type="button"
                className="mod__drop"
                onClick={() => remove(i)}
                aria-label={`Remove ${EFFECT_LABELS[spec.id]} from the chain`}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>

            <div className="mod__body">
              {params.length === 0 ? (
                <p className="mod__note">
                  {spec.enabled ? 'on' : 'off'}
                </p>
              ) : (
                params.map((p) =>
                  p.kind === 'knob' ? (
                    <Knob
                      key={p.key}
                      param={p}
                      value={readParam(spec, p.key) as number}
                      disabled={off || busy}
                      onChange={(v) => update(i, writeParam(spec, p.key, v))}
                      onCommit={onCommit}
                    />
                  ) : (
                    <Selector
                      key={p.key}
                      param={p}
                      value={readParam(spec, p.key) as string}
                      disabled={off || busy}
                      onChange={(v) => {
                        update(i, writeParam(spec, p.key, v))
                        onCommit?.()
                      }}
                    />
                  ),
                )
              )}
            </div>
          </div>
        )
      })}

      {/* Add anything, any number of times. A reroll replaces the whole chain,
          so this is how you build one deliberately instead of waiting for the
          dice to hand you the effect you wanted. */}
      <div className="mod mod--add">
        <div className="mod__head">
          <span className="mod__index" aria-hidden="true">
            +
          </span>
          <span className="mod__name mod__name--add">add</span>
        </div>
        <div className="mod__body mod__body--add" role="group" aria-label="Add an effect">
          {ALL_EFFECTS.map((id) => (
            <button
              key={id}
              type="button"
              className="addfx"
              disabled={busy}
              onClick={() => add(id)}
            >
              {EFFECT_LABELS[id]}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
