// Ponte mínima entre as páginas e o processo principal. O principal confere de qual janela veio cada chamada.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('taverna', {
  // janela conectada
  info: () => ipcRenderer.invoke('room:info'),
  leave: () => ipcRenderer.invoke('room:leave'),
  tunnelStart: () => ipcRenderer.invoke('tunnel:start'),
  tunnelStop: () => ipcRenderer.invoke('tunnel:stop'),
  onTunnelClosed: (fn) => ipcRenderer.on('tunnel:closed', () => fn()),
  // tela inicial
  state: () => ipcRenderer.invoke('launcher:state'),
  host: () => ipcRenderer.invoke('launcher:host'),
  connect: (address) => ipcRenderer.invoke('launcher:connect', address),
  // seletor de tela
  sources: () => ipcRenderer.invoke('picker:sources'),
  choose: (id, audio) => ipcRenderer.invoke('picker:choose', id, audio),
})
