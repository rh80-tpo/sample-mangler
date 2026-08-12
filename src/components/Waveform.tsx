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
  /** Phrase boundaries to mark, as bar index plus letter. */
  sections?: { bar: number; letter: string }[]
  /** Seconds per bar, needed to place the section marks. */
  barSeconds?: number
  /**
   * Draw gain at a position through the buffer, 0 to 1 in, amplitude out.
   *
   * Everything applied after the render — the level trim and the sidechain duck
   * — comes in here rather than as a modified buffer. Peaks are cached against
   * buffer identity, so handing this panel a freshly multiplied copy on every
   * step of a drag would recompute the envelope over every sample, 16 million of
   * them on a three minute file. Evaluating a function per column is the same
   * picture for a few hundred calls.
   */
  gainAt?: (position: number) => number
  /**
   * Voices to colour individually, as fractions of the whole.
   *
   * Same `slice` gets the same tint wherever it lands, so a repeated phrase
   * repeats its colours and you can see the arrangement instead of squinting at
   * an envelope. The palette stays inside a warm band around the signal colour
   * rather than going full rainbow, because the point is to tell chops apart,
   * not to redecorate.
   */
  voices?: { start: number; end: number; slice: number }[]
}

/** Column pitch in device pixels: a 2px stroke with a 1px gap. */
/**
 * Tints for telling one chop from the next.
 *
 * Four, not six, and separated by *lightness* rather than by hue. The first
 * version of this varied hue across a warm band at roughly constant lightness,
 * which looked good and failed the job: simulated against deuteranopia, two of
 * the six tints came out 0.003 apart in luminance — the same colour. Ordering
 * them by lightness instead gives 0.163 separation in normal vision and holds
 * up in greyscale, and four well-spaced tints tell neighbours apart better than
 * six that blur together.
 *
 * Colour is still only the enhancement here. The boundary ticks below carry the
 * same information without relying on colour vision at all, because for
 * protanopia even this ladder converges at the pale end.
 */
const CHOP_TINTS = [
  'hsl(8 90% 34%)',
  'hsl(22 86% 50%)',
  'hsl(36 84% 66%)',
  'hsl(48 82% 82%)',
]

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
  sections,
  barSeconds,
  gainAt,
  voices,
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
    // One tint per column, resolved once. -1 means no voice owns this column,
    // which is silence between chops and stays the plain body colour.
    let tint: Int16Array | null = null
    if (voices && voices.length) {
      tint = new Int16Array(n).fill(-1)
      for (const v of voices) {
        const a = Math.max(0, Math.floor(v.start * n))
        const b = Math.min(n, Math.ceil(v.end * n))
        for (let i = a; i < b; i++) tint[i] = v.slice % CHOP_TINTS.length
      }
    }

    // The played/unplayed split only means anything while audio is running.
    // Idle, the cursor is just a start marker and the whole waveform stays lit.
    const playIndex = !active || playhead == null ? n : Math.floor(playhead * n)
    const frame = Math.floor(reveal * 1000) + nonce

    // Envelope. Split into played and unplayed so the playhead reads without
    // needing a separate overlay pass.
    const drawEnvelope = (from: number, to: number, alpha: number) => {
      if (to <= from) return
      ctx.lineWidth = 2 * dpr

      // One path per colour rather than one per column: a stroke call per
      // column would be hundreds of them every frame.
      const passes = tint ? CHOP_TINTS.length + 1 : 1
      for (let pass = 0; pass < passes; pass++) {
        const want = pass - 1
        ctx.globalAlpha = alpha
        ctx.strokeStyle = tint && want >= 0 ? CHOP_TINTS[want] : body
        ctx.beginPath()
        let drew = false
        for (let i = from; i < to; i++) {
          if (tint && tint[i] !== want) continue
          const x = i * COL + dpr
          const g = gainAt ? gainAt(i / n) : 1
          const top = mid - peaks.max[i] * half * g
          const bot = mid - peaks.min[i] * half * g
          ctx.moveTo(x, top)
          ctx.lineTo(x, Math.max(bot, top + dpr))
          drew = true
        }
        if (drew) ctx.stroke()
      }

      // Density core: the rms band inside the envelope.
      ctx.strokeStyle = core
      ctx.globalAlpha = alpha * (tone === 'mangled' ? 0.55 : 0.4)
      ctx.beginPath()
      for (let i = from; i < to; i++) {
        const x = i * COL + dpr
        const r = peaks.rms[i] * half * (gainAt ? gainAt(i / n) : 1)
        if (r < dpr) continue
        ctx.moveTo(x, mid - r)
        ctx.lineTo(x, mid + r)
      }
      ctx.stroke()
    }

    const resolved = Math.min(headIndex, n)
    drawEnvelope(0, Math.min(playIndex, resolved), 1)
    drawEnvelope(Math.min(playIndex, resolved), resolved, 0.42)

    // Where each chop starts, marked without colour.
    //
    // The tints alone cannot carry this: even ordered by lightness they
    // converge at the pale end under protanopia, and a producer who cannot
    // separate them loses the one thing the colour was added to show. A tick is
    // legible to everyone, so the colour is decoration and this is the data.
    if (voices && voices.length) {
      ctx.globalAlpha = 0.9
      ctx.strokeStyle = tone === 'mangled' ? v('--ink') : v('--ink-dim')
      ctx.lineWidth = dpr
      ctx.beginPath()
      const tick = Math.max(4 * dpr, H * 0.09)
      for (const voice of voices) {
        const x = Math.round(voice.start * n) * COL + dpr
        if (x < 0 || x > W) continue
        ctx.moveTo(x, 0)
        ctx.lineTo(x, tick)
        ctx.moveTo(x, H - tick)
        ctx.lineTo(x, H)
      }
      ctx.stroke()
      ctx.globalAlpha = 1
    }

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

    // Phrase boundaries. Marking where A ends and B begins is what makes an
    // arrangement pattern legible rather than something you have to count.
    if (sections && sections.length && barSeconds && pcm) {
      const totalSeconds = pcm.channels[0].length / pcm.sampleRate
      ctx.globalAlpha = 1
      for (const s of sections) {
        const x = Math.floor(((s.bar * barSeconds) / totalSeconds) * W)
        if (x <= 0 || x >= W) {
          // Still label the first phrase even though it has no divider.
          if (x <= 0) {
            ctx.fillStyle = v('--ink')
            ctx.font = `${11 * dpr}px ui-monospace, monospace`
            ctx.fillText(s.letter, 4 * dpr, 13 * dpr)
          }
          continue
        }
        ctx.fillStyle = v('--hairline-strong')
        ctx.fillRect(x, 0, dpr, H)
        ctx.fillStyle = v('--ink')
        ctx.font = `${11 * dpr}px ui-monospace, monospace`
        ctx.fillText(s.letter, x + 4 * dpr, 13 * dpr)
      }
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
  }, [size, pcm, tone, reveal, playhead, active, nonce, region, sections, barSeconds, gainAt, voices])

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
