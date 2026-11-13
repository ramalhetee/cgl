/**
 * Sons curtos da chamada, sintetizados na hora (nenhum arquivo de áudio).
 * Cada som é uma sequência de notas com envelope suave.
 */
export type Cue =
  | 'join'
  | 'leave'
  | 'peerJoin'
  | 'peerLeave'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'screenOn'
  | 'screenOff'

type Note = { f: number; at: number; len: number; gain?: number; type?: OscillatorType }

// notas em Hz: C5 523, D5 587, E5 659, G5 784, A5 880, C6 1047
const CUES: Record<Cue, Note[]> = {
  join: [
    { f: 523, at: 0, len: 0.12 },
    { f: 784, at: 0.09, len: 0.2 },
  ],
  leave: [
    { f: 784, at: 0, len: 0.12 },
    { f: 523, at: 0.09, len: 0.22 },
  ],
  peerJoin: [
    { f: 659, at: 0, len: 0.09, gain: 0.7 },
    { f: 880, at: 0.07, len: 0.14, gain: 0.7 },
  ],
  peerLeave: [
    { f: 880, at: 0, len: 0.09, gain: 0.7 },
    { f: 659, at: 0.07, len: 0.16, gain: 0.7 },
  ],
  mute: [
    { f: 587, at: 0, len: 0.07, type: 'triangle' },
    { f: 440, at: 0.06, len: 0.11, type: 'triangle' },
  ],
  unmute: [
    { f: 440, at: 0, len: 0.07, type: 'triangle' },
    { f: 587, at: 0.06, len: 0.11, type: 'triangle' },
  ],
  deafen: [
    { f: 494, at: 0, len: 0.09, type: 'triangle' },
    { f: 392, at: 0.08, len: 0.09, type: 'triangle' },
    { f: 330, at: 0.16, len: 0.16, type: 'triangle' },
  ],
  undeafen: [
    { f: 330, at: 0, len: 0.09, type: 'triangle' },
    { f: 392, at: 0.08, len: 0.09, type: 'triangle' },
    { f: 494, at: 0.16, len: 0.16, type: 'triangle' },
  ],
  screenOn: [
    { f: 523, at: 0, len: 0.08 },
    { f: 659, at: 0.07, len: 0.08 },
    { f: 1047, at: 0.14, len: 0.18 },
  ],
  screenOff: [
    { f: 1047, at: 0, len: 0.08 },
    { f: 659, at: 0.07, len: 0.08 },
    { f: 523, at: 0.14, len: 0.18 },
  ],
}

let ctx: (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null = null
let sink = ''

/** Toca um som. volume de 0 a 100; sinkId '' = saída padrão. */
export async function playCue(cue: Cue, volume: number, sinkId = '') {
  if (volume <= 0) return
  // usado pelos testes automáticos para conferir quais sons tocaram
  ;((globalThis as { __cglCues?: string[] }).__cglCues ??= []).push(cue)
  ctx ??= new AudioContext({ latencyHint: 'interactive' })
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
  if (sinkId !== sink && ctx.setSinkId) {
    try {
      await ctx.setSinkId(sinkId)
      sink = sinkId
    } catch {
      // dispositivo sumiu: toca na saída atual
    }
  }
  const master = ctx.createGain()
  master.gain.value = (Math.min(100, volume) / 100) * 0.35
  master.connect(ctx.destination)
  const t0 = ctx.currentTime + 0.01
  let end = t0
  for (const n of CUES[cue]) {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = n.type ?? 'sine'
    osc.frequency.value = n.f
    const start = t0 + n.at
    const peak = n.gain ?? 1
    g.gain.setValueAtTime(0.0001, start)
    g.gain.exponentialRampToValueAtTime(peak, start + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, start + n.len)
    osc.connect(g).connect(master)
    osc.start(start)
    osc.stop(start + n.len + 0.02)
    end = Math.max(end, start + n.len + 0.05)
  }
  setTimeout(() => master.disconnect(), (end - ctx.currentTime) * 1000 + 100)
}

export const CUE_NAMES: Record<Cue, string> = {
  join: 'Entrar na chamada',
  leave: 'Sair da chamada',
  peerJoin: 'Alguém entrou',
  peerLeave: 'Alguém saiu',
  mute: 'Microfone mudo',
  unmute: 'Microfone ligado',
  deafen: 'Sem ouvir',
  undeafen: 'Voltar a ouvir',
  screenOn: 'Tela compartilhada',
  screenOff: 'Parou de compartilhar',
}
