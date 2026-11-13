// Teste do anel de "falando" na lista de voz, com o microfone falso do Chromium (bipes periódicos).
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3315
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const p = spawn(exe, ['--remote-debugging-port=9361', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], { env: { ...process.env, TAVERNA_PORT: String(PORT) }, stdio: 'ignore' })
const pages = async () => { for (let i = 0; i < 40; i++) { try { return (await (await fetch('http://127.0.0.1:9361/json')).json()).filter((t) => t.type === 'page') } catch { await sleep(250) } } return [] }
const waitPage = async (m) => { for (let i = 0; i < 80; i++) { const x = (await pages()).find((t) => t.url.includes(m)); if (x) return x; await sleep(250) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + expression.slice(0, 50))) }, 20000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
})
const post = (path, body) => `fetch('${path}',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+(localStorage.getItem('cgl.token')||'')},body:JSON.stringify(${JSON.stringify(body)})}).then(r=>r.json())`
// observa por alguns segundos se o anel aparece e se some
const watch = (ms) => `new Promise((res)=>{let on=0,off=0;const t=setInterval(()=>{document.querySelector('.occupant .avatar.talking')?on++:off++},60);setTimeout(()=>{clearInterval(t);res({on,off})},${ms})})`

try {
  void evaluate(await waitPage('launcher.html'), "document.getElementById('host').click()").catch(() => {})
  let host = await waitPage(`localhost:${PORT}`)
  await sleep(800)
  await evaluate(host, post('/api/register', { username: 'falante', password: 'teste-local-8' }) + ".then(j=>localStorage.setItem('cgl.token',j.token))")
  await evaluate(host, post('/api/guilds', { name: 'Mesa' }))
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(2500)
  host = await waitPage(`localhost:${PORT}`)
  await evaluate(host, "[...document.querySelectorAll('.row')].find(b=>b.textContent.includes('Sala de voz')).click()")
  await sleep(3000)
  console.log('microfone (falso) ativo:', await evaluate(host, "!document.querySelector('.voice-buttons button').disabled"))
  const a = await evaluate(host, watch(5000))
  console.log('falando (bipes):', JSON.stringify(a), '-> anel acende e apaga:', a.on > 0 && a.off > 0)
  await evaluate(host, "document.querySelector('.voice-buttons button').click()")
  await sleep(600)
  const b = await evaluate(host, watch(3000))
  console.log('mutado:', JSON.stringify(b), '-> anel fica apagado:', b.on === 0)
  // a aba de texto continua mostrando o anel (o usuário não precisa estar olhando a chamada)
  await evaluate(host, "document.querySelector('.voice-buttons button').click()")
  await evaluate(host, "[...document.querySelectorAll('.row')].find(b=>b.textContent.includes('geral')).click()")
  await sleep(600)
  const c = await evaluate(host, watch(4000))
  console.log('vendo o canal de texto:', JSON.stringify(c), '-> anel continua funcionando:', c.on > 0)
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  p.kill()
}
