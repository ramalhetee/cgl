// Teste da tela cheia no app empacotado: entra numa sala de voz e alterna a tela cheia do quadro.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3314
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const p = spawn(exe, ['--remote-debugging-port=9351', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], { env: { ...process.env, TAVERNA_PORT: String(PORT) }, stdio: 'ignore' })
const pages = async () => { for (let i = 0; i < 40; i++) { try { return (await (await fetch('http://127.0.0.1:9351/json')).json()).filter((t) => t.type === 'page') } catch { await sleep(250) } } return [] }
const waitPage = async (m) => { for (let i = 0; i < 80; i++) { const x = (await pages()).find((t) => t.url.includes(m)); if (x) return x; await sleep(250) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + expression.slice(0, 50))) }, 15000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
})
const post = (path, body) => `fetch('${path}',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+(localStorage.getItem('cgl.token')||'')},body:JSON.stringify(${JSON.stringify(body)})}).then(r=>r.json())`

try {
  void evaluate(await waitPage('launcher.html'), "document.getElementById('host').click()").catch(() => {})
  let host = await waitPage(`localhost:${PORT}`)
  await sleep(800)
  await evaluate(host, post('/api/register', { username: 'tela_cheia', password: 'teste-local-7' }) + ".then(j=>localStorage.setItem('cgl.token',j.token))")
  await evaluate(host, post('/api/guilds', { name: 'Mesa' }))
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(2500)
  host = await waitPage(`localhost:${PORT}`)
  await evaluate(host, "[...document.querySelectorAll('.row')].find(b=>b.textContent.includes('Sala de voz')).click()")
  await sleep(3500)
  console.log('quadros na chamada:', await evaluate(host, "document.querySelectorAll('.tile').length"), '| botão de tela cheia:', await evaluate(host, "!!document.querySelector('.tile-fs')"))
  await evaluate(host, "document.querySelector('.tile-fs').click()")
  await sleep(1200)
  console.log('botão -> tela cheia:', await evaluate(host, "document.fullscreenElement?.classList.contains('tile') === true && innerWidth === screen.width"))
  console.log('rótulo do botão:', await evaluate(host, "document.querySelector('.tile-fs').getAttribute('aria-label')"))
  await evaluate(host, "document.querySelector('.tile-fs').click()")
  await sleep(1200)
  console.log('botão de novo -> saiu:', await evaluate(host, 'document.fullscreenElement === null'))
  await evaluate(host, "document.querySelector('.tile').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
  await sleep(1200)
  console.log('duplo clique -> tela cheia:', await evaluate(host, "document.fullscreenElement?.classList.contains('tile') === true"))
  await evaluate(host, 'document.exitFullscreen()')
  await sleep(800)
  console.log('continua na chamada depois:', await evaluate(host, "document.querySelectorAll('.tile').length > 0 && !!document.querySelector('.dock')"))
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  p.kill()
}
