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
/**
 * Half an hour. The earlier ceiling of ten minutes was wrong: a full track or
 * a set is exactly the sort of thing you pull a vocal chop out of, and
 * refusing it made the tool useless for its actual job. Long sources are
 * handled by selecting the part you want rather than by turning them away.
 */
export const MAX_SECONDS = 1800
/** Past this, rolls take long enough to be worth mentioning. */
export const WARN_SECONDS = 150
/**
 * Checked before reading the file, from `File.size` alone. The point is to
 * refuse before pulling something enormous into memory, not to be exact.
 */
export const MAX_BYTES = 600 * 1024 * 1024

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

/**
 * RIFF/WAVE, plus RF64 and BW64.
 *
 * There is a native decoder for plain wav, so this is the fallback for the
 * ones it rejects. RF64 and BW64 are the big-file variants a DAW writes when a
 * render passes 4GB (and some write always) and they are not RIFF, so the
 * browser refuses them outright. WAVE_FORMAT_EXTENSIBLE is handled too, since
 * multichannel and high bit depth renders use it as a matter of course.
 */
function parseWav(view: DataView): Pcm | null {
  const magic = ascii(view, 0)
  if (magic !== 'RIFF' && magic !== 'RF64' && magic !== 'BW64') return null
  if (ascii(view, 8) !== 'WAVE') return null

  let pos = 12
  let fmt: {
    format: number
    channels: number
    sampleRate: number
    bits: number
  } | null = null
  let dataAt = -1
  let dataSize = 0
  // RF64 parks the real 64-bit sizes in a ds64 chunk and writes -1 in the
  // 32-bit fields.
  let ds64DataSize = -1

  while (pos + 8 <= view.byteLength) {
    const id = ascii(view, pos)
    let size = view.getUint32(pos + 4, true)
    const body = pos + 8

    if (id === 'ds64' && body + 16 <= view.byteLength) {
      ds64DataSize = Number(view.getBigUint64(body + 8, true))
    } else if (id === 'fmt ' && body + 16 <= view.byteLength) {
      let format = view.getUint16(body, true)
      const channels = view.getUint16(body + 2, true)
      const sampleRate = view.getUint32(body + 4, true)
      const bits = view.getUint16(body + 14, true)
      // Extensible: the real format code lives in the subformat GUID.
      if (format === 0xfffe && body + 26 <= view.byteLength) {
        format = view.getUint16(body + 24, true)
      }
      fmt = { format, channels, sampleRate, bits }
    } else if (id === 'data') {
      dataAt = body
      if (size === 0xffffffff && ds64DataSize >= 0) size = ds64DataSize
      dataSize = size
    }

    if (size === 0xffffffff || size <= 0) {
      // Unknown or streamed size: take the rest of the file.
      if (dataAt >= 0 && dataSize <= 0) dataSize = view.byteLength - dataAt
      break
    }
    pos = body + size + (size % 2)
  }

  if (!fmt || dataAt < 0) return null
  if (fmt.format !== 1 && fmt.format !== 3) {
    throw new DecodeError(
      'undecodable',
      `this wav holds compressed audio (format ${fmt.format})`,
    )
  }

  const usable = Math.min(dataSize, view.byteLength - dataAt)
  const bytesPerFrame = (fmt.bits / 8) * fmt.channels
  if (bytesPerFrame <= 0) return null

  return readSamples(view, {
    channels: fmt.channels,
    bits: fmt.bits,
    sampleRate: fmt.sampleRate,
    float: fmt.format === 3,
    littleEndian: true,
    start: dataAt,
    frames: Math.floor(usable / bytesPerFrame),
  })
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
  const parsed = parseWav(view) ?? parseAiff(view) ?? parseCaf(view)
  if (parsed && parsed.channels[0].length > 0) return parsed

  // Nothing could read it, so say what it actually appears to be. A vague
  // failure on a file that is sitting right there is useless.
  throw new DecodeError('undecodable', identify(view, bytes.byteLength))
}

/**
 * Best guess at what a file is, from its first bytes. Used only to make the
 * failure message specific enough to act on.
 */
export function identify(view: DataView, length: number): string {
  if (length < 12) return 'that file is too short to be audio'
  const head = ascii(view, 0)
  // In an mp4/m4a the brand box starts at byte 4, not 8.
  const brand = ascii(view, 4)

  if (head === 'RIFF' || head === 'RF64' || head === 'BW64') {
    return `that wav is damaged or uses a codec nothing here can read`
  }
  if (head === 'FORM') return 'that aiff is damaged or compressed'
  if (head === 'caff') return 'that caf holds compressed audio'
  if (head === 'OggS') return 'that ogg uses a codec this browser lacks'
  if (head === 'fLaC') return 'that flac is damaged'
  if (head.startsWith('ID3') || (view.getUint8(0) === 0xff && (view.getUint8(1) & 0xe0) === 0xe0)) {
    return 'that mp3 is damaged'
  }
  if (brand === 'ftyp') {
    // Everything in the mp4 family shares this box: m4a, mp4, mov, 3gp. The
    // codec and track names live in the moov atom, which can sit at either end
    // of the file, so both ends get scanned rather than just the head.
    const latin = new TextDecoder('latin1')
    const window = 262144
    const front = latin.decode(new Uint8Array(view.buffer, 0, Math.min(length, window)))
    const tailAt = Math.max(0, length - window)
    const back =
      tailAt > 0 ? latin.decode(new Uint8Array(view.buffer, tailAt, length - tailAt)) : ''
    const both = front + back
    const isVideo = both.includes('vide')
    const hasSound = both.includes('soun')

    // A video dropped in for its audio is a normal thing to do, so the case
    // worth naming is the one where there is no audio to take.
    if (isVideo && !hasSound) {
      return 'that video has no audio track, so there is nothing to sample'
    }
    if (both.includes('alac')) {
      // Apple Lossless lives in an mp4 container and Chromium cannot decode it,
      // which is exactly what Logic and Music.app export by default.
      return 'that file is apple lossless, which no browser decodes. render it as wav or aiff'
    }
    if (isVideo) {
      return "that video's audio uses a codec this browser cannot decode. try mp4 or m4a"
    }
    return 'that m4a uses a codec this browser cannot decode'
  }
  if (head === 'riff') {
    return 'that is a wave64 file. export it as a normal wav or aiff'
  }
  if (head.slice(0, 2) === '0&') return 'that looks like a wma file'

  return 'that is not an audio format anything here recognises'
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

/**
 * The raw facts about a file that would not load: what the browser called it,
 * how big it is, and the actual first bytes of the header. This is what makes
 * an unreproducible "it will not take my file" into one answerable line.
 */
export async function describeFile(file: File): Promise<string> {
  const bits: string[] = []
  bits.push(`${(file.size / 1048576).toFixed(2)}MB`)
  bits.push(`type "${file.type || 'none'}"`)
  try {
    const head = await file.slice(0, 16).arrayBuffer()
    const b = new Uint8Array(head)
    let tag = ''
    for (let i = 0; i < Math.min(12, b.length); i++) {
      const c = b[i]
      tag += c >= 32 && c < 127 ? String.fromCharCode(c) : '.'
    }
    const hex = Array.from(b.slice(0, 8))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join(' ')
    bits.push(`header "${tag}"`)
    bits.push(hex)
  } catch {
    bits.push('header unreadable')
  }
  return bits.join(' · ')
}

/** Message for the interface, per failure reason. */
/** Extensions that usually arrive as video rather than as a sample. */
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.3gp', '.mkv', '.avi']

export function looksLikeVideo(name: string): boolean {
  const lower = name.toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * Why a file that decoded fine came out silent.
 *
 * Worth separating from the generic message: dropping a video in to take its
 * audio is a normal thing to do, and "that file is silent" sends you looking at
 * the audio when the real answer is that there was never an audio track.
 */
export function describeSilent(name: string): string {
  return looksLikeVideo(name)
    ? 'that video has no audio track, so there is nothing to sample.'
    : 'that file is silent.'
}

export function describeFailure(e: unknown): string {
  if (e instanceof DecodeError) {
    switch (e.reason) {
      case 'empty':
        return 'that file is empty.'
      case 'too-large':
        return `${e.message}. the ceiling is ${Math.round(MAX_BYTES / 1048576)}MB, which is about twenty minutes of 24 bit stereo.`
      case 'too-long':
        return `${e.message}. the ceiling is ${MAX_SECONDS / 60} minutes.`
      case 'compressed-aifc':
        return `${e.message}. render it uncompressed and try again.`
      default: {
        // identify() often already says what to do. Only add the generic
        // fallback when it did not.
        const guided = /export|render|damaged|decode/.test(e.message)
        return guided
          ? `${e.message}.`
          : `${e.message}. wav, aiff, mp3, flac, m4a and mp4 all work.`
      }
    }
  }
  return 'could not read that one. wav, aiff, mp3, flac, m4a and mp4 all work.'
}
