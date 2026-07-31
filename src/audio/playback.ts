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

  /** `from` is a 0..1 position, used to pick playback back up after an edit. */
  async play(pcm: Pcm, from = 0) {
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
    this.duration = source.buffer.duration
    const offset = Math.max(0, Math.min(0.999, from)) * this.duration
    this.startedAt = ctx.currentTime - offset
    source.start(0, offset)
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

  /** 0 to 1 through the current buffer, or null when idle. */
  progress(): number | null {
    if (!this.source || !this.ctx || this.duration <= 0) return null
    const t = (this.ctx.currentTime - this.startedAt) / this.duration
    return Math.max(0, Math.min(1, t))
  }
}
