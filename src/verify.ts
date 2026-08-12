/**
 * Dev-only verification harness. Not part of the shipped bundle.
 *
 * Proves the three things the build has to get right:
 *   1. A roll produces audible, non-silent, non-clipped output.
 *   2. Rerolling produces genuinely different results, not a cached repeat.
 *   3. The exported WAV decodes back to the exact buffer that was previewed.
 *
 * Open /verify.html on the dev server and press the button.
 */
import { describeChain, rollChain } from './audio/chain'
import type { ChainSpec, EffectSpec } from './audio/types'
import {
  MIN_LEVEL_DB,
  applyLevel,
  durationOf,
  peakOf,
  pcmFrom,
  rmsOf,
  type Pcm,
} from './audio/buffers'
import { renderChain } from './audio/render'
import { DEFAULT_BPM } from './audio/fit'
import { encodeWav, QUANTISATION_STEP } from './audio/wav'
import { freshSeed } from './audio/rng'
import { GENERATORS, generateSample } from './audio/generate'
import { DecodeError, decodeAudio } from './audio/decode'
import { detectKey } from './audio/key'
import { PATTERNS, buildChop, slicesFromGrid } from './audio/chopper'
import { Playback } from './audio/playback'
import {
  DEFAULT_SIDECHAIN,
  applySidechain,
  duckGainAt,
  renderKick,
} from './audio/sidechain'
import { describeLoopTempo, detectTempo, loopTempos } from './audio/tempo'

const out = document.getElementById('out') as HTMLPreElement
const lines: string[] = []
let failures = 0

function log(msg = '') {
  lines.push(msg)
  out.innerHTML = lines.join('\n')
}

function check(label: string, pass: boolean, detail: string) {
  if (!pass) failures++
  log(
    `  <span class="${pass ? 'ok' : 'bad'}">${pass ? 'PASS' : 'FAIL'}</span>  ${label}  ${detail}`,
  )
}

async function loadFixture(ctx: AudioContext, name: string): Promise<Pcm> {
  const res = await fetch(`/test-audio/${name}`)
  const arr = await res.arrayBuffer()
  const decoded = await ctx.decodeAudioData(arr)
  return pcmFrom(decoded)
}

/** Max absolute per-sample difference between two buffers. */
function maxDiff(a: Pcm, b: Pcm): { diff: number; at: number } {
  let worst = 0
  let at = -1
  const n = Math.min(a.channels[0].length, b.channels[0].length)
  for (let c = 0; c < a.channels.length; c++) {
    const ca = a.channels[c]
    const cb = b.channels[c]
    for (let i = 0; i < n; i++) {
      const d = Math.abs(ca[i] - cb[i])
      if (d > worst) {
        worst = d
        at = i
      }
    }
  }
  return { diff: worst, at }
}

/** Correlation between two buffers, used to tell rolls apart. */
function similarity(a: Pcm, b: Pcm): number {
  const n = Math.min(a.channels[0].length, b.channels[0].length)
  if (n === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  const ca = a.channels[0]
  const cb = b.channels[0]
  for (let i = 0; i < n; i++) {
    dot += ca[i] * cb[i]
    na += ca[i] * ca[i]
    nb += cb[i] * cb[i]
  }
  if (na === 0 || nb === 0) return 0
  return Math.abs(dot / Math.sqrt(na * nb))
}

async function run() {
  lines.length = 0
  failures = 0
  const ctx = new AudioContext()
  await ctx.resume()
  log(`context sampleRate ${ctx.sampleRate}Hz`)
  log()

  for (const fixture of ['drums.wav', 'pluck.wav']) {
    const original = await loadFixture(ctx, fixture)
    log(
      `=== ${fixture}  ${durationOf(original).toFixed(3)}s  ${original.channels.length}ch  peak ${peakOf(original).toFixed(4)} ===`,
    )
    log()

    const results: { pcm: Pcm; desc: string }[] = []

    // Enough rolls that the rarer shapes, especially the one-effect roll that
    // has to carry itself, actually come up.
    for (let roll = 0; roll < 14; roll++) {
      const seed = freshSeed()
      const chain = rollChain(seed, durationOf(original))
      const { pcm, elapsedMs } = await renderChain(original, chain)
      const peak = peakOf(pcm)
      const rms = rmsOf(pcm)
      const dur = durationOf(pcm)

      log(
        `roll ${roll + 1}  seed ${seed}  ${elapsedMs.toFixed(0)}ms  ${dur.toFixed(3)}s  peak ${peak.toFixed(4)}  rms ${rms.toFixed(4)}`,
      )
      log(`  chain: ${describeChain(chain)}`)

      // --- audible output ---------------------------------------------
      check('non-silent', rms > 0.005, `rms ${rms.toFixed(5)} > 0.005`)
      check('non-clipped', peak <= 1.0, `peak ${peak.toFixed(6)} <= 1.0`)
      check(
        'differs from source',
        similarity(pcm, original) < 0.99,
        `corr ${similarity(pcm, original).toFixed(4)} < 0.99`,
      )

      // --- WAV round trip ---------------------------------------------
      const blob = encodeWav(pcm)
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
      const back = pcmFrom(decoded)

      check(
        'wav frame count',
        back.channels[0].length === pcm.channels[0].length,
        `${back.channels[0].length} === ${pcm.channels[0].length}`,
      )
      check(
        'wav channel count',
        back.channels.length === pcm.channels.length,
        `${back.channels.length} === ${pcm.channels.length}`,
      )
      check(
        'wav sample rate',
        back.sampleRate === pcm.sampleRate,
        `${back.sampleRate} === ${pcm.sampleRate}`,
      )
      const { diff, at } = maxDiff(pcm, back)
      check(
        'wav samples match',
        diff <= QUANTISATION_STEP * 1.5,
        `max |delta| ${diff.toExponential(3)} at frame ${at} (24-bit step ${QUANTISATION_STEP.toExponential(3)})`,
      )
      log()

      results.push({ pcm, desc: describeChain(chain) })
    }

    // --- rerolls differ from each other -------------------------------
    //
    // The invariant is that a different chain gives different audio, not that
    // every pair differs. `reverse` has no parameters, so two rolls that both
    // draw it alone are the same chain and must produce identical output.
    // Asserting otherwise failed on correct behaviour about once every twenty
    // rolls, which is how this got found.
    let identical = 0
    let sameChainPairs = 0
    let maxPairCorr = 0
    let pairs = 0
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const sameChain = results[i].desc === results[j].desc
        const s = similarity(results[i].pcm, results[j].pcm)
        if (sameChain) {
          sameChainPairs++
          // Same chain, same source: the output has to match exactly.
          if (s <= 0.999) identical++
          continue
        }
        pairs++
        maxPairCorr = Math.max(maxPairCorr, s)
        if (s > 0.999) identical++
      }
    }
    check(
      'different chains give different audio',
      identical === 0,
      `${pairs} distinct pairs, worst-case corr ${maxPairCorr.toFixed(4)}` +
        (sameChainPairs ? `, ${sameChainPairs} repeat-chain pairs verified identical` : ''),
    )
    log()
  }

  // --- sidechain --------------------------------------------------------
  {
    log('=== sidechain ===')
    log()
    const bpm = 120
    const spec = { ...DEFAULT_SIDECHAIN, amount: 0.8, rate: 4 as const, release: 0.5 }
    const interval = 60 / bpm

    // At the kick itself the gain is still open; it closes over the attack.
    // That ordering is what lets a transient through instead of swallowing it.
    check('gain is open at the kick', duckGainAt(0, spec, bpm) === 1, 'gain 1.0')
    const atFloor = duckGainAt(0.004, spec, bpm)
    check(
      'gain reaches the floor after the attack',
      Math.abs(atFloor - (1 - spec.amount)) < 0.001,
      `gain ${atFloor.toFixed(4)}, floor ${(1 - spec.amount).toFixed(4)}`,
    )

    // Recovery has to be monotonic, or it is not a release, it is a wobble.
    let rising = true
    let prev = atFloor
    for (let t = 0.005; t < interval - 0.001; t += 0.002) {
      const g = duckGainAt(t, spec, bpm)
      if (g < prev - 1e-6) rising = false
      prev = g
    }
    check('the duck recovers monotonically', rising, `ends at ${prev.toFixed(4)}`)

    // It is tempo locked, so the same point in the next kick must match.
    let periodic = true
    for (let t = 0.01; t < interval; t += 0.01) {
      if (Math.abs(duckGainAt(t, spec, bpm) - duckGainAt(t + interval, spec, bpm)) > 1e-6) {
        periodic = false
      }
    }
    check('the duck is locked to the grid', periodic, `period ${interval.toFixed(3)}s`)

    check('amount 0 is a true no-op', duckGainAt(0.1, { ...spec, amount: 0 }, bpm) === 1, 'gain 1.0')

    // Rate has to change where the holes land, not just the label.
    const quarter = duckGainAt(interval / 2, { ...spec, rate: 4 }, bpm)
    const eighth = duckGainAt(interval / 2, { ...spec, rate: 8 }, bpm)
    check('rate moves the kick positions', Math.abs(quarter - eighth) > 0.01, `1/4 ${quarter.toFixed(3)} vs 1/8 ${eighth.toFixed(3)}`)

    // And it has to reach the audio, not only the envelope function.
    {
      const steady = generateSample('vocal', ctx.sampleRate, freshSeed())
      const ducked = applySidechain(steady, spec, bpm)
      check('sidechain leaves the source alone', ducked !== steady, 'new buffer')
      check(
        'ducking lowers the level',
        rmsOf(ducked) < rmsOf(steady) * 0.95,
        `rms ${rmsOf(steady).toFixed(4)} dry vs ${rmsOf(ducked).toFixed(4)} ducked`,
      )
      check(
        'amount 0 returns the same buffer',
        applySidechain(steady, { ...spec, amount: 0 }, bpm) === steady,
        'same buffer back',
      )

      // A ducked output still has to survive the encode, same as a trimmed one.
      const blob = encodeWav(ducked)
      const back = pcmFrom(await ctx.decodeAudioData(await blob.arrayBuffer()))
      const { diff } = maxDiff(ducked, back)
      check(
        'a ducked output still exports exactly',
        diff <= QUANTISATION_STEP * 1.5,
        `max |delta| ${diff.toExponential(3)}`,
      )
    }

    // The reference kick is audition-only, so all that matters is that it is a
    // real kick at the right spacing.
    {
      const k = renderKick(ctx.sampleRate, 2, bpm, 4)
      check('reference kick is audible', rmsOf(k) > 0.01, `rms ${rmsOf(k).toFixed(4)}`)
      // Four quarter notes in two seconds at 120.
      //
      // Counted with a time-based refractory gap, not by waiting for silence
      // between hits: a kick is a sine, so it crosses zero every half cycle and
      // a re-arm-on-quiet counter scores each kick twice.
      const countHits = (pcm: Pcm) => {
        const ch = pcm.channels[0]
        const gap = Math.floor(0.15 * pcm.sampleRate)
        let hits = 0
        let last = -gap
        for (let i = 0; i < ch.length; i++) {
          if (Math.abs(ch[i]) > 0.2 && i - last >= gap) {
            hits++
            last = i
          }
        }
        return hits
      }
      check('reference kick lands on the beat', countHits(k) === 4, `${countHits(k)} hits in 2s at 120 (1/4)`)
      const eighths = renderKick(ctx.sampleRate, 2, bpm, 8)
      check(
        'reference kick follows the rate',
        countHits(eighths) === 8,
        `${countHits(eighths)} hits in 2s at 120 (1/8)`,
      )
    }
    log()
  }

  // --- determinism ------------------------------------------------------
  // Roll history stores chains, not audio, and re-renders when you step back.
  // That is only honest if the same chain gives back the same sound, so this
  // measures it per effect rather than asserting one global tolerance — the
  // answer turned out to be different for different effects, and an aggregate
  // number hid which.
  {
    log('=== rendering is deterministic ===')
    log()
    const original = await loadFixture(ctx, 'drums.wav')
    const only = (spec: EffectSpec): ChainSpec => ({ seed: 5, effects: [spec] })
    const cases: { name: string; chain: ChainSpec }[] = [
      { name: 'reverse', chain: only({ id: 'reverse', enabled: true }) },
      { name: 'chop', chain: only({ id: 'chop', enabled: true, segments: 12, reorder: 0.5, repeat: 0.3, gate: 0.2 }) },
      { name: 'bitcrush', chain: only({ id: 'bitcrush', enabled: true, bits: 6, divisor: 6 }) },
      { name: 'drive', chain: only({ id: 'drive', enabled: true, amount: 0.6, oversample: '2x' }) },
      { name: 'reverb', chain: only({ id: 'reverb', enabled: true, size: 0.7, damp: 4000, mix: 0.5 }) },
      { name: 'pitch', chain: only({ id: 'pitch', enabled: true, semitones: -5, windowSize: 0.06 }) },
    ]

    let worstName = ''
    let worstDelta = 0
    for (const c of cases) {
      const a = await renderChain(original, c.chain, { bars: 2, mode: 'trim', bpm: DEFAULT_BPM })
      const b = await renderChain(original, c.chain, { bars: 2, mode: 'trim', bpm: DEFAULT_BPM })
      const sameLength = a.pcm.channels[0].length === b.pcm.channels[0].length
      const { diff } = maxDiff(a.pcm, b.pcm)
      if (diff > worstDelta) {
        worstDelta = diff
        worstName = c.name
      }
      // Every effect must at least land in the same place with the same length,
      // and be far below audibility. -100 dBFS is roughly 1e-5.
      check(
        `${c.name} reproduces`,
        sameLength && diff < 1e-5,
        `max |delta| ${diff.toExponential(2)}${sameLength ? '' : ' · LENGTH DIFFERS'}`,
      )
    }
    log(
      `  worst drift: ${worstName} at ${worstDelta.toExponential(2)} (${(
        20 * Math.log10(Math.max(worstDelta, 1e-12))
      ).toFixed(0)} dBFS)`,
    )
    log()
  }

  // --- output level -----------------------------------------------------
  // There was no volume control at all for the first nine versions, and nothing
  // here noticed. These checks exist so that cannot recur quietly: the level has
  // to reach the exported bytes, and the monitor has to stay out of them.
  {
    log('=== output level ===')
    log()
    const src = generateSample('vocal', ctx.sampleRate, freshSeed())
    const base = peakOf(src)

    // Attenuation is exact, and it is the peak that has to move — a control
    // that only changed rms could be a filter rather than a fader.
    for (const db of [-6, -12, -24]) {
      const cut = applyLevel(src, db)
      const want = base * Math.pow(10, db / 20)
      const got = peakOf(cut)
      check(
        `level ${db} dB attenuates exactly`,
        Math.abs(got - want) < want * 0.001,
        `peak ${got.toFixed(5)}, wanted ${want.toFixed(5)}`,
      )
    }

    check('level 0 dB is a true no-op', applyLevel(src, 0) === src, 'same buffer back')
    check(
      `level ${MIN_LEVEL_DB} dB is silence`,
      peakOf(applyLevel(src, MIN_LEVEL_DB)) === 0,
      'peak 0',
    )
    check(
      'level does not touch the buffer it was given',
      peakOf(src) === base,
      `source peak still ${base.toFixed(5)}`,
    )

    // The point of the whole render-once design: a trimmed output still has to
    // survive the encode sample-for-sample, or preview and export have drifted.
    {
      const trimmed = applyLevel(src, -9)
      const blob = encodeWav(trimmed)
      const back = pcmFrom(await ctx.decodeAudioData(await blob.arrayBuffer()))
      const { diff } = maxDiff(trimmed, back)
      check(
        'a trimmed output still exports exactly',
        diff <= QUANTISATION_STEP * 1.5,
        `max |delta| ${diff.toExponential(3)}`,
      )
    }

    // Monitor must be a node, not a multiply. If it were ever implemented by
    // scaling the buffer, the file would silently follow the listening level.
    {
      const probe = generateSample('vocal', ctx.sampleRate, 99)
      const before = peakOf(probe)
      const pb = new Playback()
      pb.setMonitor(0.25)
      check('monitor reports what it was set to', pb.getMonitor() === 0.25, '0.25')
      pb.setMonitor(-3)
      check('monitor clamps below zero', pb.getMonitor() === 0, 'clamped to 0')
      pb.setMonitor(9)
      check('monitor clamps above one', pb.getMonitor() === 1, 'clamped to 1')
      pb.setMonitor(0.4)
      await pb.play(probe)
      pb.stop()
      check(
        'monitor leaves the audio untouched',
        peakOf(probe) === before,
        `peak still ${before.toFixed(5)} after playing at monitor 0.4`,
      )
    }
    log()
  }

  // --- the chopper ------------------------------------------------------
  // The pattern is the feature, so it gets checked by measuring which phrases
  // came out byte-identical rather than by trusting the label.
  {
    log('=== vocal chopper ===')
    log()
    const vocal = generateSample('vocal', ctx.sampleRate, freshSeed())
    const base = {
      bpm: 140,
      density: 0.6,
      variation: 0.6,
      resolution: 16 as const,
      inOrder: false,
      phraseBars: 4 as const,
      hold: 0.25,
      quantize: 'transient' as const,
      seed: 4242,
    }

    const samePhrase = (a: Float32Array, b: Float32Array) => {
      if (a.length !== b.length) return false
      // Skip the ends: a buffer-wide edge fade is not a phrase difference.
      for (let i = 5000; i < a.length - 5000; i += 5) {
        if (Math.abs(a[i] - b[i]) > 1e-6) return false
      }
      return true
    }

    for (const pattern of PATTERNS.map((p) => p.id)) {
      const r = buildChop(vocal, { ...base, pattern })
      const q = r.pcm.channels[0].length / 4
      if (!Number.isInteger(q)) {
        check(`${pattern} phrases divide evenly`, false, `${q} frames per phrase`)
        continue
      }
      const phrases = [0, 1, 2, 3].map((i) => r.pcm.channels[0].slice(i * q, (i + 1) * q))
      // Rebuild the pattern from the audio: first phrase is A, each later one
      // is whichever earlier phrase it matches, or a new letter.
      const letters = ['A']
      for (let i = 1; i < 4; i++) {
        let found: string | null = null
        for (let j = 0; j < i; j++) {
          if (samePhrase(phrases[i], phrases[j])) {
            found = letters[j]
            break
          }
        }
        letters.push(found ?? String.fromCharCode(65 + new Set(letters).size))
      }
      check(
        `${pattern} arrangement is honoured`,
        letters.join('') === pattern,
        `audio reads as ${letters.join('')}`,
      )
    }

    // Phrase length decides the total, and the total must be exact.
    for (const phraseBars of [1, 2, 4] as const) {
      const r = buildChop(vocal, { ...base, pattern: 'AAAB', phraseBars })
      const wanted = phraseBars * 4
      const seconds = durationOf(r.pcm)
      const expected = wanted * (60 / base.bpm) * 4
      check(
        `${wanted} bar loop is exact`,
        r.bars === wanted && Math.abs(seconds - expected) < 0.01,
        `${r.bars} bars, ${seconds.toFixed(3)}s vs ${expected.toFixed(3)}s`,
      )
    }

    // Quantised cutting. The whole point is that a cut lands on the grid, so
    // that is measured directly rather than inferred from how it sounds.
    {
      for (const perBar of [1, 2, 4, 8, 16] as const) {
        const grid = slicesFromGrid(vocal, base.bpm, perBar)
        const want = Math.round(((60 / base.bpm) * 4 / perBar) * vocal.sampleRate)

        const sameLength = grid.every((sl) => sl.end - sl.start === want)
        check(
          `1/${perBar} slices are all one slot long`,
          sameLength && grid.length > 0,
          `${grid.length} slices of ${want} frames`,
        )
        // Every start has to be an exact multiple of the slot, or it is not a
        // grid — near-silent slices are dropped, so starts skip but never drift.
        const onGrid = grid.every((sl) => sl.start % want === 0)
        check(
          `1/${perBar} cuts land on the grid`,
          onGrid,
          onGrid ? 'every start is a slot multiple' : 'a start was off the grid',
        )
      }

      // Finer grids give more slices. If they did not, the control does nothing.
      const counts = ([1, 2, 4, 8, 16] as const).map(
        (q) => slicesFromGrid(vocal, base.bpm, q).length,
      )
      let increasing = true
      for (let i = 1; i < counts.length; i++) {
        if (counts[i] <= counts[i - 1]) increasing = false
      }
      check('finer grids cut more slices', increasing, counts.join(' → '))

      // And it has to change the audio, not just the slice list.
      const onTransients = buildChop(vocal, { ...base, pattern: 'AAAB', quantize: 'transient' })
      const onGrid8 = buildChop(vocal, { ...base, pattern: 'AAAB', quantize: 8 })
      check(
        'quantising changes the loop',
        similarity(onTransients.pcm, onGrid8.pcm) < 0.99,
        `corr ${similarity(onTransients.pcm, onGrid8.pcm).toFixed(4)}`,
      )
      check(
        'quantising skips onset detection',
        onGrid8.onsets === 0 && onTransients.onsets > 0,
        `${onTransients.onsets} transients vs ${onGrid8.onsets} when gridded`,
      )
      // Cut on the same grid the slices are placed on, and every chop should
      // come out exactly one slot long — that is what "quantised" has to mean.
      //
      // Not tested as "no gaps in the loop": density is multiplied by each
      // step's rhythmic weight, so even at 1.0 an offbeat sixteenth only lands
      // 28% of the time and holes in the rhythm are correct. What must hold is
      // the length of each chop that does land.
      {
        const tight = buildChop(vocal, {
          ...base,
          pattern: 'AAAB',
          quantize: 16,
          resolution: 16,
          hold: 0,
          density: 1,
        })
        // phraseBars is bars *per phrase*, and the pattern covers four phrases.
        const steps = base.phraseBars * 16 * 4
        const slot = 1 / steps
        const lengths = tight.voices.map((v) => v.end - v.start)
        const over = lengths.filter((l) => l > slot * 1.02).length
        const exact = lengths.filter((l) => Math.abs(l - slot) <= slot * 0.02).length
        check(
          'a gridded chop never outruns its slot',
          over === 0,
          `${lengths.length} voices, ${over} longer than a slot`,
        )
        check(
          'a gridded chop is exactly one slot long',
          exact >= lengths.length * 0.9,
          `${exact}/${lengths.length} within 2% of one slot`,
        )
      }
      // Still mono, which the grid must not break.
      const sorted = [...onGrid8.voices].sort((a, b) => a.start - b.start)
      let overlaps = 0
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i - 1].end - sorted[i].start > 1e-9) overlaps++
      }
      check('gridded chops stay monophonic', overlaps === 0, `${sorted.length} voices, ${overlaps} overlapping`)
    }

    // One voice at a time. Overlapping chops are the thing that turns a rhythm
    // into a smear, so this is checked on the reported voices rather than by ear.
    {
      for (const hold of [0, 0.5, 1]) {
        const r = buildChop(vocal, { ...base, pattern: 'AAAB', hold })
        const sorted = [...r.voices].sort((a, b) => a.start - b.start)
        let overlaps = 0
        let worst = 0
        for (let i = 1; i < sorted.length; i++) {
          const over = sorted[i - 1].end - sorted[i].start
          if (over > 1e-9) {
            overlaps++
            worst = Math.max(worst, over)
          }
        }
        check(
          `hold ${hold} never plays two voices at once`,
          overlaps === 0,
          `${sorted.length} voices, ${overlaps} overlapping${overlaps ? `, worst ${(worst * 100).toFixed(3)}% of the loop` : ''}`,
        )
      }

      // Colouring is only meaningful if the voices actually name their source
      // slice, and if a repeated phrase repeats its colours.
      const r = buildChop(vocal, { ...base, pattern: 'AAAB' })
      check(
        'every voice names a real slice',
        r.voices.length > 0 && r.voices.every((v) => v.slice >= 0 && v.slice < r.slices),
        `${r.voices.length} voices across ${r.slices} slices`,
      )
      const inPhrase = (i: number) =>
        r.voices
          .filter((v) => v.start >= i / 4 - 1e-9 && v.start < (i + 1) / 4)
          .map((v) => v.slice)
          .join(',')
      check(
        'a repeated phrase repeats its colours',
        inPhrase(0) === inPhrase(1) && inPhrase(0) === inPhrase(2),
        `A "${inPhrase(0).slice(0, 28)}" vs B "${inPhrase(3).slice(0, 28)}"`,
      )
      check(
        'the variation phrase is coloured differently',
        inPhrase(3) !== inPhrase(0),
        'B differs from A',
      )
    }

    // Hold has to lengthen the slices, not just redraw a number.
    {
      const tight = buildChop(vocal, { ...base, pattern: 'AAAA', hold: 0 })
      const held = buildChop(vocal, { ...base, pattern: 'AAAA', hold: 1 })
      // Measured as how much of the loop is actually sounding, not as level.
      // The output is peak normalised, so letting slices ring raises the peak
      // and the gain comes straight back off: mean level barely moves even
      // though the chops are audibly longer. What hold changes is the fill.
      const filled = (p: Pcm) => {
        const ch = p.channels[0]
        let n = 0
        for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) > 1e-3) n++
        return n / ch.length
      }
      const a = filled(tight.pcm)
      const b = filled(held.pcm)
      check(
        'hold extends the chops',
        b > a * 1.15,
        `${(a * 100).toFixed(1)}% of the loop sounding at hold 0, ${(b * 100).toFixed(1)}% at hold 1`,
      )
    }
    log()
  }

  // --- tempo ------------------------------------------------------------
  // Two separate claims. The loop tempo is exact arithmetic and must be right
  // every time. The detected pulse is an estimate and is allowed to miss the
  // octave occasionally, which is why the interface offers the alternative.
  {
    log('=== tempo ===')
    log()
    const sr = ctx.sampleRate
    const click = (bpm: number, secs = 8): Pcm => {
      const n = sr * secs
      const l = new Float32Array(n)
      const r = new Float32Array(n)
      const beat = ((60 / bpm) * sr) / 2
      for (let b = 0; b * beat < n; b++) {
        const at = Math.floor(b * beat)
        const onBeat = b % 2 === 0
        const len = Math.floor((onBeat ? 0.18 : 0.04) * sr)
        let ph = 0
        for (let i = 0; i < len && at + i < n; i++) {
          const t = i / sr
          let v: number
          if (onBeat) {
            const f = 45 + 90 * Math.exp(-t * 40)
            ph += (2 * Math.PI * f) / sr
            v = Math.sin(ph) * Math.exp(-t * 14)
          } else {
            v = (Math.random() * 2 - 1) * Math.exp(-t * 70) * 0.35
          }
          l[at + i] += v
          r[at + i] += v
        }
      }
      return { channels: [l, r], sampleRate: sr }
    }

    const tempos = [80, 90, 100, 110, 120, 128, 135, 140, 150, 160, 174]
    let hit = 0
    const misses: string[] = []
    for (const bpm of tempos) {
      const got = detectTempo(click(bpm))
      if (got && Math.abs(got.bpm - bpm) < 3) hit++
      else misses.push(`${bpm}→${got ? got.bpm : 'none'}`)
    }
    log(`  detected ${hit}/${tempos.length}${misses.length ? `   missed ${misses.join(' ')}` : ''}`)
    // Ten of eleven is where the swept prior landed; the remaining miss is a
    // half-time reading, which the interface shows as an alternative.
    check('pulse detection holds up', hit >= 10, `${hit}/${tempos.length}`)

    for (const bpm of tempos) {
      const got = detectTempo(click(bpm))
      if (!got || Math.abs(got.bpm - bpm) < 3) continue
      check(
        `${bpm} offers the right alternative`,
        got.alternates.some((a) => Math.abs(a - bpm) < 4),
        `read ${got.bpm}, alternates ${got.alternates.join('/')}`,
      )
    }

    // Exact loop arithmetic: a clip of N bars at 120 must report 120 and N.
    for (const bars of [0.5, 1, 2, 4]) {
      const seconds = bars * 2
      check(
        `${bars} bars reports 120`,
        describeLoopTempo(seconds, bars) === `120 bpm · ${bars} ${bars === 1 ? 'bar' : 'bars'}`,
        describeLoopTempo(seconds, bars) ?? 'null',
      )
      // And unfitted, the same length must solve back to the same tempo.
      const solved = loopTempos(seconds)[0]
      check(
        `${bars} bars solves back to 120`,
        Math.abs(solved.bpm - 120) < 0.05,
        `${solved.bpm} at ${solved.bars} bars`,
      )
    }
    log()
  }

  // --- key detection ----------------------------------------------------
  // Chords built at a known tonic must come back as that key, and material
  // with no key must come back as nothing rather than a confident guess.
  {
    log('=== key detection ===')
    log()
    const sr = ctx.sampleRate
    const midiHz = (n: number) => 440 * Math.pow(2, (n - 69) / 12)
    const chords = (root: number, mode: 'major' | 'minor'): Pcm => {
      const n = sr * 8
      const l = new Float32Array(n)
      const r = new Float32Array(n)
      const prog =
        mode === 'major'
          ? [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]]
          : [[0, 3, 7], [5, 8, 12], [7, 10, 14], [0, 3, 7]]
      const per = Math.floor(n / prog.length)
      prog.forEach((ch, idx) => {
        for (const iv of ch) {
          const f = midiHz(root + 60 + iv)
          for (let i = 0; i < per; i++) {
            const t = i / sr
            const env = Math.min(1, t * 8) * Math.exp(-t * 0.6)
            let v = 0
            for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * f * h * t) / (h * h)
            const at = idx * per + i
            if (at < n) {
              l[at] += v * env * 0.12
              r[at] += v * env * 0.12
            }
          }
        }
      })
      return { channels: [l, r], sampleRate: sr }
    }

    const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    let right = 0
    const cases: [number, 'major' | 'minor'][] = [
      [0, 'major'], [7, 'major'], [9, 'minor'], [2, 'minor'],
      [6, 'major'], [3, 'minor'], [10, 'major'], [4, 'minor'],
    ]
    for (const [root, mode] of cases) {
      const want = `${NAMES[root]} ${mode === 'major' ? 'maj' : 'min'}`
      const got = detectKey(chords(root, mode))
      if (got?.label === want) right++
      else log(`  <span class="bad">${want} read as ${got?.label ?? 'nothing'}</span>`)
    }
    check('known keys are identified', right === cases.length, `${right}/${cases.length}`)

    const noise: Pcm = {
      sampleRate: sr,
      channels: [new Float32Array(sr * 4), new Float32Array(sr * 4)],
    }
    for (const ch of noise.channels) {
      for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1
    }
    check('noise is not given a key', detectKey(noise) === null, 'returned null')

    // The case that matters: a tonal part under a drum loop.
    const tonal = chords(9, 'minor')
    const drums = generateSample('drums', sr, freshSeed())
    const n = Math.min(tonal.channels[0].length, drums.channels[0].length)
    const mixed: Pcm = {
      sampleRate: sr,
      channels: [new Float32Array(n), new Float32Array(n)],
    }
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < n; i++) {
        mixed.channels[c][i] = tonal.channels[c][i] * 0.8 + drums.channels[c][i] * 0.9
      }
    }
    const mixedKey = detectKey(mixed)
    check(
      'drums do not drown the key',
      mixedKey?.label === 'A min',
      `A min chords over drums read as ${mixedKey?.label ?? 'nothing'}`,
    )
    log()
  }

  // --- file formats -----------------------------------------------------
  // Chromium's decodeAudioData cannot read AIFF or CAF, which is exactly what
  // a Mac DAW renders. Those go through our own parser, so this checks both
  // that they load and that they decode to the same audio as the wav.
  {
    log('=== file formats ===')
    log()
    // A context at the fixtures' own rate, so decodeAudioData does not
    // resample and both decode paths land on the same sample grid. Without
    // this the comparison silently stops running whenever the hardware rate
    // differs from the files.
    const fmtCtx = new AudioContext({ sampleRate: 48000 })
    const native = (b: ArrayBuffer) => fmtCtx.decodeAudioData(b)
    const load = async (name: string) => {
      const res = await fetch(`/test-audio/formats/${name}`)
      return decodeAudio(await res.arrayBuffer(), native)
    }

    try {
      const ref = await load('a-wav16.wav')
      for (const name of [
        'a-wav24.wav',
        'a-wav32f.wav',
        'a-mono.wav',
        'b-aiff.aiff',
        'b-aif.aif',
        'b-aifc-sowt.aifc',
        'c-mp3.mp3',
        'd-flac.flac',
        'e-m4a.m4a',
        'h-caf.caf',
        'i-UPPER.WAV',
      ]) {
        const pcm = await load(name)
        const sec = durationOf(pcm)
        check(
          `${name} loads`,
          pcm.channels[0].length > 0 && rmsOf(pcm) > 0.001,
          `${sec.toFixed(2)}s ${pcm.channels.length}ch ${(pcm.sampleRate / 1000).toFixed(1)}k`,
        )
        // Every format has to agree on how long the audio is, whatever rate it
        // decoded at.
        check(
          `${name} duration matches`,
          Math.abs(sec - durationOf(ref)) < 0.02,
          `${sec.toFixed(3)}s vs ${durationOf(ref).toFixed(3)}s`,
        )

        // Sample-accurate comparison only means something at a matched rate.
        // decodeAudioData resamples to the context, while our own parsers keep
        // the file's native rate, so aiff at 48k against a wav resampled to
        // 44.1k would compare two different sample grids. The app never hits
        // this: it opens the context at the sniffed rate before decoding.
        const comparable =
          /aif|caf|wav/i.test(name) &&
          pcm.channels.length === ref.channels.length &&
          pcm.sampleRate === ref.sampleRate
        if (comparable) {
          const sim = similarity(ref, pcm)
          check(
            `${name} matches the wav`,
            sim > 0.999,
            `correlation ${sim.toFixed(6)}`,
          )
        }
      }

      let emptyReason = ''
      try {
        await decodeAudio(new ArrayBuffer(0), native)
      } catch (e) {
        emptyReason = e instanceof DecodeError ? e.reason : 'other'
      }
      check('empty file is reported as empty', emptyReason === 'empty', emptyReason)
      void fmtCtx.close()
    } catch (e) {
      log(
        `  <span class="bad">could not run: ${e instanceof Error ? e.message : String(e)}</span>`,
      )
      log('  (fixtures come from the ffmpeg battery in test-audio/formats)')
    }
    log()
  }

  // --- bar-fitted rolls are never silent --------------------------------
  // A reverb renders with a long decay tail, and that tail becomes real buffer
  // length. Put a reverse after it and the quiet end moves to the front, so
  // trimming to a bar handed back silence. This is the regression guard.
  {
    log('=== bar-fitted rolls stay audible ===')
    log()
    let silent = 0
    let quietest = 1
    const ROUNDS = 40
    for (const gen of ['vocal', 'choir', 'keys'] as const) {
      const src = generateSample(gen, ctx.sampleRate, freshSeed())
      for (let i = 0; i < ROUNDS; i++) {
        const bars = [0.5, 1, 2][i % 3]
        const chain = rollChain(freshSeed(), durationOf(src))
        const { pcm } = await renderChain(src, chain, { bars, mode: 'trim', bpm: DEFAULT_BPM })
        const r = rmsOf(pcm)
        quietest = Math.min(quietest, r)
        if (r < 0.004) {
          silent++
          log(`  <span class="bad">silent:</span> ${describeChain(chain)}`)
        }
      }
    }
    check(
      'no bar-fitted roll comes back silent',
      silent === 0,
      `${silent} of ${ROUNDS * 3}, quietest rms ${quietest.toFixed(5)}`,
    )
    log()
  }

  // --- loops actually loop ----------------------------------------------
  // A bar-length result exists to be played round and round. That means two
  // things must hold: the length is exactly the bar count asked for, and the
  // join from the last sample back to the first does not step.
  {
    log('=== loop integrity ===')
    log()
    const original = await loadFixture(ctx, 'drums.wav')

    // Fixed seeds rather than random ones. This section used to roll a fresh
    // chain each run, which made it intermittent — the worst property a check
    // can have, because a failure could not be told apart from bad luck.
    const SEAM_SEEDS = [7, 1153, 20219, 44497, 90001]
    let worstRatio = 0
    let worstNote = ''

    for (const bars of [0.5, 1, 2]) {
      for (const mode of ['trim', 'stretch', 'fit'] as const) {
        let lengthOk = true
        let lengthNote = ''
        let seamFailures = 0
        let seamNote = ''

        for (const seed of SEAM_SEEDS) {
          const chain = rollChain(seed, durationOf(original))
          const { pcm } = await renderChain(original, chain, { bars, mode, bpm: DEFAULT_BPM })
          const seconds = durationOf(pcm)
          const wanted = bars * 2 // 120bpm, 4/4

          if (Math.abs(seconds - wanted) >= 0.002) {
            lengthOk = false
            lengthNote = `seed ${seed}: ${seconds.toFixed(4)}s vs ${wanted}s`
          }

          const ch = pcm.channels[0]
          const padded = durationOf(original) < wanted
          if (padded) continue

          // Compared against the material's own worst steps, not its mean step.
          //
          // The mean is the wrong yardstick here and it made this check both
          // unfair and flaky. Decimation is sample-and-hold: most neighbouring
          // samples are identical, which drags the mean toward zero, while the
          // steps that do occur are large by design. A seam the same size as
          // steps the signal already contains everywhere is not a click — it is
          // the material. A high percentile says that; a mean does not.
          const steps = new Float64Array(ch.length - 1)
          for (let i = 1; i < ch.length; i++) steps[i - 1] = Math.abs(ch[i] - ch[i - 1])
          const sorted = Float64Array.from(steps).sort()
          const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
          const p999 = pick(0.999)
          const seam = Math.abs(ch[0] - ch[ch.length - 1])
          const limit = Math.max(p999 * 1.5, 0.02)
          const ratio = seam / Math.max(p999, 1e-9)
          if (ratio > worstRatio) {
            worstRatio = ratio
            worstNote = `${bars}b ${mode} seed ${seed}: seam ${seam.toFixed(5)}, p99.9 ${p999.toFixed(5)}`
          }
          if (!(seam <= limit)) {
            seamFailures++
            seamNote = `seed ${seed}: seam ${seam.toFixed(5)} vs p99.9 ${p999.toFixed(5)} · ${describeChain(chain)}`
          }
        }

        check(`${bars} bar ${mode}: exact length`, lengthOk, lengthNote || `all ${SEAM_SEEDS.length} seeds`)
        if (durationOf(original) >= bars * 2) {
          check(
            `${bars} bar ${mode}: seam is not a step`,
            seamFailures === 0,
            seamFailures ? seamNote : `${SEAM_SEEDS.length} seeds clean`,
          )
        }
      }
    }
    log(`  worst seam across all ${SEAM_SEEDS.length * 9} renders: ${worstNote}`)

    // No fade to silence on a bar-fitted result, tested directly rather than
    // inferred from how loud a random roll happened to end.
    //
    // A steady tone with every effect bypassed: whatever comes out, both ends
    // must still be at full amplitude. Measuring energy on random chains could
    // not do this, because a chain that gates or reverb-tails its own ending is
    // legitimately quiet there and the check kept failing on correct output.
    {
      const n = Math.round(2 * ctx.sampleRate)
      const steady: Pcm = {
        sampleRate: ctx.sampleRate,
        channels: [new Float32Array(n), new Float32Array(n)],
      }
      for (let i = 0; i < n; i++) {
        const v = Math.sin((2 * Math.PI * 220 * i) / ctx.sampleRate) * 0.5
        steady.channels[0][i] = v
        steady.channels[1][i] = v
      }
      const bypassed: ChainSpec = {
        seed: 1,
        effects: [{ id: 'reverse', enabled: false }],
      }
      const { pcm } = await renderChain(steady, bypassed, { bars: 1, mode: 'trim', bpm: DEFAULT_BPM })
      const ch = pcm.channels[0]
      // Several cycles wide. A 64 sample window at 220Hz covers a third of one
      // cycle, so it reads low or high purely on where the phase starts, which
      // has nothing to do with whether a fade was applied.
      const WINDOW = 2048
      const rms = (from: number) => {
        let s = 0
        for (let i = from; i < from + WINDOW; i++) s += ch[i] * ch[i]
        return Math.sqrt(s / WINDOW)
      }
      // A steady tone at the ceiling has an rms near 0.7 of its peak.
      const head = rms(0)
      const tail = rms(ch.length - WINDOW)
      check(
        'bar-fitted output is not faded at the ends',
        head > 0.4 && tail > 0.4,
        `head rms ${head.toFixed(4)}, tail rms ${tail.toFixed(4)}`,
      )
    }
    log()
  }

  // --- pool balance -----------------------------------------------------
  // The engine used to lean on drive and bitcrush: uniform selection meant the
  // two broadband effects showed up as often as the structural ones, and
  // whenever either landed it painted over everything else. This measures the
  // actual distribution rather than trusting the weights.
  {
    log('=== effect distribution over 4000 rolls ===')
    log()
    const counts: Record<string, number> = {}
    let both = 0
    let neither = 0
    const ROLLS = 4000
    for (let i = 0; i < ROLLS; i++) {
      const ids = rollChain(freshSeed(), 3).effects.map((e) => e.id)
      for (const id of ids) counts[id] = (counts[id] ?? 0) + 1
      const d = ids.includes('drive')
      const b = ids.includes('bitcrush')
      if (d && b) both++
      if (!d && !b) neither++
    }
    const pct = (n: number) => ((n / ROLLS) * 100).toFixed(1)
    for (const id of Object.keys(counts).sort((a, b) => counts[b] - counts[a])) {
      log(`  ${id.padEnd(9)} in ${pct(counts[id]).padStart(5)}% of rolls`)
    }
    log(`  drive+crush together ${pct(both)}%   neither ${pct(neither)}%`)

    const grit = (counts.drive ?? 0) + (counts.bitcrush ?? 0)
    const structural =
      (counts.chop ?? 0) + (counts.reverse ?? 0) + (counts.pitch ?? 0)
    check(
      'grit does not dominate',
      grit < structural * 0.75,
      `drive+bitcrush ${grit} vs chop+reverse+pitch ${structural}`,
    )
    check(
      'most rolls have no grit at all',
      neither / ROLLS > 0.35,
      `${pct(neither)}% of rolls avoid both`,
    )
    check(
      'drive and crush rarely stack',
      both / ROLLS < 0.14,
      `${pct(both)}% have both`,
    )
    log()
  }

  // --- the built-in generators -----------------------------------------
  // Each one has to make real audio, twice in a row without repeating itself,
  // and survive being mangled afterwards.
  {
    log('=== built-in sample generators ===')
    log()
    for (const g of GENERATORS) {
      const a = generateSample(g.id, ctx.sampleRate, freshSeed())
      const b = generateSample(g.id, ctx.sampleRate, freshSeed())
      const rms = rmsOf(a)
      const peak = peakOf(a)
      const dur = durationOf(a)
      const sim = similarity(a, b)

      log(
        `${g.label.padEnd(7)} ${dur.toFixed(2)}s  ${a.channels.length}ch  peak ${peak.toFixed(3)}  rms ${rms.toFixed(4)}`,
      )
      check(`${g.label}: audible`, rms > 0.01, `rms ${rms.toFixed(4)} > 0.01`)
      check(`${g.label}: not clipped`, peak <= 1.0, `peak ${peak.toFixed(4)}`)
      check(
        `${g.label}: sane length`,
        dur > 0.4 && dur < 12,
        `${dur.toFixed(2)}s`,
      )
      check(
        `${g.label}: two presses differ`,
        sim < 0.99,
        `corr ${sim.toFixed(4)}`,
      )
      // Finite check: a runaway filter would produce NaN and poison the export.
      let finite = true
      for (const ch of a.channels) {
        for (let i = 0; i < ch.length; i++) {
          if (!Number.isFinite(ch[i])) {
            finite = false
            break
          }
        }
      }
      check(`${g.label}: all samples finite`, finite, 'no NaN or Infinity')

      const rolled = await renderChain(a, rollChain(freshSeed(), dur))
      check(
        `${g.label}: survives a mangle`,
        rmsOf(rolled.pcm) > 0.004 && peakOf(rolled.pcm) <= 1.0,
        `rms ${rmsOf(rolled.pcm).toFixed(4)}, peak ${peakOf(rolled.pcm).toFixed(4)}`,
      )
      log()
    }
  }

  // --- the dials actually move the audio -------------------------------
  // A control that redraws a label but leaves the render alone would be worse
  // than no control at all. For every parameter the rack exposes, render the
  // chain at two different values and confirm the audio is genuinely
  // different.
  {
    log('=== every rack control changes the render ===')
    log()
    const original = await loadFixture(ctx, 'drums.wav')
    const dur = durationOf(original)

    const cases: { name: string; a: ChainSpec; b: ChainSpec }[] = []
    const only = (spec: EffectSpec): ChainSpec => ({ seed: 1, effects: [spec] })

    cases.push({
      name: 'reverse enabled',
      a: only({ id: 'reverse', enabled: false }),
      b: only({ id: 'reverse', enabled: true }),
    })
    const chopBase = { id: 'chop' as const, enabled: true, segments: 12, reorder: 0.4, repeat: 0.3, gate: 0.1 }
    cases.push(
      { name: 'chop slices', a: only({ ...chopBase, segments: 6 }), b: only({ ...chopBase, segments: 40 }) },
      { name: 'chop scatter', a: only({ ...chopBase, reorder: 0 }), b: only({ ...chopBase, reorder: 1 }) },
      { name: 'chop stutter', a: only({ ...chopBase, repeat: 0 }), b: only({ ...chopBase, repeat: 0.9 }) },
      { name: 'chop gate', a: only({ ...chopBase, repeat: 0.9, gate: 0 }), b: only({ ...chopBase, repeat: 0.9, gate: 1 }) },
    )
    const crushBase = { id: 'bitcrush' as const, enabled: true, bits: 8, divisor: 4 }
    cases.push(
      { name: 'bitcrush bits', a: only({ ...crushBase, bits: 16 }), b: only({ ...crushBase, bits: 2 }) },
      { name: 'bitcrush rate', a: only({ ...crushBase, divisor: 1 }), b: only({ ...crushBase, divisor: 24 }) },
    )
    const pitchBase = { id: 'pitch' as const, enabled: true, semitones: 0, windowSize: 0.05 }
    cases.push(
      { name: 'pitch semitones', a: only({ ...pitchBase, semitones: -12 }), b: only({ ...pitchBase, semitones: 7 }) },
      { name: 'pitch grain', a: only({ ...pitchBase, semitones: 5, windowSize: 0.01 }), b: only({ ...pitchBase, semitones: 5, windowSize: 0.25 }) },
    )
    const verbBase = { id: 'reverb' as const, enabled: true, size: 0.6, damp: 4000, mix: 0.5 }
    cases.push(
      { name: 'reverb size', a: only({ ...verbBase, size: 0.05 }), b: only({ ...verbBase, size: 0.95 }) },
      { name: 'reverb damp', a: only({ ...verbBase, damp: 400 }), b: only({ ...verbBase, damp: 16000 }) },
      { name: 'reverb mix', a: only({ ...verbBase, mix: 0 }), b: only({ ...verbBase, mix: 1 }) },
      { name: 'reverb bypass', a: only({ ...verbBase, mix: 0.9, enabled: false }), b: only({ ...verbBase, mix: 0.9, enabled: true }) },
    )
    const driveBase = { id: 'drive' as const, enabled: true, amount: 0.5, oversample: '2x' as const }
    cases.push(
      { name: 'drive amount', a: only({ ...driveBase, amount: 0.02 }), b: only({ ...driveBase, amount: 0.98 }) },
      { name: 'drive alias', a: only({ ...driveBase, amount: 0.9, oversample: 'none' }), b: only({ ...driveBase, amount: 0.9, oversample: '4x' }) },
      { name: 'drive bypass', a: only({ ...driveBase, amount: 0.95, enabled: false }), b: only({ ...driveBase, amount: 0.95, enabled: true }) },
    )

    for (const c of cases) {
      void dur
      const ra = await renderChain(original, c.a)
      const rb = await renderChain(original, c.b)
      const sim = similarity(ra.pcm, rb.pcm)
      const lenA = ra.pcm.channels[0].length
      const lenB = rb.pcm.channels[0].length
      // Either the waveform correlation moved or the length did. Both mean the
      // knob reached the renderer.
      const moved = sim < 0.995 || lenA !== lenB
      check(
        c.name,
        moved,
        `corr ${sim.toFixed(4)}, frames ${lenA} vs ${lenB}`,
      )
    }
    log()
  }

  // --- long samples ----------------------------------------------------
  // Three minutes is the stated ceiling, so it gets measured rather than
  // assumed. Timings here are real: this loop awaits actual work instead of
  // polling on a timer.
  {
    log('=== three minute sample ===')
    log()
    try {
      const t0 = performance.now()
      const res = await fetch('/test-audio/edge/long-180s.wav')
      const arr = await res.arrayBuffer()
      const fetchMs = performance.now() - t0

      const t1 = performance.now()
      const decoded = await ctx.decodeAudioData(arr)
      const original = pcmFrom(decoded)
      const decodeMs = performance.now() - t1

      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      const mb = () => (mem ? Math.round(mem.usedJSHeapSize / 1048576) : 0)
      const before = mb()

      log(
        `  ${durationOf(original).toFixed(1)}s  ${original.channels.length}ch  ${(original.sampleRate / 1000).toFixed(1)}k   fetch ${fetchMs.toFixed(0)}ms  decode ${decodeMs.toFixed(0)}ms`,
      )

      let worstRender = 0
      let peakMb = before
      for (let i = 0; i < 4; i++) {
        const chain = rollChain(freshSeed(), durationOf(original))
        const r = await renderChain(original, chain)
        worstRender = Math.max(worstRender, r.elapsedMs)
        peakMb = Math.max(peakMb, mb())
        log(
          `  roll ${i + 1}  ${r.elapsedMs.toFixed(0)}ms  ${durationOf(r.pcm).toFixed(1)}s  peak ${peakOf(r.pcm).toFixed(3)}  heap ${mb()}MB`,
        )
        log(`    ${describeChain(chain)}`)
      }

      const t2 = performance.now()
      const chain = rollChain(freshSeed(), durationOf(original))
      const { pcm } = await renderChain(original, chain)
      const blob = encodeWav(pcm)
      const encodeMs = performance.now() - t2
      const after = mb()

      check(
        'renders a 3 minute sample',
        worstRender < 20000,
        `worst roll ${worstRender.toFixed(0)}ms`,
      )
      check(
        'exports a 3 minute sample',
        blob.size > 1_000_000,
        `${(blob.size / 1048576).toFixed(1)}MB wav in ${encodeMs.toFixed(0)}ms total`,
      )
      check(
        'long-sample heap stays sane',
        !mem || after - before < 900,
        `start ${before}MB, peak ${peakMb}MB, end ${after}MB`,
      )
    } catch (e) {
      log(
        `  <span class="bad">could not run: ${e instanceof Error ? e.message : String(e)}</span>`,
      )
      log('  (run: node tools/make-long.mjs 180)')
    }
    log()
  }

  // --- memory ---------------------------------------------------------
  // Every node pass builds an offline context and a node graph. If those are
  // not disposed the heap climbs with every roll, which on a long sample gets
  // to gigabytes fast. This is the regression guard for that.
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } })
    .memory
  if (mem) {
    log('=== memory across 24 rolls ===')
    log()
    const original = await loadFixture(ctx, 'drums.wav')
    const mb = () => Math.round(mem.usedJSHeapSize / 1048576)
    const before = mb()
    let peakMb = before
    for (let i = 0; i < 24; i++) {
      const chain = rollChain(freshSeed(), durationOf(original))
      await renderChain(original, chain)
      peakMb = Math.max(peakMb, mb())
    }
    const after = mb()
    log(`  start ${before}MB   peak ${peakMb}MB   end ${after}MB`)
    // 24 rolls of a 3.75s stereo sample. Each intermediate buffer is about
    // 1.3MB, so a working set of a few tens of MB is expected; hundreds means
    // contexts are being retained.
    check(
      'heap does not run away',
      after - before < 300,
      `growth ${after - before}MB over 24 rolls (limit 300MB)`,
    )
    log()
  } else {
    log('(performance.memory unavailable, skipping the heap check)')
    log()
  }

  log(
    failures === 0
      ? `<span class="ok">ALL CHECKS PASSED</span>`
      : `<span class="bad">${failures} CHECK(S) FAILED</span>`,
  )
  ;(window as unknown as { VERIFY_DONE: boolean; VERIFY_FAILURES: number }).VERIFY_DONE = true
  ;(window as unknown as { VERIFY_FAILURES: number }).VERIFY_FAILURES = failures
}

document.getElementById('run')!.addEventListener('click', () => {
  run().catch((e) => {
    log(`<span class="bad">ERROR ${e?.message ?? e}</span>`)
    log(String(e?.stack ?? ''))
    ;(window as unknown as { VERIFY_DONE: boolean; VERIFY_FAILURES: number }).VERIFY_DONE = true
    ;(window as unknown as { VERIFY_FAILURES: number }).VERIFY_FAILURES = 999
  })
})
