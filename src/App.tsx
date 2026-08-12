import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { Waveform } from './components/Waveform'
import { Playback } from './audio/playback'
import {
  applyLevel,
  durationOf,
  levelGain,
  peakOf,
  pcmFrom,
  type Pcm,
} from './audio/buffers'
import { sniffSampleRate } from './audio/sniff'
import {
  WARN_SECONDS,
  checkDuration,
  checkFileSize,
  decodeAudio,
  describeFailure,
  describeFile,
} from './audio/decode'
import { rollChain } from './audio/chain'
import { renderChain } from './audio/render'
import { Rack } from './components/Rack'
import { Levels } from './components/Levels'
import { Sidechain } from './components/Sidechain'
import {
  DEFAULT_SIDECHAIN,
  applySidechain,
  duckGainAt,
  renderKick,
  type SidechainSpec,
} from './audio/sidechain'
import type { ChainSpec } from './audio/types'
import { freshSeed } from './audio/rng'
import { GENERATORS, generateSample, type GeneratorId } from './audio/generate'
import {
  BAR_CHOICES,
  BPM,
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
import { describeKey, detectKey } from './audio/key'
import { describeDetected, describeLoopTempo, detectTempo } from './audio/tempo'
import { Library } from './components/Library'
import { Wordmark } from './components/Wordmark'
import { addItem, countItems, createFolder, listFolders } from './lib/library'
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

/** `embedded` hides the wordmark, which the shell already renders. */
export function App({ embedded = false }: { embedded?: boolean } = {}) {
  const reduceMotion = useReducedMotion()
  const playback = useMemo(() => new Playback(), [])
  const fileInput = useRef<HTMLInputElement>(null)

  const [source, setSource] = useState<Pcm | null>(null)
  /**
   * The file as it decoded, kept so a trim is always reversible. `source` is
   * whatever is currently in play, which may be a crop of this.
   */
  const [fullSource, setFullSource] = useState<Pcm | null>(null)
  const [fileName, setFileName] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [chain, setChain] = useState<ChainSpec | null>(null)
  const [edited, setEdited] = useState(false)
  const [tweaking, setTweaking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  /** Raw header facts, shown only when a file fails to load. */
  const [detail, setDetail] = useState('')
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
  const [level, setLevel] = useState(0)
  const [monitor, setMonitor] = useState(1)
  const [sidechain, setSidechain] = useState<SidechainSpec>(DEFAULT_SIDECHAIN)
  const [kickAudible, setKickAudible] = useState(false)
  /**
   * One selection per panel. A selection on the source decides what actually
   * gets mangled, which is how you pull two bars of a vocal out of a five
   * minute track instead of processing the whole thing.
   */
  const [regions, setRegions] = useState<{
    source: Region | null
    mangled: Region | null
  }>({ source: null, mangled: null })
  /** What stage a file load is at, so a slow one does not look like nothing. */
  const [stage, setStage] = useState('')
  /** Detected key of each panel. Null when the material has no key to name. */
  const [keys, setKeys] = useState<{ source: string | null; mangled: string | null }>(
    { source: null, mangled: null },
  )
  /** Estimated pulse of the source. The result's tempo is exact, not guessed. */
  const [sourceTempo, setSourceTempo] = useState<string | null>(null)
  const [fit, setFit] = useState<FitSpec>(NO_FIT)
  // Read through a ref so the render callbacks do not have to be rebuilt (and
  // the render queue reset) every time a length control moves.
  const fitRef = useRef(fit)
  fitRef.current = fit
  const [libOpen, setLibOpen] = useState(false)
  /** Opened on load when the library already has something in it. */
  const openedOnce = useRef(false)
  const [libRev, setLibRev] = useState(0)
  /** Which folder SAVE drops into. */
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)
  const [activeFolderName, setActiveFolderName] = useState('')
  /** Short-lived visible confirmation, so an action never looks like nothing. */
  const [flash, setFlash] = useState('')
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

  /**
   * The roll with the level trim applied.
   *
   * Derived rather than stored, and the one value the player, the waveform, the
   * WAV and a save all read — so the trim cannot land in the file without also
   * being in what you just heard. A multiply over the finished buffer, so it is
   * cheap enough to follow a drag without re-rendering the chain.
   */
  const mangled = useMemo(
    () =>
      result ? applyLevel(applySidechain(result.pcm, sidechain, BPM), level) : null,
    [result, sidechain, level],
  )

  /**
   * Draw gain, so a duck or a trim redraws without re-reading the samples.
   * Same two stages in the same order as the audio above.
   */
  const gainAt = useCallback(
    (position: number) => {
      if (!result) return 1
      const seconds = position * durationOf(result.pcm)
      return levelGain(level) * duckGainAt(seconds, sidechain, BPM)
    },
    [result, level, sidechain],
  )

  /** The reference kick, rendered to match the output so looping stays locked. */
  const kick = useMemo(() => {
    if (!kickAudible || !result) return null
    return renderKick(
      result.pcm.sampleRate,
      durationOf(result.pcm),
      BPM,
      sidechain.rate,
    )
  }, [kickAudible, result, sidechain.rate])

  // Monitor is a live node parameter, so it applies to whatever is already
  // playing rather than waiting for the next press of play.
  useEffect(() => {
    playback.setMonitor(monitor)
  }, [monitor, playback])

  // What the transport is actually pointed at right now.
  const current =
    target === 'source' ? source : (mangled ?? source)

  /** A selection only applies to the panel it was drawn on. */
  const regionOf = useCallback(
    (which: 'source' | 'mangled') =>
      regionIsReal(regions[which]) ? regions[which] : null,
    [regions],
  )
  const sourceRegion = regionOf('source')
  const mangledRegion = regionOf('mangled')
  /** The selection on whichever panel the transport is pointed at. */
  const activeRegion = regionOf(target)

  const togglePlay = useCallback(async () => {
    if (!current) return
    if (playback.playing) {
      playback.stop()
      setPlaying(false)
      setPlayhead(null)
      return
    }
    // Picks up from the cursor, so play after a seek starts where you put it.
    await playback.play(current, cursor, { loop, region: activeRegion, kick })
    setPlaying(true)
  }, [current, playback, cursor, loop, activeRegion, kick])

  /** Click or keyboard on a panel: point the transport there and play from it. */
  const seekTo = useCallback(
    async (which: 'source' | 'mangled', position: number) => {
      const pcm = which === 'source' ? source : mangled
      if (!pcm) return
      setTarget(which)
      setCursor(position)
      setPlayhead(position)
      await playback.play(pcm, position, { loop, region: regionOf(which), kick })
      setPlaying(true)
    },
    [source, mangled, playback, loop, regionOf, kick],
  )

  /** Selecting a region restarts playback inside it, so you hear the edit. */
  const changeRegion = useCallback(
    (which: 'source' | 'mangled', next: Region | null) => {
      setTarget(which)
      setRegions((prev) => ({ ...prev, [which]: next }))
      const pcm = which === 'source' ? source : mangled
      if (!pcm) return

      // The output length is snapped against whatever is actually going in.
      // Selecting four seconds out of a fifteen minute track must not still be
      // aiming at the sixteen bars the whole file suggested.
      if (which === 'source') {
        const real = regionIsReal(next) ? next : null
        const seconds = real
          ? regionSeconds(real, durationOf(pcm))
          : durationOf(pcm)
        const bars = nearestBars(seconds)
        if (fitRef.current.bars !== null && fitRef.current.bars !== bars) {
          const nextFit: FitSpec = { ...fitRef.current, bars }
          setFit(nextFit)
          fitRef.current = nextFit
        }
      }
      const real = regionIsReal(next) ? next : null
      if (playback.playing || (real && loop)) {
        setCursor(real ? real.start : 0)
        void playback
          .play(pcm, real ? real.start : 0, { loop, region: real })
          .then(() => setPlaying(true))
      }
    },
    [source, mangled, playback, loop],
  )

  // Toggling loop takes effect immediately rather than at the next press.
  const toggleLoop = useCallback(() => {
    const next = !loop
    setLoop(next)
    if (playback.playing && current) {
      void playback.play(current, playback.progress() ?? cursor, {
        loop: next,
        region: activeRegion,
        kick,
      })
    }
  }, [loop, playback, current, cursor, activeRegion, kick])

  /** Shared by file loads and generated samples. */
  const adopt = useCallback(
    (pcm: Pcm, name: string) => {
      setSource(pcm)
      setFullSource(pcm)
      setFileName(name)
      setResult(null)
      setChain(null)
      setEdited(false)
      setTarget('mangled')
      setCursor(0)
      setRegions({ source: null, mangled: null })
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

  /**
   * Crop the source down to the selection, for good.
   *
   * The selection already limits what a roll processes, but the panel still
   * shows the whole file and every later selection is measured against it.
   * Committing the crop means the ends are gone: they cannot be mangled, they
   * do not stretch the waveform, and the bar snap is measured on what is left.
   */
  const trimSource = useCallback(() => {
    if (!source || !sourceRegion) return
    const cropped = slicePcm(source, sourceRegion)
    playback.stop()
    setPlaying(false)
    setPlayhead(null)
    setSource(cropped)
    setRegions({ source: null, mangled: null })
    setCursor(0)
    const bars = nearestBars(durationOf(cropped))
    const nextFit: FitSpec = { ...fitRef.current, bars }
    setFit(nextFit)
    fitRef.current = nextFit
    setAnnounce(`Trimmed to ${fmtDuration(durationOf(cropped))}.`)
  }, [source, sourceRegion, playback])

  /** Put the whole file back. A trim is never destructive to the upload. */
  const untrimSource = useCallback(() => {
    if (!fullSource) return
    playback.stop()
    setPlaying(false)
    setPlayhead(null)
    setSource(fullSource)
    setRegions({ source: null, mangled: null })
    setCursor(0)
    const bars = nearestBars(durationOf(fullSource))
    const nextFit: FitSpec = { ...fitRef.current, bars }
    setFit(nextFit)
    fitRef.current = nextFit
    setAnnounce(`Restored the full ${fmtDuration(durationOf(fullSource))}.`)
  }, [fullSource, playback])

  const trimmed =
    Boolean(source && fullSource && source.channels[0].length !== fullSource.channels[0].length)

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
      setDetail('')
      setBusy(true)
      playback.stop()
      setPlaying(false)
      setPlayhead(null)
      try {
        // Checked from File.size before anything is read, so an enormous file
        // is refused instead of pulling a gigabyte into memory first.
        const tooBig = checkFileSize(file.size)
        if (tooBig) throw tooBig

        // Reading a 70MB file off disk and decoding it both take real time.
        // Without saying so, a slow load is indistinguishable from a dead
        // page, which is what made large files feel like a failure.
        setStage(`reading ${(file.size / 1048576).toFixed(1)}MB`)
        await new Promise((r) => setTimeout(r, 0))
        const bytes = await file.arrayBuffer()

        setStage('decoding')
        await new Promise((r) => setTimeout(r, 0))
        // Decode at the file's own rate when it declares one, so a 48k stem
        // stays 48k instead of being quietly converted to the hardware rate.
        const rate = sniffSampleRate(bytes)
        const pcm = await decodeAudio(bytes, (b) => playback.decode(b, rate))

        const tooLong = checkDuration(durationOf(pcm))
        if (tooLong) throw tooLong

        adopt(pcm, file.name)
        const seconds = durationOf(pcm)
        if (peakOf(pcm) < SILENCE_FLOOR) {
          setError('that file is silent. nothing to mangle.')
        } else if (seconds > WARN_SECONDS) {
          // Not a failure, just honest: past this length every roll takes
          // seconds and the page will sit still while it works.
          setError(
            `${Math.round(seconds)}s loaded. anything this long takes a few seconds per roll.`,
          )
        }
      } catch (e) {
        setSource(null)
        setResult(null)
        // Say what actually went wrong. "Unsupported" and "empty" and
        // "compressed" are different problems with different fixes.
        setError(describeFailure(e))
        // And leave the raw facts on screen. When a file that plays fine
        // everywhere else will not load, the useful thing is the header and
        // the type the browser reported, not a friendlier sentence.
        setDetail(await describeFile(file))
      } finally {
        setStage('')
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

  /**
   * Exactly what the current result was rendered from. Live dial edits must
   * re-render the same input the roll used, not the whole source again.
   */
  const inputRef = useRef<Pcm | null>(null)

  const runRender = useCallback(
    async (next: ChainSpec) => {
      const source = inputRef.current
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
    [],
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
      // A different output length invalidates a selection drawn on the old
      // one. The source selection still stands: it decides the input.
      setRegions((prev) => ({ ...prev, mangled: null }))
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
    if (at == null || !mangled) return
    resumeAt.current = null
    void playback.play(mangled, at, { loop, region: mangledRegion, kick })
  }, [mangled, playback, loop, mangledRegion, kick])

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

      // A selection on the source is the input. Loading a whole track and
      // grabbing two bars of the vocal out of it is the point, and it also
      // means a long source never costs a long render.
      const input = sourceRegion ? slicePcm(source, sourceRegion) : source
      inputRef.current = input
      const seed = freshSeed()
      const rolled = rollChain(seed, durationOf(input))
      const { pcm } = await renderChain(input, rolled, fitRef.current)
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
  }, [source, busy, playback, startReveal, sourceRegion])

  // --- export and save -------------------------------------------------
  /**
   * What export and save both operate on: the previewed buffer, cut down to
   * the selection when there is one. Still the same buffer that plays, so the
   * file keeps matching what was heard.
   */
  /**
   * Save and export both work on whichever panel the transport is pointed at,
   * cut down to that panel's selection.
   *
   * Previously this was the mangled result only, so with a sample loaded but
   * not yet rolled the buttons sat disabled and silent. Pressing a dead button
   * with no explanation is indistinguishable from a broken one, and a trimmed
   * source is worth keeping in its own right.
   */
  const savingSource = target === 'source' || !result
  const outputPcm = useCallback((): Pcm | null => {
    if (savingSource) {
      if (!source) return null
      return sourceRegion ? slicePcm(source, sourceRegion) : source
    }
    if (!result) return null
    const out = applyLevel(result.pcm, level)
    return mangledRegion ? slicePcm(out, mangledRegion) : out
  }, [savingSource, source, sourceRegion, result, mangledRegion, level])

  const outputName = useCallback((): string => {
    if (savingSource) {
      const cut = sourceRegion || trimmed ? '-cut' : ''
      return `${baseName(fileName)}${cut}`
    }
    if (!result) return 'mangled'
    // The seed alone reproduces a rolled chain but not a hand-edited one, so
    // the name says which it is rather than implying it can be recreated.
    const stamp = edited ? `${result.seed.toString(36)}-edit` : result.seed.toString(36)
    const cut = mangledRegion ? '-cut' : ''
    return `${baseName(fileName)}-mangled-${stamp}${cut}`
  }, [savingSource, sourceRegion, trimmed, result, fileName, edited, mangledRegion])

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
    setFlash(`exported ${a.download}`)
  }, [outputPcm, outputName])

  /** Drop the current output into a folder, making one if none exists yet. */
  /**
   * Save the current output into a folder.
   *
   * `folderId` targets one directly. Without it, the save goes to whichever
   * folder is currently marked as the destination, and makes the first one if
   * the library is empty.
   */
  const saveToLibrary = useCallback(
    async (folderId?: string) => {
      const pcm = outputPcm()
      if (!pcm) return
      const folders = await listFolders()
      const wanted = folderId ?? activeFolderId
      const folder =
        folders.find((f) => f.id === wanted) ??
        folders[0] ??
        (await createFolder('folder 1'))
      await addItem({
        folderId: folder.id,
        name: outputName(),
        blob: encodeWav(pcm),
        seconds: durationOf(pcm),
        sampleRate: pcm.sampleRate,
        channels: pcm.channels.length,
      })
      setActiveFolderId(folder.id)
      setLibRev((n) => n + 1)
      setLibOpen(true)
      setAnnounce(`Saved to ${folder.name}.`)
      // Something has to visibly happen. The drawer sits at the bottom of a
      // tall page, so opening it was usually off screen and a save looked
      // exactly like a button that did nothing.
      setFlash(`saved ${outputName()} → ${folder.name}`)
      window.setTimeout(() => {
        document
          .querySelector('.lib')
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }, 60)
    },
    [outputPcm, outputName, activeFolderId],
  )

  // Clear the confirmation after a beat.
  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(''), 2600)
    return () => clearTimeout(id)
  }, [flash])

  // Anything already saved gets shown on arrival. A collapsed drawer meant
  // work from a previous session was invisible until you went looking.
  useEffect(() => {
    void (async () => {
      if (openedOnce.current) return
      openedOnce.current = true
      if ((await countItems()) > 0) setLibOpen(true)
    })()
  }, [])

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

  // --- key detection --------------------------------------------------
  // Run off the back of a render rather than inside it: the answer is useful
  // but never worth making a roll feel slower. Pitch shift is in the pool, so
  // the mangled key genuinely differs from the source and both are worth
  // knowing before dropping a chop into a track.
  useEffect(() => {
    let cancelled = false
    const pcm = sourceRegion && source ? slicePcm(source, sourceRegion) : source
    if (!pcm) {
      setKeys((k) => ({ ...k, source: null }))
      setSourceTempo(null)
      return
    }
    const id = setTimeout(() => {
      const found = describeKey(detectKey(pcm))
      const pulse = describeDetected(detectTempo(pcm))
      if (!cancelled) {
        setKeys((k) => ({ ...k, source: found }))
        setSourceTempo(pulse)
      }
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [source, sourceRegion])

  useEffect(() => {
    let cancelled = false
    if (!result) {
      setKeys((k) => ({ ...k, mangled: null }))
      return
    }
    const id = setTimeout(() => {
      const found = describeKey(detectKey(result.pcm))
      if (!cancelled) setKeys((k) => ({ ...k, mangled: found }))
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [result])

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
          {embedded ? (
            <span className="bar__spacer" ref={markRef} />
          ) : (
            <h1 className="mark" ref={markRef}>
              <span className="sr-only">HAZEN sample mangler</span>
              <Wordmark />
              <span aria-hidden="true">sample mangler</span>
            </h1>
          )}
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
                summary={`${summarise(source)}${keys.source ? ` · ${keys.source}` : ''}${sourceTempo ? ` · ${sourceTempo}` : ''}`}
                seconds={durationOf(source)}
                playhead={
                  target === 'source' ? (playing ? playhead : cursor) : null
                }
                active={playing && target === 'source'}
                onSeek={(p) => void seekTo('source', p)}
                region={sourceRegion}
                onRegionChange={(r) => changeRegion('source', r)}
                tools={
                  <>
                    <LoopToggle on={loop} onToggle={toggleLoop} label="source" />
                    {sourceRegion ? (
                      <>
                        <span className="wave__tag">
                          mangling {regionSeconds(sourceRegion, durationOf(source)).toFixed(2)}s
                        </span>
                        <button
                          type="button"
                          className="wave__btn"
                          onClick={trimSource}
                        >
                          trim to this
                        </button>
                      </>
                    ) : null}
                    {trimmed ? (
                      <button
                        type="button"
                        className="wave__btn"
                        onClick={untrimSource}
                      >
                        undo trim
                      </button>
                    ) : null}
                  </>
                }
              />
              <Waveform
                pcm={result?.pcm ?? null}
                gainAt={gainAt}
                tone="mangled"
                label="mangled"
                summary={
                  result
                    ? `${summarise(result.pcm)}${keys.mangled ? ` · ${keys.mangled}` : ''} · roll ${rollCount.current}${edited ? ' · edited' : ''}`
                    : 'not yet'
                }
                tempo={
                  result
                    ? describeLoopTempo(durationOf(result.pcm), fit.bars)
                    : null
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
                region={mangledRegion}
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
                {stage ? (
                  <p className="drop__stage" role="status">
                    <span className="drop__spin" aria-hidden="true" />
                    {stage}…
                  </p>
                ) : null}
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
              seconds={
                inputRef.current ? durationOf(inputRef.current) : 2
              }
            />
            <Sidechain
              spec={sidechain}
              kickAudible={kickAudible}
              bpm={BPM}
              disabled={busy}
              onChange={setSidechain}
              onKickAudible={setKickAudible}
              onCommit={resumeAfterEdit}
            />
            <Levels
              level={level}
              monitor={monitor}
              disabled={busy}
              onLevel={setLevel}
              onMonitor={setMonitor}
            />
            <section className="len" aria-label="Output length">
              <div className="len__head">
                <span className="len__title">length</span>
                <span className="len__now">
                  {result ? describeLength(durationOf(result.pcm)) : ''}
                  {mangledRegion && result
                    ? ` · exporting ${regionSeconds(mangledRegion, durationOf(result.pcm)).toFixed(2)}s`
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
            disabled={!current}
            title={
              current
                ? `Save the ${savingSource ? 'source' : 'mangled result'} to ${activeFolderName || 'a new folder'}`
                : 'Load or build a sample first'
            }
          >
            {/* Naming the destination means you never have to guess where a
                save landed, or open the drawer to find out. */}
            save{activeFolderName ? ` → ${activeFolderName}` : ''}
            <span className="sr-only">
              {' the '}
              {savingSource ? 'source' : 'mangled result'}
              {(savingSource ? sourceRegion : mangledRegion) ? ' selection' : ''}
              {activeFolderName ? '' : ' to a new folder'}
            </span>
          </button>

          <button
            type="button"
            className="btn btn--ghost"
            onClick={exportWav}
            disabled={!current}
            title={
              current
                ? `Download the ${savingSource ? 'source' : 'mangled result'} as a wav`
                : 'Load or build a sample first'
            }
          >
            wav
            <span className="sr-only">
              {' — download the '}
              {savingSource ? 'source' : 'mangled result'}
              {(savingSource ? sourceRegion : mangledRegion) ? ' selection' : ''}
            </span>
          </button>
        </footer>

        <Library
          open={libOpen}
          onToggle={() => setLibOpen((v) => !v)}
          revision={libRev}
          activeId={activeFolderId}
          onPickActive={(id, name) => {
            setActiveFolderId(id)
            setActiveFolderName(name)
          }}
          onSaveTo={(id) => void saveToLibrary(id)}
          canSave={hasResult}
          onNotice={(m) => setAnnounce(m)}
          onLoad={(item) => {
            void (async () => {
              const bytes = await item.blob.arrayBuffer()
              const decoded = await playback.decode(bytes, sniffSampleRate(bytes))
              adopt(pcmFrom(decoded), `${item.name}.wav`)
            })()
          }}
        />

        {flash ? (
          <p className="flash" role="status">
            <span className="flash__tick" aria-hidden="true">
              ✓
            </span>
            {flash}
          </p>
        ) : null}

        {error ? (
          <div className="notice" role="alert">
            <p className="notice__msg">{error}</p>
            {detail ? <p className="notice__detail">{detail}</p> : null}
          </div>
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
