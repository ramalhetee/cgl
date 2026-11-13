// Teste da atualização automática, sem publicar nada: simula o GitHub no próprio PC.
// Copia o app empacotado para uma pasta temporária (a "instalação"), monta uma "versão 0.5.9" com um
// arquivo marcador e confere que a instalação se atualiza sozinha e reabre. Também confere que um
// arquivo adulterado (SHA-256 errado) é recusado sem tocar na instalação.
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const built = process.env.TAVERNA_BUILD || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const work = mkdtempSync(join(tmpdir(), 'cgl-updtest-'))
const install = join(work, 'instalacao', 'CGL-win32-x64')
const newer = join(work, 'nova', 'CGL-win32-x64')
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd]).toString().trim()

console.log('preparando cópias...')
cpSync(built, install, { recursive: true })
cpSync(built, newer, { recursive: true })
const pkgPath = join(newer, 'resources', 'app', 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.version = '0.5.9'
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
writeFileSync(join(newer, 'resources', 'app', 'VERSAO-NOVA.txt'), 'atualizado')
const zip = join(work, 'CGL.zip')
execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', join(work, 'nova'), 'CGL-win32-x64'])
const sha = createHash('sha256').update(readFileSync(zip)).digest('hex')

// "GitHub" falso
let digest = 'sha256:' + '0'.repeat(64) // primeiro: arquivo adulterado
const server = http.createServer((q, s) => {
  if (q.url === '/latest') {
    s.writeHead(200, { 'content-type': 'application/json' })
    return s.end(JSON.stringify({ tag_name: 'v0.5.9', assets: [{ name: 'CGL.zip', size: readFileSync(zip).length, digest, browser_download_url: `http://127.0.0.1:${server.address().port}/CGL.zip` }] }))
  }
  if (q.url === '/CGL.zip') {
    s.writeHead(200, { 'content-type': 'application/zip', 'content-length': readFileSync(zip).length })
    return s.end(readFileSync(zip))
  }
  s.writeHead(404)
  s.end()
}).listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const api = `http://127.0.0.1:${server.address().port}/latest`

const launch = (dbg) =>
  spawn(join(install, 'CGL.exe'), [`--remote-debugging-port=${dbg}`, `--user-data-dir=${join(work, 'dados-' + dbg)}`], { env: { ...process.env, CGL_UPDATE_API: api, TAVERNA_PORT: '3328' }, stdio: 'ignore' })
const launcherPage = async (dbg) => {
  for (let i = 0; i < 60; i++) {
    try {
      const p = (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find((t) => t.url.includes('launcher.html'))
      if (p) return p
    } catch {}
    await sleep(250)
  }
  throw new Error('tela inicial não abriu')
}
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) { ws.close(); resolve(m.result.result?.value) } }
  ws.onerror = () => reject(new Error('ws'))
})
const waitStatus = async (page, want, ms = 60000) => {
  const end = Date.now() + ms
  let st
  while (Date.now() < end) {
    st = await evaluate(page, 'window.taverna.updateState()')
    if (want.includes(st?.status)) return st
    await sleep(500)
  }
  return st
}
const running = () => ps(`@(Get-CimInstance Win32_Process -Filter "Name='CGL.exe'" | Where-Object { $_.ExecutablePath -like '${install.replace(/'/g, "''")}*' }).Count`)

// espera a tela inicial terminar de carregar (a janela aparece para o depurador antes disso)
const ready = async (p) => { for (let i = 0; i < 60; i++) { try { if (await evaluate(p, "document.readyState === 'complete' && !!window.taverna")) return p } catch {} await sleep(250) } return p }

try {
  // 1. arquivo adulterado: recusado
  let app = launch(9461)
  let page = await launcherPage(9461)
  let st = await waitStatus(page, ['error', 'ready'])
  console.log('arquivo adulterado:', JSON.stringify({ status: st.status, erro: st.error }), '| instalação intacta:', !existsSync(join(install, 'resources', 'app', 'VERSAO-NOVA.txt')))
  console.log('aviso na tela inicial:', await evaluate(page, "document.getElementById('update').hidden ? '(escondido)' : document.getElementById('update-text').textContent"))
  app.kill()
  await sleep(1500)

  // 2. arquivo certo: baixa, confere, atualiza e reabre
  digest = 'sha256:' + sha
  app = launch(9462)
  page = await launcherPage(9462)
  st = await waitStatus(page, ['ready', 'error'])
  console.log('versão nova baixada:', JSON.stringify({ status: st.status, atual: st.current, nova: st.latest }))
  console.log('botão na tela inicial:', await evaluate(page, "document.getElementById('update-text').textContent + ' | botão: ' + !document.getElementById('update-go').hidden"))
  void evaluate(page, "document.getElementById('update-go').click()").catch(() => {})
  let ok = false
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(1000)
    ok = existsSync(join(install, 'resources', 'app', 'VERSAO-NOVA.txt')) && running() !== '0'
  }
  const ver = JSON.parse(readFileSync(join(install, 'resources', 'app', 'package.json'), 'utf8')).version
  console.log('instalação atualizada:', existsSync(join(install, 'resources', 'app', 'VERSAO-NOVA.txt')), '| versão nos arquivos:', ver, '| CGL reaberto:', running() !== '0')
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  ps(`Get-CimInstance Win32_Process -Filter "Name='CGL.exe'" | Where-Object { $_.ExecutablePath -like '${install.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`)
  server.close()
  await sleep(1500)
  if (process.env.KEEP) console.log('pasta do teste mantida:', work)
  else try { rmSync(work, { recursive: true, force: true }) } catch {}
}
