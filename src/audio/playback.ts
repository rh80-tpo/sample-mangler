import { pcmToBuffer, type Pcm } from './buffers'

/**
 * Plays the exact rendered buffer. Not a second signal path: the same Pcm that
 * gets encoded to WAV is what goes to the speakers, so what you hear is what
 * you export.
 */
export class Playback {
  private ctx: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private startedAt = 0
  private duration = 0
  private regionStart = 0
  private regionEnd = 0
  private looping = false
  onEnded: (() => void) | null = null

  /** Created lazily so the context is opened inside a user gesture. */
  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext()
    return this.ctx
  }

  /** The rate everything decodes and renders at. */
  sampleRate(): number {
    return this.context().sampleRate
  }

  /**
   * Reopen the context at a specific rate so a decode does not resample.
   * Falls back to whatever context we already have if the browser will not
   * give us that rate.
   */
  private async contextAt(rate: number | null): Promise<AudioContext> {
    if (!rate || this.ctx?.sampleRate === rate) return this.context()
    try {
      const next = new AudioContext({ sampleRate: rate })
      if (next.sampleRate !== rate) {
        void next.close()
        return this.context()
      }
      this.stop()
      void this.ctx?.close()
      this.ctx = next
      return next
    } catch {
      return this.context()
    }
  }

  /**
   * Decode at `preferredRate` when the file declares one, so the sample keeps
   * its original rate all the way through to the exported WAV.
   */
  async decode(
    file: ArrayBuffer,
    preferredRate: number | null = null,
  ): Promise<AudioBuffer> {
    const ctx = await this.contextAt(preferredRate)
    // decodeAudioData detaches the buffer it is given, so hand it a copy and
    // keep the original readable for a retry.
    return ctx.decodeAudioData(file.slice(0))
  }

  /**
   * `from` is a 0..1 position. `region` confines playback (and looping) to a
   * slice of the buffer, expressed the same way.
   */
  async play(
    pcm: Pcm,
    from = 0,
    opts: { loop?: boolean; region?: { start: number; end: number } | null } = {},
  ) {
    const ctx = this.context()
    if (ctx.state === 'suspended') await ctx.resume()
    this.stop()

    const source = ctx.createBufferSource()
    source.buffer = pcmToBuffer(pcm, ctx)
    source.connect(ctx.destination)
    source.onended = () => {
      if (this.source === source) {
        this.source = null
        this.onEnded?.()
      }
    }
    this.source = source

    const full = source.buffer.duration
    const region = opts.region
    const lo = region ? Math.max(0, region.start) * full : 0
    const hi = region ? Math.min(1, region.end) * full : full
    this.regionStart = lo
    this.regionEnd = hi
    this.duration = full
    this.looping = Boolean(opts.loop)

    if (opts.loop) {
      source.loop = true
      source.loopStart = lo
      source.loopEnd = hi
    }

    // `from` is relative to the whole buffer, but a start outside the region
    // would drop the playhead somewhere the loop never visits.
    const wanted = Math.max(0, Math.min(0.999, from)) * full
    const offset = region ? Math.min(Math.max(wanted, lo), hi - 0.001) : wanted
    this.startedAt = ctx.currentTime - (offset - lo)
    if (region && !opts.loop) {
      source.start(0, offset, Math.max(0.01, hi - offset))
    } else {
      source.start(0, offset)
    }
  }

  stop() {
    if (this.source) {
      const s = this.source
      this.source = null
      s.onended = null
      try {
        s.stop()
      } catch {
        // Already stopped. Nothing to do.
      }
    }
  }

  get playing(): boolean {
    return this.source !== null
  }

  /**
   * 0 to 1 through the whole buffer, or null when idle. Wraps within the
   * region while looping, so the cursor tracks what is actually being heard.
   */
  progress(): number | null {
    if (!this.source || !this.ctx || this.duration <= 0) return null
    const span = Math.max(1e-6, this.regionEnd - this.regionStart)
    let elapsed = this.ctx.currentTime - this.startedAt
    if (this.looping) elapsed = elapsed % span
    const seconds = this.regionStart + Math.min(elapsed, span)
    return Math.max(0, Math.min(1, seconds / this.duration))
  }
}
