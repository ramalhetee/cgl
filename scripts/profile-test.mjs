// Teste do perfil no app empacotado: editar nome/status/bio/cor/foto pela tela e conferir onde aparece.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3316
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const p = spawn(exe, ['--remote-debugging-port=9371', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], { env: { ...process.env, TAVERNA_PORT: String(PORT) }, stdio: 'ignore' })
const pages = async () => { for (let i = 0; i < 40; i++) { try { return (await (await fetch('http://127.0.0.1:9371/json')).json()).filter((t) => t.type === 'page') } catch { await sleep(250) } } return [] }
const waitPage = async (m) => { for (let i = 0; i < 80; i++) { const x = (await pages()).find((t) => t.url.includes(m)); if (x) return x; await sleep(250) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + expression.slice(0, 50))) }, 20000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
})
const auth = "authorization:'Bearer '+(localStorage.getItem('cgl.token')||'')"
const post = (path, body, method = 'POST') => `fetch('${path}',{method:'${method}',headers:{'content-type':'application/json',${auth}},body:JSON.stringify(${JSON.stringify(body)})}).then(async r=>({status:r.status,...(await r.json())}))`
// digita num campo controlado pelo React
const type = (sel, value) => `(()=>{const el=document.querySelector(${JSON.stringify(sel)});const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`
// PNG 2x2 gerado na hora, enviado pelo mesmo campo de arquivo que o usuário usa
const pickPhoto = `(async()=>{const c=document.createElement('canvas');c.width=c.height=2;c.getContext('2d').fillRect(0,0,2,2);const blob=await new Promise(r=>c.toBlob(r,'image/png'));const dt=new DataTransfer();dt.items.add(new File([blob],'foto.png',{type:'image/png'}));const input=document.querySelector('.profile-edit input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`

// espera a tela inicial terminar de carregar (a janela aparece para o depurador antes disso)
const ready = async (p) => { for (let i = 0; i < 60; i++) { try { if (await evaluate(p, "document.readyState === 'complete' && !!window.taverna")) return p } catch {} await sleep(250) } return p }

try {
  void evaluate(await ready(await waitPage('launcher.html')), "document.getElementById('host').click()").catch(() => {})
  let host = await waitPage(`localhost:${PORT}`)
  await sleep(800)
  await evaluate(host, post('/api/register', { username: 'perfil_teste', password: 'teste-local-6' }) + ".then(j=>localStorage.setItem('cgl.token',j.token))")
  await evaluate(host, post('/api/guilds', { name: 'Mesa' }))
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(2500)
  host = await waitPage(`localhost:${PORT}`)

  await evaluate(host, "document.querySelector('.me-chip').click()")
  await sleep(400)
  console.log('editor abriu:', await evaluate(host, "!!document.querySelector('.profile-edit')"))
  await evaluate(host, type('.profile-edit label:nth-of-type(1) input', 'Mestre Ana'))
  await evaluate(host, type('.profile-edit label:nth-of-type(2) input', 'jogando RPG'))
  await evaluate(host, type('.profile-edit textarea', 'Narradora das quintas.'))
  await evaluate(host, "document.querySelectorAll('.swatches button')[3].click()")
  await evaluate(host, pickPhoto)
  await sleep(900)
  await evaluate(host, "[...document.querySelectorAll('.crop .modal-actions button')].pop().click()") // confirma o recorte
  await sleep(1500)
  console.log('prévia com foto:', await evaluate(host, "!!document.querySelector('.profile-head .avatar img')"))
  await evaluate(host, "document.querySelector('.profile-edit button[type=submit]').click()")
  await sleep(1200)
  console.log('editor fechou:', await evaluate(host, "!document.querySelector('.profile-edit')"))
  console.log('topo:', await evaluate(host, "document.querySelector('.me-chip').textContent.trim() + ' | foto: ' + !!document.querySelector('.me-chip img')"))
  console.log('lista de membros:', await evaluate(host, "document.querySelector('.people .row').textContent.trim() + ' | foto: ' + !!document.querySelector('.people .row img')"))

  // mensagem nova e cartão de perfil
  await evaluate(host, type('.composer textarea', 'oi'))
  await evaluate(host, "document.querySelector('.composer .primary').click()")
  await sleep(800)
  console.log('autor da mensagem:', await evaluate(host, "document.querySelector('.msg-meta b').textContent.trim() + ' | foto: ' + !!document.querySelector('.msg-gutter img')"))
  await evaluate(host, "document.querySelector('.msg-meta b').click()")
  await sleep(800)
  console.log('cartão:', await evaluate(host, "document.querySelector('.profile-card').innerText.replace(/\\n+/g,' / ')"))
  await evaluate(host, "document.querySelector('.profile-card .modal-actions button').click()")

  // depois de reabrir o app (recarregar), tudo continua salvo
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(2500)
  host = await waitPage(`localhost:${PORT}`)
  console.log('depois de recarregar:', await evaluate(host, "document.querySelector('.me-chip').textContent.trim() + ' | foto: ' + !!document.querySelector('.me-chip img')"))

  // o servidor recusa valores inválidos
  console.log('foto de fora recusada:', (await evaluate(host, post('/api/me', { avatar: 'https://exemplo.invalid/x.png' }, 'PATCH'))).status)
  console.log('cor inválida recusada:', (await evaluate(host, post('/api/me', { color: 'red' }, 'PATCH'))).status)
  console.log('sem login recusado:', await evaluate(host, "fetch('/api/me',{method:'PATCH',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)"))
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  p.kill()
}
