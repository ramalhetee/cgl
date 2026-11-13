// Teste de atalhos globais e sons no app empacotado, com duas cópias (anfitrião e convidado).
// Aperta o atalho de verdade pelo teclado do Windows (combinação incomum, para não afetar outros programas).
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3325
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const procs = []
const launch = (dbg) =>
  procs.push(spawn(exe, [`--remote-debugging-port=${dbg}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], { env: { ...process.env, TAVERNA_PORT: String(PORT) }, stdio: 'ignore' }))
const pages = async (dbg) => { for (let i = 0; i < 40; i++) { try { return (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).filter((t) => t.type === 'page') } catch { await sleep(250) } } return [] }
const waitPage = async (dbg, m) => { for (let i = 0; i < 80; i++) { const x = (await pages(dbg)).find((t) => t.url.includes(m)); if (x) return x; await sleep(250) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + expression.slice(0, 60))) }, 20000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
})
const call = (path, body, method = 'POST') => `fetch('${path}',{method:'${method}',headers:{'content-type':'application/json',authorization:'Bearer '+localStorage.getItem('cgl.token')},body:${body === undefined ? 'undefined' : `JSON.stringify(${JSON.stringify(body)})`}}).then(r=>r.json())`
const login = (user) => `fetch('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'${user}',password:'teste-local-2'})}).then(r=>r.json()).then(j=>{localStorage.setItem('cgl.token',j.token);return j.user.id})`
const reload = async (dbg, page, url) => { void evaluate(page, 'location.reload()').catch(() => {}); await sleep(2500); return waitPage(dbg, url) }
const joinRoom = "[...document.querySelectorAll('.row')].find(b=>b.textContent.includes('Sala de voz')).click()"
const cues = 'JSON.stringify((globalThis.__cglCues||[]).splice(0))'
const state = "JSON.stringify((()=>{const b=document.querySelectorAll('.stage-bar .voice-buttons button');return {micMudo:b[0].classList.contains('warn'),semOuvir:b[1].classList.contains('warn')}})())"
// Ctrl+Alt+Shift+F9 e F10 pelo Windows (SendKeys: ^ Ctrl, % Alt, + Shift)
const press = (keys) => execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`])

try {
  launch(9431)
  void evaluate(await waitPage(9431, 'launcher.html'), "document.getElementById('host').click()").catch(() => {})
  let host = await waitPage(9431, `localhost:${PORT}`)
  await sleep(800)
  await evaluate(host, login('anfitriao'))
  const g = await evaluate(host, call('/api/guilds', { name: 'Mesa' }))
  // atalhos de teste, salvos na conta
  await evaluate(host, call('/api/me/settings', { hotkeys: { mute: 'Ctrl+Alt+Shift+F9', deafen: 'Ctrl+Alt+Shift+F10' } }, 'PUT'))
  host = await reload(9431, host, `localhost:${PORT}`)
  await sleep(800)

  await evaluate(host, joinRoom)
  await sleep(2500)
  console.log('entrar na chamada:', await evaluate(host, cues))

  launch(9432)
  void evaluate(await waitPage(9432, 'launcher.html'), `document.getElementById('address').value='127.0.0.1:${PORT}';document.getElementById('go').click()`).catch(() => {})
  let guest = await waitPage(9432, '127.0.0.1:32100')
  await sleep(800)
  await evaluate(guest, login('convidado'))
  await evaluate(guest, call(`/api/invites/${g.inviteCode}/join`, {}))
  // o convidado tenta usar o mesmo atalho do anfitrião: o Windows só deixa um programa ter cada atalho
  await evaluate(guest, call('/api/me/settings', { hotkeys: { mute: 'Ctrl+Alt+Shift+F9', deafen: '' } }, 'PUT'))
  guest = await reload(9432, guest, '127.0.0.1:32100')
  await sleep(1000)
  await evaluate(guest, joinRoom)
  await sleep(4000)
  console.log('anfitrião ouve alguém entrar:', await evaluate(host, cues))

  // atalhos de verdade, com o foco em outra janela (o convidado)
  press('^%+{F9}')
  await sleep(800)
  console.log('atalho mutar:', await evaluate(host, state), await evaluate(host, cues))
  press('^%+{F9}')
  await sleep(800)
  console.log('atalho desmutar:', await evaluate(host, state), await evaluate(host, cues))
  press('^%+{F10}')
  await sleep(800)
  console.log('atalho não ouvir:', await evaluate(host, state), await evaluate(host, cues))
  press('^%+{F10}')
  await sleep(800)
  console.log('atalho voltar a ouvir:', await evaluate(host, state), await evaluate(host, cues))
  console.log('convidado (atalho repetido não age nele):', await evaluate(guest, state))

  // ajustes mostram o conflito no convidado
  await evaluate(guest, "document.querySelector('.icon-btn').click()")
  await sleep(1200)
  console.log('aviso de conflito no convidado:', await evaluate(guest, "[...document.querySelectorAll('.hotkey')].map(h=>h.innerText.replace(/\\n+/g,' | ')).join(' // ')"))

  // gravar um atalho novo pela tela
  await evaluate(guest, "document.querySelector('.hotkey-key').click()")
  await sleep(200)
  await evaluate(guest, "dispatchEvent(new KeyboardEvent('keydown',{key:'F8',code:'F8',ctrlKey:true,altKey:true,bubbles:true}))")
  await sleep(1500)
  console.log('atalho gravado pela tela:', await evaluate(guest, "document.querySelector('.hotkey-key').textContent"), '| conflito some:', await evaluate(guest, "!document.querySelector('.hotkey .error')"))

  // sons: desligar e conferir que não toca
  await evaluate(guest, "document.querySelector('.sound-settings input[type=checkbox]').click()")
  await sleep(800)
  await evaluate(guest, "[...document.querySelectorAll('.audio-settings button')].pop().click()")
  await evaluate(guest, cues)
  await evaluate(guest, "document.querySelectorAll('.stage-bar .voice-buttons button')[0].click()")
  await sleep(500)
  console.log('sons desligados -> mutar não toca:', await evaluate(guest, cues))

  // outro sai: anfitrião ouve; anfitrião compartilha a tela
  await evaluate(guest, "document.querySelectorAll('.stage-bar .voice-buttons button')[5].click()")
  await sleep(1500)
  console.log('anfitrião ouve alguém sair:', await evaluate(host, cues))
  await evaluate(host, "document.querySelectorAll('.stage-bar .voice-buttons button')[3].click()")
  await sleep(3000)
  console.log('compartilhar a tela:', await evaluate(host, cues))
  await evaluate(host, "document.querySelectorAll('.stage-bar .voice-buttons button')[5].click()")
  await sleep(800)
  console.log('sair da chamada:', await evaluate(host, cues))

  const saved = await evaluate(guest, call('/api/me', undefined, 'GET'))
  console.log('salvo na conta do convidado:', JSON.stringify({ hotkeys: saved.settings.hotkeys, sounds: saved.settings.sounds }))
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  for (const p of procs) p.kill()
}
