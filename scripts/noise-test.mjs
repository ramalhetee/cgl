// Teste da supressão de ruído no app empacotado, com duas cópias (anfitrião e convidado).
// O microfone falso do convidado toca um arquivo: fala de verdade (voz do Windows) misturada com ruído
// (chiado + zumbido). Mede o nível do áudio que o convidado ENVIA para a chamada em cada modo:
// o piso (trechos só com ruído) precisa cair com o RNNoise, e a fala precisa continuar chegando.
// Também mede a CPU dos processos do convidado em cada modo.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'CGL-win32-x64', 'CGL.exe')
const PORT = 3324
const RATE = 48000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const procs = []

// ---------- arquivo do microfone falso ----------
function speech(path) {
  const ps = `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('${path}', $f)
$s.Rate = 0
$s.Speak('Testing the microphone. One, two, three. The quick brown fox jumps over the lazy dog.')
$s.Dispose()`
  execFileSync('powershell', ['-NoProfile', '-Command', ps])
  const buf = readFileSync(path)
  let off = 12
  while (buf.toString('ascii', off, off + 4) !== 'data') off += 8 + buf.readUInt32LE(off + 4)
  const len = buf.readUInt32LE(off + 4) / 2
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768
  return out
}
function makeWav(path, voice) {
  const total = RATE * 20 // 20 s em loop: 3 s só ruído, fala (~9 s), resto só ruído
  const pcm = Buffer.alloc(total * 2)
  let peak = 0
  for (const v of voice) peak = Math.max(peak, Math.abs(v))
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  let brown = 0
  for (let i = 0; i < total; i++) {
    brown = Math.max(-1, Math.min(1, brown + rnd() * 0.05))
    const noise = rnd() * 0.06 + brown * 0.08 + Math.sin((2 * Math.PI * 120 * i) / RATE) * 0.03 // chiado + ventilador + zumbido
    const v = i >= RATE * 3 && i - RATE * 3 < voice.length ? (voice[i - RATE * 3] / peak) * 0.5 : 0
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v + noise)) * 32767), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  writeFileSync(path, Buffer.concat([h, pcm]))
  return { voiceSeconds: voice.length / RATE }
}

// ---------- controle das janelas ----------
const pages = async (dbg) => { try { return (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).filter((t) => t.type === 'page') } catch { return [] } }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const timer = setTimeout(() => { ws.close(); reject(new Error('sem resposta: ' + expression.slice(0, 60))) }, 90000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
  ws.onerror = () => { clearTimeout(timer); reject(new Error('depurador indisponível')) }
})
const until = async (dbg, m, expression, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const p = (await pages(dbg)).find((t) => t.url.includes(m))
    if (p) { try { if (await evaluate(p, expression)) return p } catch { /* trocando de página */ } }
    await sleep(100)
  }
  throw new Error(`não ficou pronto: ${m}`)
}
const PAGE = "location.protocol.startsWith('http') && document.readyState === 'complete'"
const APP = "location.protocol.startsWith('http') && !!document.querySelector('.app')"
const LAUNCHER = "document.readyState === 'complete' && !!window.taverna && !!document.getElementById('host')"
const call = (path, body, method = 'POST') => `fetch('${path}',{method:'${method}',headers:{'content-type':'application/json',authorization:'Bearer '+localStorage.getItem('cgl.token')},body:${body === undefined ? 'undefined' : `JSON.stringify(${JSON.stringify(body)})`}}).then(r=>r.json())`
const register = (u) => `fetch('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'${u}',password:'teste-local-3'})}).then(r=>r.json()).then(j=>{localStorage.setItem('cgl.token',j.token);return j.user.id})`
const joinRoom = "[...document.querySelectorAll('.row')].find(b=>b.textContent.includes('Sala de voz')).click()"
const launch = (dbg, wav) => {
  const p = spawn(exe, [`--remote-debugging-port=${dbg}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cgl-noise-'))}`], {
    env: { ...process.env, TAVERNA_PORT: String(PORT) },
    stdio: 'ignore',
  })
  procs.push(p)
  return p
}

/** Troca o filtro pela tela de ajustes (o mesmo caminho do usuário) e espera o microfone da chamada trocar. */
const setNoise = async (page, mode) => {
  await evaluate(page, "document.querySelector('.icon-btn').click()")
  await sleep(800)
  await evaluate(page, `(()=>{const sel=document.querySelector('.audio-settings select.noise-select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(sel,'${mode}');sel.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  await sleep(1500)
  await evaluate(page, "[...document.querySelectorAll('.audio-settings button')].pop().click()")
  const end = Date.now() + 10000
  while (Date.now() < end) {
    if ((await evaluate(page, 'globalThis.__cglVoice?.micHandle?.mode ?? null')) === mode) return
    await sleep(200)
  }
  throw new Error(`o microfone da chamada não ficou em ${mode}`)
}
/** Nível (RMS) do áudio que o convidado ENVIA (a faixa entregue à chamada, já filtrada), por `ms`. dBFS em percentis. */
const levels = (page, ms) => evaluate(page, `(async()=>{
  const stream=globalThis.__cglVoice.mic;
  const ctx=new AudioContext(); const an=ctx.createAnalyser(); an.fftSize=2048;
  ctx.createMediaStreamSource(stream).connect(an); await ctx.resume();
  const buf=new Float32Array(an.fftSize); const xs=[]; const end=Date.now()+${ms};
  while(Date.now()<end){ an.getFloatTimeDomainData(buf); let s=0; for(const v of buf) s+=v*v; xs.push(Math.sqrt(s/buf.length)); await new Promise(r=>setTimeout(r,40)) }
  await ctx.close();
  xs.sort((a,b)=>a-b); const db=(x)=>Math.round(20*Math.log10(Math.max(x,1e-5))*10)/10; const p=(q)=>db(xs[Math.floor(xs.length*q)]);
  return { amostras: xs.length, pisoDb: p(0.2), falaDb: p(0.9) }
})()`)
function treeCpuSeconds(pid) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const all = JSON.parse(out)
  const ids = new Set([pid])
  for (let grew = true; grew;) { grew = false; for (const x of all) if (!ids.has(x.ProcessId) && ids.has(x.ParentProcessId)) { ids.add(x.ProcessId); grew = true } }
  return all.filter((x) => ids.has(x.ProcessId)).reduce((s, x) => s + (Number(x.KernelModeTime) + Number(x.UserModeTime)) / 1e7, 0)
}
async function cpuPercent(pid, ms = 10000) {
  const a = treeCpuSeconds(pid)
  await sleep(ms)
  return Math.round(((treeCpuSeconds(pid) - a) / (ms / 1000)) * 1000) / 10 // % de um núcleo
}

try {
  const dir = mkdtempSync(join(tmpdir(), 'cgl-noise-wav-'))
  const info = makeWav(join(dir, 'mic.wav'), speech(join(dir, 'fala.wav')))
  console.log(`arquivo do microfone: 20 s em loop, fala de ${info.voiceSeconds.toFixed(1)} s + ruído o tempo todo`)
  const wav = join(dir, 'mic.wav')

  launch(9601, wav)
  void evaluate(await until(9601, 'launcher.html', LAUNCHER), "document.getElementById('host').click()").catch(() => {})
  let host = await until(9601, `localhost:${PORT}`, PAGE)
  await evaluate(host, register('anfitriao'))
  const g = await evaluate(host, call('/api/guilds', { name: 'Ruído' }))
  void evaluate(host, 'location.reload()').catch(() => {})
  await sleep(1500)
  host = await until(9601, `localhost:${PORT}`, APP)

  const guestProc = launch(9602, wav)
  void evaluate(await until(9602, 'launcher.html', LAUNCHER), `document.getElementById('address').value='127.0.0.1:${PORT}';document.getElementById('go').click()`).catch(() => {})
  let guest = await until(9602, '127.0.0.1:32100', PAGE)
  await evaluate(guest, register('convidado'))
  await evaluate(guest, call(`/api/invites/${g.inviteCode}/join`, {}))
  await evaluate(guest, call('/api/me/settings', { noise: 'off' }, 'PUT'))
  void evaluate(guest, 'location.reload()').catch(() => {})
  await sleep(1500)
  guest = await until(9602, '127.0.0.1:32100', APP)

  await evaluate(host, joinRoom)
  await sleep(1500)
  await evaluate(guest, joinRoom)
  await sleep(4000)
  console.log('modo inicial do convidado (salvo na conta):', await evaluate(guest, 'globalThis.__cglVoice?.micHandle?.mode'))

  const results = {}
  for (const mode of ['off', 'browser', 'rnnoise']) {
    await setNoise(guest, mode)
    await sleep(2000)
    const [lv, cpu] = await Promise.all([levels(guest, 40000), cpuPercent(guestProc.pid, 30000)])
    // a chamada continua entregando o áudio do convidado (bytes recebidos pelo anfitrião só crescem)
    const got = await evaluate(host, "(async()=>{const l=[...globalThis.__cglVoice.links.values()][0];let b=0;(await l.pc.getStats()).forEach(x=>{if(x.type==='inbound-rtp'&&x.kind==='audio')b=x.bytesReceived});return b})()")
    results[mode] = { ...lv, cpuConvidado: cpu, anfitriaoRecebeuBytes: got }
    console.log(mode.padEnd(8), JSON.stringify(results[mode]))
  }

  const off = results.off
  const rn = results.rnnoise
  const floorDrop = off.pisoDb - rn.pisoDb
  const voiceGap = rn.falaDb - rn.pisoDb
  console.log(`\nRNNoise: piso caiu ${floorDrop.toFixed(1)} dB; fala ${voiceGap.toFixed(1)} dB acima do piso (sem filtro: ${(off.falaDb - off.pisoDb).toFixed(1)} dB)`)
  console.log(`CPU extra do RNNoise no convidado: ${(rn.cpuConvidado - results.browser.cpuConvidado).toFixed(1)} pontos de um núcleo`)
  const ok = floorDrop >= 10 && voiceGap >= 15
  console.log(ok ? 'OK: o ruído caiu e a fala continua chegando' : 'FALHOU: o ruído não caiu o bastante ou a fala sumiu')
  if (!ok) process.exitCode = 1

  // ajuste salvo na conta
  const saved = await evaluate(guest, call('/api/me', undefined, 'GET'))
  console.log('salvo na conta:', saved.settings.noise)
} catch (e) {
  console.log('FALHOU:', e.message)
  process.exitCode = 1
} finally {
  for (const p of procs) {
    try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* já saiu */ }
  }
}
