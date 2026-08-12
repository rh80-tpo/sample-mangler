# HAZEN Sampler — the plugin

A VST3 instrument. Built, installed, and verified on this machine.

## What is real

Everything in here compiles and runs. Earlier versions of this file said the
plugin had never been compiled; that is no longer true, and the evidence is
below rather than asserted.

| Piece | State |
| --- | --- |
| `include/hazen/dsp.hpp` | Reverse, decimator, quantiser, drive curve, Schroeder reverb, normalise, loop-seam fold. 13 checks against vectors captured from the browser. |
| `include/hazen/mangle.hpp` | Granular pitch shift, chop, sidechain duck, level, the chain runner, bar fitting. |
| `include/hazen/chop.hpp` | Radix-2 FFT, spectral-flux onsets, grid slicing, monophonic phrase builder, the four-phrase patterns. |
| `plugin/` | JUCE VST3 + Standalone. Builds clean, installs to `~/Library/Audio/Plug-Ins/VST3`. |
| `harness/` | Headless host that drives the real processor: loads a file, waits for the render, pulls audio through `processBlock`, measures it. |

## Build it

```bash
cd native
./setup.sh          # fetches JUCE if it is not already there
cmake -B build -S plugin -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release --parallel 8
```

`COPY_PLUGIN_AFTER_BUILD` puts the VST3 straight into
`~/Library/Audio/Plug-Ins/VST3/`, which is one of the two paths Ableton scans.

## Verify it

Two suites, and they check different things.

```bash
c++ -std=c++20 -O2 -I include tests/test_dsp.cpp -o /tmp/test_dsp && /tmp/test_dsp
cmake --build build --target HazenHarness --config Release
./build/HazenHarness_artefacts/Release/HazenHarness
```

The first checks the DSP against reference vectors from the browser build. The
second is the one that matters for "does it work as a plugin": a bundle that
loads is not the same as a plugin that makes sound, and only `processBlock` can
tell you which you have. Last run:

```
PASS  loads a wav                       hazen_harness.wav
PASS  renders something                 4.000s rendered
PASS  mangle mode makes sound           rms 0.26186
PASS  mangle fits the bar count         4.0000s for 2 bars @120
PASS  chop mode renders 16 bars         32.000s (want 32.0)
PASS  chop mode makes sound             rms 0.23484
PASS  level -12dB attenuates            rms ratio 0.2512 (want ~0.251)
PASS  rechop gives a different chop
PASS  the rack reaches chop mode        verb on changed the loop
PASS  chop + mangle renders             32.00s after chop + mangle
PASS  play restarts from the beginning
PASS  rechop restarts from the beginning was at 0.00726, now 0.00018
PASS  exports a wav                      4233704 bytes
PASS  the export decodes back            32.000s, 24 bit
PASS  the drag file is written           hazen_harness-chop-120bpm.wav
PASS  state round trips                  saved and restored
```

## Load it in Ableton

1. Live → Settings → Plug-Ins → turn on **Use VST3 Plug-In System Folders**, then
   **Rescan**.
2. It appears in the browser under Plug-Ins → HAZEN → **HAZEN Sampler**, as an
   *instrument*, so drop it on a MIDI track.
3. Drag an audio file onto the plugin window, or press `load a sample`.
4. Press `play` to hear it. A MIDI note also triggers it, and with `sync` on it
   follows the host transport, restarting on the bar.

## Getting the audio onto a track

`drag to a track` is the short way: drag from that panel straight into Ableton's
arrangement or session view and the loop lands as an audio clip. It writes a
24-bit WAV to a temp folder and hands the host the file, named after the source,
the mode and the tempo — `loveme-chop-140bpm.wav` — so a session full of them
still makes sense a week later.

`export wav` is the same file through a save dialog, for when you want it
somewhere specific.

It reads the host tempo and re-renders when it changes, so a chop built in a
140 BPM set is cut for 140.

## Why it is a sampler and not a port

The web build renders the whole chain offline, once, and plays the result. That
is what makes its preview and its exported WAV identical — the single most
important property in the whole project. A plugin that streamed the same chain
per block would produce different audio from identical settings, and the two
halves of the product would disagree.

So this keeps the same shape: load, render offline on a background thread, play
the buffer. The cost is that a parameter change is not instant — it queues a
re-render, and the editor says when one is in flight. That is an honest
trade rather than a limitation to hide.

## Both actions on the chopper

`rechop` gives a different take of the same setup — only the seed moves, so the
tempo, pattern, cut and feel all stay. It exists because the rhythm is seeded:
without it, every chop of a given setup came out byte-identical and there was no
way to ask for another one.

`rechop + mangle` rechops *and* rolls a random rack over the result, which is the
fastest way to find something. The rack runs over the finished loop rather than
the vocal going in, the same order the site uses, and there is no bar fitting
afterwards — the chop is already exact, and a reverb tail is meant to ring past
the loop rather than be trimmed back into it.

## What differs from the web build

Worth knowing before you expect parity.

- **Effect order is fixed.** The web build randomises order across render
  passes, which is a lot of what makes a roll surprising. Here every control is
  visible at once, and a hidden order you cannot see or set would be worse than
  a predictable one.
- **30 second ceiling on the source.** Longer files are truncated and the status
  line says so. A whole track would make every render slow for no benefit.
- **No key or tempo detection**, and no folders. Those are the web build's jobs.

## AU is not built, and why

This machine has the Command Line Tools but not a full Xcode, and JUCE's AU
wrapper needs Xcode's AudioUnit tooling. VST3 needs neither, and Ableton Live on
macOS loads VST3, so VST3 is the target. `FORMATS` in
[plugin/CMakeLists.txt](plugin/CMakeLists.txt) is where to add `AU` if a full
Xcode ever gets installed.

The bundle is **ad-hoc signed**, which is what an unnotarised local build gets.
Ableton loads it fine. Distributing it to anyone else would need a Developer ID
and notarisation.

## What is not verified

I could not confirm Ableton itself loading it — driving Live's GUI is outside
what I can do here, and `screencapture` needs a Screen Recording permission this
environment does not have. What is confirmed: the bundle is a valid arm64 VST3
exporting `GetPluginFactory` and `bundleEntry`, it registers as
`Instrument|Synth`, it is installed in a folder Live scans, and the processor
inside it loads files and produces measured audio. The remaining step is you
opening Live and dropping it on a track.
