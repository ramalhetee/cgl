// Medição do app empacotado: tempo de abertura e memória (todos os processos do app somados).
// Serve de base para comparar otimizações e outros cascos (ex.: Tauri) com o mesmo roteiro.
//   node scripts/bench.mjs                 (5 aberturas; BENCH_RUNS=n para mudar)
//   TAVERNA_EXE=caminho\CGL.exe node scripts/bench.mjs
// Usa microfone/câmera falsos do Chromium e aceita a tela automaticamente (sem o seletor do app).
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const RUNS = Number(process.env.BENCH_RUNS || 5)
const PORT = 3323
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const mb = (b) => Math.round(b / 1024 / 1024)

// ---------- controle das janelas pelo protocolo de depuração ----------
const pages = async (dbg) => { try { return (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).filter((t) => t.type === 'page') } catch { return [] } }
const waitPage = async (dbg, m, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { const x = (await pages(dbg)).find((t) => t.url.includes(m)); if (x) return x; await sleep(30) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + expression.slice(0, 60))) }, 20000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
  ws.onerror = () => { clearTimeout(timer); reject(new Error('depurador indisponível')) }
})
/** Espera até a expressão ser verdadeira na página (que pode trocar enquanto carrega). */
const until = async (dbg, m, expression, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const p = await waitPage(dbg, m, end - Date.now())
      if (await evaluate(p, expression)) return p
    } catch {
      // página ainda trocando
    }
    await sleep(30)
  }
  throw new Error(`não ficou pronto: ${m} / ${expression}`)
}
const call = (path, body, method = 'POST') => `fetch('${path}',{method:'${method}',headers:{'content-type':'application/json',authorization:'Bearer '+localStorage.getItem('cgl.token')},body:${body === undefined ? 'undefined' : `JSON.stringify(${JSON.stringify(body)})`}}).then(r=>r.json())`
const register = (user) => `fetch('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'${user}',password:'bench-local-1'})}).then(r=>r.json()).then(j=>{localStorage.setItem('cgl.token',j.token);return j.user.id})`
const joinRoom = "[...document.querySelectorAll('.row')].find(b=>b.textContent.includes('Sala de voz')).click()"
const LAUNCHER_READY = "document.readyState === 'complete' && !!window.taverna && !!document.getElementById('host')"
const PAGE_READY = "location.protocol.startsWith('http') && document.readyState === 'complete'"
const APP_READY = "location.protocol.startsWith('http') && !!document.querySelector('.app')"

// ---------- processos e memória ----------
const procs = []
function launch(dbg, userDir) {
  const p = spawn(exe, [`--remote-debugging-port=${dbg}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--user-data-dir=${userDir}`], {
    env: { ...process.env, TAVERNA_PORT: String(PORT) },
    stdio: 'ignore',
  })
  procs.push(p)
  return p
}
/** Fecha como o usuário fecharia (grava login e dados); só força se não sair em 8 s. */
async function kill(p) {
  const exited = () => (p.exitCode !== null ? Promise.resolve() : new Promise((r) => p.once('exit', r)))
  try {
    execFileSync('taskkill', ['/pid', String(p.pid), '/T'], { stdio: 'ignore' })
  } catch {
    // já tinha saído
  }
  await Promise.race([exited(), sleep(8000)])
  if (p.exitCode === null) {
    try {
      execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // saiu nesse meio-tempo
    }
    await exited()
  }
  await sleep(1500) // porta e arquivos liberados
}
/** Soma dos processos do app (principal + filhos): conjunto de trabalho e memória privada. */
function treeMemory(pid) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const all = JSON.parse(out)
  const ids = new Set([pid])
  let grew = true
  while (grew) {
    grew = false
    for (const x of all) if (!ids.has(x.ProcessId) && ids.has(x.ParentProcessId)) { ids.add(x.ProcessId); grew = true }
  }
  const mine = all.filter((x) => ids.has(x.ProcessId))
  return {
    processos: mine.length,
    workingSet: mine.reduce((s, x) => s + Number(x.WorkingSetSize), 0),
    privada: mine.reduce((s, x) => s + Number(x.PrivatePageCount), 0),
  }
}
async function memory(pid, samples = 3) {
  const xs = []
  for (let i = 0; i < samples; i++) {
    xs.push(treeMemory(pid))
    await sleep(1500)
  }
  return { processos: median(xs.map((x) => x.processos)), workingSetMB: mb(median(xs.map((x) => x.workingSet))), privadaMB: mb(median(xs.map((x) => x.privada))) }
}
function dirSize(dir) {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) total += e.isDirectory() ? dirSize(join(dir, e.name)) : statSync(join(dir, e.name)).size
  return total
}

// ---------- roteiro ----------
const result = { exe, runs: RUNS, abertura: [], memoria: {}, tamanhoPastaMB: mb(dirSize(dirname(exe))) }
try {
  const hostDir = mkdtempSync(join(tmpdir(), 'cgl-bench-host-'))

  // preparação: conta + servidor, para que as próximas aberturas já entrem logadas
  let p = launch(9501, hostDir)
  void evaluate(await until(9501, 'launcher.html', LAUNCHER_READY), "document.getElementById('host').click()").catch(() => {})
  let host = await until(9501, `localhost:${PORT}`, PAGE_READY)
  await evaluate(host, register('bench'))
  const guild = await evaluate(host, call('/api/guilds', { name: 'Bench' }))
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(1500)
  await until(9501, `localhost:${PORT}`, APP_READY)
  await sleep(2000)
  await kill(p)

  // aberturas: até a tela inicial e até a sala pronta (logado), cada uma do zero
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now()
    p = launch(9501, hostDir)
    const launcher = await until(9501, 'launcher.html', LAUNCHER_READY)
    const tLauncher = performance.now() - t0
    const t1 = performance.now()
    void evaluate(launcher, "document.getElementById('host').click()").catch(() => {})
    await until(9501, `localhost:${PORT}`, APP_READY)
    const tApp = performance.now() - t1
    result.abertura.push({ telaInicialMs: Math.round(tLauncher), salaProntaMs: Math.round(tApp) })
    console.log(`abertura ${i + 1}/${RUNS}:`, result.abertura.at(-1))
    if (i < RUNS - 1) await kill(p)
  }

  // memória: o app continua aberto na sala, só com texto
  await sleep(5000)
  result.memoria.salaTexto = await memory(p.pid)
  console.log('memória, sala de texto:', result.memoria.salaTexto)

  // tela inicial parada (outra cópia, só a tela inicial)
  const idleDir = mkdtempSync(join(tmpdir(), 'cgl-bench-idle-'))
  const idle = launch(9503, idleDir)
  await until(9503, 'launcher.html', LAUNCHER_READY)
  await sleep(5000)
  result.memoria.telaInicial = await memory(idle.pid)
  console.log('memória, tela inicial:', result.memoria.telaInicial)
  await kill(idle)

  // chamada de voz com um convidado (pela ponte)
  const guestDir = mkdtempSync(join(tmpdir(), 'cgl-bench-guest-'))
  const g = launch(9502, guestDir)
  void evaluate(await until(9502, 'launcher.html', LAUNCHER_READY), `document.getElementById('address').value='127.0.0.1:${PORT}';document.getElementById('go').click()`).catch(() => {})
  let guest = await until(9502, '127.0.0.1:32100', PAGE_READY)
  await evaluate(guest, register('bench_convidado'))
  await evaluate(guest, call(`/api/invites/${guild.inviteCode}/join`, {}))
  void evaluate(guest, 'location.reload()').catch(() => {})
  await sleep(1500)
  guest = await until(9502, '127.0.0.1:32100', APP_READY)
  host = await until(9501, `localhost:${PORT}`, APP_READY)
  await evaluate(host, joinRoom)
  await sleep(1500)
  await evaluate(guest, joinRoom)
  await sleep(8000)
  result.memoria.chamadaAnfitriao = await memory(p.pid)
  result.memoria.chamadaConvidado = await memory(g.pid)
  console.log('memória, em chamada:', result.memoria.chamadaAnfitriao, result.memoria.chamadaConvidado)

  // anfitrião transmitindo a tela para o convidado
  void evaluate(host, "document.querySelectorAll('.stage-bar .voice-buttons button')[3].click()").catch(() => {})
  await sleep(8000)
  const sharing = await evaluate(host, "!!document.querySelector('.own-screen')")
  result.memoria.transmitindoTela = { ...(await memory(p.pid)), transmitindo: sharing }
  result.memoria.assistindoTela = await memory(g.pid)
  console.log('memória, transmitindo tela:', result.memoria.transmitindoTela, result.memoria.assistindoTela)

  const s = (k) => median(result.abertura.map((x) => x[k]))
  result.mediana = { telaInicialMs: s('telaInicialMs'), salaProntaMs: s('salaProntaMs') }
  console.log('\nRESULTADO\n' + JSON.stringify(result, null, 2))
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  for (const p of procs) {
    try {
      execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // já saiu
    }
  }
}
