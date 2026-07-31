import type { Pcm } from './buffers'

/**
 * Getting audio out of a file the browser may or may not understand.
 *
 * `decodeAudioData` is tried first: it is fast, native, and handles wav, mp3,
 * flac, m4a and opus. What it does NOT handle in Chromium is AIFF, which is
 * the format Logic and Ableton render by default on a Mac. Dropping a .aif in
 * would just fail, which is exactly the file a producer reaches for most.
 *
 * So when the native path fails we parse it ourselves. AIFF, AIFC and CAF are
 * all uncompressed PCM in a simple chunk container, which is the overwhelming
 * majority of what a DAW writes.
 */

/**
 * Limits, measured rather than guessed.
 *
 * Decoded audio is Float32, so a stereo 48k minute costs about 22MB of heap
 * whatever the file was compressed to, and the render pipeline holds several
 * of those at once. Measured on this machine:
 *
 *   60s   15MB file    22MB decoded   0.7s per roll    115MB heap
 *   3min  49MB file    66MB decoded   7.5s per roll    436MB heap
 *   10min 165MB file  220MB decoded  15.8s per roll   1433MB heap
 *
 * Ten minutes still completes, but a 16 second freeze per roll is not a tool
 * you can use, and the heap is close to where a tab gets killed. So: refuse
 * past ten minutes, and say so plainly rather than locking up and dying.
 */
export const MAX_SECONDS = 600
export const WARN_SECONDS = 200
/**
 * Checked before reading the file, from `File.size` alone. 24-bit stereo 48k
 * runs about 17MB a minute, so this is roughly twenty minutes of the heaviest
 * format anyone actually renders. The point is to refuse before pulling a
 * gigabyte into memory, not to be exact.
 */
export const MAX_BYTES = 400 * 1024 * 1024

export type DecodeFailure =
  | 'empty'
  | 'too-large'
  | 'too-long'
  | 'unknown-format'
  | 'compressed-aifc'
  | 'undecodable'

export class DecodeError extends Error {
  reason: DecodeFailure

  constructor(reason: DecodeFailure, message: string) {
    super(message)
    this.name = 'DecodeError'
    this.reason = reason
  }
}

const ascii = (v: DataView, at: number, n = 4) => {
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(at + i))
  return s
}

/** IEEE 754 80-bit extended, which only AIFF uses. */
function extended80(v: DataView, at: number): number {
  const expon = v.getUint16(at, false)
  const hi = v.getUint32(at + 2, false)
  const lo = v.getUint32(at + 6, false)
  const sign = expon & 0x8000 ? -1 : 1
  const e = (expon & 0x7fff) - 16383
  return sign * (hi * 2 ** 32 + lo) * 2 ** (e - 63)
}

type RawPcm = {
  channels: number
  bits: number
  sampleRate: number
  /** true for float samples, false for signed integer */
  float: boolean
  littleEndian: boolean
  start: number
  frames: number
}

/** Turn interleaved bytes into per-channel float arrays. */
function readSamples(view: DataView, spec: RawPcm): Pcm {
  const { channels, bits, float, littleEndian, start, frames } = spec
  const bytes = bits / 8
  const out: Float32Array<ArrayBuffer>[] = []
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames))

  const available = Math.floor((view.byteLength - start) / (bytes * channels))
  const n = Math.max(0, Math.min(frames, available))

  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      const at = start + (i * channels + c) * bytes
      let value: number
      if (float) {
        value = bits === 64 ? view.getFloat64(at, littleEndian) : view.getFloat32(at, littleEndian)
      } else if (bits === 8) {
        // 8-bit AIFF is signed; 8-bit WAV is unsigned, but WAV never reaches
        // this path because the native decoder handles it.
        value = view.getInt8(at) / 128
      } else if (bits === 16) {
        value = view.getInt16(at, littleEndian) / 32768
      } else if (bits === 24) {
        const b0 = view.getUint8(at)
        const b1 = view.getUint8(at + 1)
        const b2 = view.getUint8(at + 2)
        let raw = littleEndian
          ? b0 | (b1 << 8) | (b2 << 16)
          : b2 | (b1 << 8) | (b0 << 16)
        if (raw & 0x800000) raw -= 0x1000000
        value = raw / 8388608
      } else if (bits === 32) {
        value = view.getInt32(at, littleEndian) / 2147483648
      } else {
        throw new DecodeError('undecodable', `${bits}-bit samples are not supported`)
      }
      out[c][i] = Math.max(-1, Math.min(1, value))
    }
  }

  return { channels: out, sampleRate: spec.sampleRate }
}

/** AIFF and AIFC. */
function parseAiff(view: DataView): Pcm | null {
  if (ascii(view, 0) !== 'FORM') return null
  const kind = ascii(view, 8)
  if (kind !== 'AIFF' && kind !== 'AIFC') return null

  let pos = 12
  let comm: RawPcm | null = null
  let compression = 'NONE'
  let ssndAt = -1

  while (pos + 8 <= view.byteLength) {
    const id = ascii(view, pos)
    const size = view.getUint32(pos + 4, false)
    const body = pos + 8

    if (id === 'COMM' && body + 18 <= view.byteLength) {
      const channels = view.getUint16(body, false)
      const frames = view.getUint32(body + 2, false)
      const bits = view.getUint16(body + 6, false)
      const sampleRate = extended80(view, body + 8)
      if (kind === 'AIFC' && body + 22 <= view.byteLength) {
        compression = ascii(view, body + 18)
      }
      comm = {
        channels,
        frames,
        bits,
        sampleRate: Math.round(sampleRate),
        float: false,
        // AIFF is big-endian. AIFC 'sowt' is the little-endian variant, which
        // is what Apple tools write most of the time.
        littleEndian: false,
        start: 0,
      }
    } else if (id === 'SSND') {
      ssndAt = body
    }
    pos = body + size + (size % 2)
  }

  if (!comm || ssndAt < 0) return null

  const c = compression.trim().toLowerCase()
  if (c === 'sowt') comm.littleEndian = true
  else if (c === 'fl32' || c === 'fl64') {
    comm.float = true
    comm.bits = c === 'fl32' ? 32 : 64
  } else if (c !== 'none' && c !== 'twos' && c !== '') {
    throw new DecodeError(
      'compressed-aifc',
      `this aiff uses ${compression.trim()} compression`,
    )
  }

  // SSND body: offset (4), blockSize (4), then the samples.
  const offset = view.getUint32(ssndAt, false)
  comm.start = ssndAt + 8 + offset
  return readSamples(view, comm)
}

/** Apple Core Audio Format, uncompressed only. */
function parseCaf(view: DataView): Pcm | null {
  if (ascii(view, 0) !== 'caff') return null

  let pos = 8
  let desc: RawPcm | null = null
  let dataAt = -1
  let dataSize = 0

  while (pos + 12 <= view.byteLength) {
    const id = ascii(view, pos)
    // Chunk sizes are 64-bit. Reading the low half is plenty for any sample.
    const size = Number(view.getBigInt64(pos + 4, false))
    const body = pos + 12

    if (id === 'desc' && body + 32 <= view.byteLength) {
      const sampleRate = view.getFloat64(body, false)
      const formatId = ascii(view, body + 8)
      const flags = view.getUint32(body + 12, false)
      const channels = view.getUint32(body + 24, false)
      const bits = view.getUint32(body + 28, false)
      if (formatId !== 'lpcm') {
        throw new DecodeError('undecodable', `this caf holds ${formatId}, not raw pcm`)
      }
      desc = {
        channels,
        bits,
        sampleRate: Math.round(sampleRate),
        float: (flags & 1) !== 0,
        littleEndian: (flags & 2) !== 0,
        start: 0,
        frames: 0,
      }
    } else if (id === 'data') {
      dataAt = body
      dataSize = size < 0 ? view.byteLength - body : size
    }
    if (size < 0) break
    pos = body + size
  }

  if (!desc || dataAt < 0) return null
  // The data chunk opens with a 4-byte edit count.
  desc.start = dataAt + 4
  desc.frames = Math.floor((dataSize - 4) / ((desc.bits / 8) * desc.channels))
  return readSamples(view, desc)
}

function pcmFromAudioBuffer(buffer: AudioBuffer): Pcm {
  const channels: Float32Array<ArrayBuffer>[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(new Float32Array(buffer.getChannelData(c)))
  }
  return { channels, sampleRate: buffer.sampleRate }
}

/**
 * Decode a file to sample data.
 *
 * `nativeDecode` is injected so the caller controls which AudioContext (and
 * therefore which sample rate) the native path decodes into.
 */
export async function decodeAudio(
  bytes: ArrayBuffer,
  nativeDecode: (b: ArrayBuffer) => Promise<AudioBuffer>,
): Promise<Pcm> {
  if (bytes.byteLength === 0) {
    throw new DecodeError('empty', 'that file is empty')
  }

  try {
    return pcmFromAudioBuffer(await nativeDecode(bytes.slice(0)))
  } catch {
    // Native decoding failed. Chromium cannot read AIFF or CAF, so try the
    // formats we can parse before giving up on the file.
  }

  const view = new DataView(bytes)
  // A DecodeError from a parser is specific and worth surfacing, so it is
  // deliberately not swallowed here.
  const parsed = parseAiff(view) ?? parseCaf(view)
  if (parsed && parsed.channels[0].length > 0) return parsed

  throw new DecodeError(
    'undecodable',
    'this browser cannot read that file',
  )
}

/**
 * Cheap pre-flight on the File itself, before any of it is read into memory.
 * Returns an error to report, or null to go ahead.
 */
export function checkFileSize(bytes: number): DecodeError | null {
  if (bytes === 0) return new DecodeError('empty', 'that file is empty')
  if (bytes > MAX_BYTES) {
    return new DecodeError(
      'too-large',
      `that file is ${(bytes / 1048576).toFixed(0)}MB`,
    )
  }
  return null
}

/** Applied after decoding, when the real duration is known. */
export function checkDuration(seconds: number): DecodeError | null {
  if (seconds > MAX_SECONDS) {
    return new DecodeError(
      'too-long',
      `that is ${Math.round(seconds / 60)} minutes long`,
    )
  }
  return null
}

/** Message for the interface, per failure reason. */
export function describeFailure(e: unknown): string {
  if (e instanceof DecodeError) {
    switch (e.reason) {
      case 'empty':
        return 'that file is empty.'
      case 'too-large':
        return `${e.message}. the ceiling is ${Math.round(MAX_BYTES / 1048576)}MB, which is about twenty minutes of 24 bit stereo.`
      case 'too-long':
        return `${e.message}. the ceiling is ${MAX_SECONDS / 60} minutes. trim it in your daw first.`
      case 'compressed-aifc':
        return `${e.message}. render it uncompressed and try again.`
      default:
        return `${e.message}. wav, aiff, mp3, flac and m4a all work.`
    }
  }
  return 'could not read that one. wav, aiff, mp3, flac and m4a all work.'
}
