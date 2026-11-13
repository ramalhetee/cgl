// Teste da prévia de links: endereços bloqueados (rede local) e páginas públicas reais.
import http from 'node:http'
import { unfurl, _test } from '../server/src/unfurl.js'

const priv = ['127.0.0.1', '10.0.0.5', '192.168.18.138', '172.20.1.1', '169.254.169.254', '100.101.1.2', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']
const pub = ['8.8.8.8', '140.82.112.3', '2606:4700::6810:84e5']
console.log('privados bloqueados:', priv.every((ip) => !_test.isPublicIp(ip)), '| públicos aceitos:', pub.every((ip) => _test.isPublicIp(ip)))

// servidor local que redireciona para um endereço interno: também tem que ser recusado
const local = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>segredo</title>') }).listen(0, '127.0.0.1')
await new Promise((r) => local.once('listening', r))
const port = local.address().port
for (const u of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://192.168.18.138:3210/', 'file:///C:/Windows/win.ini', 'http://user:pw@example.com/']) {
  try {
    await unfurl(u)
    console.log('NÃO BLOQUEOU:', u)
  } catch (e) {
    console.log('bloqueado:', u.slice(0, 45).padEnd(45), '->', e.message)
  }
}
local.close()

for (const u of ['https://github.com/ramalhetee/cgl/releases', 'https://www.youtube.com/watch?v=W4aQLPUcTYI', 'https://youtu.be/W4aQLPUcTYI', 'https://www.instagram.com/p/DfiJUF_ILjq']) {
  try {
    const d = await unfurl(u)
    console.log('ok:', u.slice(8, 40).padEnd(32), JSON.stringify({ site: d.site, title: d.title.slice(0, 50), desc: d.description.slice(0, 40), image: !!d.image, grande: d.largeImage }))
  } catch (e) {
    console.log('sem prévia:', u.slice(8, 40), '->', e.message)
  }
}
