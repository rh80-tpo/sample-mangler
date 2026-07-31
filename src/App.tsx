import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { Waveform } from './components/Waveform'
import { Playback } from './audio/playback'
import { durationOf, pcmFrom, type Pcm } from './audio/buffers'
import { rollChain } from './audio/chain'
import { renderChain } from './audio/render'
import { freshSeed } from './audio/rng'
import { encodeWav } from './audio/wav'
import './styles/app.css'

type Result = { pcm: Pcm; seed: number }

const ACCEPT = 'audio/*,.wav,.mp3,.aiff,.aif,.flac,.ogg,.m4a'

function fmtDuration(s: number): string {
  return `${s.toFixed(2)}s`
}

function summarise(pcm: Pcm | null): string {
  if (!pcm) return 'no signal'
  const ch = pcm.channels.length === 1 ? 'mono' : 'stereo'
  return `${fmtDuration(durationOf(pcm))} · ${ch} · ${(pcm.sampleRate / 1000).toFixed(1)}k`
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
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [reveal, setReveal] = useState(1)
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
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

  const current = result?.pcm ?? source

  const togglePlay = useCallback(async () => {
    if (!current) return
    if (playback.playing) {
      playback.stop()
      setPlaying(false)
      setPlayhead(null)
      return
    }
    await playback.play(current)
    setPlaying(true)
  }, [current, playback])

  // --- loading -------------------------------------------------------
  const loadFile = useCallback(
    async (file: File) => {
      setError('')
      setBusy(true)
      playback.stop()
      setPlaying(false)
      setPlayhead(null)
      try {
        const decoded = await playback.decode(await file.arrayBuffer())
        const pcm = pcmFrom(decoded)
        setSource(pcm)
        setFileName(file.name)
        setResult(null)
        rollCount.current = 0
        setAnnounce(`Loaded ${file.name}, ${fmtDuration(durationOf(pcm))}.`)
      } catch {
        setSource(null)
        setResult(null)
        setError('could not read that one. try a wav, mp3, aiff, or flac.')
      } finally {
        setBusy(false)
      }
    },
    [playback],
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
      const seed = freshSeed()
      const chain = rollChain(seed, durationOf(source))
      const { pcm } = await renderChain(source, chain)
      rollCount.current += 1
      setResult({ pcm, seed })
      setAnnounce(
        `Roll ${rollCount.current}. ${fmtDuration(durationOf(pcm))} of mangled audio ready.`,
      )

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

  // --- export --------------------------------------------------------
  const exportWav = useCallback(() => {
    if (!result) return
    // Encodes the same Pcm the preview plays. There is no second render.
    const blob = encodeWav(result.pcm)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${baseName(fileName)}-mangled-${result.seed.toString(36)}.wav`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    setAnnounce(`Exported ${a.download}.`)
  }, [result, fileName])

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
            sample mangler
          </h1>
          <p className="bar__meta">
            {fileName ? (
              <>
                <span className="bar__file">{fileName}</span>
                <span aria-hidden="true"> · </span>
                <span>{summarise(source)}</span>
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
                playhead={playing && !hasResult ? playhead : null}
              />
              <Waveform
                pcm={result?.pcm ?? null}
                tone="mangled"
                label="mangled"
                summary={
                  result
                    ? `${summarise(result.pcm)} · roll ${rollCount.current}`
                    : 'not yet'
                }
                reveal={reveal}
                playhead={playing && hasResult ? playhead : null}
                placeholder="hit mangle"
                nonce={result?.seed ?? 0}
              />
            </>
          ) : (
            /* The idle state is the instrument with no signal in it, not a
               separate upload screen sitting in front of it. */
            <div className="drop">
              <Waveform
                pcm={null}
                tone="source"
                label="input"
                summary="waiting"
              />
              <div className="drop__inner">
                <p className="drop__head">drop a sample</p>
                <p className="drop__sub">
                  wav, mp3, aiff, flac. built for stems, one shots and loops
                  under 30 seconds.
                </p>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => fileInput.current?.click()}
                >
                  or pick a file
                </button>
              </div>
            </div>
          )}
        </section>

        <footer className="controls">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={togglePlay}
            disabled={!current}
            aria-pressed={playing}
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
          >
            <span className="btn__slabtext">
              {busy ? 'mangling' : hasResult ? 'reroll' : 'mangle'}
            </span>
          </button>

          <button
            type="button"
            className="btn btn--ghost"
            onClick={exportWav}
            disabled={!hasResult}
          >
            wav
            <span className="sr-only"> — download the current result</span>
          </button>
        </footer>

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
