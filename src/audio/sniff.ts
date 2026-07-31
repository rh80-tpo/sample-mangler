/**
 * Read the declared sample rate out of a file's header without decoding it.
 *
 * decodeAudioData always resamples to the AudioContext's rate, so a 48k stem
 * decoded in a 44.1k context comes back as 44.1k and exports as 44.1k. For a
 * tool whose output is meant to drop into a session, silently changing the
 * rate is the wrong default. Knowing the rate up front lets us open the
 * context at the file's own rate and skip the conversion entirely.
 *
 * WAV and AIFF are parsed because they are what stems and one-shots actually
 * ship as. Compressed formats return null and fall back to the hardware rate,
 * which the interface then displays honestly.
 */
export function sniffSampleRate(bytes: ArrayBuffer): number | null {
  const view = new DataView(bytes)
  if (view.byteLength < 16) return null

  const tag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    )

  // --- RIFF / WAVE ---------------------------------------------------
  if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
    let pos = 12
    while (pos + 8 <= view.byteLength) {
      const id = tag(pos)
      const size = view.getUint32(pos + 4, true)
      if (id === 'fmt ' && pos + 12 <= view.byteLength) {
        const rate = view.getUint32(pos + 12, true)
        return plausible(rate) ? rate : null
      }
      pos += 8 + size + (size % 2)
    }
    return null
  }

  // --- AIFF / AIFC ---------------------------------------------------
  if (tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC')) {
    let pos = 12
    while (pos + 8 <= view.byteLength) {
      const id = tag(pos)
      const size = view.getUint32(pos + 4, false)
      if (id === 'COMM' && pos + 18 <= view.byteLength) {
        // The rate is an 80-bit IEEE extended float, which nothing else uses.
        const expon = view.getUint16(pos + 16, false)
        const hi = view.getUint32(pos + 18, false)
        const lo = view.getUint32(pos + 22, false)
        const sign = expon & 0x8000 ? -1 : 1
        const e = (expon & 0x7fff) - 16383
        const mantissa = hi * 2 ** 32 + lo
        const rate = sign * mantissa * 2 ** (e - 63)
        return plausible(rate) ? Math.round(rate) : null
      }
      pos += 8 + size + (size % 2)
    }
    return null
  }

  return null
}

/** Web Audio will refuse anything outside roughly this band anyway. */
function plausible(rate: number): boolean {
  return Number.isFinite(rate) && rate >= 8000 && rate <= 192000
}
