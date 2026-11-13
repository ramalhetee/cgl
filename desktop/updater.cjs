// Atualização automática a partir das versões publicadas no GitHub.
// 1. Pergunta ao GitHub qual é a versão mais nova.
// 2. Se for mais nova que esta, baixa o CGL.zip em segundo plano e confere o SHA-256 publicado pelo GitHub.
// 3. Quando a pessoa aceita, a própria versão nova espera o app fechar, troca a pasta do app
//    (com volta atrás se falhar) e abre o CGL de novo. Contas e mensagens ficam em %APPDATA% e não são tocadas.
const { app } = require('electron')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const API = process.env.CGL_UPDATE_API || 'https://api.github.com/repos/ramalhetee/cgl/releases/latest'
const TRUSTED_HOSTS = /^(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)$/
const CHECK_EVERY = 30 * 60 * 1000

let state = { status: 'idle', current: app.getVersion() }
let listeners = []
let staged = null // { dir } pasta com a versão nova já extraída

const set = (patch) => {
  state = { ...state, ...patch }
  for (const fn of listeners) fn(state)
}
const newer = (a, b) => {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

async function check() {
  if (!app.isPackaged && !process.env.CGL_UPDATE_API) return // rodando pelo código-fonte: não atualiza
  if (['downloading', 'ready', 'applying'].includes(state.status)) return
  set({ status: 'checking', error: null })
  try {
    const res = await fetch(API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'CGL-updater' }, signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`)
    const rel = await res.json()
    const version = String(rel.tag_name || '').replace(/^v/, '')
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('versão publicada sem número válido')
    if (!newer(version, state.current)) return set({ status: 'none', latest: version })
    const asset = (rel.assets || []).find((a) => a.name === 'CGL.zip')
    const sha = /^sha256:([0-9a-f]{64})$/.exec(asset?.digest || '')?.[1]
    if (!asset || !sha) throw new Error('a versão nova não tem o arquivo com verificação')
    const url = new URL(asset.browser_download_url)
    if (!process.env.CGL_UPDATE_API && (url.protocol !== 'https:' || !TRUSTED_HOSTS.test(url.hostname))) throw new Error('endereço de download inesperado')
    await download(url, sha, version, asset.size)
  } catch (e) {
    set({ status: 'error', error: String(e.message || e) })
  }
}

async function download(url, sha, version, size) {
  set({ status: 'downloading', latest: version, progress: 0 })
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cgl-update-'))
  const zip = path.join(work, 'CGL.zip')
  const res = await fetch(url, { headers: { 'user-agent': 'CGL-updater' }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download falhou (${res.status})`)
  if (!process.env.CGL_UPDATE_API && !TRUSTED_HOSTS.test(new URL(res.url).hostname)) throw new Error('download redirecionado para endereço inesperado')
  const total = Number(res.headers.get('content-length')) || size || 0
  const hash = createHash('sha256')
  const out = fs.createWriteStream(zip)
  let got = 0
  let lastReport = 0
  for await (const chunk of res.body) {
    hash.update(chunk)
    got += chunk.length
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
    if (total && Date.now() - lastReport > 250) {
      lastReport = Date.now()
      set({ progress: Math.min(99, Math.floor((got / total) * 100)) })
    }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())))
  if (hash.digest('hex') !== sha) {
    fs.rmSync(work, { recursive: true, force: true })
    throw new Error('o arquivo baixado não confere com o publicado; nada foi instalado')
  }
  // extrai com o tar do próprio Windows
  const dir = path.join(work, 'novo')
  fs.mkdirSync(dir)
  await new Promise((resolve, reject) => {
    const tar = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir], { windowsHide: true })
    tar.on('error', reject)
    tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('não consegui extrair a atualização'))))
  })
  const appDir = path.join(dir, 'CGL-win32-x64')
  if (!fs.existsSync(path.join(appDir, 'CGL.exe')) || !fs.existsSync(path.join(appDir, 'resources', 'app', 'main.cjs'))) {
    throw new Error('a atualização veio incompleta')
  }
  fs.rmSync(zip, { force: true })
  staged = { work, dir: appDir }
  set({ status: 'ready', progress: 100 })
}

/** Fecha o app, copia a versão nova por cima e abre de novo. */
function apply() {
  if (state.status !== 'ready' || !staged) return false
  const target = path.dirname(process.execPath)
  // só mexe numa pasta que é mesmo uma instalação do CGL
  if (path.basename(process.execPath).toLowerCase() !== 'cgl.exe' || !fs.existsSync(path.join(target, 'resources', 'app', 'main.cjs'))) {
    set({ status: 'error', error: 'não reconheci a pasta do app; baixe a versão nova pelo GitHub' })
    return false
  }
  set({ status: 'applying' })
  // A versão nova (já conferida, na pasta temporária) faz a troca: espera este app fechar,
  // copia a si mesma para a pasta do app e reabre. Ela é um programa de janela comum, então
  // sobrevive ao fechamento deste processo.
  const job = {
    pid: process.pid,
    target,
    args: process.argv.slice(1), // reabre com as mesmas opções (ex.: outra pasta de dados)
    failFile: path.join(app.getPath('userData'), 'atualizacao-falhou.txt'),
  }
  const payload = Buffer.from(JSON.stringify(job)).toString('base64url')
  const child = spawn(path.join(staged.dir, 'CGL.exe'), [`--cgl-apply-update=${payload}`], { detached: true, stdio: 'ignore', cwd: staged.work })
  child.unref()
  setTimeout(() => app.quit(), 200)
  return true
}

/**
 * Modo "instalar atualização": roda a partir da pasta temporária da versão nova.
 * Retorna true se este processo foi aberto só para isso (aí o app normal não deve iniciar).
 */
function runApplyMode() {
  const arg = process.argv.find((a) => a.startsWith('--cgl-apply-update='))
  if (!arg) return false
  let job
  try {
    job = JSON.parse(Buffer.from(arg.slice('--cgl-apply-update='.length), 'base64url').toString('utf8'))
  } catch {
    app.exit(1)
    return true
  }
  // Quem abre o app com duplo clique deixa a pasta do app como pasta atual, e este processo herda isso.
  // Enquanto um processo "está dentro" da pasta, o Windows não deixa renomeá-la: sai dela antes de tudo.
  try {
    process.chdir(os.tmpdir())
  } catch {}
  const source = path.dirname(process.execPath)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const fail = (why) => {
    try {
      fs.writeFileSync(job.failFile, why)
    } catch {}
  }
  void (async () => {
    // 1. espera o app antigo fechar (até 60 s)
    for (let i = 0; i < 120 && alive(job.pid); i++) await sleep(500)
    await sleep(800)
    const looksLikeCgl = (dir) => fs.existsSync(path.join(dir, 'CGL.exe')) && fs.existsSync(path.join(dir, 'resources', 'app', 'main.cjs'))
    if (!looksLikeCgl(job.target) || !looksLikeCgl(source)) {
      fail('pasta não reconhecida')
    } else {
      // 2. troca: a pasta antiga vira backup, a nova é copiada; se algo falhar, o backup volta
      const backup = `${job.target}.antigo-${Date.now()}`
      let moved = false
      for (let i = 0; i < 30 && !moved; i++) {
        try {
          fs.renameSync(job.target, backup)
          moved = true
        } catch {
          await sleep(500) // algum arquivo ainda preso pelo app que está fechando
        }
      }
      if (!moved) {
        // plano B: copia os arquivos novos por cima dos antigos (funciona se nenhum arquivo estiver aberto)
        try {
          fs.cpSync(source, job.target, { recursive: true, force: true })
        } catch (e) {
          fail(`não deu para trocar os arquivos (${e.code || e.message}); feche o CGL e tente de novo`)
        }
      } else {
        try {
          fs.cpSync(source, job.target, { recursive: true })
          fs.rmSync(backup, { recursive: true, force: true })
        } catch (e) {
          fail(`cópia falhou: ${e.message}`)
          try {
            fs.rmSync(job.target, { recursive: true, force: true })
            fs.renameSync(backup, job.target)
          } catch {}
        }
      }
    }
    // 3. reabre o app (versão nova, ou a antiga se a troca falhou)
    const exe = path.join(job.target, 'CGL.exe')
    if (fs.existsSync(exe)) spawn(exe, Array.isArray(job.args) ? job.args : [], { detached: true, stdio: 'ignore', cwd: job.target }).unref()
    app.exit(0)
  })()
  return true
}

/** Apaga pastas temporárias de atualizações anteriores. */
function cleanOld() {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('cgl-update-')) continue
      const dir = path.join(os.tmpdir(), name)
      if (Date.now() - fs.statSync(dir).mtimeMs > 10 * 60 * 1000) fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch {}
}

function start() {
  cleanOld()
  setTimeout(() => void check(), 3000)
  setInterval(() => void check(), CHECK_EVERY).unref?.()
  // se a última atualização falhou, avisa uma vez
  const fail = path.join(app.getPath('userData'), 'atualizacao-falhou.txt')
  if (fs.existsSync(fail)) {
    let why = ''
    try {
      why = fs.readFileSync(fail, 'utf8').trim().slice(0, 200)
    } catch {}
    fs.rmSync(fail, { force: true })
    set({ status: 'error', error: `a última atualização não terminou${why ? ` (${why})` : ''}; vou tentar de novo` })
  }
}

module.exports = {
  start,
  check,
  apply,
  runApplyMode,
  getState: () => state,
  onChange: (fn) => listeners.push(fn),
}
