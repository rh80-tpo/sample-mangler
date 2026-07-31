import { useCallback, useEffect, useId, useRef } from 'react'
import type { Continuous } from '../audio/params'

type Props = {
  param: Continuous
  value: number
  disabled?: boolean
  onChange: (v: number) => void
  /** Fires when a drag ends, so callers can resync playback once. */
  onCommit?: () => void
}

/** Sweep of the indicator arc, in degrees. Leaves a gap at the bottom. */
const SWEEP = 280
const START = 90 + (360 - SWEEP) / 2

/** Pixels of vertical drag to travel the whole range. */
const DRAG_RANGE = 190

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

function quantise(v: number, param: Continuous) {
  const steps = Math.round((v - param.min) / param.step)
  return clamp(
    +(param.min + steps * param.step).toFixed(6),
    param.min,
    param.max,
  )
}

/** Position 0..1 along the control face, with the optional taper applied. */
function toNorm(v: number, p: Continuous) {
  const raw = (v - p.min) / (p.max - p.min)
  return p.curve ? Math.pow(raw, p.curve) : raw
}

function fromNorm(n: number, p: Continuous) {
  const raw = p.curve ? Math.pow(clamp(n, 0, 1), 1 / p.curve) : clamp(n, 0, 1)
  return quantise(p.min + raw * (p.max - p.min), p)
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
}

function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const [x1, y1] = polar(cx, cy, r, from)
  const [x2, y2] = polar(cx, cy, r, to)
  const large = Math.abs(to - from) > 180 ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`
}

/**
 * A rotary control.
 *
 * Drag is the fast path, but everything it does is reachable from the
 * keyboard: arrows step, shift-arrow does a fine step, page keys jump, home
 * and end go to the ends. It reports itself as a slider with a real value and
 * a spoken value, so it is not a mouse-only control wearing an accessible
 * label.
 */
export function Knob({ param, value, disabled, onChange, onCommit }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; start: number } | null>(null)
  const labelId = useId()

  const norm = toNorm(value, param)
  const angle = START + norm * SWEEP
  const size = 46
  const c = size / 2
  const r = c - 5

  const nudge = useCallback(
    (steps: number) => {
      onChange(quantise(value + steps * param.step, param))
    },
    [onChange, param, value],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return
      const big = Math.max(1, Math.round((param.max - param.min) / param.step / 10))
      let handled = true
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowRight':
          nudge(e.shiftKey ? 0.25 : 1)
          break
        case 'ArrowDown':
        case 'ArrowLeft':
          nudge(e.shiftKey ? -0.25 : -1)
          break
        case 'PageUp':
          nudge(big)
          break
        case 'PageDown':
          nudge(-big)
          break
        case 'Home':
          onChange(param.min)
          break
        case 'End':
          onChange(param.max)
          break
        default:
          handled = false
      }
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
        onCommit?.()
      }
    },
    [disabled, nudge, onChange, onCommit, param],
  )

  // Pointer drag. Vertical travel maps to the range; holding shift slows it
  // down for fine work, the way a hardware knob with a fine mode behaves.
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      drag.current = { y: e.clientY, start: toNorm(value, param) }
      ref.current?.focus()
      e.preventDefault()
    },
    [disabled, param, value],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current
      if (!d) return
      const scale = e.shiftKey ? 4 : 1
      const delta = (d.y - e.clientY) / (DRAG_RANGE * scale)
      onChange(fromNorm(d.start + delta, param))
    },
    [onChange, param],
  )

  const endDrag = useCallback(() => {
    if (!drag.current) return
    drag.current = null
    onCommit?.()
  }, [onCommit])

  // A drag can end outside the element, so release on the window too.
  useEffect(() => {
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    return () => {
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
    }
  }, [endDrag])

  const shown = param.format(value)

  return (
    <div className={`knob${disabled ? ' knob--off' : ''}`}>
      <div
        ref={ref}
        className="knob__dial"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={labelId}
        aria-valuemin={param.min}
        aria-valuemax={param.max}
        aria-valuenow={value}
        aria-valuetext={`${shown} ${param.label}`}
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onDoubleClick={() => {
          if (disabled) return
          // Double-click parks it at the middle of the range, the usual
          // hardware convention for "put it back".
          onChange(fromNorm(0.5, param))
          onCommit?.()
        }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <path
            d={arc(c, c, r, START, START + SWEEP)}
            className="knob__track"
            fill="none"
          />
          {norm > 0.005 ? (
            <path
              d={arc(c, c, r, START, angle)}
              className="knob__fill"
              fill="none"
            />
          ) : null}
          <line
            x1={polar(c, c, r - 11, angle)[0]}
            y1={polar(c, c, r - 11, angle)[1]}
            x2={polar(c, c, r - 2, angle)[0]}
            y2={polar(c, c, r - 2, angle)[1]}
            className="knob__pointer"
          />
        </svg>
      </div>
      <span className="knob__value">{shown}</span>
      <span className="knob__label" id={labelId}>
        {param.label}
      </span>
    </div>
  )
}
