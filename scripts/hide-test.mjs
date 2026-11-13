// Teste de ocultar a tela de outra pessoa: o vídeo some e quem transmite para de mandar (bytes param de chegar).
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3329
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const procs = []
const launch = (dbg) =>
  procs.push(spawn(exe, [`--remote-debugging-port=${dbg}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], { env: { ...process.env, TAVERNA_PORT: String(PORT) }, stdio: 'ignore' }))
const pages = async (dbg) => { for (let i = 0; i < 40; i++) { try { return (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).filter((t) => t.type === 'page') } catch { await sleep(250) } } return [] }
const waitPage = async (dbg, m) => { for (let i = 0; i < 160; i++) { const x = (await pages(dbg)).find((t) => t.url.includes(m)); if (x) return x; await sleep(250) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + expression.slice(0, 60))) }, 20000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
})
const call = (path, body) => `fetch('${path}',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+localStorage.getItem('cgl.token')},body:JSON.stringify(${JSON.stringify(body)})}).then(r=>r.json())`
const login = (user) => `fetch('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'${user}',password:'teste-local-2'})}).then(r=>r.json()).then(j=>{localStorage.setItem('cgl.token',j.token);return j.user.id})`
const reload = async (dbg, page, url) => { void evaluate(page, 'location.reload()').catch(() => {}); await sleep(2500); return waitPage(dbg, url) }
const joinRoom = "[...document.querySelectorAll('.row')].find(b=>b.textContent.includes('Sala de voz')).click()"
// do lado de quem transmite: faixas da tela sendo enviadas para o anfitrião (ativas / pausadas)
const sending = `JSON.stringify((()=>{const v=globalThis.__cglVoice;const out={ativas:0,pausadas:0};for(const l of v.links.values()){if(l.info.user.username!=='anfitriao')continue;for(const s of l.screenSenders){s.sender.track?out.ativas++:out.pausadas++}}return out})())`
const screenTile = "[...document.querySelectorAll('.tile')].find(t=>t.textContent.includes('Tela de'))"

// espera a tela inicial terminar de carregar (a janela aparece para o depurador antes disso)
const ready = async (p) => { for (let i = 0; i < 60; i++) { try { if (await evaluate(p, "document.readyState === 'complete' && !!window.taverna")) return p } catch {} await sleep(250) } return p }

try {
  launch(9471)
  const l1 = await ready(await waitPage(9471, 'launcher.html'))
  void evaluate(l1, 'window.taverna.host()').catch(() => {}) // a tela inicial fecha ao abrir a sala
  let host = await waitPage(9471, `localhost:${PORT}`)
  await sleep(800)
  await evaluate(host, login('anfitriao'))
  const g = await evaluate(host, call('/api/guilds', { name: 'Mesa' }))
  host = await reload(9471, host, `localhost:${PORT}`)

  launch(9472)
  void evaluate(await ready(await waitPage(9472, 'launcher.html')), `document.getElementById('address').value='127.0.0.1:${PORT}';document.getElementById('go').click()`).catch(() => {})
  let guest = await waitPage(9472, '127.0.0.1:32100')
  await sleep(800)
  await evaluate(guest, login('convidado'))
  await evaluate(guest, call(`/api/invites/${g.inviteCode}/join`, {}))
  guest = await reload(9472, guest, '127.0.0.1:32100')

  await evaluate(host, joinRoom)
  await sleep(1500)
  await evaluate(guest, joinRoom)
  await sleep(4000)
  void evaluate(guest, "document.querySelectorAll('.stage-bar .voice-buttons button')[3].click()").catch(() => {})
  await sleep(6000)

  console.log('anfitrião vê a tela do convidado:', await evaluate(host, `JSON.stringify({video:!!${screenTile}?.querySelector('video'),botaoOcultar:!!${screenTile}?.querySelector('.tile-hide')})`))
  console.log('convidado enviando a tela para o anfitrião:', await evaluate(guest, sending))

  await evaluate(host, `${screenTile}.querySelector('.tile-hide').click()`)
  await sleep(2500)
  console.log('depois de Ocultar:', await evaluate(host, `JSON.stringify({video:!!${screenTile}?.querySelector('video'),aviso:${screenTile}?.querySelector('.own-screen')?.innerText.replace(/\\n+/g,' / ')})`))
  console.log('convidado enviando a tela para o anfitrião:', await evaluate(guest, sending))

  await evaluate(host, `${screenTile}.querySelector('.own-screen button').click()`)
  await sleep(3000)
  console.log('depois de Assistir:', await evaluate(host, `JSON.stringify({video:!!${screenTile}?.querySelector('video')})`))
  console.log('convidado enviando a tela para o anfitrião:', await evaluate(guest, sending))

  // ocultar, o convidado para e volta a transmitir: a tela volta a aparecer sozinha
  await evaluate(host, `${screenTile}.querySelector('.tile-hide').click()`)
  await sleep(1500)
  await evaluate(guest, "document.querySelectorAll('.stage-bar .voice-buttons button')[3].click()")
  await sleep(2500)
  console.log('convidado parou de transmitir -> quadro some:', await evaluate(host, `!${screenTile}`))
  void evaluate(guest, "document.querySelectorAll('.stage-bar .voice-buttons button')[3].click()").catch(() => {})
  await sleep(6000)
  console.log('transmitiu de novo -> aparece com vídeo:', await evaluate(host, `JSON.stringify({video:!!${screenTile}?.querySelector('video')})`), '| envio:', await evaluate(guest, sending))
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  for (const p of procs) p.kill()
}
