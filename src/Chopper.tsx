import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Waveform } from './components/Waveform'
import { Playback } from './audio/playback'
import {
  applyLevel,
  durationOf,
  levelGain,
  peakOf,
  type Pcm,
} from './audio/buffers'
import { sniffSampleRate } from './audio/sniff'
import {
  checkDuration,
  checkFileSize,
  decodeAudio,
  describeFailure,
  describeFile,
  describeSilent,
} from './audio/decode'
import { freshSeed } from './audio/rng'
import { rollChain } from './audio/chain'
import { encodeWav } from './audio/wav'
import {
  DEFAULT_CHOP,
  PATTERNS,
  QUANTIZE_CHOICES,
  buildChop,
  stitchPhrases,
  type ChopResult,
  type Pattern,
  type Quantize,
} from './audio/chopper'
import { describeKey, detectKey } from './audio/key'
import { describeDetected, detectTempo } from './audio/tempo'
import { renderChain } from './audio/render'
import { NO_FIT } from './audio/fit'
import type { ChainSpec } from './audio/types'
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
import { addItem, createFolder, listFolders } from './lib/library'

const ACCEPT =
  'audio/*,video/*,.wav,.wave,.aif,.aiff,.aifc,.caf,.mp3,.flac,.m4a,.mp4,.m4v,.mov,.aac,.3gp,.ogg,.oga,.opus,.webm,.au,.snd'

/** Tempos worth one tap. Anything else goes in the number field. */
const QUICK_BPM = [90, 100, 110, 120, 128, 140, 150, 174]

function fmt(s: number) {
  return `${s.toFixed(2)}s`
}

export function Chopper() {
  const playback = useMemo(() => new Playback(), [])
  const fileInput = useRef<HTMLInputElement>(null)

  const [source, setSource] = useState<Pcm | null>(null)
  const [fileName, setFileName] = useState('')
  const [result, setResult] = useState<ChopResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [detail, setDetail] = useState('')
  const [flash, setFlash] = useState('')
  const [dragging, setDragging] = useState(false)

  const [bpm, setBpm] = useState(DEFAULT_CHOP.bpm)
  const [pattern, setPattern] = useState<Pattern>(DEFAULT_CHOP.pattern)
  const [density, setDensity] = useState(DEFAULT_CHOP.density)
  const [variation, setVariation] = useState(DEFAULT_CHOP.variation)
  const [resolution, setResolution] = useState<8 | 16>(DEFAULT_CHOP.resolution)
  const [inOrder, setInOrder] = useState(DEFAULT_CHOP.inOrder)
  const [phraseBars, setPhraseBars] = useState<1 | 2 | 4>(DEFAULT_CHOP.phraseBars)
  const [hold, setHold] = useState(DEFAULT_CHOP.hold)
  const [quantize, setQuantize] = useState<Quantize>(DEFAULT_CHOP.quantize)
  /** Master switch for the rack. Off means the chop plays dry. */
  const [rackOn, setRackOn] = useState(true)

  /** Effects applied to the finished chop. Null until one is added. */
  const [chain, setChain] = useState<ChainSpec | null>(null)
  /** The chop with the rack applied, which is what plays and exports. */
  const [processed, setProcessed] = useState<Pcm | null>(null)
  const [cursor, setCursor] = useState(0)
  const [target, setTarget] = useState<'vocal' | 'chop'>('chop')

  const [playing, setPlaying] = useState(false)
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [loop, setLoop] = useState(true)
  const [level, setLevel] = useState(0)
  const [monitor, setMonitor] = useState(1)
  const [sidechain, setSidechain] = useState<SidechainSpec>(DEFAULT_SIDECHAIN)
  const [kickAudible, setKickAudible] = useState(false)
  const [sourceInfo, setSourceInfo] = useState<string>('')

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

  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(''), 2600)
    return () => clearTimeout(id)
  }, [flash])

  // Monitor is a live node parameter, so it applies to whatever is already
  // playing rather than waiting for the next press of play.
  useEffect(() => {
    playback.setMonitor(monitor)
  }, [monitor, playback])

  // Key and tempo of the upload, so the suggested bpm is not a blind guess.
  useEffect(() => {
    if (!source) {
      setSourceInfo('')
      return
    }
    let cancelled = false
    const id = setTimeout(() => {
      const k = describeKey(detectKey(source))
      const t = detectTempo(source)
      if (cancelled) return
      setSourceInfo([k, describeDetected(t)].filter(Boolean).join(' · '))
      // Only nudge the tempo when the estimate is confident. A wrong auto-set
      // is worse than none, because it looks deliberate.
      //
      // Of the detected pulse and its octaves, take whichever sits closest to
      // where chops are actually built. A confident 75 usually means 150, and
      // half time turns a 16 bar loop into nearly a minute of audio.
      if (t && t.confidence > 0.5) {
        const options = [t.bpm, ...t.alternates]
        const best = options.reduce((a, b) =>
          Math.abs(b - 125) < Math.abs(a - 125) ? b : a,
        )
        setBpm(Math.round(best))
      }
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [source])

  const loadFile = useCallback(
    async (file: File) => {
      setError('')
      setDetail('')
      setBusy(true)
      playback.stop()
      setPlaying(false)
      setPlayhead(null)
      try {
        const tooBig = checkFileSize(file.size)
        if (tooBig) throw tooBig
        setStage(`reading ${(file.size / 1048576).toFixed(1)}MB`)
        await new Promise((r) => setTimeout(r, 0))
        const bytes = await file.arrayBuffer()
        setStage('decoding')
        await new Promise((r) => setTimeout(r, 0))
        const rate = sniffSampleRate(bytes)
        const pcm = await decodeAudio(bytes, (b) => playback.decode(b, rate))
        const tooLong = checkDuration(durationOf(pcm))
        if (tooLong) throw tooLong
        setSource(pcm)
        setFileName(file.name)
        setResult(null)
        if (peakOf(pcm) < 1e-4) setError(describeSilent(file.name))
      } catch (e) {
        setSource(null)
        setResult(null)
        setError(describeFailure(e))
        setDetail(await describeFile(file))
      } finally {
        setStage('')
        setBusy(false)
      }
    },
    [playback],
  )

  // --- the rack --------------------------------------------------------
  // Effects are applied to the finished chop rather than the vocal, so the
  // arrangement stays intact and the chain colours the whole loop.
  const queue = useRef<{ running: boolean; pending: ChainSpec | null }>({
    running: false,
    pending: null,
  })

  const runChain = useCallback(
    async (next: ChainSpec | null, from?: ChopResult) => {
      const built = from ?? result
      if (!built) return
      if (!next || next.effects.length === 0 || !rackOn) {
        setProcessed(null)
        return
      }
      if (queue.current.running) {
        queue.current.pending = next
        return
      }
      queue.current.running = true
      try {
        let target: ChainSpec | null = next
        while (target) {
          // Per phrase, not over the whole loop.
          //
          // Running the rack across all 16 bars reorders and smears material
          // across phrase boundaries, and the arrangement is gone: a dry AAAB
          // measured as ABCD with a chop, a reverb or a pitch shift in the
          // chain. Treating each distinct phrase and then restitching keeps
          // every repeat of a letter identical by construction, so the pattern
          // survives whatever the effects do.
          const frames = built.phrases[built.order[0]].channels[0].length
          const treated: Record<string, Pcm> = {}
          for (const letter of Object.keys(built.phrases)) {
            const { pcm } = await renderChain(built.phrases[letter], target, NO_FIT)
            treated[letter] = pcm
          }
          setProcessed(stitchPhrases(treated, built.order, frames))
          target = queue.current.pending
          queue.current.pending = null
        }
      } catch (e) {
        setError(e instanceof Error ? `that effect fell over. ${e.message}` : 'that effect fell over.')
      } finally {
        queue.current.running = false
      }
    },
    [result, rackOn],
  )

  /**
   * Build the loop. Optionally roll a random rack over it in the same press.
   *
   * `rollRack` is what makes the second button worth having. The mangler's
   * reroll is the fastest way it has to find something, and the chopper had no
   * equivalent: you could rechop the rhythm, or tweak the rack by hand, but not
   * gamble on both at once. The rolled chain is applied to the loop that was
   * just built rather than to the one in state, because state has not committed
   * yet inside this callback.
   */
  const runChop = useCallback(
    async (rollRack: boolean) => {
      if (!source || busy) return
      setBusy(true)
      setError('')
      playback.stop()
      setPlaying(false)
      setPlayhead(null)
      try {
        await new Promise((r) => setTimeout(r, 0))
        const built = buildChop(source, {
          bpm,
          pattern,
          density,
          variation,
          resolution,
          inOrder,
          phraseBars,
          hold,
          quantize,
          seed: freshSeed(),
        })
        setResult(built)
        setCursor(0)
        if (built.slices < 2) {
          setError(
            'only found one transient. try a more percussive vocal, or one with clearer consonants.',
          )
        }
        if (rollRack) {
          const rolled = rollChain(freshSeed(), durationOf(built.pcm))
          setChain(rolled)
          await runChain(rolled, built)
        }
      } catch (e) {
        setError(e instanceof Error ? `chop failed. ${e.message}` : 'chop failed.')
      } finally {
        setBusy(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, busy, playback, bpm, pattern, density, variation, resolution, inOrder, phraseBars, hold, quantize, runChain],
  )

  const chop = useCallback(() => runChop(false), [runChop])
  const chopAndRoll = useCallback(() => runChop(true), [runChop])


  // A fresh chop invalidates whatever the rack had produced.
  useEffect(() => {
    if (!result) {
      setProcessed(null)
      return
    }
    void runChain(chain)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  const onChainChange = useCallback(
    (next: ChainSpec) => {
      setChain(next.effects.length ? next : null)
      void runChain(next.effects.length ? next : null)
    },
    [runChain],
  )

  // When a control settles, pick playback back up where it was rather than
  // leaving the transport stopped mid-tweak.
  const resumeAfterEdit = useCallback(() => {
    if (!playback.playing) return
    resumeAt.current = playback.progress() ?? 0
  }, [playback])
  const resumeAt = useRef<number | null>(null)

  /**
   * What plays and exports: the chop through the rack, then the level trim.
   *
   * One value for both, so the trim cannot drift between what you hear and what
   * lands in the file. It is a multiply over the finished buffer, not a
   * re-render, so the knob keeps up with a drag.
   */
  const rendered = processed ?? result?.pcm ?? null
  const output = useMemo(
    () =>
      rendered ? applyLevel(applySidechain(rendered, sidechain, bpm), level) : null,
    [rendered, sidechain, bpm, level],
  )

  /** Draw gain, so a duck or a trim redraws without re-reading the samples. */
  const gainAt = useCallback(
    (position: number) => {
      if (!rendered) return 1
      const seconds = position * durationOf(rendered)
      return levelGain(level) * duckGainAt(seconds, sidechain, bpm)
    },
    [rendered, level, sidechain, bpm],
  )

  /**
   * The reference kick. Built at the chop's own tempo, which is the tempo the
   * loop was cut to, so the duck lands where the grid says it should.
   */
  const kick = useMemo(() => {
    if (!kickAudible || !rendered) return null
    return renderKick(rendered.sampleRate, durationOf(rendered), bpm, sidechain.rate)
  }, [kickAudible, rendered, bpm, sidechain.rate])

  // Consume what resumeAfterEdit parked. Keyed on the finished output, so a duck
  // or a trim is picked up even though the chop itself did not change. Without
  // this the commit callback sets a ref nobody reads.
  useEffect(() => {
    const at = resumeAt.current
    if (at == null || !output) return
    resumeAt.current = null
    void playback.play(output, at, { loop, kick })
  }, [output, playback, loop, kick])

  // The master switch has to reach the audio, not just grey the modules out.
  useEffect(() => {
    if (!rackOn) setProcessed(null)
    else if (chain) void runChain(chain)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rackOn])

  // Rebuild when a control moves, but only once something exists.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (!result) return
    void chop()
    // Deliberately not depending on chop: it changes identity with every
    // control, and this should fire on the controls, not on the callback.
    // Every control that feeds buildChop has to be listed here, or moving it
    // updates the label and changes nothing, which is how phraseBars and hold
    // silently did nothing on first pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bpm, pattern, density, variation, resolution, inOrder, phraseBars, hold, quantize])

  const current = target === 'vocal' ? source : (output ?? source)

  const togglePlay = useCallback(async () => {
    if (!current) return
    if (playback.playing) {
      playback.stop()
      setPlaying(false)
      setPlayhead(null)
      return
    }
    await playback.play(current, cursor, { loop, kick })
    setPlaying(true)
    // `kick` belongs here. Without it this callback keeps the reference kick it
    // closed over on first render, which is null, and the toggle silently does
    // nothing — the same stale-closure trap phraseBars fell into.
  }, [current, playback, loop, cursor, kick])

  /** Click anywhere on a panel to play that panel from that point. */
  const seekTo = useCallback(
    async (which: 'vocal' | 'chop', position: number) => {
      const pcm = which === 'vocal' ? source : output
      if (!pcm) return
      setTarget(which)
      setCursor(position)
      setPlayhead(position)
      await playback.play(pcm, position, { loop, kick })
      setPlaying(true)
    },
    [source, output, playback, loop, kick],
  )

  const exportWav = useCallback(() => {
    if (!output) return
    const blob = encodeWav(output)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileName.replace(/\.[^.]+$/, '') || 'vocal'}-${pattern}-${bpm}bpm-16bar.wav`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    setFlash(`exported ${a.download}`)
  }, [output, fileName, pattern, bpm])

  const save = useCallback(async () => {
    if (!output) return
    const folders = await listFolders()
    const folder = folders[0] ?? (await createFolder('folder 1'))
    const name = `${fileName.replace(/\.[^.]+$/, '') || 'vocal'}-${pattern}-${bpm}bpm`
    await addItem({
      folderId: folder.id,
      name,
      blob: encodeWav(output),
      seconds: durationOf(output),
      sampleRate: output.sampleRate,
      channels: output.channels.length,
    })
    setFlash(`saved ${name} → ${folder.name}`)
  }, [output, fileName, pattern, bpm])

  const barSeconds = (60 / bpm) * 4

  return (
    <div
      className={`chop${dragging ? ' chop--dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files?.[0]
        if (f) void loadFile(f)
      }}
    >
      <section className={`stage${source ? '' : ' stage--empty'}`}>
        {source ? (
          <>
            <Waveform
              pcm={source}
              tone="source"
              label="vocal"
              summary={`${fmt(durationOf(source))} · ${source.channels.length === 1 ? 'mono' : 'stereo'}${sourceInfo ? ` · ${sourceInfo}` : ''}`}
              seconds={durationOf(source)}
              playhead={target === 'vocal' ? (playing ? playhead : cursor) : null}
              active={playing && target === 'vocal'}
              onSeek={(p) => void seekTo('vocal', p)}
              tools={
                <button
                  type="button"
                  className="wave__btn"
                  onClick={() => {
                    playback.stop()
                    setPlaying(false)
                    setSource(null)
                    setResult(null)
                    setProcessed(null)
                    setChain(null)
                    setFileName('')
                  }}
                >
                  new vocal
                </button>
              }
            />
            <Waveform
              pcm={rendered}
              gainAt={gainAt}
              voices={result?.voices}
              tone="mangled"
              label={`chop · ${pattern}`}
              summary={
                result
                  ? `${result.bars} bars · ${fmt(durationOf(output ?? result.pcm))} · ${result.slices} slices ${
                      quantize === 'transient'
                        ? `from ${result.onsets} transients`
                        : `on the ${QUANTIZE_CHOICES.find((q) => q.id === quantize)?.label} grid`
                    }${processed ? ' · racked' : ''}`
                  : 'not yet'
              }
              tempo={result ? `${bpm} bpm · ${result.bars} bars` : null}
              seconds={output ? durationOf(output) : 0}
              playhead={target === 'chop' ? (playing ? playhead : cursor) : null}
              active={playing && target === 'chop'}
              onSeek={output ? (p) => void seekTo('chop', p) : undefined}
              placeholder="set a tempo, then chop"
              nonce={result?.slices ?? 0}
              sections={result?.sections}
              barSeconds={barSeconds}
              tools={
                result ? (
                  <button
                    type="button"
                    className="loop"
                    aria-pressed={loop}
                    onClick={() => setLoop((v) => !v)}
                  >
                    loop
                  </button>
                ) : null
              }
            />
          </>
        ) : (
          <div
            className="drop"
            onClick={() => fileInput.current?.click()}
            role="presentation"
          >
            <Waveform pcm={null} tone="source" label="vocal" summary="waiting" />
            <div className="drop__inner">
              <p className="drop__head">drop a vocal</p>
              <p className="drop__sub">
                drop a vocal, or a video to take the audio out of. it cuts the
                line up — on the transients, or straight on the beat — and
                builds a 16 bar loop from a 4 bar phrase.
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
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="chopctl" aria-label="Chop settings">
        <div className="chopctl__row">
          <span className="chopctl__title">tempo</span>
          <div className="len__bars" role="group" aria-label="Tempo">
            {QUICK_BPM.map((b) => (
              <button
                key={b}
                type="button"
                className="len__opt"
                aria-pressed={bpm === b}
                onClick={() => setBpm(b)}
              >
                {b}
              </button>
            ))}
          </div>
          <label className="chopctl__num">
            <span className="sr-only">Tempo in beats per minute</span>
            <input
              type="number"
              min={60}
              max={200}
              value={bpm}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v)) setBpm(Math.max(60, Math.min(200, Math.round(v))))
              }}
            />
            <span aria-hidden="true">bpm</span>
          </label>
        </div>

        <div className="chopctl__row">
          <span className="chopctl__title">pattern</span>
          <div className="len__bars" role="group" aria-label="Arrangement pattern">
            {PATTERNS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="len__opt"
                aria-pressed={pattern === p.id}
                title={p.hint}
                onClick={() => setPattern(p.id)}
              >
                {p.label}
                <span className="sr-only">. {p.hint}</span>
              </button>
            ))}
          </div>
          <span className="chopctl__hint">
            {PATTERNS.find((p) => p.id === pattern)?.hint}
          </span>
        </div>

        <div className="chopctl__row">
          <span className="chopctl__title">length</span>
          {/* The pattern always covers four phrases, so the phrase length is
              what decides the total. One bar each gives the same AAAB shape
              across 4 bars instead of 16. */}
          <div className="len__bars" role="group" aria-label="Total length">
            {([1, 2, 4] as const).map((b) => (
              <button
                key={b}
                type="button"
                className="len__opt"
                aria-pressed={phraseBars === b}
                onClick={() => setPhraseBars(b)}
              >
                {b * 4} bars
              </button>
            ))}
          </div>
          <span className="chopctl__hint">
            {phraseBars * 4} bars total, {phraseBars} per phrase
          </span>
        </div>

        <div className="chopctl__row">
          <span className="chopctl__title">cut</span>
          {/* Where the source is sliced, as opposed to where slices are placed.
              Transients follow the delivery; a grid ignores it and cuts on the
              beat, which is the point — every slice comes out one slot long. */}
          <div className="len__bars" role="group" aria-label="Cut points">
            {QUANTIZE_CHOICES.map((q) => (
              <button
                key={String(q.id)}
                type="button"
                className="len__opt"
                aria-pressed={quantize === q.id}
                title={q.hint}
                onClick={() => setQuantize(q.id)}
              >
                {q.label}
              </button>
            ))}
          </div>
          <span className="chopctl__hint">
            {QUANTIZE_CHOICES.find((q) => q.id === quantize)?.hint}
          </span>
        </div>

        <div className="chopctl__row">
          <span className="chopctl__title">feel</span>
          <label className="chopctl__slider">
            <span>density</span>
            <input
              type="range"
              min={10}
              max={100}
              value={Math.round(density * 100)}
              onChange={(e) => setDensity(Number(e.target.value) / 100)}
            />
            <b>{Math.round(density * 100)}</b>
          </label>
          <label className="chopctl__slider">
            <span>variation</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(variation * 100)}
              onChange={(e) => setVariation(Number(e.target.value) / 100)}
            />
            <b>{Math.round(variation * 100)}</b>
          </label>
          <label className="chopctl__slider" title="How far a slice rings past its own slot">
            <span>hold</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(hold * 100)}
              onChange={(e) => setHold(Number(e.target.value) / 100)}
            />
            <b>{Math.round(hold * 100)}</b>
          </label>
          <div className="len__bars" role="group" aria-label="Grid resolution">
            {([8, 16] as const).map((r) => (
              <button
                key={r}
                type="button"
                className="len__opt"
                aria-pressed={resolution === r}
                onClick={() => setResolution(r)}
              >
                1/{r}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="len__opt chopctl__order"
            aria-pressed={inOrder}
            onClick={() => setInOrder((v) => !v)}
            title="Keep syllables in the order they were sung"
          >
            in order
          </button>
        </div>
      </section>

      {/* The rack colours each phrase, so the arrangement survives it. Empty
          until you add something, so it never sits there taking height from the
          waveforms for nothing. */}
      {result ? (
        <section className="rackhead" aria-label="Effects">
          <span className="rackhead__title">mangle</span>
          <button
            type="button"
            className="rackhead__switch"
            aria-pressed={rackOn}
            disabled={busy}
            onClick={() => setRackOn(!rackOn)}
            title={
              rackOn
                ? 'Effects are on. Turn off to hear the chop dry.'
                : 'Effects are bypassed. Turn on to hear them again.'
            }
          >
            {rackOn ? 'on' : 'off'}
          </button>
          <span className="rackhead__note">
            {chain && chain.effects.length
              ? rackOn
                ? `${chain.effects.length} ${chain.effects.length === 1 ? 'effect' : 'effects'} on each phrase, so the pattern holds`
                : `${chain.effects.length} ${chain.effects.length === 1 ? 'effect' : 'effects'} bypassed`
              : 'add an effect, or hit rechop + mangle'}
          </span>
        </section>
      ) : null}

      {result ? (
        <Rack
          chain={chain ?? { seed: 0, effects: [] }}
          onChange={onChainChange}
          seconds={durationOf(result.pcm) / 4}
          busy={busy || !rackOn}
        />
      ) : null}

      {result ? (
        <Sidechain
          spec={sidechain}
          kickAudible={kickAudible}
          bpm={bpm}
          disabled={busy}
          onChange={setSidechain}
          onKickAudible={setKickAudible}
          onCommit={resumeAfterEdit}
        />
      ) : null}

      {result ? (
        <Levels
          level={level}
          monitor={monitor}
          disabled={busy}
          onLevel={setLevel}
          onMonitor={setMonitor}
        />
      ) : null}

      <footer className="controls">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void togglePlay()}
          disabled={!source}
          aria-pressed={playing}
        >
          {playing ? 'stop' : 'play'}
        </button>
        <button
          type="button"
          className="btn btn--slab"
          onClick={() => void chop()}
          disabled={!source || busy}
        >
          <span className="btn__slabtext">{busy ? 'chopping' : result ? 'rechop' : 'chop'}</span>
        </button>
        {/* Rechop and roll a rack in one press. The rhythm and the treatment are
            the two things you would otherwise gamble on separately. */}
        <button
          type="button"
          className="btn"
          onClick={() => void chopAndRoll()}
          disabled={!source || busy}
          title="Rechop and roll a random set of effects over it"
        >
          rechop + mangle
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void save()}
          disabled={!output}
        >
          save
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={exportWav}
          disabled={!output}
        >
          wav
        </button>
      </footer>

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
  )
}
