// Teste de áudio no app empacotado, com duas cópias (anfitrião e convidado) e microfone falso:
// volume por pessoa (voz e transmissão), som da tela compartilhada, preferências salvas na conta,
// troca de microfone no meio da chamada e lista de dispositivos.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3322
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const procs = []
const launch = (dbg) =>
  procs.push(
    spawn(exe, [`--remote-debugging-port=${dbg}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], {
      env: { ...process.env, TAVERNA_PORT: String(PORT) },
      stdio: 'ignore',
    }),
  )
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
const gains = "JSON.stringify([...(globalThis.__cglMixer?.entries?.values()??[])].map(e=>({quem:e.userId,tipo:e.kind,ganho:Math.round(e.gain.gain.value*100)})).sort((a,b)=>a.tipo.localeCompare(b.tipo)))"
const reload = async (dbg, page, url) => { void evaluate(page, 'location.reload()').catch(() => {}); await sleep(2500); return waitPage(dbg, url) }
const joinRoom = "[...document.querySelectorAll('.row')].find(b=>b.textContent.includes('Sala de voz')).click()"

// espera a tela inicial terminar de carregar (a janela aparece para o depurador antes disso)
const ready = async (p) => { for (let i = 0; i < 60; i++) { try { if (await evaluate(p, "document.readyState === 'complete' && !!window.taverna")) return p } catch {} await sleep(250) } return p }

try {
  // anfitrião
  launch(9401)
  void evaluate(await ready(await waitPage(9401, 'launcher.html')), "document.getElementById('host').click()").catch(() => {})
  let host = await waitPage(9401, `localhost:${PORT}`)
  await sleep(800)
  const hostId = await evaluate(host, login('anfitriao'))
  const g = await evaluate(host, call('/api/guilds', { name: 'Mesa' }))
  host = await reload(9401, host, `localhost:${PORT}`)
  console.log('restrictOwnAudio suportado:', await evaluate(host, 'navigator.mediaDevices.getSupportedConstraints().restrictOwnAudio === true'))

  // convidado, pela ponte
  launch(9402)
  void evaluate(await ready(await waitPage(9402, 'launcher.html')), `document.getElementById('address').value='127.0.0.1:${PORT}';document.getElementById('go').click()`).catch(() => {})
  let guest = await waitPage(9402, '127.0.0.1:32100')
  await sleep(800)
  const guestId = await evaluate(guest, login('convidado'))
  await evaluate(guest, call(`/api/invites/${g.inviteCode}/join`, {}))
  guest = await reload(9402, guest, '127.0.0.1:32100')

  await evaluate(host, joinRoom)
  await sleep(1500)
  await evaluate(guest, joinRoom)
  await sleep(5000)
  console.log('anfitrião ouve o convidado (padrão 100%):', await evaluate(host, gains))

  // volume por clique direito na lista da sala
  await evaluate(host, `(()=>{const row=[...document.querySelectorAll('.occupant')].find(o=>o.textContent.includes('convidado'));const r=row.getBoundingClientRect();row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+20,clientY:r.top+5}));return true})()`)
  await sleep(400)
  console.log('menu de volume abriu:', await evaluate(host, "document.querySelector('.vol-menu')?.innerText.replace(/\\n+/g,' / ')"))
  const slide = (i, v) => `(()=>{const el=document.querySelectorAll('.vol-menu input[type=range]')[${i}];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'${v}');el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`
  await evaluate(host, slide(0, 160))
  await evaluate(host, slide(1, 60))
  await sleep(800)
  console.log('voz 160% / transmissão 60%:', await evaluate(host, gains))

  // convidado compartilha a tela com som
  void evaluate(guest, "document.querySelectorAll('.stage-bar .voice-buttons button')[3].click()").catch(() => {})
  // com a interface falsa de mídia do Chromium, a tela é escolhida sozinha (sem o seletor do app)
  await sleep(6000)
  console.log('convidado compartilhando, com som:', await evaluate(guest, "JSON.stringify({tela:!!document.querySelector('.own-screen'),botaoAtivo:document.querySelectorAll('.stage-bar .voice-buttons button')[3].classList.contains('on')})"))
  console.log('anfitrião recebe voz + som da tela:', await evaluate(host, gains))
  console.log('estado que o anfitrião vê:', await evaluate(host, "JSON.stringify((()=>{const row=[...document.querySelectorAll('.occupant')].find(o=>o.textContent.includes('convidado'));return {seloAoVivo:row.querySelector('.live-badge')?.textContent==='AO VIVO'}})())"))

  // não ouvir zera tudo; voltar restaura os volumes escolhidos
  await evaluate(host, "document.querySelectorAll('.stage-bar .voice-buttons button')[1].click()")
  await sleep(500)
  console.log('não ouvir:', await evaluate(host, gains))
  await evaluate(host, "document.querySelectorAll('.stage-bar .voice-buttons button')[1].click()")
  await sleep(500)
  console.log('voltar a ouvir:', await evaluate(host, gains))

  // dispositivos
  await evaluate(host, "document.querySelector('.icon-btn').click()")
  await sleep(1500)
  console.log('ajustes de áudio:', await evaluate(host, "JSON.stringify({microfones:[...document.querySelectorAll('.audio-settings select')[0].options].map(o=>o.text),saidas:document.querySelectorAll('.audio-settings select')[2].options.length,medidor:document.querySelector('.meter i').style.width})"))
  const before = await evaluate(host, "JSON.stringify(window.__trackBefore=null)")
  void before
  await evaluate(host, `(()=>{const sel=document.querySelectorAll('.audio-settings select')[0];const opt=[...sel.options].find(o=>o.value);if(!opt)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(sel,opt.value);sel.dispatchEvent(new Event('change',{bubbles:true}));return opt.text})()`)
  await sleep(2500)
  console.log('microfone escolhido no seletor:', await evaluate(host, "document.querySelectorAll('.audio-settings select')[0].selectedOptions[0].text"))
  console.log('convidado continua ouvindo o anfitrião depois da troca:', await evaluate(guest, gains))
  await evaluate(host, "[...document.querySelectorAll('.audio-settings button')].pop().click()")

  // tudo salvo na conta: recarrega e confere
  await sleep(1000)
  const saved = await evaluate(host, call('/api/me', undefined, 'GET'))
  console.log('salvo na conta:', JSON.stringify({ volumes: saved.settings.volumes, microfone: saved.settings.input?.label ?? null }))
  host = await reload(9401, host, `localhost:${PORT}`)
  await evaluate(host, joinRoom)
  await sleep(5000)
  console.log('depois de recarregar e entrar de novo:', await evaluate(host, gains))
  await sleep(6000)
  console.log('11 s depois:', await evaluate(host, gains))
  console.log('ids:', JSON.stringify({ hostId, guestId }))
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  for (const p of procs) p.kill()
}
