# Phase 0.5 — elevation brief

## 1. What this product is secretly about

Not audio processing. The flinch. You hand the machine something you made and it hands back
something you did not expect, and the good rolls feel like luck. It is a slot machine with a
signal chain inside it.

That means the interface has one job: make the moment of the roll feel like something
happened to your sound, not like a form submitted successfully.

## 2. The AI-default version of each surface, named so it can be rejected

| Surface | The reflex version |
|---|---|
| Upload zone | Dashed 2px border rounded rectangle, cloud-with-arrow icon, "Drag and drop your file here or click to browse" |
| Waveforms | Two wavesurfer.js instances stacked in cards, default blue bars, a playhead line |
| Mangle button | Filled pill, indigo to violet gradient, sparkle icon, centered under the waveform |
| Result state | A toast that says "Success! Your audio has been mangled." and a green check |
| Page | Centered hero, subhead, three identical feature cards below, purple glow blobs |
| Type | Inter everywhere, one weight, gradient on the h1 |
| Motion | 200ms fade-in, everything eases the same, nothing reacts to anything |

Every row above is banned for this build.

## 3. The signature direction, surface by surface

**The waveform is the product, so it gets the real work.** Hand drawn on canvas, not a
library. Not symmetric bars: a dense vertical scan rendered from real min/max peak pairs, so
it reads like a spectrogram slice off a hardware sampler rather than a widget. The original
renders in cold bone. The mangled renders in hot signal. The two share a baseline and a scale
so you can see, physically, what got shorter, louder, more violent.

**The mangled waveform does not fade in. It arrives.** On a roll, the mangled canvas resolves
column by column at speed, left to right, like a render head sweeping the buffer. That sweep
is the loading state, so there is never a spinner. The sweep duration is honest: it tracks
the real render.

**Reroll is the hero interaction and it is physical.** Not a button that gets pressed. A slab
you slam. It carries weight on hover, drops on press, and on release the entire page takes a
single hard flinch, one frame of displacement, then settles. The display face is variable
(width axis), and the wordmark compresses and snaps back on every roll. The type itself gets
mangled. That is the joke and it is the signature.

**The mangled state is loud and the original state is quiet.** Before a roll, the page is
almost monochrome. After a roll, the signal color exists. Color arrives as a result of an
action rather than as decoration.

**No chain readout.** The temptation is a "reverse -> bitcrush -> chop" receipt. That is the
chain visualization the spec cut. You do not get to know. Not knowing is why you reroll.

## 4. Design defaults, proposed against `design-signature.md`

| Default | Call | Reason |
|---|---|---|
| Light theme | **Override to dark** | Producers work in dark rooms in dark DAWs. The concept is genuinely nocturnal and high drama, which is the documented reason the light default can be dropped. |
| Real imagery over code illustration | **Not applicable** | This is not an image-forward site. Its only visual content is generated from the user's own audio, which is real data, not illustration. |
| Distinctive display face | **Apply** | `Anybody` variable from fontsource. It has a width axis, which is what makes the wordmark compression on roll possible. Not a decorative choice, a functional one. |
| Understated wordmark | **Apply** | Small, lowercase, top left. It earns attention by moving, not by being big. |
| Structure-focused imagery | **Apply, translated** | Show the sample's actual structure, the peaks, not a generic audio motif. |
| Honest content | **Hard rule** | No fake claims about what the effects do. No invented preset names. |

Second family: `Martian Mono` for labels and numerals. Not JetBrains Mono, which is banned.

Palette: near black ground, warm bone text, one accent, a hot vermillion signal. No purple,
no indigo, no violet, no gradient text.
