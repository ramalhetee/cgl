// Teste do visualizador de imagem no app empacotado: abrir, aproximar, trocar de imagem e fechar,
// sem abrir janela nem navegador.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3323
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const p = spawn(exe, ['--remote-debugging-port=9411', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], { env: { ...process.env, TAVERNA_PORT: String(PORT) }, stdio: 'ignore' })
const pages = async () => { for (let i = 0; i < 40; i++) { try { return (await (await fetch('http://127.0.0.1:9411/json')).json()).filter((t) => t.type === 'page') } catch { await sleep(250) } } return [] }
const waitPage = async (m) => { for (let i = 0; i < 80; i++) { const x = (await pages()).find((t) => t.url.includes(m)); if (x) return x; await sleep(250) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + expression.slice(0, 60))) }, 20000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
})
const call = (path, body) => `fetch('${path}',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+localStorage.getItem('cgl.token')},body:JSON.stringify(${JSON.stringify(body)})}).then(r=>r.json())`
const viewer = "JSON.stringify((()=>{const v=document.querySelector('.viewer');if(!v)return null;const i=v.querySelector('.viewer-img');return {nome:v.querySelector('.viewer-info b').textContent,info:v.querySelector('.viewer-info .muted').textContent.split(' · ').pop(),zoom:v.querySelector('.viewer-zoom').textContent,transform:i.style.transform}})())"
const key = (k) => `dispatchEvent(new KeyboardEvent('keydown',{key:'${k}'}))`

try {
  void evaluate(await waitPage('launcher.html'), "document.getElementById('host').click()").catch(() => {})
  let host = await waitPage(`localhost:${PORT}`)
  await sleep(800)
  await evaluate(host, "fetch('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'imagens',password:'teste-local-1'})}).then(r=>r.json()).then(j=>localStorage.setItem('cgl.token',j.token))")
  await evaluate(host, call('/api/guilds', { name: 'Mesa' }))
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(2500)
  host = await waitPage(`localhost:${PORT}`)
  // envia duas imagens pelo botão de anexo do chat
  for (const [color, w, h] of [['red', 1600, 900], ['blue', 400, 800]]) {
    await evaluate(host, `(async()=>{const input=document.querySelector('.composer input[type=file]');const c=document.createElement('canvas');c.width=${w};c.height=${h};const x=c.getContext('2d');x.fillStyle='${color}';x.fillRect(0,0,${w},${h});const blob=await new Promise(r=>c.toBlob(r,'image/png'));const dt=new DataTransfer();dt.items.add(new File([blob],'${color}.png',{type:'image/png'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
    await sleep(1200)
    await evaluate(host, "document.querySelector('.composer .primary').click()")
    await sleep(1200)
  }
  const before = (await pages()).length
  console.log('imagens no chat:', await evaluate(host, "document.querySelectorAll('.att-open img').length"))

  await evaluate(host, "document.querySelectorAll('.att-open')[0].click()")
  await sleep(500)
  console.log('abriu dentro do app:', await evaluate(host, viewer), '| janelas novas:', (await pages()).length - before)
  console.log('imagem cabe na tela:', await evaluate(host, "(()=>{const r=document.querySelector('.viewer-img').getBoundingClientRect();return r.width<=innerWidth&&r.height<=innerHeight})()"))

  await evaluate(host, "document.querySelector('.viewer').dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-100,clientX:innerWidth/2+200,clientY:innerHeight/2}))")
  await sleep(300)
  console.log('roda do mouse aproxima:', await evaluate(host, viewer))
  await evaluate(host, "(()=>{const i=document.querySelector('.viewer-img');const o={bubbles:true,pointerId:1};i.dispatchEvent(new PointerEvent('pointerdown',{...o,clientX:500,clientY:300}));i.dispatchEvent(new PointerEvent('pointermove',{...o,clientX:420,clientY:260}));i.dispatchEvent(new PointerEvent('pointerup',{...o,clientX:420,clientY:260}));return true})()")
  await sleep(200)
  console.log('arrastar move a imagem:', await evaluate(host, viewer))
  await evaluate(host, "document.querySelector('.viewer-img').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
  await sleep(300)
  console.log('duplo clique volta ao tamanho:', await evaluate(host, viewer))

  await evaluate(host, key('ArrowRight'))
  await sleep(300)
  console.log('seta direita -> próxima:', await evaluate(host, viewer))
  await evaluate(host, key('ArrowLeft'))
  await sleep(300)
  console.log('seta esquerda -> anterior:', await evaluate(host, viewer))
  await evaluate(host, key('Escape'))
  await sleep(300)
  console.log('Esc fecha:', await evaluate(host, "!document.querySelector('.viewer')"))

  await evaluate(host, "document.querySelectorAll('.att-open')[1].click()")
  await sleep(400)
  await evaluate(host, "document.querySelector('.viewer').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))")
  await sleep(300)
  console.log('clicar fora fecha:', await evaluate(host, "!document.querySelector('.viewer')"))
  console.log('nenhuma janela nova no fim:', (await pages()).length === before)
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  p.kill()
}
