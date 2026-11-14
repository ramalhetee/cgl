// Teste da barra de título própria e do "AO VIVO" no app empacotado (anfitrião + convidado).
// - barra: sem a barra do Windows, título do servidor, voltar/avançar, menu do servidor, botão de membros
// - AO VIVO: convidado transmite; anfitrião (fora da sala) vê o selo, abre o cartão com a prévia e
//   clica em "Assistir transmissão": entra na sala com a tela da pessoa em destaque.
// Prints em PRINTS_DIR (padrão: pasta temporária) para conferência visual.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3325
const prints = process.env.PRINTS_DIR || mkdtempSync(join(tmpdir(), 'cgl-prints-'))
mkdirSync(prints, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const procs = []
let failed = false
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FALHOU'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed = true
}

const pages = async (dbg) => { try { return (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).filter((t) => t.type === 'page') } catch { return [] } }
const cdp = (page, method, params = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + method)) }, 30000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result) }
  ws.onerror = () => { clearTimeout(timer); reject(new Error('depurador indisponível')) }
})
const evaluate = async (page, expression) => {
  const r = await cdp(page, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'erro na página')
  return r.result.value
}
const shot = async (page, name) => {
  const r = await cdp(page, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(prints, name), Buffer.from(r.data, 'base64'))
}
const until = async (dbg, m, expression, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const p = (await pages(dbg)).find((t) => t.url.includes(m))
    if (p) { try { if (await evaluate(p, expression)) return p } catch { /* trocando de página */ } }
    await sleep(150)
  }
  throw new Error(`não ficou pronto: ${m} / ${expression.slice(0, 80)}`)
}
const waitTrue = async (page, expression, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { try { if (await evaluate(page, expression)) return true } catch { /* ainda não */ } await sleep(200) }
  return false
}
const PAGE = "location.protocol.startsWith('http') && document.readyState === 'complete'"
const APP = "location.protocol.startsWith('http') && !!document.querySelector('.app')"
const LAUNCHER = "document.readyState === 'complete' && !!window.taverna && !!document.getElementById('host')"
const call = (path, body, method = 'POST') => `fetch('${path}',{method:'${method}',headers:{'content-type':'application/json',authorization:'Bearer '+localStorage.getItem('cgl.token')},body:${body === undefined ? 'undefined' : `JSON.stringify(${JSON.stringify(body)})`}}).then(r=>r.json())`
const register = (u) => `fetch('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'${u}',password:'teste-local-4'})}).then(r=>r.json()).then(j=>{localStorage.setItem('cgl.token',j.token);return j.user.id})`
const clickRow = (text) => `[...document.querySelectorAll('.side .row')].find(b=>b.textContent.includes(${JSON.stringify(text)})).click()`
const headText = "document.querySelector('.content .chat-head strong')?.textContent"
const launch = (dbg) => {
  const p = spawn(exe, [`--remote-debugging-port=${dbg}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    // as duas janelas ficam uma sobre a outra: sem isso o Chromium congela a de trás (como se ninguém olhasse)
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cgl-live-'))}`], {
    env: { ...process.env, TAVERNA_PORT: String(PORT) },
    stdio: 'ignore',
  })
  procs.push(p)
  return p
}

try {
  // ---------- tela inicial ----------
  launch(9701)
  const launcher = await until(9701, 'launcher.html', LAUNCHER)
  check('tela inicial sem a barra do Windows', await evaluate(launcher, 'navigator.windowControlsOverlay?.visible === true'))
  await shot(launcher, '1-tela-inicial.png')

  // ---------- anfitrião ----------
  void evaluate(launcher, "document.getElementById('host').click()").catch(() => {})
  let host = await until(9701, `localhost:${PORT}`, PAGE)
  await evaluate(host, register('anfitriao'))
  const g = await evaluate(host, call('/api/guilds', { name: 'Servidor do Teste' }))
  await evaluate(host, call(`/api/guilds/${g.id}/channels`, { name: 'jogos' }))
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(1500)
  host = await until(9701, `localhost:${PORT}`, APP)

  check('sala sem a barra do Windows', await evaluate(host, 'navigator.windowControlsOverlay?.visible === true'))
  check('barra própria com o nome do servidor', (await evaluate(host, "document.querySelector('.titlebar .tb-title')?.textContent")) === 'Servidor do Teste')
  check('título da janela', (await evaluate(host, 'document.title')) === 'Servidor do Teste — CGL')
  const area = await evaluate(host, "JSON.stringify(navigator.windowControlsOverlay.getTitlebarAreaRect())")
  console.log('     área livre da barra (fora dos botões do Windows):', area)
  check('botões do Windows não cobrem a barra', await evaluate(host, "(()=>{const r=navigator.windowControlsOverlay.getTitlebarAreaRect();const b=document.querySelector('.tb-right').getBoundingClientRect();return b.right<=r.x+r.width+1})()"))

  // voltar / avançar
  check('voltar começa desligado', await evaluate(host, "document.querySelectorAll('.titlebar .tb-btn')[0].disabled"))
  await evaluate(host, clickRow('jogos'))
  await sleep(300)
  await evaluate(host, clickRow('geral'))
  await sleep(300)
  await evaluate(host, "document.querySelectorAll('.titlebar .tb-btn')[0].click()")
  await sleep(300)
  check('voltar volta ao canal anterior', (await evaluate(host, headText)) === '# jogos', await evaluate(host, headText))
  await evaluate(host, "document.querySelectorAll('.titlebar .tb-btn')[1].click()")
  await sleep(300)
  check('avançar', (await evaluate(host, headText)) === '# geral')
  await evaluate(host, "window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',altKey:true}))")
  await sleep(300)
  check('Alt+← também volta', (await evaluate(host, headText)) === '# jogos')

  // menu do servidor e membros
  await evaluate(host, "document.querySelector('.server-name').click()")
  await sleep(300)
  const menu = await evaluate(host, "[...document.querySelectorAll('.server-menu button')].map(b=>b.textContent.trim())")
  check('menu do servidor', menu.length === 4, JSON.stringify(menu))
  await shot(host, '2-barra-e-menu.png')
  await evaluate(host, "document.querySelector('.menu-veil').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))")
  await sleep(200)
  check('lista de membros aparece', await evaluate(host, "!!document.querySelector('.people')"))
  await evaluate(host, "document.querySelector('.head-end').click()")
  await sleep(200)
  check('botão de membros oculta a lista', await evaluate(host, "!document.querySelector('.people')"))
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(1500)
  host = await until(9701, `localhost:${PORT}`, APP)
  check('escolha dos membros lembrada', await evaluate(host, "!document.querySelector('.people')"))
  await evaluate(host, "document.querySelector('.head-end').click()")

  // ---------- convidado transmite ----------
  launch(9702)
  void evaluate(await until(9702, 'launcher.html', LAUNCHER), `document.getElementById('address').value='127.0.0.1:${PORT}';document.getElementById('go').click()`).catch(() => {})
  let guest = await until(9702, '127.0.0.1:32100', PAGE)
  await evaluate(guest, register('convidado'))
  await evaluate(guest, call(`/api/invites/${g.inviteCode}/join`, {}))
  void evaluate(guest, 'location.reload()').catch(() => {})
  await sleep(1500)
  guest = await until(9702, '127.0.0.1:32100', APP)
  check('convidado (pela ponte) também tem a barra própria', await evaluate(guest, 'navigator.windowControlsOverlay?.visible === true'))
  await evaluate(guest, clickRow('Sala de voz'))
  await sleep(2500)
  void evaluate(guest, "document.querySelectorAll('.stage-bar .voice-buttons button')[3].click()").catch(() => {})
  check('convidado transmitindo', await waitTrue(guest, "!!document.querySelector('.own-screen')"))

  // ---------- anfitrião vê AO VIVO ----------
  check('selo AO VIVO na lista da sala', await waitTrue(host, "[...document.querySelectorAll('.occupant')].some(o=>o.textContent.includes('convidado')&&o.querySelector('.live-badge')?.textContent==='AO VIVO')"))
  await evaluate(host, "[...document.querySelectorAll('.occupant')].find(o=>o.textContent.includes('convidado')).click()")
  check('cartão abre', await waitTrue(host, "!!document.querySelector('.live-card')", 3000))
  console.log('     cartão logo ao abrir:', await evaluate(host, "document.querySelector('.live-preview').innerText.trim() || (document.querySelector('.live-preview img')?'(com imagem)':'')"))
  check('prévia da tela chega (miniatura JPEG)', await waitTrue(host, "document.querySelector('.live-preview img')?.src.startsWith('data:image/jpeg')", 12000))
  check('botão Assistir transmissão', (await evaluate(host, "document.querySelector('.live-watch').textContent.trim()")) === 'Assistir transmissão')
  await shot(host, '3-cartao-ao-vivo.png')
  await evaluate(host, "document.querySelector('.live-watch').click()")
  check('assistir: entra na sala com a tela em destaque', await waitTrue(host, "!!document.querySelector('.stage .spot video')", 15000))
  if (!(await evaluate(host, "!!document.querySelector('.stage .spot video')")))
    console.log('     diagnóstico:', await evaluate(host, "JSON.stringify([...globalThis.__cglVoice.links.values()].map(l=>({screen:l.info.screen,screenStream:l.info.screenStream,streams:[...l.streams.values()].map(s=>s.id+':'+s.getTracks().map(t=>t.kind).join('+')),conn:l.pc.connectionState,sig:l.pc.signalingState,recv:l.pc.getReceivers().map(r=>r.track.kind+':'+r.track.readyState+':'+r.track.muted)})))"))
  if (process.env.LIVE_DEBUG) {
    console.log('     convidado:', await evaluate(guest, "JSON.stringify({display:!!globalThis.__cglVoice.display, dtracks:globalThis.__cglVoice.display?.getTracks().map(t=>t.kind+':'+t.readyState+':'+t.enabled+':'+t.muted), hiddenFrom:[...globalThis.__cglVoice.hiddenFrom], links:[...globalThis.__cglVoice.links.values()].map(l=>({polite:l.polite,sig:l.pc.signalingState,tx:l.pc.getTransceivers().map(t=>({mid:t.mid,dir:t.direction,cur:t.currentDirection,track:t.sender.track&&(t.sender.track.kind+':'+t.sender.track.readyState)})),screenSenders:l.screenSenders.length}))})"))
    console.log('     anfitrião tx:', await evaluate(host, "JSON.stringify([...globalThis.__cglVoice.links.values()].map(l=>({polite:l.polite,tx:l.pc.getTransceivers().map(t=>({mid:t.mid,dir:t.direction,cur:t.currentDirection,rtrack:t.receiver.track.kind+':'+t.receiver.track.muted}))})))"))
  }
  check('o destaque é a tela do convidado', await waitTrue(host, "document.querySelector('.stage .spot .tile-label')?.textContent.includes('Tela de convidado')", 5000), await evaluate(host, "document.querySelector('.stage .spot .tile-label')?.textContent"))
  const hasFrames = await waitTrue(host, "document.querySelector('.stage .spot video')?.videoWidth > 0", 10000)
  if (!hasFrames && process.env.LIVE_DEBUG) {
    const stats = (kind) => `(async()=>{const out=[];for(const l of globalThis.__cglVoice.links.values()){(await l.pc.getStats()).forEach(x=>{if(x.type==='${kind}'&&x.kind==='video')out.push({bytes:x.bytesSent??x.bytesReceived,frames:x.framesSent??x.framesDecoded,keyframes:x.keyFramesEncoded??x.keyFramesDecoded,pli:x.pliCount,fir:x.firCount,nack:x.nackCount,lost:x.packetsLost,limit:x.qualityLimitationReason,w:x.frameWidth,active:x.active})})}return JSON.stringify(out)})()`
    console.log('     envio (convidado):', await evaluate(guest, stats('outbound-rtp')))
    console.log('     recebimento (anfitrião):', await evaluate(host, stats('inbound-rtp')))
    console.log('     vídeo no anfitrião:', await evaluate(host, "JSON.stringify((()=>{const v=document.querySelector('.stage .spot video');return {w:v?.videoWidth,ready:v?.readyState,paused:v?.paused,tracks:v?.srcObject?.getTracks().map(t=>t.kind+':'+t.muted+':'+t.readyState)}})())"))
    const ice = "(async()=>{const out=[];for(const l of globalThis.__cglVoice.links.values()){const pairs=[];let loc=0,rem=0;(await l.pc.getStats()).forEach(x=>{if(x.type==='candidate-pair')pairs.push(x.state+(x.nominated?'*':''));if(x.type==='local-candidate')loc++;if(x.type==='remote-candidate')rem++});out.push({conn:l.pc.connectionState,ice:l.pc.iceConnectionState,gather:l.pc.iceGatheringState,pairs,loc,rem})}return JSON.stringify(out)})()"
    console.log('     ICE convidado:', await evaluate(guest, ice))
    console.log('     ICE anfitrião:', await evaluate(host, ice))
    console.log('     ocultos:', await evaluate(guest, "JSON.stringify({hiddenFrom:[...globalThis.__cglVoice.hiddenFrom],senders:[...globalThis.__cglVoice.links.values()].map(l=>l.screenSenders.map(x=>!!x.sender.track))})"))
  }
  check('o vídeo da tela tem imagem', hasFrames)
  await sleep(2500)
  await shot(host, '4-assistindo.png')

  // ---------- o próprio cartão ----------
  await evaluate(guest, "[...document.querySelectorAll('.occupant')].find(o=>o.textContent.includes('convidado')).click()")
  await waitTrue(guest, "!!document.querySelector('.live-card')", 3000)
  check('no próprio cartão: "Você está transmitindo!" desativado', await evaluate(guest, "(()=>{const b=document.querySelector('.live-watch');return b.disabled&&b.textContent.trim()==='Você está transmitindo!'})()"))
  await evaluate(guest, "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
  await sleep(200)
  check('Esc fecha o cartão', await evaluate(guest, "!document.querySelector('.live-card')"))

  // parou de transmitir: o selo some
  void evaluate(guest, "document.querySelectorAll('.stage-bar .voice-buttons button')[3].click()").catch(() => {})
  check('parou de transmitir: selo some', await waitTrue(host, "![...document.querySelectorAll('.occupant')].some(o=>o.querySelector('.live-badge'))"))
  console.log('prints em', prints)
} catch (e) {
  console.log('FALHOU:', e.message)
  failed = true
} finally {
  for (const p of procs) {
    try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* já saiu */ }
  }
}
process.exitCode = failed ? 1 : 0
