import { MIN_LEVEL_DB } from '../audio/buffers'
import type { Continuous } from '../audio/params'
import { Knob } from './Knob'

/**
 * The two volume controls, which are not the same control.
 *
 * LEVEL is signal. It is baked into the Pcm that both the player and the WAV
 * encoder read, so turning it down makes the exported file quieter and what you
 * hear stays what you get.
 *
 * MONITOR is not signal. It sits on the playback node and never reaches the
 * file, so you can audition a loud loop quietly under a beat without changing
 * what you are about to export.
 *
 * Keeping them apart matters here: this tool's whole promise is that the export
 * matches the preview, and a single fader that quietly did both jobs would
 * either break that promise or take away the ability to listen quietly.
 */

const LEVEL: Continuous = {
  kind: 'knob',
  key: 'level',
  label: 'level',
  min: MIN_LEVEL_DB,
  max: 0,
  step: 0.5,
  // At the bottom of the travel it is off, and saying so is clearer than
  // showing a number that implies there is still something there.
  format: (v) => (v <= MIN_LEVEL_DB ? 'off' : v === 0 ? '0.0' : v.toFixed(1)),
}

const MONITOR: Continuous = {
  kind: 'knob',
  key: 'monitor',
  label: 'monitor',
  min: 0,
  max: 1,
  step: 0.01,
  format: (v) => (v <= 0 ? 'off' : `${Math.round(v * 100)}`),
}

type Props = {
  level: number
  monitor: number
  disabled?: boolean
  onLevel: (db: number) => void
  onMonitor: (v: number) => void
}

export function Levels({ level, monitor, disabled, onLevel, onMonitor }: Props) {
  return (
    <div className="levels">
      <span className="levels__title">out</span>
      <Knob param={LEVEL} value={level} disabled={disabled} onChange={onLevel} />
      <span className="levels__unit">dB</span>
      <Knob param={MONITOR} value={monitor} onChange={onMonitor} />
      <p className="levels__note">
        {level <= MIN_LEVEL_DB
          ? 'level is off, so the export would be silent'
          : level < 0
            ? `exports ${Math.abs(level).toFixed(1)} dB below full`
            : 'exports at full level'}
        . monitor only changes what you hear.
      </p>
    </div>
  )
}
