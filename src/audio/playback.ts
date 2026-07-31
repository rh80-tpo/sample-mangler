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

  async decode(file: ArrayBuffer): Promise<AudioBuffer> {
    return this.context().decodeAudioData(file)
  }

  async play(pcm: Pcm) {
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
    this.startedAt = ctx.currentTime
    source.start()
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
