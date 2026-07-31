# Parameter ranges, and why

Two different jobs here. A **roll** has to land usable most of the time without
becoming predictable. A **knob** has to let you go past whatever the roll would
have given you. So the roll ranges sit inside the knob ranges on purpose.

## How many effects a roll uses

| Count | Weight |
|---|---|
| 1 | 0.10 |
| 2 | 0.31 |
| 3 | 0.32 |
| 4 | 0.21 |
| 5 | 0.06 |

Two and three dominate because that is where the result still reads as the
source you fed in. All five at once is rare on purpose: that is the roll that
comes back genuinely destroyed, and it should feel like it cost something.

## The solo rule

When a roll picks exactly one effect, that effect has to carry the whole thing,
so its parameters are drawn from the more committed part of its range.

This came out of a real failure. A roll produced `bitcrush(8 bits, no rate
reduction)` on its own, which correlated 0.9960 with the source. Technically a
mangle, audibly nothing. Verification caught it. Now a solo bitcrush can never
roll a divisor of 1, a solo drive starts at 0.35 instead of 0.18, and a solo
chop guarantees real scatter and stutter.

## Per effect

| Effect | Parameter | Roll range | Knob range | Reasoning |
|---|---|---|---|---|
| reverse | (none) | always full | bypass only | Reversing is all or nothing. |
| chop | slices | 45ms to 320ms per slice, converted to a count | 2 to 64 | Segment *length* is what decides character, not count. A fixed count means something completely different on a 0.4s one-shot than on a 6s loop. Above ~320ms the reorder stops reading as an effect and just sounds like a bad edit; below ~45ms it stops being a chop and becomes a buzz. |
| chop | scatter | 0.15 to 0.65 (solo: 0.35 to 0.65) | 0 to 1 | Positions are swapped in pairs rather than fully shuffled, so the result still tracks the shape of the original. |
| chop | stutter | 0.12 to 0.45 (solo: 0.25 to 0.45) | 0 to 1 | A repeat steals the next slot instead of extending the file, which is what holds total length stable. |
| chop | gate | 0.0 to 0.3 | 0 to 1 | Gating is the most destructive control here. Kept low on rolls, fully open on the knob. |
| bitcrush | bits | 7 to 12, or 4 to 6 on a 30% "wrecked" branch | 1 to 16 | 7 to 12 is the lo-fi band: audible grit, source intact. 4 to 6 is where it falls apart. Below 4 everything becomes the same square-wave fizz regardless of input, which is not interesting, so rolls floor at 4. The knob goes to 1 anyway because sometimes you want the fizz. |
| bitcrush | rate | 1, 2-4, 5-9, or 10-16, weighted toward the low end | 1 to 32 | Sample-and-hold. At 48k, divisor 6 lands near 8kHz, the classic sampler sound. 16 lands near 3kHz: very broken, still readable as the original. |
| pitch | semitones | 70% from a musical set (octaves, fifths, fourths, thirds), else -24 to +12 continuous | -24 to +24 | Down is more useful than up. Pitching down adds weight and keeps the transient; past an octave up it thins out and gets cartoonish. Hence the asymmetric roll ceiling of +12. The musical-set bias means most pitched rolls drop into a project without retuning. |
| pitch | grain | 0.03 to 0.09 | 0.01 to 0.25 | Tone's shifter is granular, so window size drives the artefacts. Small windows sound rougher, which is on-brief, so the roll range sits low. |
| drive | amount | 0.18 to 0.62, or 0.62 to 0.92 on a 25% "hard" branch | 0 to 1 | Past ~0.7 Tone.Distortion is mostly square wave; under ~0.15 it is inaudible. |
| drive | alias | 2x or 4x 80% of the time, else none | none / 2x / 4x | Oversampling is on most of the time because the aliasing without it reads as a bug rather than a choice. It gets switched off deliberately, not by accident. |

## Output level

Every result is peak-normalised to **0.891 (-1.0 dBFS)**.

Two reasons. Distortion and bitcrush both raise level a lot, so without this the
loud rolls would clip and the quiet ones would be unusable. And a sample tool
should hand back a predictable level every time, so rolls are comparable to each
other and drop into a session at a known gain.

Near-silent output is left alone rather than normalised, because amplifying
silence just turns the noise floor into the result. That case is detected and
reported instead.
