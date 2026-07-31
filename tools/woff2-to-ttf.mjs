/**
 * Decompress the brand woff2 files to ttf so the OG card and favicon can be
 * drawn with the real typefaces instead of a lookalike.
 *
 *   node tools/woff2-to-ttf.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { decompress } = require('wawoff2')

const jobs = [
  [
    'node_modules/@fontsource-variable/anybody/files/anybody-latin-wdth-normal.woff2',
    'anybody.ttf',
  ],
  [
    'node_modules/@fontsource/martian-mono/files/martian-mono-latin-700-normal.woff2',
    'martian-700.ttf',
  ],
  [
    'node_modules/@fontsource/martian-mono/files/martian-mono-latin-400-normal.woff2',
    'martian-400.ttf',
  ],
]

mkdirSync(new URL('../.fonts/', import.meta.url), { recursive: true })

for (const [src, out] of jobs) {
  const buf = readFileSync(new URL('../' + src, import.meta.url))
  const ttf = await decompress(buf)
  const dest = new URL('../.fonts/' + out, import.meta.url)
  writeFileSync(dest, Buffer.from(ttf))
  console.log(`${out}  ${buf.length} -> ${ttf.length} bytes`)
}
