// Teste de teclas de atalho no app empacotado: grava "=" (e outras teclas de pontuação) pela tela
// e aperta "=" de verdade pelo teclado do Windows.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3326
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const p = spawn(exe, ['--remote-debugging-port=9441', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], { env: { ...process.env, TAVERNA_PORT: String(PORT) }, stdio: 'ignore' })
const pages = async () => { for (let i = 0; i < 40; i++) { try { return (await (await fetch('http://127.0.0.1:9441/json')).json()).filter((t) => t.type === 'page') } catch { await sleep(250) } } return [] }
const waitPage = async (m) => { for (let i = 0; i < 80; i++) { const x = (await pages()).find((t) => t.url.includes(m)); if (x) return x; await sleep(250) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + expression.slice(0, 60))) }, 20000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
})
const call = (path, body, method = 'POST') => `fetch('${path}',{method:'${method}',headers:{'content-type':'application/json',authorization:'Bearer '+localStorage.getItem('cgl.token')},body:${body === undefined ? 'undefined' : `JSON.stringify(${JSON.stringify(body)})`}}).then(r=>r.json())`
const muted = "document.querySelectorAll('.stage-bar .voice-buttons button')[0].classList.contains('warn')"
// grava um atalho pela tela: clica no campo e "aperta" a tecla
const record = (i, code, key, mods = {}) => `(async()=>{document.querySelectorAll('.hotkey-key')[${i}].click();await new Promise(r=>setTimeout(r,150));dispatchEvent(new KeyboardEvent('keydown',{code:'${code}',key:${JSON.stringify(key)},bubbles:true,...${JSON.stringify(mods)}}));await new Promise(r=>setTimeout(r,900));const f=document.querySelectorAll('.hotkey')[${i}];return f.querySelector('.hotkey-key').textContent+(f.querySelector('.error')?' | ERRO: '+f.querySelector('.error').textContent:'')})()`
const press = (keys) => execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`])

// espera a tela inicial terminar de carregar (a janela aparece para o depurador antes disso)
const ready = async (p) => { for (let i = 0; i < 60; i++) { try { if (await evaluate(p, "document.readyState === 'complete' && !!window.taverna")) return p } catch {} await sleep(250) } return p }

try {
  void evaluate(await ready(await waitPage('launcher.html')), "document.getElementById('host').click()").catch(() => {})
  let host = await waitPage(`localhost:${PORT}`)
  await sleep(800)
  await evaluate(host, "fetch('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'teclas',password:'teste-local-2'})}).then(r=>r.json()).then(j=>localStorage.setItem('cgl.token',j.token))")
  await evaluate(host, call('/api/guilds', { name: 'Mesa' }))
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(2500)
  host = await waitPage(`localhost:${PORT}`)
  await evaluate(host, "[...document.querySelectorAll('.row')].find(b=>b.textContent.includes('Sala de voz')).click()")
  await sleep(2500)
  await evaluate(host, "document.querySelector('.icon-btn').click()")
  await sleep(800)

  console.log('gravar Ç:', await evaluate(host, record(1, 'Semicolon', 'ç')))
  console.log('gravar Ctrl + \\\\:', await evaluate(host, record(1, 'Backslash', '\\', { ctrlKey: true })))
  console.log('gravar Shift + -:', await evaluate(host, record(1, 'Minus', '_', { shiftKey: true })))
  console.log('gravar Num 5:', await evaluate(host, record(1, 'Numpad5', '5')))
  console.log('gravar Espaço com Alt:', await evaluate(host, record(1, 'Space', ' ', { altKey: true })))
  console.log('tecla sem suporte (/ do ABNT2):', await evaluate(host, `(async()=>{document.querySelectorAll('.hotkey-key')[1].click();await new Promise(r=>setTimeout(r,150));dispatchEvent(new KeyboardEvent('keydown',{code:'IntlRo',key:'/',bubbles:true}));await new Promise(r=>setTimeout(r,300));const t=document.querySelectorAll('.hotkey')[1].innerText.replace(/\\n+/g,' | ');dispatchEvent(new KeyboardEvent('keydown',{code:'Escape',key:'Escape',bubbles:true}));return t})()`))
  console.log('só Ctrl apertado espera a tecla:', await evaluate(host, `(async()=>{document.querySelectorAll('.hotkey-key')[1].click();await new Promise(r=>setTimeout(r,150));dispatchEvent(new KeyboardEvent('keydown',{code:'ControlLeft',key:'Control',ctrlKey:true,bubbles:true}));await new Promise(r=>setTimeout(r,300));const t=document.querySelectorAll('.hotkey-key')[1].textContent;dispatchEvent(new KeyboardEvent('keydown',{code:'Escape',key:'Escape',bubbles:true}));return t})()`))
  console.log('gravar = (mutar):', await evaluate(host, record(0, 'Equal', '=')))
  await sleep(1000)
  console.log('aviso de tecla sozinha:', await evaluate(host, "document.querySelector('.hotkey .hotkey-warn')?.textContent ?? 'sem aviso'"))
  await evaluate(host, "[...document.querySelectorAll('.audio-settings button')].pop().click()")
  await sleep(500)

  const before = await evaluate(host, muted)
  press('=')
  await sleep(800)
  const after1 = await evaluate(host, muted)
  press('=')
  await sleep(800)
  const after2 = await evaluate(host, muted)
  console.log('apertar = de verdade:', JSON.stringify({ antes: before, depoisDe1: after1, depoisDe2: after2 }))
  const saved = await evaluate(host, call('/api/me', undefined, 'GET'))
  console.log('salvo na conta:', JSON.stringify(saved.settings.hotkeys))
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  p.kill()
}
