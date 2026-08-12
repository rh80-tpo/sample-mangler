import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Waveform } from './components/Waveform'
import { Playback } from './audio/playback'
import { durationOf, peakOf, type Pcm } from './audio/buffers'
import { sniffSampleRate } from './audio/sniff'
import {
  checkDuration,
  checkFileSize,
  decodeAudio,
  describeFailure,
  describeFile,
} from './audio/decode'
import { freshSeed } from './audio/rng'
import { encodeWav } from './audio/wav'
import {
  DEFAULT_CHOP,
  PATTERNS,
  buildChop,
  type ChopResult,
  type Pattern,
} from './audio/chopper'
import { describeKey, detectKey } from './audio/key'
import { describeDetected, detectTempo } from './audio/tempo'
import { addItem, createFolder, listFolders } from './lib/library'

const ACCEPT =
  'audio/*,.wav,.wave,.aif,.aiff,.aifc,.caf,.mp3,.flac,.m4a,.mp4,.aac,.ogg,.oga,.opus,.webm'

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

  const [playing, setPlaying] = useState(false)
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [loop, setLoop] = useState(true)
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
        if (peakOf(pcm) < 1e-4) setError('that file is silent.')
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

  const chop = useCallback(async () => {
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
        seed: freshSeed(),
      })
      setResult(built)
      if (built.slices < 2) {
        setError(
          'only found one transient. try a more percussive vocal, or one with clearer consonants.',
        )
      }
    } catch (e) {
      setError(e instanceof Error ? `chop failed. ${e.message}` : 'chop failed.')
    } finally {
      setBusy(false)
    }
  }, [source, busy, playback, bpm, pattern, density, variation, resolution, inOrder])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bpm, pattern, density, variation, resolution, inOrder])

  const togglePlay = useCallback(async () => {
    const pcm = result?.pcm ?? source
    if (!pcm) return
    if (playback.playing) {
      playback.stop()
      setPlaying(false)
      setPlayhead(null)
      return
    }
    await playback.play(pcm, 0, { loop })
    setPlaying(true)
  }, [result, source, playback, loop])

  const exportWav = useCallback(() => {
    if (!result) return
    const blob = encodeWav(result.pcm)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileName.replace(/\.[^.]+$/, '') || 'vocal'}-${pattern}-${bpm}bpm-16bar.wav`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    setFlash(`exported ${a.download}`)
  }, [result, fileName, pattern, bpm])

  const save = useCallback(async () => {
    if (!result) return
    const folders = await listFolders()
    const folder = folders[0] ?? (await createFolder('folder 1'))
    const name = `${fileName.replace(/\.[^.]+$/, '') || 'vocal'}-${pattern}-${bpm}bpm`
    await addItem({
      folderId: folder.id,
      name,
      blob: encodeWav(result.pcm),
      seconds: durationOf(result.pcm),
      sampleRate: result.pcm.sampleRate,
      channels: result.pcm.channels.length,
    })
    setFlash(`saved ${name} → ${folder.name}`)
  }, [result, fileName, pattern, bpm])

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
              tools={
                <button
                  type="button"
                  className="wave__btn"
                  onClick={() => {
                    playback.stop()
                    setPlaying(false)
                    setSource(null)
                    setResult(null)
                    setFileName('')
                  }}
                >
                  new vocal
                </button>
              }
            />
            <Waveform
              pcm={result?.pcm ?? null}
              tone="mangled"
              label={`chop · ${pattern}`}
              summary={
                result
                  ? `${result.bars} bars · ${fmt(durationOf(result.pcm))} · ${result.slices} slices from ${result.onsets} transients`
                  : 'not yet'
              }
              tempo={result ? `${bpm} bpm · ${result.bars} bars` : null}
              seconds={result ? durationOf(result.pcm) : 0}
              playhead={playing ? playhead : null}
              active={playing}
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
                it finds the transients, cuts on them, and builds a 16 bar loop
                from a 4 bar phrase. pick the pattern and the tempo.
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
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void save()}
          disabled={!result}
        >
          save
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={exportWav}
          disabled={!result}
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
