// Microfone com supressão de ruído. Esconde atrás de openMicrophone() tudo o que é preciso:
// restrições do getUserMedia, volta para o microfone padrão, WASM do RNNoise, AudioWorklet e
// AudioContext de 48 kHz. Quem chama recebe um MediaStream pronto para enviar e um close().
//
// RNNoise (xiph, BSD-3) via @sapphi-red/web-noise-suppressor (MIT) e shiguredo/rnnoise-wasm (Apache-2.0).
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

export type NoiseMode = 'off' | 'browser' | 'rnnoise'
export const DEFAULT_NOISE_MODE: NoiseMode = 'browser'
export const NOISE_MODES: { id: NoiseMode; name: string; hint: string }[] = [
  { id: 'off', name: 'Desligada', hint: 'Microfone sem filtro.' },
  { id: 'browser', name: 'Padrão', hint: 'Filtro leve do próprio navegador.' },
  { id: 'rnnoise', name: 'Forte (RNNoise)', hint: 'Rede neural: tira ventilador, teclado e barulho de fundo.' },
]
export const isNoiseMode = (v: unknown): v is NoiseMode => v === 'off' || v === 'browser' || v === 'rnnoise'

export type Microphone = {
  /** O que deve ser enviado/medido: já com o filtro aplicado. */
  stream: MediaStream
  /** Modo que de fato está ativo (RNNoise cai para 'browser' se não puder rodar). */
  mode: NoiseMode
  close: () => void
}

let wasm: Promise<ArrayBuffer> | null = null
const loadWasm = () => {
  wasm ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdUrl }).catch((e) => {
    wasm = null // tenta de novo na próxima vez
    throw e
  })
  return wasm
}

async function getRaw(deviceId: string, noiseSuppression: boolean): Promise<MediaStream | null> {
  const base = { echoCancellation: true, autoGainControl: true, noiseSuppression }
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } } })
    } catch {
      // o microfone salvo não está ligado: cai no padrão
    }
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: base })
  } catch {
    return null // sem microfone
  }
}

async function withRnnoise(raw: MediaStream): Promise<Microphone> {
  // o RNNoise só funciona a 48 kHz; o navegador converte a taxa do microfone
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
  try {
    const [binary] = await Promise.all([loadWasm(), ctx.audioWorklet.addModule(rnnoiseWorkletUrl)])
    const source = ctx.createMediaStreamSource(raw)
    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary })
    const out = ctx.createMediaStreamDestination()
    out.channelCount = 1
    source.connect(node).connect(out)
    void ctx.resume()
    return {
      stream: out.stream,
      mode: 'rnnoise',
      close: () => {
        source.disconnect()
        node.disconnect()
        node.destroy()
        void ctx.close()
        raw.getTracks().forEach((t) => t.stop())
        out.stream.getTracks().forEach((t) => t.stop())
      },
    }
  } catch (e) {
    void ctx.close()
    throw e
  }
}

/**
 * Abre o microfone escolhido (ou o padrão, se ele não estiver ligado) com o filtro pedido.
 * Devolve null se não houver microfone nenhum.
 */
export async function openMicrophone(deviceId: string, mode: NoiseMode): Promise<Microphone | null> {
  if (mode === 'rnnoise') {
    // sem o filtro do navegador: dois filtros em sequência deixam a voz robótica
    const raw = await getRaw(deviceId, false)
    if (!raw) return null
    try {
      return await withRnnoise(raw)
    } catch (e) {
      console.warn('RNNoise indisponível, usando o filtro padrão', e)
      raw.getTracks().forEach((t) => t.stop())
      return openMicrophone(deviceId, 'browser')
    }
  }
  const raw = await getRaw(deviceId, mode === 'browser')
  if (!raw) return null
  return { stream: raw, mode, close: () => raw.getTracks().forEach((t) => t.stop()) }
}
