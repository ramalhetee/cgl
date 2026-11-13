import type { Socket } from 'socket.io-client'
import type { VoicePeer } from './api'

const ICE: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

type Link = {
  pc: RTCPeerConnection
  info: VoicePeer
  streams: Map<string, MediaStream>
  makingOffer: boolean
  ignoreOffer: boolean
  polite: boolean
}

export type RemoteView = { info: VoicePeer; streams: MediaStream[] }
export type VoiceSnapshot = {
  channelId: number
  muted: boolean
  deafened: boolean
  video: boolean
  screen: boolean
  micOk: boolean
  mic: MediaStream | null
  camera: MediaStream | null
  screenStream: MediaStream | null
  remotes: RemoteView[]
}

/**
 * Chamada em malha (mesh): uma RTCPeerConnection por participante.
 * O servidor só repassa a sinalização; áudio/vídeo/tela vão direto entre os pares.
 */
export class VoiceSession {
  private links = new Map<string, Link>()
  private mic: MediaStream | null = null
  private camera: MediaStream | null = null
  private display: MediaStream | null = null
  private muted = false
  private deafened = false
  private mutedBeforeDeaf = false
  private closed = false
  private speaking = false
  private stopMonitor: (() => void) | null = null
  private socket: Socket
  private onChange: (s: VoiceSnapshot) => void
  readonly channelId: number

  constructor(socket: Socket, channelId: number, onChange: (s: VoiceSnapshot) => void) {
    this.socket = socket
    this.channelId = channelId
    this.onChange = onChange
  }

  async join(): Promise<void> {
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch {
      this.mic = null // sem microfone: entra só ouvindo
    }
    if (this.closed) return this.stopLocal()
    this.socket.on('voice:peer-joined', this.onPeerJoined)
    this.socket.on('voice:peer-left', this.onPeerLeft)
    this.socket.on('voice:signal', this.onSignal)
    this.socket.on('voice:state', this.onState)
    const res: { peers?: VoicePeer[]; error?: string } = await this.socket.emitWithAck('voice:join', {
      channelId: this.channelId,
    })
    if (res.error) throw new Error(res.error)
    for (const p of res.peers ?? []) this.link(p)
    this.monitorMic()
    this.sendState()
    this.emit()
  }

  leave() {
    this.closed = true
    this.socket.off('voice:peer-joined', this.onPeerJoined)
    this.socket.off('voice:peer-left', this.onPeerLeft)
    this.socket.off('voice:signal', this.onSignal)
    this.socket.off('voice:state', this.onState)
    this.stopMonitor?.()
    this.socket.emit('voice:leave')
    for (const l of this.links.values()) l.pc.close()
    this.links.clear()
    this.stopLocal()
  }

  toggleMute() {
    // falar de novo também volta a ouvir
    if (this.deafened) this.deafened = false
    this.muted = !this.muted
    this.applyMute()
  }

  /** Não ouvir: corta o som de todos e fecha o próprio microfone; ao voltar, o mic fica como estava. */
  toggleDeafen() {
    this.deafened = !this.deafened
    if (this.deafened) {
      this.mutedBeforeDeaf = this.muted
      this.muted = true
    } else {
      this.muted = this.mutedBeforeDeaf
    }
    this.applyMute()
  }

  private applyMute() {
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !this.muted))
    this.sendState()
    this.emit()
  }

  async toggleCamera() {
    if (this.camera) {
      this.dropStream(this.camera)
      this.camera = null
    } else {
      this.camera = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })
      this.shareStream(this.camera)
    }
    this.sendState()
    this.emit()
  }

  async toggleScreen() {
    if (this.display) {
      this.dropStream(this.display)
      this.display = null
    } else {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 } }, audio: true })
      this.display = stream
      // prioriza movimento suave (jogos, vídeo) em vez de nitidez parada
      for (const t of stream.getVideoTracks()) t.contentHint = 'motion'
      // botão "parar de compartilhar" do próprio navegador
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (this.display === stream) void this.toggleScreen()
      })
      this.shareStream(stream)
    }
    this.sendState()
    this.emit()
  }

  // ---------- interno ----------
  private monitorMic() {
    if (!this.mic) return
    const ctx = new AudioContext()
    void ctx.resume()
    const source = ctx.createMediaStreamSource(this.mic)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const buf = new Uint8Array(analyser.fftSize)
    let loudAt = 0
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
      const now = Date.now()
      if (peak > 10 && !this.muted) loudAt = now
      const speaking = !this.muted && now - loudAt < 350
      if (speaking !== this.speaking) {
        this.speaking = speaking
        this.socket.emit('voice:speaking', { speaking })
      }
    }, 80)
    this.stopMonitor = () => {
      clearInterval(timer)
      source.disconnect()
      void ctx.close()
    }
  }

  private stopLocal() {
    for (const s of [this.mic, this.camera, this.display]) s?.getTracks().forEach((t) => t.stop())
    this.mic = this.camera = this.display = null
  }

  private shareStream(stream: MediaStream) {
    for (const l of this.links.values()) for (const t of stream.getTracks()) this.tune(l.pc.addTrack(t, stream), stream)
  }

  /** Tela: mais banda e taxa de quadros estável. Câmera: teto moderado pra não disputar banda. */
  private tune(sender: RTCRtpSender, stream: MediaStream) {
    if (sender.track?.kind !== 'video') return
    const isScreen = stream === this.display
    const params = sender.getParameters()
    if (!params.encodings?.length) params.encodings = [{}]
    params.encodings[0].maxBitrate = isScreen ? 8_000_000 : 1_500_000
    if (isScreen) {
      params.encodings[0].maxFramerate = 60
      params.degradationPreference = 'maintain-framerate'
    }
    sender.setParameters(params).catch(() => {})
  }

  private dropStream(stream: MediaStream) {
    const tracks = new Set(stream.getTracks())
    for (const l of this.links.values()) {
      for (const sender of l.pc.getSenders()) if (sender.track && tracks.has(sender.track)) l.pc.removeTrack(sender)
    }
    tracks.forEach((t) => t.stop())
  }

  private sendState() {
    this.socket.emit('voice:state', {
      muted: this.muted || !this.mic,
      deaf: this.deafened,
      video: !!this.camera,
      screen: !!this.display,
      cameraStream: this.camera?.id ?? null,
      screenStream: this.display?.id ?? null,
    })
  }

  private link(info: VoicePeer): Link {
    const existing = this.links.get(info.socketId)
    if (existing) return existing
    const pc = new RTCPeerConnection(ICE)
    const l: Link = {
      pc,
      info,
      streams: new Map(),
      makingOffer: false,
      ignoreOffer: false,
      // "perfect negotiation": em colisão de ofertas, o lado educado cede
      polite: (this.socket.id ?? '') > info.socketId,
    }
    this.links.set(info.socketId, l)
    const send = (data: unknown) => this.socket.emit('voice:signal', { to: info.socketId, data })

    pc.onnegotiationneeded = async () => {
      try {
        l.makingOffer = true
        await pc.setLocalDescription()
        send({ description: pc.localDescription })
      } catch (e) {
        console.warn('negociação falhou', e)
      } finally {
        l.makingOffer = false
      }
    }
    pc.onicecandidate = (e) => e.candidate && send({ candidate: e.candidate })
    pc.ontrack = (e) => {
      for (const stream of e.streams) {
        l.streams.set(stream.id, stream)
        stream.onremovetrack = () => {
          if (stream.getTracks().length === 0) l.streams.delete(stream.id)
          this.emit()
        }
      }
      this.emit()
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce()
    }
    for (const s of [this.mic, this.camera, this.display]) {
      if (s) for (const t of s.getTracks()) this.tune(pc.addTrack(t, s), s)
    }
    // sem nada pra enviar ainda: abre um canal de áudio só de recepção pra iniciar a conexão
    if (pc.getSenders().length === 0) pc.addTransceiver('audio', { direction: 'recvonly' })
    return l
  }

  private onPeerJoined = (info: VoicePeer) => {
    this.link(info)
    this.emit()
  }

  private onPeerLeft = ({ socketId }: { socketId: string }) => {
    this.links.get(socketId)?.pc.close()
    this.links.delete(socketId)
    this.emit()
  }

  private onState = (info: VoicePeer) => {
    const l = this.links.get(info.socketId)
    if (l) l.info = info
    this.emit()
  }

  private onSignal = async ({ from, data }: { from: string; data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => {
    const l = this.links.get(from)
    if (!l) return
    const { pc } = l
    try {
      if (data.description) {
        const collision = data.description.type === 'offer' && (l.makingOffer || pc.signalingState !== 'stable')
        l.ignoreOffer = !l.polite && collision
        if (l.ignoreOffer) return
        await pc.setRemoteDescription(data.description)
        if (data.description.type === 'offer') {
          await pc.setLocalDescription()
          this.socket.emit('voice:signal', { to: from, data: { description: pc.localDescription } })
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate)
        } catch (e) {
          if (!l.ignoreOffer) throw e
        }
      }
    } catch (e) {
      console.warn('sinalização falhou', e)
    }
  }

  private emit() {
    if (this.closed) return
    this.onChange({
      channelId: this.channelId,
      muted: this.muted,
      deafened: this.deafened,
      video: !!this.camera,
      screen: !!this.display,
      micOk: !!this.mic,
      mic: this.mic,
      camera: this.camera,
      screenStream: this.display,
      remotes: [...this.links.values()].map((l) => ({ info: l.info, streams: [...l.streams.values()] })),
    })
  }
}
