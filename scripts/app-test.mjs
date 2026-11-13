// Teste do app empacotado: uma instância hospeda, outra entra pela ponte. Dirige as janelas pelo protocolo de depuração.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'Taverna-win32-x64', 'Taverna.exe')
const PORT = 3311
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const procs = []

function launch(debugPort) {
  const p = spawn(exe, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], {
    env: { ...process.env, TAVERNA_PORT: String(PORT) }, stdio: 'ignore',
  })
  procs.push(p)
}
async function pages(debugPort) {
  for (let i = 0; i < 40; i++) {
    try {
      return (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).filter((t) => t.type === 'page')
    } catch {
      await sleep(250)
    }
  }
  throw new Error('depuração não respondeu')
}
async function waitPage(debugPort, match) {
  for (let i = 0; i < 60; i++) {
    const p = (await pages(debugPort)).find((t) => t.url.includes(match))
    if (p) return p
    await sleep(250)
  }
  throw new Error(`janela ${match} não apareceu`)
}
function evaluate(page, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id !== 1) return
      ws.close()
      m.result.exceptionDetails ? reject(new Error(JSON.stringify(m.result.exceptionDetails.exception?.description))) : resolve(m.result.result.value)
    }
    ws.onerror = () => reject(new Error('ws'))
  })
}

try {
  // 1. anfitrião
  launch(9333)
  const l1 = await waitPage(9333, 'launcher.html')
  console.log('tela inicial:', await evaluate(l1, "document.querySelector('h1').textContent + ' | ' + document.getElementById('addresses').textContent"))
  void evaluate(l1, "document.getElementById('host').click()").catch(() => {})
  const host = await waitPage(9333, `localhost:${PORT}`)
  await sleep(800)
  console.log('anfitrião:', host.url, JSON.stringify(await evaluate(host, 'window.taverna.info()')))
  console.log('anfitrião cria conta:', await evaluate(host, `fetch('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'host_'+Date.now()%100000,password:'teste-local-1'})}).then(r=>r.status)`))

  // 2. convidado, pela ponte
  launch(9334)
  const l2 = await waitPage(9334, 'launcher.html')
  void evaluate(l2, `document.getElementById('address').value='127.0.0.1:${PORT}';document.getElementById('go').click()`).catch(() => {})
  const guest = await waitPage(9334, '127.0.0.1:32100')
  await sleep(800)
  console.log('convidado:', guest.url, JSON.stringify(await evaluate(guest, 'window.taverna.info()')))
  console.log('convidado vê a interface:', await evaluate(guest, "document.title + ' / ' + !!document.querySelector('.auth-card')"))
  console.log('contexto seguro (mic/tela liberados):', await evaluate(guest, 'isSecureContext && !!navigator.mediaDevices?.getDisplayMedia'))
  console.log('API pela ponte:', await evaluate(guest, `fetch('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'guest_'+Date.now()%100000,password:'teste-local-2'})}).then(r=>r.json()).then(j=>{localStorage.setItem('t',j.token);return !!j.token})`))
  console.log('tempo real pela ponte:', await evaluate(guest, `new Promise((res)=>{const w=new WebSocket('ws://127.0.0.1:32100/socket.io/?EIO=4&transport=websocket');w.onmessage=(e)=>{if(e.data.startsWith('0')){w.send('40'+JSON.stringify({token:localStorage.getItem('t')}))}else if(e.data.startsWith('40')){res('conectado');w.close()}else if(e.data.startsWith('44')){res('recusado '+e.data)}};w.onerror=()=>res('falhou');setTimeout(()=>res('sem resposta'),5000)})`))
  console.log('endereço errado:', await (async () => {
    launch(9335)
    const l3 = await waitPage(9335, 'launcher.html')
    await evaluate(l3, "window.taverna.connect('127.0.0.1:3999').then(r=>window.__r=r)")
    return JSON.stringify(await evaluate(l3, 'window.__r'))
  })())
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  for (const p of procs) p.kill()
}
