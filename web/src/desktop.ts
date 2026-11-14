// Ponte com o app desktop (window.taverna, exposta por desktop/preload.cjs).
// É a única seam entre a interface e o casco: para trocar o casco (ex.: Electron → Tauri), basta
// outro casco expor os mesmos métodos. Fora do app desktop (navegador), `desktop` é undefined.
//
// Contrato completo da ponte (preload.cjs):
//   janela da sala:  info, leave, tunnelStart, tunnelStop, onTunnelClosed, setHotkeys, onHotkey,
//                    updateState, updateCheck, updateApply, onUpdate
//   barra de título: setTitleBarColors (sala e tela inicial; os botões são os do Windows, por cima da barra)
//   tela inicial:    state, host, connect            (usados só por desktop/launcher.html)
//   seletor de tela: sources, choose                 (usados só por desktop/picker.html)
// Aqui ficam tipados só os que a interface web usa.

export type DesktopInfo = { hosting: boolean; label: string; addresses: string[]; tunnel: string | null }
export type UpdateState = { status: string; current: string; latest?: string; progress?: number; error?: string | null }
export type Hotkeys = { mute?: string; deafen?: string }

export type DesktopBridge = {
  /** Sala atual: se este PC hospeda, endereços para os outros entrarem e o link do túnel. */
  info: () => Promise<DesktopInfo | null>
  /** Fecha a sala e volta para a tela inicial. */
  leave: () => Promise<void>
  /** Atalhos globais (funcionam com outro programa em foco). Devolve os que o Windows recusou. */
  setHotkeys?: (map: Hotkeys) => Promise<{ failed: string[] }>
  onHotkey?: (fn: (name: string) => void) => () => void
  updateState?: () => Promise<UpdateState | null>
  updateApply?: () => Promise<boolean>
  onUpdate?: (fn: (s: UpdateState) => void) => () => void
  /** Túnel para a internet (só quem hospeda). */
  tunnelStart: () => Promise<{ url?: string; error?: string }>
  tunnelStop: () => Promise<void>
  onTunnelClosed: (fn: () => void) => void
  /** Cores dos botões do Windows sobre a barra própria (#rrggbb). Ausente em versões antigas do app. */
  setTitleBarColors?: (color: string, symbol: string) => Promise<boolean>
}

/** A janela está sem a barra do Windows e a página deve desenhar a sua (Window Controls Overlay). */
export const ownTitleBar = (): boolean =>
  !!(navigator as Navigator & { windowControlsOverlay?: { visible: boolean } }).windowControlsOverlay?.visible

export const desktop: DesktopBridge | undefined = (window as unknown as { taverna?: DesktopBridge }).taverna
