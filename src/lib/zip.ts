/**
 * Minimal ZIP writer, store method only.
 *
 * No compression on purpose. The payload is 24-bit PCM, which deflate barely
 * touches, so compressing it would cost real time to save almost nothing. This
 * keeps mass export dependency-free.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array<ArrayBuffer>): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/** Pinned to a plain ArrayBuffer so the parts hand straight to Blob. */
export type ZipEntry = { name: string; data: Uint8Array<ArrayBuffer> }

/** DOS time/date. Zip has no concept of a timezone, so local is fine. */
function dosStamp(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export function buildZip(entries: ZipEntry[], when = new Date()): Blob {
  const { time, date } = dosStamp(when)
  const encoder = new TextEncoder()
  const parts: BlobPart[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true) // local file header
    local.setUint16(4, 20, true) // version needed
    local.setUint16(6, 0, true) // flags
    local.setUint16(8, 0, true) // method: store
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, size, true)
    local.setUint32(22, size, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true)

    parts.push(local.buffer, nameBytes, entry.data)

    const dir = new DataView(new ArrayBuffer(46))
    dir.setUint32(0, 0x02014b50, true) // central directory header
    dir.setUint16(4, 20, true)
    dir.setUint16(6, 20, true)
    dir.setUint16(8, 0, true)
    dir.setUint16(10, 0, true)
    dir.setUint16(12, time, true)
    dir.setUint16(14, date, true)
    dir.setUint32(16, crc, true)
    dir.setUint32(20, size, true)
    dir.setUint32(24, size, true)
    dir.setUint16(28, nameBytes.length, true)
    dir.setUint16(30, 0, true)
    dir.setUint16(32, 0, true)
    dir.setUint16(34, 0, true)
    dir.setUint16(36, 0, true)
    dir.setUint32(38, 0, true)
    dir.setUint32(42, offset, true)

    const dirBytes = new Uint8Array(46 + nameBytes.length)
    dirBytes.set(new Uint8Array(dir.buffer), 0)
    dirBytes.set(nameBytes, 46)
    central.push(dirBytes)

    offset += 30 + nameBytes.length + size
  }

  const centralSize: number = central.reduce((a, b) => a + b.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true) // end of central directory
  end.setUint16(4, 0, true)
  end.setUint16(6, 0, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  end.setUint16(20, 0, true)

  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' })
}
