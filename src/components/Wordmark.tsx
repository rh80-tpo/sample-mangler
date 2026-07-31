/**
 * HAZEN, set as ΗΛΖΞΝ.
 *
 * Drawn as paths rather than typed as Greek characters. Anybody ships latin,
 * latin-ext and vietnamese only, so the real Greek codepoints would fall back
 * to a system font and sit next to the wordmark looking like a different
 * product. These are geometric caps built to match the display face's weight,
 * which is what a logotype should be anyway.
 *
 * The glyphs are decorative: the accessible name comes from the text beside
 * them, so a screen reader says "HAZEN" rather than five Greek letter names.
 */

/** Each glyph is drawn on a 62 x 100 box with an 18 unit stroke. */
const GLYPHS = [
  // Eta
  'M0,0 H18 V41 H44 V0 H62 V100 H44 V59 H18 V100 H0 Z',
  // Lambda
  'M22,0 H40 L62,100 H44 L31,42 L18,100 H0 Z',
  // Zeta
  'M0,0 H62 V18 L28,82 H62 V100 H0 V82 L34,18 H0 Z',
  // Xi: three bars, no stems
  'M0,0 H62 V18 H0 Z M8,41 H54 V59 H8 Z M0,82 H62 V100 H0 Z',
  // Nu
  'M0,100 V0 H18 L44,62 V0 H62 V100 H44 L18,38 V100 Z',
]

const STEP = 78 // 62 wide plus a 16 gap
const WIDTH = GLYPHS.length * 62 + (GLYPHS.length - 1) * 16

export function Wordmark() {
  return (
    <svg
      className="mark__owner"
      viewBox={`0 0 ${WIDTH} 100`}
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS.map((d, i) => (
        <path key={i} d={d} transform={`translate(${i * STEP} 0)`} />
      ))}
    </svg>
  )
}
