/**
 * Saída de áudio da chamada. Cada stream remoto passa por um ganho próprio, o que permite
 * volume de 0 a 200% por pessoa (o <audio> comum para em 100%) e escolher o dispositivo de saída.
 */
export type SourceKind = 'voice' | 'screen'
type Entry = { stream: MediaStream; source: MediaStreamAudioSourceNode; gain: GainNode; keepAlive: HTMLAudioElement; userId: number; kind: SourceKind }
export type Volumes = Record<string, { voice?: number; screen?: number }>

export class AudioMixer {
  private ctx: AudioContext
  private entries = new Map<string, Entry>()
  private volumes: Volumes = {}
  private deafened = false
  private sinkId = ''

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    // o contexto pode nascer suspenso; volta a tocar no primeiro gesto do usuário
    const resume = () => void this.ctx.resume()
    resume()
    addEventListener('pointerdown', resume, { once: true })
    addEventListener('keydown', resume, { once: true })
    // usado pelos testes automáticos para conferir os volumes aplicados
    ;(globalThis as { __cglMixer?: AudioMixer }).__cglMixer = this
  }

  /** Sincroniza com os streams atuais da chamada. Chave: algo estável por stream. */
  sync(list: { key: string; stream: MediaStream; userId: number; kind: SourceKind }[]) {
    const keep = new Set<string>()
    for (const item of list) {
      if (item.stream.getAudioTracks().length === 0) continue
      keep.add(item.key)
      const cur = this.entries.get(item.key)
      if (cur && cur.stream === item.stream) {
        cur.kind = item.kind
        cur.userId = item.userId
        this.apply(cur)
        continue
      }
      if (cur) this.drop(item.key)
      // Chromium só entrega áudio de WebRTC ao Web Audio se o stream também estiver num elemento de mídia
      const keepAlive = new Audio()
      keepAlive.muted = true
      keepAlive.srcObject = item.stream
      void keepAlive.play().catch(() => {})
      const source = this.ctx.createMediaStreamSource(item.stream)
      const gain = this.ctx.createGain()
      source.connect(gain).connect(this.ctx.destination)
      const entry: Entry = { stream: item.stream, source, gain, keepAlive, userId: item.userId, kind: item.kind }
      this.entries.set(item.key, entry)
      this.apply(entry)
    }
    for (const key of [...this.entries.keys()]) if (!keep.has(key)) this.drop(key)
  }

  setVolumes(v: Volumes) {
    this.volumes = v
    this.entries.forEach((e) => this.apply(e))
  }

  setDeafened(on: boolean) {
    this.deafened = on
    this.entries.forEach((e) => this.apply(e))
  }

  /** '' = saída padrão do sistema. */
  async setOutput(deviceId: string) {
    if (deviceId === this.sinkId) return
    const ctx = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    if (!ctx.setSinkId) return
    try {
      await ctx.setSinkId(deviceId)
      this.sinkId = deviceId
    } catch {
      // dispositivo sumiu: fica na saída atual
    }
  }

  close() {
    for (const key of [...this.entries.keys()]) this.drop(key)
    void this.ctx.close()
  }

  private apply(e: Entry) {
    const pct = this.volumes[e.userId]?.[e.kind] ?? 100
    const target = this.deafened ? 0 : Math.max(0, Math.min(200, pct)) / 100
    e.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02)
  }

  private drop(key: string) {
    const e = this.entries.get(key)
    if (!e) return
    e.source.disconnect()
    e.gain.disconnect()
    e.keepAlive.srcObject = null
    this.entries.delete(key)
  }
}

/** Acha o dispositivo salvo: primeiro pelo id, depois pelo nome (o id muda entre servidores). */
export function resolveDevice(saved: { id: string; label: string } | null | undefined, list: MediaDeviceInfo[]): string {
  if (!saved) return ''
  if (list.some((d) => d.deviceId === saved.id)) return saved.id
  const byLabel = list.find((d) => d.label && d.label === saved.label)
  return byLabel?.deviceId ?? ''
}
