// CGL desktop.
// - "Hospedar": sobe o servidor embutido neste PC (dados na pasta do usuário).
// - "Entrar": abre uma ponte local (127.0.0.1) até o servidor de outra pessoa. A interface sempre
//   roda em localhost, então microfone, câmera e tela funcionam sem HTTPS.
const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, session, shell, Menu } = require('electron')
const http = require('node:http')
const https = require('node:https')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const updater = require('./updater.cjs')
// aberto só para instalar uma atualização: não inicia o app normal
const APPLYING_UPDATE = updater.runApplyMode()

const HOST_PORT = Number(process.env.TAVERNA_PORT || 3210)
const BRIDGE_PORT = 32100
const BUNDLE = path.join(__dirname, 'app') // gerado por scripts/build-desktop.mjs
const PRELOAD = path.join(__dirname, 'preload.cjs')
const BG = '#1b1613'

// O app se chamava Taverna. Na primeira vez com o nome novo, traz contas, mensagens, fotos e login
// da pasta antiga (%APPDATA%\\Taverna) para a nova. A antiga fica intacta.
function migrateOldData() {
  const forced = process.env.TAVERNA_OLD_DATA // só para teste: pasta antiga em outro lugar
  if (!forced && process.argv.some((a) => a.startsWith('--user-data-dir'))) return
  const now = app.getPath('userData')
  const old = forced || path.join(app.getPath('appData'), 'Taverna')
  if (path.resolve(now) === path.resolve(old)) return
  if (fs.existsSync(path.join(now, 'dados')) || !fs.existsSync(path.join(old, 'dados'))) return
  try {
    fs.cpSync(path.join(old, 'dados'), path.join(now, 'dados'), { recursive: true }) // o essencial primeiro
  } catch (e) {
    console.error('migração dos dados falhou', e)
    return
  }
  for (const name of fs.readdirSync(old)) {
    if (name === 'dados' || name === 'lockfile' || name.startsWith('Singleton')) continue
    try {
      fs.cpSync(path.join(old, name), path.join(now, name), { recursive: true }) // login salvo, recentes
    } catch {
      // arquivo em uso ou ilegível: segue sem ele
    }
  }
}
if (!APPLYING_UPDATE) migrateOldData()

let launcher = null
let room = null // janela conectada a um servidor
let picker = null
let bridge = null
let hosting = false
let current = null // { label, hosting }
let tunnel = null // { proc, url }

/** Túnel rápido da Cloudflare: dá um link https público que aponta pro servidor deste PC. */
function startTunnel() {
  if (tunnel?.url) return Promise.resolve(tunnel.url)
  if (tunnel?.starting) return tunnel.starting
  const exe = path.join(__dirname, 'bin', 'cloudflared.exe')
  if (!fs.existsSync(exe)) return Promise.reject(new Error('Este app foi montado sem o túnel'))
  const proc = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${HOST_PORT}`], { windowsHide: true })
  const mine = { proc, url: null, starting: null }
  tunnel = mine
  mine.starting = new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('O túnel demorou demais. Confira a internet e tente de novo.')), 40000)
    const fail = (err) => {
      clearTimeout(timer)
      proc.kill()
      if (tunnel === mine) tunnel = null
      reject(err)
    }
    let log = ''
    const onData = (chunk) => {
      if (mine.url) return
      log = (log + chunk).slice(-8000)
      const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      // Só entrega o link depois que o túnel conectou, e com folga pro DNS do link novo propagar:
      // quem tenta cedo demais recebe "não existe" e o PC da pessoa guarda essa resposta por um tempo.
      if (m && /Registered tunnel connection/.test(log)) {
        clearTimeout(timer)
        mine.url = m[0]
        setTimeout(() => resolve(m[0]), 6000)
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('error', fail)
    proc.on('exit', () => {
      if (tunnel === mine) tunnel = null
      if (!mine.url) fail(new Error('O túnel não abriu'))
      else room?.webContents.send('tunnel:closed')
    })
  })
  return mine.starting
}
function stopTunnel() {
  tunnel?.proc.kill()
  tunnel = null
}

const recentsFile = () => path.join(app.getPath('userData'), 'recentes.json')
const readRecents = () => {
  try {
    return JSON.parse(fs.readFileSync(recentsFile(), 'utf8')).filter((x) => typeof x === 'string').slice(0, 8)
  } catch {
    return []
  }
}
const addRecent = (addr) =>
  fs.writeFileSync(recentsFile(), JSON.stringify([addr, ...readRecents().filter((x) => x !== addr)].slice(0, 8)))

function lanAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`${a.address}:${HOST_PORT}`)
  }
  return out
}

async function reachable(url) {
  try {
    const r = await fetch(new URL('/api/me', url), { signal: AbortSignal.timeout(4000) })
    return r.status === 401 || r.ok // 401 = é um servidor CGL, só falta login
  } catch {
    return false
  }
}

async function startHosting() {
  if (hosting) return
  // Nunca adota um servidor que já esteja na porta: pode ser de outra versão e com outros dados.
  // Se a porta estiver ocupada, o listen falha e o usuário vê o aviso de porta em uso.
  const data = path.join(app.getPath('userData'), 'dados')
  fs.mkdirSync(data, { recursive: true })
  process.env.TAVERNA_DATA = data
  process.env.TAVERNA_WEB = path.join(BUNDLE, 'web')
  process.env.PORT = String(HOST_PORT)
  process.env.HOST = '0.0.0.0'
  await import(pathToFileURL(path.join(BUNDLE, 'server.mjs')).href)
  hosting = true
}

/** Ponte local: repassa HTTP e WebSocket de 127.0.0.1 para o servidor escolhido. */
function startBridge(target) {
  const mod = target.protocol === 'https:' ? https : http
  const opts = (req) => ({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: target.host },
  })
  const server = http.createServer((req, res) => {
    const out = mod.request(opts(req), (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    out.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Servidor fora do ar')
    })
    req.pipe(out)
  })
  server.on('upgrade', (req, socket, head) => {
    const out = mod.request(opts(req))
    out.on('upgrade', (r, upstream, upHead) => {
      const lines = [`HTTP/1.1 ${r.statusCode} ${r.statusMessage}`]
      for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`)
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upHead.length) socket.write(upHead)
      if (head.length) upstream.write(head)
      upstream.pipe(socket).on('error', () => upstream.destroy())
      socket.pipe(upstream).on('error', () => socket.destroy())
      upstream.on('close', () => socket.destroy())
      socket.on('close', () => upstream.destroy())
    })
    out.on('response', () => socket.destroy())
    out.on('error', () => socket.destroy())
    out.end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(BRIDGE_PORT, '127.0.0.1', () => resolve(server))
  })
}

function parseAddress(text) {
  let s = String(text || '').trim()
  if (!s) throw new Error('Digite o endereço de quem está hospedando')
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  const url = new URL(s)
  if (!url.port && url.protocol === 'http:') url.port = String(HOST_PORT)
  return new URL(url.origin)
}

function secureSession(partition, origin) {
  const ses = session.fromPartition(partition)
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    let ok = false
    try {
      ok = ['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(permission) && new URL(wc.getURL()).origin === origin
    } catch {}
    cb(ok)
  })
  // Compartilhar tela: seletor próprio, sem a barra do navegador.
  ses.setDisplayMediaRequestHandler((_req, cb) => {
    pickSource()
      .then((choice) => (choice ? cb({ video: choice.source, ...(choice.audio ? { audio: 'loopback' } : {}) }) : cb({})))
      .catch(() => cb({}))
  })
  return ses
}

let pickerSources = []
let pickerDone = null
async function pickSource() {
  if (picker) return null
  pickerSources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  })
  return new Promise((resolve) => {
    pickerDone = resolve
    picker = new BrowserWindow({
      parent: room ?? undefined, modal: true, width: 760, height: 560, resizable: false, minimizable: false,
      backgroundColor: BG, autoHideMenuBar: true, title: 'Compartilhar tela',
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    picker.on('closed', () => {
      picker = null
      pickerDone?.(null)
      pickerDone = null
    })
    void picker.loadFile(path.join(__dirname, 'picker.html'))
  })
}

function openLauncher() {
  if (launcher) return launcher.focus()
  launcher = new BrowserWindow({
    width: 560, height: 640, resizable: false, backgroundColor: BG, autoHideMenuBar: true, title: 'CGL',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  launcher.on('closed', () => (launcher = null))
  void launcher.loadFile(path.join(__dirname, 'launcher.html'))
}

async function openRoom(url, label, isHost) {
  const origin = new URL(url).origin
  const partition = 'persist:' + createHash('sha1').update(label).digest('hex').slice(0, 16)
  const ses = secureSession(partition, origin)
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 760, minHeight: 500, show: false,
    backgroundColor: BG, autoHideMenuBar: true, title: 'CGL',
    webPreferences: { session: ses, preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/.test(u)) void shell.openExternal(u.startsWith(origin) && !isHost ? u.replace(origin, current?.remote ?? origin) : u)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, u) => {
    if (new URL(u).origin !== origin) e.preventDefault()
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (room === win) {
      room = null
      globalShortcut.unregisterAll()
      bridge?.close()
      bridge?.closeAllConnections?.()
      bridge = null
      current = null
      if (!quitting) openLauncher()
    }
  })
  room = win
  await win.loadURL(url)
  launcher?.close()
}

const fromLauncher = (e) => launcher && e.sender === launcher.webContents
const fromRoom = (e) => room && e.sender === room.webContents
const fromPicker = (e) => picker && e.sender === picker.webContents

ipcMain.handle('launcher:state', (e) =>
  fromLauncher(e) ? { hosting, addresses: lanAddresses(), recents: readRecents(), version: app.getVersion() } : null)

// ---------- atualização ----------
const fromApp = (e) => fromLauncher(e) || fromRoom(e)
ipcMain.handle('update:state', (e) => (fromApp(e) ? updater.getState() : null))
ipcMain.handle('update:check', (e) => (fromApp(e) ? updater.check() : null))
ipcMain.handle('update:apply', (e) => (fromApp(e) ? updater.apply() : false))
updater.onChange((st) => {
  for (const w of [launcher, room]) if (w && !w.isDestroyed()) w.webContents.send('update:state', st)
})
ipcMain.handle('launcher:host', async (e) => {
  if (!fromLauncher(e)) return
  try {
    await startHosting()
    current = { label: 'host', hosting: true }
    await openRoom(`http://localhost:${HOST_PORT}`, 'host', true)
    return { ok: true }
  } catch (err) {
    return { error: err.code === 'EADDRINUSE' ? `A porta ${HOST_PORT} já está em uso neste PC. Feche o outro programa que a usa (ou outro CGL aberto) e tente de novo` : String(err.message || err) }
  }
})
ipcMain.handle('launcher:connect', async (e, text) => {
  if (!fromLauncher(e)) return
  try {
    const target = parseAddress(text)
    let found = false
    for (let i = 0; i < 3 && !found; i++) {
      if (i) await new Promise((r) => setTimeout(r, 2500))
      found = await reachable(target)
    }
    if (!found) return { error: 'Não achei um servidor CGL nesse endereço. Confira o endereço e se quem hospeda está com o app aberto.' }
    bridge = await startBridge(target)
    addRecent(target.host)
    current = { label: target.host, hosting: false, remote: target.origin }
    await openRoom(`http://127.0.0.1:${BRIDGE_PORT}`, target.host, false)
    return { ok: true }
  } catch (err) {
    bridge?.close()
    bridge = null
    return { error: err.code === 'EADDRINUSE' ? 'O CGL já está aberto em outra janela' : String(err.message || err) }
  }
})
ipcMain.handle('room:info', (e) =>
  fromRoom(e) && current
    ? { hosting: current.hosting, label: current.label, addresses: current.hosting ? lanAddresses() : [], tunnel: current.hosting ? tunnel?.url ?? null : null }
    : null)
ipcMain.handle('tunnel:start', async (e) => {
  if (!fromRoom(e) || !current?.hosting) return { error: 'Só quem hospeda abre o túnel' }
  try {
    return { url: await startTunnel() }
  } catch (err) {
    return { error: String(err.message || err) }
  }
})
ipcMain.handle('tunnel:stop', (e) => {
  if (fromRoom(e) && current?.hosting) stopTunnel()
})
// Atalhos globais (funcionam com o app minimizado ou dentro de um jogo).
const HOTKEY_NAMES = ['mute', 'deafen']
const HOTKEY_MODS = new Set(['Ctrl', 'Alt', 'Shift', 'Super'])
const HOTKEY_KEY = /^([A-Z0-9]|F([1-9]|1\d|2[0-4])|num[0-9]|num(dec|add|sub|mult|div)|Plus|Space|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Capslock|Numlock|Scrolllock|PrintScreen|VolumeUp|VolumeDown|VolumeMute|MediaNextTrack|MediaPreviousTrack|MediaStop|MediaPlayPause|[-=\[\]\\;',./`])$/
/** "Ctrl+Shift+=" -> válido se tiver zero ou mais modificadores e exatamente uma tecla conhecida no fim. */
function validHotkey(acc) {
  if (typeof acc !== 'string' || !acc || acc.length > 40) return false
  const parts = acc.split('+')
  const key = parts.pop()
  return HOTKEY_KEY.test(key) && parts.every((m) => HOTKEY_MODS.has(m)) && new Set(parts).size === parts.length
}
ipcMain.handle('hotkeys:set', (e, map) => {
  if (!fromRoom(e)) return { failed: [] }
  globalShortcut.unregisterAll()
  const failed = []
  for (const name of HOTKEY_NAMES) {
    const acc = map?.[name]
    if (!validHotkey(acc)) continue
    let ok = false
    try {
      ok = globalShortcut.register(acc, () => room?.webContents.send('hotkey', name))
    } catch {
      ok = false
    }
    if (!ok) failed.push(name) // combinação inválida ou já usada por outro programa
  }
  return { failed }
})

ipcMain.handle('room:leave', (e) => {
  if (fromRoom(e)) room.close()
})
ipcMain.handle('picker:sources', (e) =>
  fromPicker(e) ? pickerSources.map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumb: s.thumbnail.toDataURL() })) : [])
ipcMain.handle('picker:choose', (e, id, audio) => {
  if (!fromPicker(e)) return
  const source = pickerSources.find((s) => s.id === id)
  pickerDone?.(source ? { source, audio: !!audio && source.id.startsWith('screen:') } : null)
  pickerDone = null
  picker.close()
})

let quitting = false
app.on('before-quit', () => (quitting = true))
app.on('quit', stopTunnel)
app.on('will-quit', () => globalShortcut.unregisterAll())
if (APPLYING_UPDATE) {
  // nada: o modo de atualização cuida de tudo e fecha sozinho
} else if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => (room ?? launcher)?.focus())
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    updater.start()
    openLauncher()
  })
  app.on('window-all-closed', () => app.quit())
}
