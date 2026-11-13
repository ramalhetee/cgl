// Ponte mínima entre as páginas e o processo principal. O principal confere de qual janela veio cada chamada.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('taverna', {
  // janela conectada
  info: () => ipcRenderer.invoke('room:info'),
  leave: () => ipcRenderer.invoke('room:leave'),
  tunnelStart: () => ipcRenderer.invoke('tunnel:start'),
  tunnelStop: () => ipcRenderer.invoke('tunnel:stop'),
  onTunnelClosed: (fn) => ipcRenderer.on('tunnel:closed', () => fn()),
  setHotkeys: (map) => ipcRenderer.invoke('hotkeys:set', map),
  onHotkey: (fn) => {
    const h = (_e, name) => fn(name)
    ipcRenderer.on('hotkey', h)
    return () => ipcRenderer.removeListener('hotkey', h)
  },
  // tela inicial
  state: () => ipcRenderer.invoke('launcher:state'),
  host: () => ipcRenderer.invoke('launcher:host'),
  connect: (address) => ipcRenderer.invoke('launcher:connect', address),
  // atualização
  updateState: () => ipcRenderer.invoke('update:state'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateApply: () => ipcRenderer.invoke('update:apply'),
  onUpdate: (fn) => {
    const h = (_e, st) => fn(st)
    ipcRenderer.on('update:state', h)
    return () => ipcRenderer.removeListener('update:state', h)
  },
  // seletor de tela
  sources: () => ipcRenderer.invoke('picker:sources'),
  choose: (id, audio) => ipcRenderer.invoke('picker:choose', id, audio),
})
