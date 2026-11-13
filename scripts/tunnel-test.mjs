// Teste do túnel no app empacotado: o anfitrião abre o link público e um convidado entra por ele.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3313
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const procs = []
const launch = (dbg) => procs.push(spawn(exe, [`--remote-debugging-port=${dbg}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], { env: { ...process.env, TAVERNA_PORT: String(PORT) }, stdio: 'ignore' }))
const pages = async (dbg) => { for (let i = 0; i < 40; i++) { try { return (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).filter((t) => t.type === 'page') } catch { await sleep(250) } } return [] }
const waitPage = async (dbg, m, tries = 80) => { for (let i = 0; i < tries; i++) { const x = (await pages(dbg)).find((t) => t.url.includes(m)); if (x) return x; await sleep(250) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
})
const register = (name) => `fetch('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'${name}_'+Date.now()%100000,password:'teste-local-9'})}).then(r=>r.json()).then(j=>{localStorage.setItem('t',j.token);return !!j.token})`

try {
  launch(9341)
  void evaluate(await waitPage(9341, 'launcher.html'), "document.getElementById('host').click()").catch(() => {})
  const host = await waitPage(9341, `localhost:${PORT}`)
  await sleep(800)
  const t0 = Date.now()
  const started = await evaluate(host, 'window.taverna.tunnelStart()')
  console.log('túnel:', started.url ? `aberto em ${((Date.now() - t0) / 1000).toFixed(1)} s` : `ERRO ${started.error}`)
  if (!started.url) throw new Error('túnel não abriu')
  console.log('info do anfitrião tem o link:', (await evaluate(host, 'window.taverna.info()')).tunnel === started.url)

  // o DNS do link novo leva alguns segundos pra propagar
  let ok = false, why = ''
  for (let i = 0; i < 30 && !ok; i++) {
    try { const r = await fetch(started.url + '/api/me', { signal: AbortSignal.timeout(5000) }); ok = r.status === 401; if (!ok) why = 'status ' + r.status } catch (e) { why = e.cause?.code ?? e.name }
    if (!ok) await sleep(2000)
  }
  console.log('link responde de fora:', ok, ok ? '' : why)

  launch(9342)
  const l2 = await waitPage(9342, 'launcher.html')
  void evaluate(l2, `window.taverna.connect(${JSON.stringify(started.url)}).then(r=>window.__r=r)`).catch(() => {})
  const guest = await waitPage(9342, '127.0.0.1:32100')
  await sleep(1500)
  console.log('convidado entrou pelo link:', JSON.stringify(await evaluate(guest, 'window.taverna.info()')))
  console.log('interface carregou:', await evaluate(guest, "document.title + ' / ' + !!document.querySelector('.auth-card')"))
  console.log('API pelo túnel:', await evaluate(guest, register('guest')))
  console.log('tempo real pelo túnel:', await evaluate(guest, `new Promise((res)=>{const w=new WebSocket('ws://127.0.0.1:32100/socket.io/?EIO=4&transport=websocket');w.onmessage=(e)=>{if(e.data.startsWith('0')){w.send('40'+JSON.stringify({token:localStorage.getItem('t')}))}else if(e.data.startsWith('40')){res('conectado');w.close()}else if(e.data.startsWith('44')){res('recusado')}};w.onerror=()=>res('falhou');setTimeout(()=>res('sem resposta'),10000)})`))
  console.log('convidado não pode abrir túnel:', JSON.stringify(await evaluate(guest, 'window.taverna.tunnelStart()')))

  await evaluate(host, 'window.taverna.tunnelStop()')
  await sleep(1500)
  console.log('depois de fechar, info:', (await evaluate(host, 'window.taverna.info()')).tunnel)
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  for (const p of procs) p.kill()
}
