# HAZEN sample mangler — native

First steps toward a plugin. Read the status section before assuming anything
here loads in a DAW, because most of it does not yet.

## Status, honestly

| Piece | State |
|---|---|
| `include/hazen/dsp.hpp` | Real. Compiles, tested, verified against the web build. |
| `tests/test_dsp.cpp` | Real. 13 checks, all passing, run with clang. |
| `plugin/` | Scaffold only. **Never compiled.** Needs cmake, full Xcode and JUCE. |

The DSP core is genuinely done and genuinely verified. The plugin wrapper is a
skeleton written from the JUCE API, and it has not been built even once, so
treat it as a starting point rather than working code.

### Why the wrapper is unverified

Building a VST3 on this machine needs three things that are not installed:

- **cmake** — not present
- **full Xcode** — only Command Line Tools are here, and VST3/AU bundle
  packaging and signing need the full install
- **JUCE** — roughly 500MB, not present

clang 17 *is* available, which is why the DSP core could be compiled and tested
for real while the wrapper could not.

## Running the DSP tests

```
c++ -std=c++20 -O2 -Wall -Wextra -I native/include \
    native/tests/test_dsp.cpp -o /tmp/test_dsp && /tmp/test_dsp
```

The reference vectors in that file were captured from the TypeScript running in
the browser, on the same input with the same parameters. Decimation matches to
0.000000 and the distortion curve to 0.000010, the residual being the finite
lookup table the browser's WaveShaper interpolates through.

That test has already earned its keep: it caught a loop-seam bug that the
browser suite was passing vacuously, because the web build faded both ends to
silence afterwards and the assertion compared 0 against 0. Porting the function
somewhere without that fade is what exposed it.

## What ported, and what did not

**Ported and verified:** reverse, sample-and-hold decimation, bit-depth
quantisation, the distortion curve, Schroeder reverb, peak normalisation, the
loop seam.

**Not ported, deliberately:**

- **Pitch shift.** The web build uses Tone.js's granular shifter. A C++
  equivalent is a real piece of work, not a translation, and doing it badly is
  worse than not doing it.
- **Chop.** The algorithm ports directly but it is a buffer rearrangement, not
  a streaming process, so where it lives depends on the architecture below.
- **Freeverb.** The web build uses Tone's; the reverb here is the one from the
  generators. They sound different.

## The architecture problem, stated up front

The web tool **renders offline and then plays the result**. That is why preview
and export cannot drift apart, and it is the right design for a browser tool.

A plugin does not work that way. It gets a callback every few milliseconds and
has to fill a buffer in real time, with no opportunity to render the whole
thing first.

So a plugin version is not a port, it is a different shape:

- A **sampler plugin** is the honest translation. Load or drop a sample, apply
  the chain once when a parameter changes, play the rendered buffer back on a
  trigger. Effects stay offline, which keeps them identical to the web build.
- A **real-time effect plugin** would mean rewriting reverse and chop, which
  need the whole buffer, into something streaming. Reverse cannot be done
  streaming at all without latency equal to the buffer length.

The scaffold in `plugin/` is set up as the sampler shape, because it preserves
the thing that makes the tool trustworthy.

## To actually build it

```
brew install cmake
# install Xcode from the App Store, then:
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
git clone --depth 1 https://github.com/juce-framework/JUCE native/JUCE
cmake -B native/build -S native/plugin -DCMAKE_BUILD_TYPE=Release
cmake --build native/build --config Release
```

Output lands in `native/build/HazenMangler_artefacts/Release/`. The VST3 goes in
`~/Library/Audio/Plug-Ins/VST3`, the AU in `~/Library/Audio/Plug-Ins/Components`.

None of the above has been run. Expect the first build to need fixing.
