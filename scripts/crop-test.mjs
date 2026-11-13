// Teste do recorte da foto no app empacotado.
// Foto de teste 400x200: metade esquerda vermelha, metade direita azul.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'Taverna-win32-x64', 'Taverna.exe')
const PORT = 3317
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const p = spawn(exe, ['--remote-debugging-port=9381', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], { env: { ...process.env, TAVERNA_PORT: String(PORT) }, stdio: 'ignore' })
const pages = async () => { for (let i = 0; i < 40; i++) { try { return (await (await fetch('http://127.0.0.1:9381/json')).json()).filter((t) => t.type === 'page') } catch { await sleep(250) } } return [] }
const waitPage = async (m) => { for (let i = 0; i < 80; i++) { const x = (await pages()).find((t) => t.url.includes(m)); if (x) return x; await sleep(250) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + expression.slice(0, 50))) }, 20000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
})
const post = (path, body) => `fetch('${path}',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+(localStorage.getItem('taverna.token')||'')},body:JSON.stringify(${JSON.stringify(body)})}).then(r=>r.json())`
const pickPhoto = (type) => `(async()=>{const c=document.createElement('canvas');c.width=400;c.height=200;const x=c.getContext('2d');x.fillStyle='#ff0000';x.fillRect(0,0,200,200);x.fillStyle='#0000ff';x.fillRect(200,0,200,200);const blob=await new Promise(r=>c.toBlob(r,'image/png'));const dt=new DataTransfer();dt.items.add(new File([blob],'foto','${type}'==='image/gif'?{type:'image/gif'}:{type:'image/png'}));const input=document.querySelector('.profile-edit input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`
// lê a foto salva na prévia: tamanho e cor das bordas esquerda/direita
const readAvatar = `(async()=>{const src=document.querySelector('.profile-head .avatar img')?.src;if(!src)return null;const i=new Image();i.src=src;await i.decode();const c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;const x=c.getContext('2d');x.drawImage(i,0,0);const px=(u)=>{const d=x.getImageData(Math.floor(u*(c.width-1)),c.height>>1,1,1).data;return d[0]>200&&d[2]<60?'vermelho':d[2]>200&&d[0]<60?'azul':'outro'};return {tamanho:i.naturalWidth+'x'+i.naturalHeight,esquerda:px(0.03),direita:px(0.97),ext:src.split('.').pop()}})()`
const drag = (dx) => `(()=>{const v=document.querySelector('.crop-view');const r=v.getBoundingClientRect();const o={bubbles:true,pointerId:1,clientY:r.top+140};v.dispatchEvent(new PointerEvent('pointerdown',{...o,clientX:r.left+140}));v.dispatchEvent(new PointerEvent('pointermove',{...o,clientX:r.left+140+(${dx})}));v.dispatchEvent(new PointerEvent('pointerup',{...o,clientX:r.left+140+(${dx})}));return true})()`
const cropState = "(()=>{const i=document.querySelector('.crop-view img');return {largura:Math.round(parseFloat(i.style.width)),x:Math.round(new DOMMatrix(getComputedStyle(i).transform).m41)}})()"
const openCrop = async (host) => { await evaluate(host, pickPhoto('image/png')); await sleep(900) }
const use = async (host) => { await evaluate(host, "[...document.querySelectorAll('.crop .modal-actions button')].pop().click()"); await sleep(1500) }

try {
  void evaluate(await waitPage('launcher.html'), "document.getElementById('host').click()").catch(() => {})
  let host = await waitPage(`localhost:${PORT}`)
  await sleep(800)
  await evaluate(host, post('/api/register', { username: 'recorte', password: 'teste-local-5' }) + ".then(j=>localStorage.setItem('taverna.token',j.token))")
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(2500)
  host = await waitPage(`localhost:${PORT}`)
  await evaluate(host, "document.querySelector('.me-chip').click()")
  await sleep(400)

  await openCrop(host)
  console.log('recorte abriu:', await evaluate(host, "!!document.querySelector('.crop-view img')"), JSON.stringify(await evaluate(host, cropState)))
  await use(host)
  console.log('1. sem mexer (centro):', JSON.stringify(await evaluate(host, readAvatar)))

  await openCrop(host)
  await evaluate(host, drag(+400))
  console.log('   arrastou pra direita, limite:', JSON.stringify(await evaluate(host, cropState)))
  await use(host)
  console.log('2. lado esquerdo da foto:', JSON.stringify(await evaluate(host, readAvatar)))

  await openCrop(host)
  await evaluate(host, drag(-400))
  await use(host)
  console.log('3. lado direito da foto:', JSON.stringify(await evaluate(host, readAvatar)))

  await openCrop(host)
  await evaluate(host, "(()=>{const el=document.querySelector('.crop-zoom input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'2');el.dispatchEvent(new Event('input',{bubbles:true}));return true})()")
  await sleep(300)
  console.log('   zoom 2x pela barra:', JSON.stringify(await evaluate(host, cropState)))
  await evaluate(host, "document.querySelector('.crop-view').dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-100}))")
  await sleep(300)
  console.log('   + roda do mouse:', JSON.stringify(await evaluate(host, cropState)))
  await evaluate(host, drag(+2000))
  await use(host)
  console.log('4. zoom + canto esquerdo:', JSON.stringify(await evaluate(host, readAvatar)))

  await openCrop(host)
  const before = await evaluate(host, "document.querySelector('.profile-head .avatar img').src")
  await evaluate(host, "document.querySelector('.crop .modal-actions button').click()")
  await sleep(500)
  console.log('5. cancelar mantém a foto anterior:', (await evaluate(host, "document.querySelector('.profile-head .avatar img').src")) === before, '| recorte fechou:', await evaluate(host, "!document.querySelector('.crop')"), '| editor continua aberto:', await evaluate(host, "!!document.querySelector('.profile-edit')"))

  await evaluate(host, "document.querySelector('.profile-edit button[type=submit]').click()")
  await sleep(1200)
  console.log('6. salvo no perfil:', await evaluate(host, "!!document.querySelector('.me-chip img') && !document.querySelector('.profile-edit')"))
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  p.kill()
}
