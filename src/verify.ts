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
import { durationOf, peakOf, pcmFrom, rmsOf, type Pcm } from './audio/buffers'
import { renderChain } from './audio/render'
import { encodeWav, QUANTISATION_STEP } from './audio/wav'
import { freshSeed } from './audio/rng'
import { GENERATORS, generateSample } from './audio/generate'

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
    let identical = 0
    let maxPairCorr = 0
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const s = similarity(results[i].pcm, results[j].pcm)
        maxPairCorr = Math.max(maxPairCorr, s)
        if (s > 0.999) identical++
      }
    }
    check(
      'rerolls all differ',
      identical === 0,
      `${identical} identical pairs of 15, worst-case corr ${maxPairCorr.toFixed(4)}`,
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
