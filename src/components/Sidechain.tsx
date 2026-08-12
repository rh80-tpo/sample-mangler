import type { Continuous } from '../audio/params'
import { KICK_RATES, type SidechainSpec } from '../audio/sidechain'
import { Knob } from './Knob'

/**
 * The sidechain row.
 *
 * Ducking against a kick you cannot hear is guesswork, so the kick toggle puts
 * a reference kick under the preview. It is monitored, not rendered: it never
 * reaches the file, which is why it is a switch here rather than an effect in
 * the rack.
 */

const pct = (v: number) => `${Math.round(v * 100)}`

const AMOUNT: Continuous = {
  kind: 'knob',
  key: 'amount',
  label: 'duck',
  min: 0,
  max: 1,
  step: 0.01,
  format: pct,
}

const RELEASE: Continuous = {
  kind: 'knob',
  key: 'release',
  label: 'release',
  min: 0.05,
  max: 1,
  step: 0.01,
  format: pct,
}

type Props = {
  spec: SidechainSpec
  kickAudible: boolean
  bpm: number
  disabled?: boolean
  onChange: (next: SidechainSpec) => void
  onKickAudible: (on: boolean) => void
  /** Called when a drag ends, so playback can pick the change up. */
  onCommit?: () => void
}

export function Sidechain({
  spec,
  kickAudible,
  bpm,
  disabled,
  onChange,
  onKickAudible,
  onCommit,
}: Props) {
  const perBar = spec.rate
  const gap = (60 / bpm) * (4 / perBar)

  return (
    <section className="sidechain" aria-label="Sidechain">
      <span className="sidechain__title">sidechain</span>

      <Knob
        param={AMOUNT}
        value={spec.amount}
        disabled={disabled}
        onChange={(v) => onChange({ ...spec, amount: v })}
        onCommit={onCommit}
      />
      <Knob
        param={RELEASE}
        value={spec.release}
        disabled={disabled || spec.amount <= 0}
        onChange={(v) => onChange({ ...spec, release: v })}
        onCommit={onCommit}
      />

      <div className="sidechain__rates" role="group" aria-label="Kick rate">
        {KICK_RATES.map((r) => (
          <button
            key={r.rate}
            type="button"
            className="sidechain__opt"
            aria-pressed={spec.rate === r.rate}
            disabled={disabled}
            title={r.hint}
            onClick={() => {
              onChange({ ...spec, rate: r.rate })
              onCommit?.()
            }}
          >
            {r.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="sidechain__kick"
        aria-pressed={kickAudible}
        disabled={disabled}
        title={
          kickAudible
            ? 'Reference kick is audible. It is never exported.'
            : 'Hear a reference kick under the preview, to check the pocket.'
        }
        onClick={() => onKickAudible(!kickAudible)}
      >
        hear kick
      </button>

      <p className="sidechain__note">
        {spec.amount <= 0
          ? `no ducking. turn duck up to cut a hole on every ${
              KICK_RATES.find((r) => r.rate === perBar)?.label ?? '1/4'
            } note.`
          : `${Math.round(spec.amount * 100)}% out of the way every ${gap.toFixed(
              2,
            )}s, back in ${(spec.release * gap).toFixed(2)}s.`}
      </p>
    </section>
  )
}
