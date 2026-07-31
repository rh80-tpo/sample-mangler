import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { Waveform } from './components/Waveform'
import { Playback } from './audio/playback'
import { durationOf, peakOf, pcmFrom, type Pcm } from './audio/buffers'
import { sniffSampleRate } from './audio/sniff'
import { decodeAudio, describeFailure } from './audio/decode'
import { rollChain } from './audio/chain'
import { renderChain } from './audio/render'
import { Rack } from './components/Rack'
import type { ChainSpec } from './audio/types'
import { freshSeed } from './audio/rng'
import { GENERATORS, generateSample, type GeneratorId } from './audio/generate'
import {
  BAR_CHOICES,
  NO_FIT,
  barLabel,
  describeLength,
  nearestBars,
  type FitMode,
  type FitSpec,
} from './audio/fit'
import {
  regionIsReal,
  regionSeconds,
  slicePcm,
  type Region,
} from './audio/slice'
import { Library } from './components/Library'
import { Wordmark } from './components/Wordmark'
import { addItem, createFolder, listFolders } from './lib/library'
import { encodeWav } from './audio/wav'
import './styles/app.css'

type Result = { pcm: Pcm; seed: number }

/** Renders in flight are coalesced, so a fast drag never queues up work. */
type RenderQueue = {
  running: boolean
  pending: ChainSpec | null
}

/**
 * Deliberately wide. A narrow accept list makes macOS grey the file out in the
 * open dialog, and a file you cannot even select gives you nothing to go on.
 * Better to take anything and say precisely why if it will not decode.
 */
const ACCEPT =
  'audio/*,.wav,.wave,.aif,.aiff,.aifc,.caf,.mp3,.flac,.m4a,.mp4,.aac,.ogg,.oga,.opus,.webm,.au,.snd'

/** Below this peak there is nothing to hear, so say so instead of pretending. */
const SILENCE_FLOOR = 1e-4

function fmtDuration(s: number): string {
  return `${s.toFixed(2)}s`
}

function summarise(pcm: Pcm | null): string {
  if (!pcm) return 'no signal'
  const ch = pcm.channels.length === 1 ? 'mono' : 'stereo'
  return `${fmtDuration(durationOf(pcm))} · ${ch} · ${(pcm.sampleRate / 1000).toFixed(1)}k`
}

/** Loop switch. One per panel, so each sound loops on its own terms. */
function LoopToggle({
  on,
  onToggle,
  label,
}: {
  on: boolean
  onToggle: () => void
  label: string
}) {
  return (
    <button
      type="button"
      className="loop"
      aria-pressed={on}
      onClick={onToggle}
      title="Loop"
    >
      <span aria-hidden="true">loop</span>
      <span className="sr-only">
        {on ? `Looping the ${label}. Turn off.` : `Loop the ${label}.`}
      </span>
    </button>
  )
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'sample'
}

export function App() {
  const reduceMotion = useReducedMotion()
  const playback = useMemo(() => new Playback(), [])
  const fileInput = useRef<HTMLInputElement>(null)

  const [source, setSource] = useState<Pcm | null>(null)
  const [fileName, setFileName] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [chain, setChain] = useState<ChainSpec | null>(null)
  const [edited, setEdited] = useState(false)
  const [tweaking, setTweaking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [reveal, setReveal] = useState(1)
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  /** Which panel the transport is pointed at. Clicking a panel repoints it. */
  const [target, setTarget] = useState<'source' | 'mangled'>('mangled')
  /**
   * Where playback will start from. Survives playback ending, so a seek is a
   * position you set rather than something that evaporates the moment the
   * sample runs out.
   */
  const [cursor, setCursor] = useState(0)
  // Loop is on by default: this is a tool for auditioning loops and chops, and
  // hearing one pass of a candidate tells you almost nothing about it.
  const [loop, setLoop] = useState(true)
  const [region, setRegion] = useState<Region | null>(null)
  const [fit, setFit] = useState<FitSpec>(NO_FIT)
  // Read through a ref so the render callbacks do not have to be rebuilt (and
  // the render queue reset) every time a length control moves.
  const fitRef = useRef(fit)
  fitRef.current = fit
  const [libOpen, setLibOpen] = useState(false)
  const [libRev, setLibRev] = useState(0)
  const [jolt, setJolt] = useState(0)
  const [announce, setAnnounce] = useState('')

  const rollCount = useRef(0)

  // --- playback ------------------------------------------------------
  useEffect(() => {
    playback.onEnded = () => {
      setPlaying(false)
      setPlayhead(null)
    }
    return () => playback.stop()
  }, [playback])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      setPlayhead(playback.progress())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, playback])

  // What the transport is actually pointed at right now.
  const current =
    target === 'source' ? source : (result?.pcm ?? source)

  /** A selection only applies to the panel it was drawn on. */
  const activeRegion = regionIsReal(region) ? region : null

  const togglePlay = useCallback(async () => {
    if (!current) return
    if (playback.playing) {
      playback.stop()
      setPlaying(false)
      setPlayhead(null)
      return
    }
    // Picks up from the cursor, so play after a seek starts where you put it.
    await playback.play(current, cursor, { loop, region: activeRegion })
    setPlaying(true)
  }, [current, playback, cursor, loop, activeRegion])

  /** Click or keyboard on a panel: point the transport there and play from it. */
  const seekTo = useCallback(
    async (which: 'source' | 'mangled', position: number) => {
      const pcm = which === 'source' ? source : result?.pcm
      if (!pcm) return
      const samePanel = which === target
      setTarget(which)
      setCursor(position)
      setPlayhead(position)
      await playback.play(pcm, position, {
        loop,
        region: samePanel ? activeRegion : null,
      })
      setPlaying(true)
    },
    [source, result, playback, target, loop, activeRegion],
  )

  /** Selecting a region restarts playback inside it, so you hear the edit. */
  const changeRegion = useCallback(
    (which: 'source' | 'mangled', next: Region | null) => {
      setTarget(which)
      setRegion(next)
      const pcm = which === 'source' ? source : result?.pcm
      if (!pcm) return
      const real = regionIsReal(next) ? next : null
      if (playback.playing || (real && loop)) {
        setCursor(real ? real.start : 0)
        void playback
          .play(pcm, real ? real.start : 0, { loop, region: real })
          .then(() => setPlaying(true))
      }
    },
    [source, result, playback, loop],
  )

  // Toggling loop takes effect immediately rather than at the next press.
  const toggleLoop = useCallback(() => {
    const next = !loop
    setLoop(next)
    if (playback.playing && current) {
      void playback.play(current, playback.progress() ?? cursor, {
        loop: next,
        region: activeRegion,
      })
    }
  }, [loop, playback, current, cursor, activeRegion])

  /** Shared by file loads and generated samples. */
  const adopt = useCallback(
    (pcm: Pcm, name: string) => {
      setSource(pcm)
      setFileName(name)
      setResult(null)
      setChain(null)
      setEdited(false)
      setTarget('mangled')
      setCursor(0)
      setRegion(null)
      // Snap to the nearest musical length so the first roll is already on the
      // grid and loopable, rather than an arbitrary tail you have to fix.
      const bars = nearestBars(durationOf(pcm))
      const nextFit: FitSpec = { bars, mode: 'trim' }
      setFit(nextFit)
      fitRef.current = nextFit
      rollCount.current = 0
      setAnnounce(
        `Loaded ${name}, ${fmtDuration(durationOf(pcm))}, snapped to ${bars} bars.`,
      )
    },
    [],
  )

  /** Clear everything and go back to the drop state. */
  const eject = useCallback(() => {
    playback.stop()
    setPlaying(false)
    setPlayhead(null)
    setSource(null)
    setFileName('')
    setResult(null)
    setChain(null)
    setEdited(false)
    setError('')
    setCursor(0)
    rollCount.current = 0
    setAnnounce('Cleared. Ready for a new sample.')
  }, [playback])

  // --- generated source material --------------------------------------
  const generate = useCallback(
    async (id: GeneratorId) => {
      setBusy(true)
      setError('')
      playback.stop()
      setPlaying(false)
      setPlayhead(null)
      try {
        // Yield so the pressed state paints before the synthesis blocks.
        await new Promise((r) => setTimeout(r, 0))
        const pcm = generateSample(id, playback.sampleRate(), freshSeed())
        adopt(pcm, `${id}.wav`)
      } catch (e) {
        setError(
          e instanceof Error ? `could not build that one. ${e.message}` : 'could not build that one.',
        )
      } finally {
        setBusy(false)
      }
    },
    [playback, adopt],
  )

  // --- loading -------------------------------------------------------
  const loadFile = useCallback(
    async (file: File) => {
      setError('')
      setBusy(true)
      playback.stop()
      setPlaying(false)
      setPlayhead(null)
      try {
        const bytes = await file.arrayBuffer()
        // Decode at the file's own rate when it declares one, so a 48k stem
        // stays 48k instead of being quietly converted to the hardware rate.
        const rate = sniffSampleRate(bytes)
        const pcm = await decodeAudio(bytes, (b) => playback.decode(b, rate))
        adopt(pcm, file.name)
        if (peakOf(pcm) < SILENCE_FLOOR) {
          setError('that file is silent. nothing to mangle.')
        }
      } catch (e) {
        setSource(null)
        setResult(null)
        // Say what actually went wrong. "Unsupported" and "empty" and
        // "compressed" are different problems with different fixes.
        setError(describeFailure(e))
      } finally {
        setBusy(false)
      }
    },
    [playback, adopt],
  )

  // --- the reveal ----------------------------------------------------
  // The sweep is a reveal, not a progress bar. The render itself finishes in
  // tens of milliseconds, so this never claims to be measuring anything.
  //
  // It is driven by rAF but does not depend on rAF: a backgrounded tab
  // throttles or suspends animation frames entirely, and without the timer
  // below the waveform would sit in its unresolved state indefinitely instead
  // of settling on the result. The timer is the guarantee; rAF is the polish.
  const REVEAL_MS = 420
  const revealRaf = useRef(0)
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const stopReveal = useCallback(() => {
    if (revealRaf.current) cancelAnimationFrame(revealRaf.current)
    if (revealTimer.current) clearTimeout(revealTimer.current)
    revealRaf.current = 0
    revealTimer.current = undefined
  }, [])

  const startReveal = useCallback(() => {
    stopReveal()
    if (reduceMotion) {
      setReveal(1)
      return
    }
    setReveal(0)
    const started = performance.now()
    const step = () => {
      const t = Math.min(1, (performance.now() - started) / REVEAL_MS)
      setReveal(t < 1 ? 1 - Math.pow(1 - t, 3) : 1)
      if (t < 1) revealRaf.current = requestAnimationFrame(step)
    }
    revealRaf.current = requestAnimationFrame(step)
    revealTimer.current = setTimeout(() => {
      stopReveal()
      setReveal(1)
    }, REVEAL_MS + 140)
  }, [reduceMotion, stopReveal])

  useEffect(() => stopReveal, [stopReveal])

  // --- live chain edits ----------------------------------------------
  // A knob drag fires many changes a second. Renders are fast, but they are
  // not free and they must not overlap, because each one swaps the global Tone
  // context while it runs. So: one render at a time, and only the newest
  // pending chain survives. Intermediate positions during a fast drag are
  // dropped, which is correct, nobody needs to hear a value they swept past.
  const queue = useRef<RenderQueue>({ running: false, pending: null })

  const runRender = useCallback(
    async (next: ChainSpec) => {
      if (!source) return
      if (queue.current.running) {
        queue.current.pending = next
        return
      }
      queue.current.running = true
      setTweaking(true)
      try {
        let target: ChainSpec | null = next
        while (target) {
          const { pcm } = await renderChain(source, target, fitRef.current)
          setResult({ pcm, seed: target.seed })
          target = queue.current.pending
          queue.current.pending = null
        }
      } catch (e) {
        setError(
          e instanceof Error ? `that edit fell over. ${e.message}` : 'that edit fell over.',
        )
      } finally {
        queue.current.running = false
        setTweaking(false)
      }
    },
    [source],
  )

  const onChainChange = useCallback(
    (next: ChainSpec) => {
      setChain(next)
      setEdited(true)
      setError('')
      void runRender(next)
    },
    [runRender],
  )

  /** Length changes re-render the same chain rather than rolling a new one. */
  const changeFit = useCallback(
    (next: FitSpec) => {
      setFit(next)
      fitRef.current = next
      // A different length invalidates any selection drawn on the old one.
      setRegion(null)
      setCursor(0)
      if (chain) {
        setEdited(true)
        void runRender(chain)
      }
    },
    [chain, runRender],
  )

  // When a control settles, pick playback back up where it was so a tweak can
  // be heard in place instead of stopping the transport.
  const resumeAfterEdit = useCallback(() => {
    if (!playback.playing) return
    const at = playback.progress() ?? 0
    resumeAt.current = at
  }, [playback])

  const resumeAt = useRef<number | null>(null)

  useEffect(() => {
    const at = resumeAt.current
    if (at == null || !result) return
    resumeAt.current = null
    void playback.play(result.pcm, at)
  }, [result, playback])

  // --- the roll ------------------------------------------------------
  const mangle = useCallback(async () => {
    if (!source || busy) return
    setBusy(true)
    setError('')
    playback.stop()
    setPlaying(false)
    setPlayhead(null)
    setJolt((j) => j + 1)

    try {
      // The offline render runs its clock synchronously, which is what makes
      // it fast, but it also means the main thread is blocked while it works.
      // Yield once so the busy state actually paints before that happens.
      // On a short sample this is imperceptible; on a long one it is the
      // difference between feedback and a dead-looking page.
      await new Promise((resolve) => setTimeout(resolve, 0))

      const seed = freshSeed()
      const rolled = rollChain(seed, durationOf(source))
      const { pcm } = await renderChain(source, rolled, fitRef.current)
      rollCount.current += 1
      setResult({ pcm, seed })
      setChain(rolled)
      setEdited(false)
      // A new roll is a different length, so a cursor from the last one no
      // longer points at anything meaningful.
      setCursor(0)
      setTarget('mangled')
      setAnnounce(
        `Roll ${rollCount.current}. ${fmtDuration(durationOf(pcm))} of mangled audio ready.`,
      )
      // A chain can gate or filter a sample down to nothing. Exporting that
      // silently would hand back a dead file with no explanation.
      if (peakOf(pcm) < SILENCE_FLOOR && peakOf(source) >= SILENCE_FLOOR) {
        setError('that chain ate the whole signal. reroll it.')
      }

      startReveal()
    } catch (e) {
      setError(
        e instanceof Error
          ? `that roll fell over. ${e.message}`
          : 'that roll fell over. try again.',
      )
    } finally {
      setBusy(false)
    }
  }, [source, busy, playback, startReveal])

  // --- export and save -------------------------------------------------
  /**
   * What export and save both operate on: the previewed buffer, cut down to
   * the selection when there is one. Still the same buffer that plays, so the
   * file keeps matching what was heard.
   */
  const outputPcm = useCallback((): Pcm | null => {
    if (!result) return null
    const useRegion = target === 'mangled' && activeRegion
    return useRegion ? slicePcm(result.pcm, activeRegion) : result.pcm
  }, [result, target, activeRegion])

  const outputName = useCallback((): string => {
    if (!result) return 'mangled'
    // The seed alone reproduces a rolled chain but not a hand-edited one, so
    // the name says which it is rather than implying it can be recreated.
    const stamp = edited ? `${result.seed.toString(36)}-edit` : result.seed.toString(36)
    const cut = target === 'mangled' && activeRegion ? '-cut' : ''
    return `${baseName(fileName)}-mangled-${stamp}${cut}`
  }, [result, fileName, edited, target, activeRegion])

  const exportWav = useCallback(() => {
    const pcm = outputPcm()
    if (!pcm) return
    const blob = encodeWav(pcm)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${outputName()}.wav`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    setAnnounce(`Exported ${a.download}.`)
  }, [outputPcm, outputName])

  /** Drop the current output into a folder, making one if none exists yet. */
  const saveToLibrary = useCallback(async () => {
    const pcm = outputPcm()
    if (!pcm) return
    const folders = await listFolders()
    const folder = folders[0] ?? (await createFolder('folder 1'))
    await addItem({
      folderId: folder.id,
      name: outputName(),
      blob: encodeWav(pcm),
      seconds: durationOf(pcm),
      sampleRate: pcm.sampleRate,
      channels: pcm.channels.length,
    })
    setLibRev((n) => n + 1)
    setLibOpen(true)
    setAnnounce(`Saved to ${folder.name}.`)
  }, [outputPcm, outputName])

  // --- drag and drop -------------------------------------------------
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer.files?.[0]
      if (file) void loadFile(file)
    },
    [loadFile],
  )

  // Keyboard: space plays, R rerolls. Skipped while a control has focus so it
  // never fights the button's own activation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el && el !== document.body && el.tagName !== 'MAIN') return
      if (e.code === 'Space' && current) {
        e.preventDefault()
        void togglePlay()
      } else if (e.key.toLowerCase() === 'r' && source && !busy) {
        e.preventDefault()
        void mangle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, source, busy, togglePlay, mangle])

  // --- the flinch ----------------------------------------------------
  // Driven through the Web Animations API rather than a remount or a toggled
  // class: re-keying the tree would tear down and reallocate both canvases on
  // every roll, which is the one thing that must stay cheap here.
  const shakeRef = useRef<HTMLDivElement>(null)
  const markRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (jolt === 0 || reduceMotion) return
    shakeRef.current?.animate(
      [
        { transform: 'translate3d(0,0,0)' },
        { transform: 'translate3d(-9px, 4px, 0)', offset: 0.11 },
        { transform: 'translate3d(6px, -3px, 0)', offset: 0.26 },
        { transform: 'translate3d(-3px, 1px, 0)', offset: 0.46 },
        { transform: 'translate3d(0,0,0)' },
      ],
      { duration: 300, easing: 'cubic-bezier(0.7, 0, 0.2, 1)' },
    )
    // The wordmark gets mangled too. Anybody carries a real width axis, so
    // this is the typeface compressing, not a scale transform faking it.
    markRef.current?.animate(
      [
        { fontVariationSettings: '"wdth" 100, "wght" 800' },
        { fontVariationSettings: '"wdth" 52, "wght" 900', offset: 0.22 },
        { fontVariationSettings: '"wdth" 128, "wght" 700', offset: 0.55 },
        { fontVariationSettings: '"wdth" 100, "wght" 800' },
      ],
      { duration: 560, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    )
  }, [jolt, reduceMotion])

  const hasResult = result !== null
  const stateClass = [
    'app',
    hasResult ? 'app--live' : '',
    dragging ? 'app--dragging' : '',
    // A visual-only cue while a re-render is in flight. Deliberately not fed
    // into the aria labels: a knob drag would otherwise spam a screen reader
    // with status changes many times a second.
    tweaking ? 'app--working' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <main
      className={stateClass}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <div className="app__shake" ref={shakeRef}>
        <header className="bar">
          <h1 className="mark" ref={markRef}>
            <span className="sr-only">HAZEN sample mangler</span>
            <Wordmark />
            <span aria-hidden="true">sample mangler</span>
          </h1>
          <p className="bar__meta">
            {fileName ? (
              <>
                <span className="bar__file">{fileName}</span>
                <span aria-hidden="true"> · </span>
                <span>{summarise(source)}</span>
                <button type="button" className="bar__eject" onClick={eject}>
                  new sample
                </button>
              </>
            ) : (
              'client side only · nothing uploads'
            )}
          </p>
        </header>

        <section className={`stage${source ? '' : ' stage--empty'}`}>
          {source ? (
            <>
              <Waveform
                pcm={source}
                tone="source"
                label="source"
                summary={summarise(source)}
                seconds={durationOf(source)}
                playhead={
                  target === 'source' ? (playing ? playhead : cursor) : null
                }
                active={playing && target === 'source'}
                onSeek={(p) => void seekTo('source', p)}
                region={target === 'source' ? activeRegion : null}
                onRegionChange={(r) => changeRegion('source', r)}
                tools={
                  <LoopToggle on={loop} onToggle={toggleLoop} label="source" />
                }
              />
              <Waveform
                pcm={result?.pcm ?? null}
                tone="mangled"
                label="mangled"
                summary={
                  result
                    ? `${summarise(result.pcm)} · roll ${rollCount.current}${edited ? ' · edited' : ''}`
                    : 'not yet'
                }
                reveal={reveal}
                seconds={result ? durationOf(result.pcm) : 0}
                playhead={
                  target === 'mangled' ? (playing ? playhead : cursor) : null
                }
                active={playing && target === 'mangled'}
                placeholder="hit mangle"
                nonce={result?.seed ?? 0}
                onSeek={result ? (p) => void seekTo('mangled', p) : undefined}
                region={target === 'mangled' ? activeRegion : null}
                onRegionChange={
                  result ? (r) => changeRegion('mangled', r) : undefined
                }
                tools={
                  result ? (
                    <LoopToggle on={loop} onToggle={toggleLoop} label="mangled" />
                  ) : null
                }
              />
            </>
          ) : (
            /* The idle state is the instrument with no signal in it, not a
               separate upload screen sitting in front of it. */
            /* The whole panel is the target, not just the small button. The
               button stays as the keyboard and screen-reader path. */
            <div
              className="drop"
              onClick={() => fileInput.current?.click()}
              role="presentation"
            >
              <Waveform
                pcm={null}
                tone="source"
                label="input"
                summary="waiting"
              />
              <div className="drop__inner">
                <p className="drop__head">drop a sample</p>
                <p className="drop__sub">
                  a loop and vocal chop machine. drop something in or build it
                  here, roll it, cut the bit you want, keep it. everything sits
                  at 120.
                </p>
                <div className="drop__acts">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => fileInput.current?.click()}
                  >
                    pick a file
                  </button>
                  <span className="drop__or">or build one</span>
                </div>
                {/* Stops the panel-wide click handler from opening the file
                    picker behind a generator press. */}
                <div
                  className="gens"
                  onClick={(e) => e.stopPropagation()}
                  role="group"
                  aria-label="Generate a sample"
                >
                  {GENERATORS.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className="gen"
                      disabled={busy}
                      onClick={() => void generate(g.id)}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        {chain ? (
          <>
            <Rack
              chain={chain}
              onChange={onChainChange}
              onCommit={resumeAfterEdit}
              busy={busy}
            />
            <section className="len" aria-label="Output length">
              <div className="len__head">
                <span className="len__title">length</span>
                <span className="len__now">
                  {result ? describeLength(durationOf(result.pcm)) : ''}
                  {activeRegion && result
                    ? ` · selection ${regionSeconds(activeRegion, durationOf(result.pcm)).toFixed(2)}s`
                    : ''}
                </span>
              </div>
              <div className="len__row">
                <div className="len__bars" role="group" aria-label="Target length in bars">
                  <button
                    type="button"
                    className="len__opt"
                    aria-pressed={fit.bars === null}
                    onClick={() => changeFit({ ...fit, bars: null })}
                  >
                    as is
                  </button>
                  {BAR_CHOICES.map((b) => (
                    <button
                      key={b}
                      type="button"
                      className="len__opt"
                      aria-pressed={fit.bars === b}
                      onClick={() => changeFit({ ...fit, bars: b })}
                    >
                      {barLabel(b)}
                      <span className="sr-only"> bars</span>
                    </button>
                  ))}
                </div>
                <div
                  className="len__modes"
                  role="group"
                  aria-label="How to change the length"
                >
                  {(
                    [
                      ['trim', 'cut or pad, sound untouched'],
                      ['stretch', 'resample, pitch moves with it'],
                      ['fit', 'time stretch, pitch held'],
                    ] as [FitMode, string][]
                  ).map(([m, hint]) => (
                    <button
                      key={m}
                      type="button"
                      className="len__opt"
                      aria-pressed={fit.mode === m}
                      disabled={fit.bars === null}
                      title={hint}
                      onClick={() => changeFit({ ...fit, mode: m })}
                    >
                      {m}
                      <span className="sr-only">. {hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            </section>
          </>
        ) : null}

        <footer className="controls">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={togglePlay}
            disabled={!current}
            aria-pressed={playing}
            aria-keyshortcuts="Space"
            title="Space"
          >
            {playing ? 'stop' : 'play'}
            <span className="sr-only">
              {hasResult ? ' the mangled result' : ' the source sample'}
            </span>
          </button>

          <button
            type="button"
            className="btn btn--slab"
            onClick={() => void mangle()}
            disabled={!source || busy}
            aria-keyshortcuts="R"
            title="R"
          >
            <span className="btn__slabtext">
              {busy ? 'mangling' : hasResult ? 'reroll' : 'mangle'}
            </span>
          </button>

          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void saveToLibrary()}
            disabled={!hasResult}
          >
            save
            <span className="sr-only">
              {activeRegion ? ' the selection to a folder' : ' to a folder'}
            </span>
          </button>

          <button
            type="button"
            className="btn btn--ghost"
            onClick={exportWav}
            disabled={!hasResult}
          >
            wav
            <span className="sr-only">
              {activeRegion ? ' — download the selection' : ' — download the result'}
            </span>
          </button>
        </footer>

        <Library
          open={libOpen}
          onToggle={() => setLibOpen((v) => !v)}
          revision={libRev}
          onNotice={(m) => setAnnounce(m)}
          onLoad={(item) => {
            void (async () => {
              const bytes = await item.blob.arrayBuffer()
              const decoded = await playback.decode(bytes, sniffSampleRate(bytes))
              adopt(pcmFrom(decoded), `${item.name}.wav`)
            })()
          }}
        />

        {error ? (
          <p className="notice" role="alert">
            {error}
          </p>
        ) : null}

        <p className="sr-only" role="status" aria-live="polite">
          {announce}
        </p>

        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void loadFile(f)
            e.target.value = ''
          }}
        />
      </div>
    </main>
  )
}
