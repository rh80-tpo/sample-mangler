# Sample Mangler — v0 spec

## Concept

Upload one of your own audio samples. The site runs it through a randomized chain of
destructive effects and plays back the wreckage. Reroll for a new random chain as many
times as you want. Export the current result as a WAV you can drop straight into a DAW.

For Ryan, an EDM producer. Stems, one-shots, short loops, typically under 30 seconds.

## Core feeling

A slot machine for sound. The value is not control, it is the gamble.

## v0 scope (the whole feature list, nothing more)

1. Upload an audio file. Show a waveform of the original.
2. Hit mangle. A random subset of the effects pool, in random order, with randomized
   parameters, runs on the sample.
3. Play the result. Show a waveform of the mangled version.
4. Reroll replaces the entire chain with a new random one.
5. Export the current result as a WAV file.

Interface surface, complete: upload zone, two waveforms, play, reroll, export. Nothing else.

## Effects pool

Five effects. A roll uses a random subset, never a fixed set, in random order.

| Effect | Implementation | Stage |
|---|---|---|
| Reverse | Sample buffer reversal | buffer |
| Chop / stutter | Slice into segments, reorder and repeat some, micro-fade the seams | buffer |
| Bitcrush | `Tone.BitCrusher` for bit depth, sample-and-hold decimation for rate | node |
| Pitch shift | `Tone.PitchShift` | node |
| Distortion / saturation | `Tone.Distortion` | node |

Buffer-stage effects transform the audio buffer directly. Node-stage effects are Tone nodes
in an offline render. Order is randomized across all five, not just within a stage: the
renderer splits the chain into passes, running consecutive node stages in one offline render
and applying buffer stages between passes. So `distortion -> reverse -> bitcrush` is a real
possible roll, not an approximation of one.

## The correctness requirement

The exported WAV must sound identical to what was just previewed. This is the single most
important thing in the build.

Architecture that makes a mismatch structurally impossible: render once, offline, and use
the resulting AudioBuffer for both jobs.

```
file -> decode -> AudioBuffer (original)
                     |
                  roll seed -> chain spec
                     |
              offline render (Tone.Offline, multi-pass)
                     |
              AudioBuffer (mangled)   <- the single source of truth
                   /        \
            preview          WAV encode
```

There is no separate live-preview signal path. Preview plays the exact buffer that gets
encoded. The two cannot drift because there is only one of them.

Verified early, not at the end: decode the exported WAV back and compare it sample for
sample against the render buffer.

## Stack

- Vite, React 19, TypeScript
- Tone.js for the effects chain and offline rendering
- Web Audio `OfflineAudioContext` under Tone.Offline for the render
- Canvas 2D for both waveforms, hand drawn, no waveform library
- Framer Motion for interface motion
- Fontsource for self-hosted type

No backend, no database, no accounts. The audio file never leaves the browser.

## Scope change, mid-build

Per-effect control was originally cut from v0. Ryan reversed that during the
build: every parameter that changes the audio now gets a control, adjustable
live.

That means the rack exists, and it necessarily shows which effects are in the
current chain. The reroll still replaces the whole chain, and effect *order* is
still only ever set by a roll, never by hand.

## Still out of scope

- Accounts, saved history, any persistence
- Video processing of any kind, including a placeholder for it
- A mixer UI, sends, or routing
- Reordering the chain by hand

## Parameter ranges

Tuned so most rolls land usable and musical, with genuinely broken results still reachable.
Ranges and the reasoning behind them land in `RANGES.md` once they are set against real audio.

## Deploy

Fly.io, static SPA served by Caddy, scale to zero. Rollback tag before every deploy.
GitHub push as durable backup.
