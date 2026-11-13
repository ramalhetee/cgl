// Confere se o som do próprio CGL fica fora da captura da tela (para ninguém ouvir vozes duplicadas)
// e se o som de outros programas continua entrando. Toca bipes curtos no PC.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3324
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const p = spawn(exe, ['--remote-debugging-port=9421', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], { env: { ...process.env, TAVERNA_PORT: String(PORT) }, stdio: 'ignore' })
const pages = async () => { for (let i = 0; i < 40; i++) { try { return (await (await fetch('http://127.0.0.1:9421/json')).json()).filter((t) => t.type === 'page') } catch { await sleep(250) } } return [] }
const waitPage = async (m) => { for (let i = 0; i < 80; i++) { const x = (await pages()).find((t) => t.url.includes(m)); if (x) return x; await sleep(250) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + expression.slice(0, 60))) }, 30000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
})

// WAV de 1,5 s em 880 Hz, tocado por outro programa (PowerShell)
const wav = join(mkdtempSync(join(tmpdir(), 'cgl-wav-')), 'bipe.wav')
{
  const rate = 44100, n = Math.round(rate * 1.5), buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 880 * i) / rate) * 9000), 44 + i * 2)
  writeFileSync(wav, buf)
}
const playOutside = () => spawn('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`], { stdio: 'ignore' })

// captura a tela inteira com som (escolhendo no seletor do app) e mede o nível do áudio capturado
async function capture(host, restrict) {
  void evaluate(host, `navigator.mediaDevices.getDisplayMedia({video:true,audio:{restrictOwnAudio:${restrict},echoCancellation:false,noiseSuppression:false,autoGainControl:false}}).then(s=>{window.__cap=s;const a=s.getAudioTracks()[0];window.__set=a?JSON.stringify({restrictOwnAudio:a.getSettings().restrictOwnAudio}):'sem audio'},e=>window.__set='erro '+e.name)`).catch(() => {})
  const pk = await waitPage('picker.html')
  await sleep(1000)
  await evaluate(pk, "document.querySelector('#screens .item').click(); document.getElementById('audio').checked = true; true")
  void evaluate(pk, "document.getElementById('share').click()").catch(() => {})
  await sleep(1500)
  return evaluate(host, 'window.__set')
}
// mede o pico do áudio capturado durante `ms`, enquanto `during` toca algo
const measure = (host, ms) => evaluate(host, `new Promise(res=>{const ctx=new AudioContext();const an=ctx.createAnalyser();an.fftSize=2048;ctx.createMediaStreamSource(window.__cap).connect(an);const b=new Float32Array(an.fftSize);let peak=0;const t=setInterval(()=>{an.getFloatTimeDomainData(b);for(const v of b)peak=Math.max(peak,Math.abs(v))},30);setTimeout(()=>{clearInterval(t);ctx.close();res(Math.round(peak*1000)/1000)},${ms})})`)
const playInside = (host) => evaluate(host, "(()=>{const ctx=new AudioContext();const o=ctx.createOscillator();const g=ctx.createGain();o.frequency.value=440;g.gain.value=0.3;o.connect(g).connect(ctx.destination);o.start();setTimeout(()=>{o.stop();ctx.close()},1500);return true})()")
const stopCap = (host) => evaluate(host, 'window.__cap.getTracks().forEach(t=>t.stop()); true')

// espera a tela inicial terminar de carregar (a janela aparece para o depurador antes disso)
const ready = async (p) => { for (let i = 0; i < 60; i++) { try { if (await evaluate(p, "document.readyState === 'complete' && !!window.taverna")) return p } catch {} await sleep(250) } return p }

try {
  void evaluate(await ready(await waitPage('launcher.html')), "document.getElementById('host').click()").catch(() => {})
  const host = await waitPage(`localhost:${PORT}`)
  await sleep(1000)
  const results = {}
  for (const restrict of [false, true]) {
    const set = await capture(host, restrict)
    await sleep(500)
    const silence = await measure(host, 600)
    void playInside(host)
    const inside = await measure(host, 1200)
    await sleep(600)
    const outside = playOutside()
    await sleep(200)
    const fromOutside = await measure(host, 1000)
    outside.kill()
    await stopCap(host)
    await sleep(800)
    results[restrict ? 'com restrictOwnAudio' : 'sem restrictOwnAudio'] = { faixa: set, silencio: silence, somDoCGL: inside, somDeOutroPrograma: fromOutside }
  }
  console.log(JSON.stringify(results, null, 1))
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  p.kill()
  try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process CGL -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*CGL-win32-x64*' } | Out-Null"]) } catch {}
}
