// Teste do seletor de tela do app empacotado.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const exe = process.env.TAVERNA_EXE || join(dirname(fileURLToPath(import.meta.url)), '..', 'release', 'Taverna-win32-x64', 'Taverna.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const p = spawn(exe, ['--remote-debugging-port=9336', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'taverna-test-'))}`], { env: { ...process.env, TAVERNA_PORT: '3312' }, stdio: 'ignore' })
const pages = async () => { for (let i = 0; i < 40; i++) { try { return (await (await fetch('http://127.0.0.1:9336/json')).json()).filter((t) => t.type === 'page') } catch { await sleep(250) } } return [] }
const waitPage = async (m) => { for (let i = 0; i < 60; i++) { const x = (await pages()).find((t) => t.url.includes(m)); if (x) return x; await sleep(250) } throw new Error('sem janela ' + m) }
const evaluate = (page, expression) => new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== 1) return; ws.close(); m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value) }
})
try {
  void evaluate(await waitPage('launcher.html'), "document.getElementById('host').click()").catch(() => {})
  const host = await waitPage('localhost:3312'); await sleep(800)
  void evaluate(host, "navigator.mediaDevices.getDisplayMedia({video:true,audio:true}).then(s=>{window.__s=s.getTracks().map(t=>t.kind+':'+t.readyState).join(',');s.getTracks().forEach(t=>t.stop())},e=>window.__s='erro '+e.name)").catch(() => {})
  const pk = await waitPage('picker.html'); await sleep(1200)
  console.log('seletor:', await evaluate(pk, "document.querySelectorAll('#screens .item').length+' tela(s), '+document.querySelectorAll('#windows .item').length+' janela(s)'"))
  void evaluate(pk, "document.querySelector('#screens .item').click();document.getElementById('share').click()").catch(() => {})
  await sleep(2000)
  console.log('captura:', await evaluate(host, 'window.__s'))
  console.log('seletor fechou:', !(await pages()).some((t) => t.url.includes('picker.html')))
} catch (e) { console.log('FALHOU:', e.message); process.exitCode = 1 } finally { p.kill() }
