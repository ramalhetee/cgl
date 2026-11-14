import type { Socket } from 'socket.io-client'
import type { VoicePeer } from './api'
import { DEFAULT_NOISE_MODE, openMicrophone } from './noise'
import type { Microphone, NoiseMode } from './noise'

const ICE: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

type Link = {
  pc: RTCPeerConnection
  info: VoicePeer
  streams: Map<string, MediaStream>
  /** faixas da minha tela enviadas para esta pessoa (para pausar quando ela oculta) */
  screenSenders: { sender: RTCRtpSender; track: MediaStreamTrack }[]
  makingOffer: boolean
  ignoreOffer: boolean
  /** aplicando uma resposta: uma oferta que chega agora não é colisão (padrão "perfect negotiation") */
  settingAnswer: boolean
  /** sinais tratados um de cada vez, na ordem de chegada */
  queue: Promise<void>
  /**
   * Acabei de entrar na sala: espero a oferta de quem já estava, em vez de oferecer junto
   * (duas ofertas cruzadas + rollback deixam o Chromium às vezes sem candidatos ICE, e nada passa).
   */
  waitOffer: boolean
  iceTimer?: ReturnType<typeof setTimeout>
  polite: boolean
}

type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }

export type RemoteView = { info: VoicePeer; streams: MediaStream[] }
export type VoiceSnapshot = {
  channelId: number
  muted: boolean
  deafened: boolean
  video: boolean
  screen: boolean
  screenAudio: boolean
  /** pessoas cuja tela eu ocultei */
  notWatching: string[]
  micOk: boolean
  /** filtro de ruído ativo no microfone (null = sem microfone) */
  noise: NoiseMode | null
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
  /** sinais que chegaram antes da conexão com a pessoa existir (o servidor avisa quem já está na sala antes de confirmar a entrada) */
  private early = new Map<string, Signal[]>()
  private mic: MediaStream | null = null
  private micHandle: Microphone | null = null
  private micSeq = 0 // descarta aberturas de microfone que ficaram velhas
  private camera: MediaStream | null = null
  private display: MediaStream | null = null
  private muted = false
  private deafened = false
  private mutedBeforeDeaf = false
  private closed = false
  private notWatching = new Set<string>() // telas que eu ocultei
  private hiddenFrom = new Set<string>() // quem ocultou a minha tela
  private speaking = false
  private stopMonitor: (() => void) | null = null
  private stopPreview: (() => void) | null = null
  private socket: Socket
  private onChange: (s: VoiceSnapshot) => void
  private inputId: string
  private noiseMode: NoiseMode
  readonly channelId: number

  constructor(socket: Socket, channelId: number, onChange: (s: VoiceSnapshot) => void, inputId = '', noiseMode: NoiseMode = DEFAULT_NOISE_MODE) {
    this.socket = socket
    this.channelId = channelId
    this.onChange = onChange
    this.inputId = inputId
    this.noiseMode = noiseMode
    // usado pelos testes automáticos (estatísticas de envio e recebimento)
    ;(globalThis as { __cglVoice?: VoiceSession }).__cglVoice = this
  }

  /** Troca o microfone no meio da chamada, sem renegociar: só substitui a faixa enviada. */
  async setInputDevice(id: string) {
    this.inputId = id
    await this.reopenMic()
  }

  /** Troca o filtro de ruído no meio da chamada (mesmo jeito da troca de microfone). */
  async setNoiseMode(mode: NoiseMode) {
    this.noiseMode = mode
    await this.reopenMic()
  }

  private async reopenMic() {
    if (this.closed) return
    const seq = ++this.micSeq
    const next = await openMicrophone(this.inputId, this.noiseMode)
    if (!next) return
    if (this.closed || seq !== this.micSeq) return next.close()
    const oldHandle = this.micHandle
    const oldTrack = this.mic?.getAudioTracks()[0]
    const newTrack = next.stream.getAudioTracks()[0]
    newTrack.enabled = !this.muted
    for (const l of this.links.values()) {
      const sender = l.pc.getSenders().find((x) => x.track && x.track === oldTrack)
      if (sender) await sender.replaceTrack(newTrack)
      else l.pc.addTrack(newTrack, next.stream)
    }
    this.micHandle = next
    this.mic = next.stream
    oldHandle?.close()
    this.stopMonitor?.()
    this.monitorMic()
    this.sendState()
    this.emit()
  }

  async join(): Promise<void> {
    const seq = ++this.micSeq
    const mic = await openMicrophone(this.inputId, this.noiseMode)
    if (this.closed) {
      mic?.close()
      return this.stopLocal()
    }
    if (seq === this.micSeq) {
      this.micHandle = mic
      this.mic = mic?.stream ?? null
    } else {
      mic?.close() // trocaram o microfone enquanto abria: vale o mais novo
    }
    this.socket.on('voice:peer-joined', this.onPeerJoined)
    this.socket.on('voice:peer-left', this.onPeerLeft)
    this.socket.on('voice:signal', this.onSignal)
    this.socket.on('voice:state', this.onState)
    this.socket.on('voice:watch', this.onWatch)
    const res: { peers?: VoicePeer[]; error?: string } = await this.socket.emitWithAck('voice:join', {
      channelId: this.channelId,
    })
    if (res.error) throw new Error(res.error)
    for (const p of res.peers ?? []) this.link(p, true)
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
    this.socket.off('voice:watch', this.onWatch)
    this.stopMonitor?.()
    this.stopPreview?.()
    this.socket.emit('voice:leave')
    for (const l of this.links.values()) {
      clearTimeout(l.iceTimer)
      l.pc.close()
    }
    this.links.clear()
    this.early.clear()
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
      this.stopPreview?.()
      this.dropStream(this.display)
      this.display = null
    } else {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60, max: 60 } },
        // som do PC sem o som da própria chamada (onde o sistema permite), pra ninguém ouvir eco de si mesmo
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true, suppressLocalAudioPlayback: false } as MediaTrackConstraints,
      })
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
    if (this.display) this.startPreview(this.display)
    this.emit()
  }

  /** Miniatura da própria tela para o cartão "AO VIVO" de quem está fora da chamada (logo no início e a cada 15 s). */
  private startPreview(stream: MediaStream) {
    this.stopPreview?.()
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = new MediaStream(stream.getVideoTracks())
    void video.play().catch(() => {})
    const canvas = document.createElement('canvas')
    const snap = () => {
      if (this.display !== stream || !video.videoWidth) return
      const w = 400
      const h = Math.round((w * video.videoHeight) / video.videoWidth)
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d')?.drawImage(video, 0, 0, w, h)
      this.socket.emit('voice:preview', { data: canvas.toDataURL('image/jpeg', 0.6) })
    }
    const first = setTimeout(snap, 1500)
    const every = setInterval(snap, 15000)
    this.stopPreview = () => {
      clearTimeout(first)
      clearInterval(every)
      video.srcObject = null
      this.stopPreview = null
    }
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
    this.micHandle?.close()
    this.micHandle = null
    for (const s of [this.camera, this.display]) s?.getTracks().forEach((t) => t.stop())
    this.mic = this.camera = this.display = null
  }

  private shareStream(stream: MediaStream) {
    for (const l of this.links.values()) for (const t of stream.getTracks()) this.addTo(l, t, stream)
  }

  /** Envia uma faixa para uma pessoa; faixas da tela ficam pausadas para quem ocultou a minha tela. */
  private addTo(l: Link, track: MediaStreamTrack, stream: MediaStream) {
    const sender = l.pc.addTrack(track, stream)
    this.tune(sender, stream)
    if (stream === this.display) {
      l.screenSenders.push({ sender, track })
      if (this.hiddenFrom.has(l.info.socketId)) void sender.replaceTrack(null)
    }
  }

  /** Para de assistir (ou volta a assistir) a tela de alguém: pede para a pessoa parar de mandar. */
  setWatching(socketId: string, watching: boolean) {
    if (watching) this.notWatching.delete(socketId)
    else this.notWatching.add(socketId)
    this.socket.emit('voice:watch', { to: socketId, watching })
    this.emit()
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
      if (stream === this.display) {
        // as faixas pausadas (sem track) também saem
        for (const { sender } of l.screenSenders) if (!sender.track) l.pc.removeTrack(sender)
        l.screenSenders = []
      }
    }
    if (stream === this.display) this.hiddenFrom.clear()
    tracks.forEach((t) => t.stop())
  }

  private sendState() {
    this.socket.emit('voice:state', {
      muted: this.muted || !this.mic,
      deaf: this.deafened,
      video: !!this.camera,
      screen: !!this.display,
      screenAudio: !!this.display?.getAudioTracks().length,
      cameraStream: this.camera?.id ?? null,
      screenStream: this.display?.id ?? null,
    })
  }

  private link(info: VoicePeer, waitOffer = false): Link {
    const existing = this.links.get(info.socketId)
    if (existing) return existing
    const pc = new RTCPeerConnection(ICE)
    const l: Link = {
      pc,
      info,
      streams: new Map(),
      screenSenders: [],
      makingOffer: false,
      ignoreOffer: false,
      settingAnswer: false,
      queue: Promise.resolve(),
      waitOffer,
      // "perfect negotiation": em colisão de ofertas, o lado educado cede
      polite: (this.socket.id ?? '') > info.socketId,
    }
    this.links.set(info.socketId, l)
    const send = (data: unknown) => this.socket.emit('voice:signal', { to: info.socketId, data })

    pc.onnegotiationneeded = () => {
      if (!l.waitOffer) void this.offer(l)
    }
    // quem já estava não mandou oferta (versão antiga, sinal perdido): toma a iniciativa
    if (waitOffer)
      setTimeout(() => {
        if (!l.waitOffer) return
        l.waitOffer = false
        this.renegotiateIfStale(l, true)
      }, 4000)
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
      if (pc.connectionState === 'connected' || pc.connectionState === 'closed') clearTimeout(l.iceTimer)
    }
    for (const s of [this.mic, this.camera, this.display]) {
      if (s) for (const t of s.getTracks()) this.addTo(l, t, s)
    }
    // sem nada pra enviar ainda: abre um canal de áudio só de recepção pra iniciar a conexão
    if (pc.getSenders().length === 0) pc.addTransceiver('audio', { direction: 'recvonly' })
    // sinais que chegaram antes desta conexão existir
    for (const data of this.early.get(info.socketId) ?? []) this.enqueue(l, data)
    this.early.delete(info.socketId)
    return l
  }

  private async offer(l: Link) {
    const { pc } = l
    try {
      l.makingOffer = true
      await pc.setLocalDescription()
      this.socket.emit('voice:signal', { to: l.info.socketId, data: { description: pc.localDescription } })
    } catch (e) {
      console.warn('negociação falhou', e)
    } finally {
      l.makingOffer = false
    }
  }

  /** Faixas minhas que ainda não estão sendo enviadas (ex.: a tela, se a oferta recebida não tinha vídeo)? Oferece. */
  private renegotiateIfStale(l: Link, force = false) {
    const { pc } = l
    if (this.closed || pc.signalingState !== 'stable' || l.makingOffer) return
    const stale = pc
      .getTransceivers()
      .some((t) => !!t.sender.track && t.currentDirection !== 'sendrecv' && t.currentDirection !== 'sendonly' && t.currentDirection !== 'stopped')
    if (stale || (force && !pc.remoteDescription)) void this.offer(l)
  }

  /** Rede de segurança: negociou, mas a conexão não sai do lugar em 8 s? Reinicia o ICE. */
  private watchIce(l: Link) {
    clearTimeout(l.iceTimer)
    l.iceTimer = setTimeout(() => {
      const st = l.pc.connectionState
      if (!this.closed && (st === 'new' || st === 'connecting')) l.pc.restartIce()
    }, 8000)
  }

  private onPeerJoined = (info: VoicePeer) => {
    this.link(info)
    this.emit()
  }

  private onPeerLeft = ({ socketId }: { socketId: string }) => {
    this.notWatching.delete(socketId)
    this.hiddenFrom.delete(socketId)
    const gone = this.links.get(socketId)
    if (gone) clearTimeout(gone.iceTimer)
    gone?.pc.close()
    this.links.delete(socketId)
    this.early.delete(socketId)
    this.emit()
  }

  private onWatch = ({ from, watching }: { from: string; watching: boolean }) => {
    if (watching) this.hiddenFrom.delete(from)
    else this.hiddenFrom.add(from)
    const l = this.links.get(from)
    if (!l) return
    for (const { sender, track } of l.screenSenders) void sender.replaceTrack(watching ? track : null).catch(() => {})
  }

  private onState = (info: VoicePeer) => {
    const l = this.links.get(info.socketId)
    // parou de transmitir: na próxima vez a tela volta a aparecer
    if (!info.screen) this.notWatching.delete(info.socketId)
    if (l) l.info = info
    this.emit()
  }

  private onSignal = ({ from, data }: { from: string; data: Signal }) => {
    const l = this.links.get(from)
    if (l) return this.enqueue(l, data)
    const list = this.early.get(from) ?? []
    if (list.length < 100) list.push(data)
    this.early.set(from, list)
  }

  private enqueue(l: Link, data: Signal) {
    l.queue = l.queue.then(() => this.handleSignal(l, data))
  }

  /** "Perfect negotiation" (especificação WebRTC): colisões de ofertas resolvidas sem travar nenhum lado. */
  private async handleSignal(l: Link, data: Signal) {
    const { pc } = l
    if (pc.signalingState === 'closed') return
    try {
      if (data.description) {
        const ready = !l.makingOffer && (pc.signalingState === 'stable' || l.settingAnswer)
        const collision = data.description.type === 'offer' && !ready
        l.ignoreOffer = !l.polite && collision
        if (l.ignoreOffer) return
        l.settingAnswer = data.description.type === 'answer'
        try {
          await pc.setRemoteDescription(data.description)
        } finally {
          l.settingAnswer = false
        }
        if (data.description.type === 'offer') {
          await pc.setLocalDescription()
          this.socket.emit('voice:signal', { to: l.info.socketId, data: { description: pc.localDescription } })
          if (l.waitOffer) {
            // respondida a primeira oferta: agora sim, ofereço o que ficou de fora (ex.: minha tela)
            l.waitOffer = false
            setTimeout(() => this.renegotiateIfStale(l), 0)
          }
        }
        this.watchIce(l)
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
      screenAudio: !!this.display?.getAudioTracks().length,
      notWatching: [...this.notWatching],
      micOk: !!this.mic,
      noise: this.micHandle?.mode ?? null,
      mic: this.mic,
      camera: this.camera,
      screenStream: this.display,
      remotes: [...this.links.values()].map((l) => ({ info: l.info, streams: [...l.streams.values()] })),
    })
  }
}
