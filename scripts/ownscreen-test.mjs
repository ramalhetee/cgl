// Teste da própria tela compartilhada: aviso no lugar da prévia (sem espelho infinito) e sem tela cheia nela.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3320
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const p = spawn(exe, ['--remote-debugging-port=9395', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], { env: { ...process.env, TAVERNA_PORT: String(PORT) }, stdio: 'ignore' })
const pages = async () => { for (let i = 0; i < 40; i++) { try { return (await (await fetch('http://127.0.0.1:9395/json')).json()).filter((t) => t.type === 'page') } catch { await sleep(250) } } return [] }
const waitPage = async (m) => { for (let i = 0; i < 80; i++) { const x = (await pages()).find((t) => t.url.includes(m)); if (x) return x; await sleep(250) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + expression.slice(0, 50))) }, 20000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
})
const post = (path, body) => `fetch('${path}',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+(localStorage.getItem('cgl.token')||'')},body:JSON.stringify(${JSON.stringify(body)})}).then(r=>r.json())`
const own = "[...document.querySelectorAll('.tile')].find(t=>t.textContent.includes('Sua tela'))"

// espera a tela inicial terminar de carregar (a janela aparece para o depurador antes disso)
const ready = async (p) => { for (let i = 0; i < 60; i++) { try { if (await evaluate(p, "document.readyState === 'complete' && !!window.taverna")) return p } catch {} await sleep(250) } return p }

try {
  const launcher = await ready(await waitPage('launcher.html'))
  console.log('nome na tela inicial:', await evaluate(launcher, "document.title + ' / ' + document.querySelector('h1').textContent"))
  void evaluate(launcher, "document.getElementById('host').click()").catch(() => {})
  let host = await waitPage(`localhost:${PORT}`)
  await sleep(800)
  console.log('nome na tela de login:', await evaluate(host, "document.title + ' / ' + document.querySelector('.brand').textContent"))
  await evaluate(host, post('/api/register', { username: 'tela_propria', password: 'teste-local-3' }) + ".then(j=>localStorage.setItem('cgl.token',j.token))")
  await evaluate(host, post('/api/guilds', { name: 'Mesa' }))
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(2500)
  host = await waitPage(`localhost:${PORT}`)
  await evaluate(host, "[...document.querySelectorAll('.row')].find(b=>b.textContent.includes('Sala de voz')).click()")
  await sleep(3000)

  void evaluate(host, "document.querySelectorAll('.stage-bar .voice-buttons button')[3].click()").catch(() => {})
  const picker = await waitPage('picker.html')
  await sleep(1200)
  void evaluate(picker, "document.querySelector('#screens .item').click();document.getElementById('share').click()").catch(() => {})
  await sleep(2500)

  console.log('compartilhando:', await evaluate(host, `!!${own}`))
  console.log('prévia desligada por padrão (sem vídeo):', await evaluate(host, `!${own}.querySelector('video')`), '| aviso:', await evaluate(host, `${own}.querySelector('.own-screen').innerText.replace(/\\n+/g,' / ')`))
  console.log('sem botão de tela cheia na própria tela:', await evaluate(host, `!${own}.querySelector('.tile-fs')`))
  await evaluate(host, `${own}.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
  await sleep(800)
  console.log('duplo clique não abre tela cheia:', await evaluate(host, 'document.fullscreenElement === null'))
  await evaluate(host, `${own}.querySelector('.own-screen button').click()`)
  await sleep(800)
  console.log('"Ver prévia" mostra o vídeo:', await evaluate(host, `!!${own}.querySelector('video')`), '| botão vira:', await evaluate(host, `${own}.querySelector('.own-screen button').textContent`))
  await evaluate(host, `${own}.querySelector('.own-screen button').click()`)
  await sleep(500)
  console.log('"Ocultar prévia" volta ao aviso:', await evaluate(host, `!${own}.querySelector('video')`))
  console.log('o quadro do avatar continua com tela cheia:', await evaluate(host, "!![...document.querySelectorAll('.tile')].find(t=>t.textContent.includes('(você)')).querySelector('.tile-fs')"))
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  p.kill()
}
