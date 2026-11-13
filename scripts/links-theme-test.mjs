// Teste de links clicáveis, prévias e temas no app empacotado.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3327
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const p = spawn(exe, ['--remote-debugging-port=9451', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], { env: { ...process.env, TAVERNA_PORT: String(PORT) }, stdio: 'ignore' })
const pages = async () => { for (let i = 0; i < 40; i++) { try { return (await (await fetch('http://127.0.0.1:9451/json')).json()).filter((t) => t.type === 'page') } catch { await sleep(250) } } return [] }
const waitPage = async (m) => { for (let i = 0; i < 80; i++) { const x = (await pages()).find((t) => t.url.includes(m)); if (x) return x; await sleep(250) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + expression.slice(0, 60))) }, 30000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
})
const call = (path, body) => `fetch('${path}',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+localStorage.getItem('cgl.token')},body:JSON.stringify(${JSON.stringify(body)})}).then(r=>r.json())`
const type = (sel, value) => `(()=>{const el=document.querySelector(${JSON.stringify(sel)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`
const cssVar = (n) => `getComputedStyle(document.documentElement).getPropertyValue('--${n}').trim()`

// espera a tela inicial terminar de carregar (a janela aparece para o depurador antes disso)
const ready = async (p) => { for (let i = 0; i < 60; i++) { try { if (await evaluate(p, "document.readyState === 'complete' && !!window.taverna")) return p } catch {} await sleep(250) } return p }

try {
  const launcher = await ready(await waitPage('launcher.html'))
  console.log('versão na tela inicial:', await evaluate(launcher, "new Promise(r=>setTimeout(()=>r(document.getElementById('version').textContent),800))"))
  void evaluate(launcher, "document.getElementById('host').click()").catch(() => {})
  let host = await waitPage(`localhost:${PORT}`)
  await sleep(800)
  await evaluate(host, "fetch('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'links',password:'teste-local-2'})}).then(r=>r.json()).then(j=>localStorage.setItem('cgl.token',j.token))")
  await evaluate(host, call('/api/guilds', { name: 'Mesa' }))
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(2500)
  host = await waitPage(`localhost:${PORT}`)

  await evaluate(host, type('.composer textarea', 'olha isso: https://github.com/ramalhetee/cgl/releases e https://www.youtube.com/watch?v=W4aQLPUcTYI.'))
  await evaluate(host, "document.querySelector('.composer .primary').click()")
  await sleep(7000)
  console.log('links clicáveis:', await evaluate(host, "JSON.stringify([...document.querySelectorAll('.msg-link')].map(a=>({href:a.href,alvo:a.target})))"))
  console.log('prévias:', await evaluate(host, "JSON.stringify([...document.querySelectorAll('.embed')].map(e=>({site:e.querySelector('.embed-site')?.textContent,titulo:e.querySelector('.embed-title')?.textContent?.slice(0,40),imagem:!!e.querySelector('img'),tocar:!!e.querySelector('.embed-play')})))"))
  const before = (await pages()).length
  await evaluate(host, "document.querySelector('.embed-play').click()")
  await sleep(2500)
  console.log('YouTube toca no chat:', await evaluate(host, "document.querySelector('.embed-video')?.src.split('?')[0]"), '| janelas novas:', (await pages()).length - before)
  console.log('abrir link não cria janela dentro do app:', await evaluate(host, "window.open('https://example.com')===null"))
  await sleep(500)
  console.log('janelas no fim:', (await pages()).length - before)

  // tema
  console.log('tema inicial:', await evaluate(host, cssVar('bg')), await evaluate(host, cssVar('accent')))
  await evaluate(host, "document.querySelector('.icon-btn[aria-label=Ajustes]').click()")
  await sleep(800)
  console.log('temas na tela:', await evaluate(host, "[...document.querySelectorAll('.theme')].map(t=>t.textContent).join(', ')"))
  await evaluate(host, "[...document.querySelectorAll('.theme')].find(t=>t.textContent==='Claro').click()")
  await sleep(400)
  console.log('Claro aplicado na hora:', await evaluate(host, `JSON.stringify({bg:${cssVar('bg')},texto:${cssVar('text')},tema:document.documentElement.dataset.theme})`))
  await evaluate(host, "(()=>{const el=document.querySelector('.theme-picker input[type=color]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'#1f6feb');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
  await sleep(1000)
  console.log('cor de destaque própria:', await evaluate(host, `JSON.stringify({destaque:${cssVar('accent')},textoNoBotao:${cssVar('accent-ink')}})`))
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(2500)
  host = await waitPage(`localhost:${PORT}`)
  console.log('depois de recarregar:', await evaluate(host, `JSON.stringify({bg:${cssVar('bg')},destaque:${cssVar('accent')}})`))
  console.log('salvo na conta:', await evaluate(host, "fetch('/api/me',{headers:{authorization:'Bearer '+localStorage.getItem('cgl.token')}}).then(r=>r.json()).then(j=>JSON.stringify(j.settings.theme))"))
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  p.kill()
}
