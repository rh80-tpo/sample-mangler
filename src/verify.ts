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
import { durationOf, peakOf, pcmFrom, rmsOf, type Pcm } from './audio/buffers'
import { renderChain } from './audio/render'
import { encodeWav, QUANTISATION_STEP } from './audio/wav'
import { freshSeed } from './audio/rng'

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

    for (let roll = 0; roll < 6; roll++) {
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
