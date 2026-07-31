import { useCallback, useEffect, useRef, useState } from 'react'
import { computePeaks, type Peaks } from '../audio/peaks'
import type { Pcm } from '../audio/buffers'
import { MIN_REGION, normaliseRegion, type Region } from '../audio/slice'

type Tone = 'source' | 'mangled'

type Props = {
  pcm: Pcm | null
  tone: Tone
  /** 0 to 1. Below 1, columns past the head render as unresolved noise. */
  reveal?: number
  /** 0 to 1 cursor position, or null when this panel is not the transport. */
  playhead?: number | null
  /** True only while audio is actually running through this panel. */
  active?: boolean
  label: string
  /** Text stand-in for the drawing, for anyone not looking at it. */
  summary: string
  /** Shown in place of the drawing when there is nothing to draw. */
  placeholder?: string
  /** Varies the unresolved-column noise so each roll tears differently. */
  nonce?: number
  /** Seconds of audio, used to speak the scrub position out loud. */
  seconds?: number
  /** Provide this to make the panel a seek control. 0 to 1. */
  onSeek?: (position: number) => void
  /** Highlighted region, as fractions of the whole. */
  region?: Region | null
  onRegionChange?: (region: Region | null) => void
  /** Per-panel controls, rendered in the header row. */
  tools?: React.ReactNode
  /** Highlighted tempo readout, for the one number people are matching to. */
  tempo?: string | null
}

/** Column pitch in device pixels: a 2px stroke with a 1px gap. */
const COL = 3

/** Cheap deterministic hash, used for the unresolved-column noise. */
function hash(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export function Waveform({
  pcm,
  tone,
  reveal = 1,
  playhead = null,
  active = false,
  label,
  summary,
  placeholder,
  nonce = 0,
  seconds = 0,
  onSeek,
  region = null,
  onRegionChange,
  tools,
  tempo,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  // A press is a seek until it travels far enough to be a selection instead.
  const drag = useRef<{ from: number; moved: boolean } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const peaksRef = useRef<Peaks | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // Track the drawing surface so peak resolution matches pixel resolution.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ w: Math.round(width), h: Math.round(height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Recompute peaks only when the audio or the width actually changes.
  useEffect(() => {
    if (!pcm || size.w === 0) {
      peaksRef.current = null
      return
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    peaksRef.current = computePeaks(pcm, Math.floor((size.w * dpr) / COL))
  }, [pcm, size.w])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w === 0 || size.h === 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(size.w * dpr)
    canvas.height = Math.floor(size.h * dpr)

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width
    const H = canvas.height
    const mid = H / 2
    const half = H / 2 - 2 * dpr

    // Colours come from the token layer, never from literals in here.
    const css = getComputedStyle(canvas)
    const v = (name: string) => css.getPropertyValue(name).trim()
    const body = tone === 'mangled' ? v('--signal') : v('--ink-dim')
    const core = tone === 'mangled' ? v('--ink') : v('--ink')
    const grid = v('--grid')
    const headCol = v('--signal')

    ctx.clearRect(0, 0, W, H)

    // Dormant scope baseline plus tick marks. Present even when empty, so the
    // idle state already looks like the instrument rather than a blank box.
    ctx.strokeStyle = grid
    ctx.lineWidth = dpr
    ctx.beginPath()
    ctx.moveTo(0, Math.round(mid) + 0.5)
    ctx.lineTo(W, Math.round(mid) + 0.5)
    ctx.stroke()
    ctx.beginPath()
    for (let x = 0; x < W; x += Math.round(W / 32)) {
      ctx.moveTo(Math.round(x) + 0.5, mid - 4 * dpr)
      ctx.lineTo(Math.round(x) + 0.5, mid + 4 * dpr)
    }
    ctx.stroke()

    const peaks = peaksRef.current
    if (!peaks) return

    const n = peaks.columns
    const headIndex = reveal >= 1 ? n : Math.floor(reveal * n)
    // The played/unplayed split only means anything while audio is running.
    // Idle, the cursor is just a start marker and the whole waveform stays lit.
    const playIndex = !active || playhead == null ? n : Math.floor(playhead * n)
    const frame = Math.floor(reveal * 1000) + nonce

    // Envelope. Split into played and unplayed so the playhead reads without
    // needing a separate overlay pass.
    const drawEnvelope = (from: number, to: number, alpha: number) => {
      if (to <= from) return
      ctx.globalAlpha = alpha
      ctx.strokeStyle = body
      ctx.lineWidth = 2 * dpr
      ctx.beginPath()
      for (let i = from; i < to; i++) {
        const x = i * COL + dpr
        const top = mid - peaks.max[i] * half
        const bot = mid - peaks.min[i] * half
        ctx.moveTo(x, top)
        ctx.lineTo(x, Math.max(bot, top + dpr))
      }
      ctx.stroke()

      // Density core: the rms band inside the envelope.
      ctx.strokeStyle = core
      ctx.globalAlpha = alpha * (tone === 'mangled' ? 0.55 : 0.4)
      ctx.beginPath()
      for (let i = from; i < to; i++) {
        const x = i * COL + dpr
        const r = peaks.rms[i] * half
        if (r < dpr) continue
        ctx.moveTo(x, mid - r)
        ctx.lineTo(x, mid + r)
      }
      ctx.stroke()
    }

    const resolved = Math.min(headIndex, n)
    drawEnvelope(0, Math.min(playIndex, resolved), 1)
    drawEnvelope(Math.min(playIndex, resolved), resolved, 0.42)

    // Columns the sweep has not reached yet render as unresolved noise, so the
    // reveal reads as the sample being torn apart rather than a bar filling up.
    if (headIndex < n) {
      ctx.globalAlpha = 0.5
      ctx.strokeStyle = headCol
      ctx.lineWidth = 2 * dpr
      ctx.beginPath()
      for (let i = headIndex; i < n; i++) {
        const d = Math.min(1, (i - headIndex) / 40)
        const a = (hash(i, frame) * 0.9 + 0.1) * (1 - d * 0.82) * half
        const x = i * COL + dpr
        ctx.moveTo(x, mid - a)
        ctx.lineTo(x, mid + a)
      }
      ctx.stroke()

      // The scan head itself.
      ctx.globalAlpha = 1
      ctx.fillStyle = headCol
      ctx.fillRect(headIndex * COL, 0, 2 * dpr, H)
    }

    // Selected region. Drawn over the waveform as a wash with hard edges, so
    // the boundaries are readable to the sample rather than approximate.
    if (region && region.end > region.start && reveal >= 1) {
      const x1 = Math.floor(region.start * n) * COL
      const x2 = Math.floor(region.end * n) * COL
      ctx.globalAlpha = 1
      ctx.fillStyle = v('--signal-wash')
      ctx.fillRect(x1, 0, x2 - x1, H)
      ctx.fillStyle = v('--signal')
      ctx.fillRect(x1, 0, 2 * dpr, H)
      ctx.fillRect(x2 - 2 * dpr, 0, 2 * dpr, H)
      // Dim everything outside the selection so the region reads as the
      // subject and the rest as context.
      ctx.fillStyle = v('--ground')
      ctx.globalAlpha = 0.55
      ctx.fillRect(0, 0, x1, H)
      ctx.fillRect(x2, 0, W - x2, H)
      ctx.globalAlpha = 1
    }

    // Cursor. Solid while playing, a thinner marker when parked.
    if (playhead != null && reveal >= 1) {
      const x = Math.floor(playhead * n) * COL
      ctx.globalAlpha = active ? 1 : 0.6
      ctx.fillStyle = active ? v('--ink') : v('--signal')
      ctx.fillRect(x, 0, (active ? 1 : 2) * dpr, H)
    }

    ctx.globalAlpha = 1
  }, [size, pcm, tone, reveal, playhead, active, nonce, region])

  // --- scrubbing and selection ---------------------------------------
  const fractionAt = useCallback((clientX: number) => {
    const el = wrapRef.current
    if (!el) return 0
    const box = el.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - box.left) / box.width))
  }, [])

  const seekToClientX = useCallback(
    (clientX: number) => {
      if (!onSeek) return
      onSeek(fractionAt(clientX))
    },
    [onSeek, fractionAt],
  )

  const at = playhead ?? 0

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!onSeek) return
      // Alt is the fine step. Shift extends a selection, matching how every
      // text field on the machine already behaves, so selecting a region is
      // reachable without a pointer.
      const step = e.altKey ? 0.005 : 0.02
      const arrow =
        e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0

      if (arrow !== 0 && e.shiftKey && onRegionChange) {
        e.preventDefault()
        e.stopPropagation()
        const anchor = region ? region.start : at
        const edge = region ? region.end : at
        const moved = Math.max(0, Math.min(1, edge + arrow * step))
        onRegionChange(normaliseRegion({ start: anchor, end: moved }))
        return
      }

      let next: number | null = null
      switch (e.key) {
        case 'ArrowRight':
          next = at + step
          break
        case 'ArrowLeft':
          next = at - step
          break
        case 'PageUp':
          next = at + 0.1
          break
        case 'PageDown':
          next = at - 0.1
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = 0.98
          break
        case 'Enter':
        case ' ':
          next = at
          break
        case 'Escape':
          if (onRegionChange && region) {
            e.preventDefault()
            e.stopPropagation()
            onRegionChange(null)
          }
          return
        default:
          return
      }
      e.preventDefault()
      e.stopPropagation()
      onSeek(Math.max(0, Math.min(1, next)))
    },
    [at, onSeek, onRegionChange, region],
  )

  const interactive = Boolean(onSeek && pcm)
  const spokenAt = seconds ? `${(at * seconds).toFixed(2)} of ${seconds.toFixed(2)} seconds` : ''

  return (
    <div className={`wave wave--${tone}`}>
      <div className="wave__head">
        <span className="wave__label">{label}</span>
        {tools}
        {/* The tempo sits apart from the rest of the metadata: it is the one
            number you are matching against, not another spec. */}
        {tempo ? <span className="wave__bpm">{tempo}</span> : null}
        <span className="wave__meta">{summary}</span>
      </div>
      <div
        className={`wave__canvas${interactive ? ' wave__canvas--seek' : ''}`}
        ref={wrapRef}
        // As a seek control it is a slider, not an image, so the position is
        // readable and movable without a pointer. Arrows step, page keys jump,
        // home and end go to the ends, enter plays from where you are.
        {...(interactive
          ? {
              role: 'slider' as const,
              tabIndex: 0,
              'aria-label': `${label} waveform, ${summary}. Playback position.`,
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': Math.round(at * 100),
              'aria-valuetext': spokenAt,
              onKeyDown,
              onPointerDown: (e: React.PointerEvent) => {
                // State first. Pointer capture is an optimisation, and it
                // throws if the pointer is already gone, so it must not be
                // able to stop the drag from starting.
                drag.current = { from: fractionAt(e.clientX), moved: false }
                try {
                  ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
                } catch {
                  // Capture unavailable. The window listeners still finish it.
                }
              },
              onPointerMove: (e: React.PointerEvent) => {
                const d = drag.current
                if (!d) return
                const now = fractionAt(e.clientX)
                // Below the threshold this is still a click, not a drag, so
                // a slightly shaky press seeks instead of selecting 3ms.
                if (!d.moved && Math.abs(now - d.from) < MIN_REGION) return
                d.moved = true
                onRegionChange?.(normaliseRegion({ start: d.from, end: now }))
              },
              onPointerUp: (e: React.PointerEvent) => {
                const d = drag.current
                drag.current = null
                if (!d) return
                if (d.moved) return
                // A press that never travelled: clear any selection and seek.
                onRegionChange?.(null)
                seekToClientX(e.clientX)
              },
              onPointerCancel: () => {
                drag.current = null
              },
            }
          : {})}
      >
        <canvas
          ref={canvasRef}
          {...(interactive
            ? { 'aria-hidden': true as const }
            : { role: 'img' as const, 'aria-label': `${label} waveform. ${summary}.` })}
        />
        {!pcm && placeholder ? (
          <span className="wave__placeholder">{placeholder}</span>
        ) : null}
      </div>
    </div>
  )
}
