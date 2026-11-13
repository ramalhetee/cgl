// Segundo usuário simulado: entra por convite, manda mensagem, reage, entra na sala de voz.
import { io } from 'socket.io-client'
const B = 'http://localhost:3210', invite = process.argv[2]
const post = (p, body, t) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(body) }).then((r) => r.json())
let acc = await post('/api/register', { username: 'teste_bia', password: 'teste-local-456' })
if (!acc.token) acc = await post('/api/login', { username: 'teste_bia', password: 'teste-local-456' })
const g = await post(`/api/invites/${invite}/join`, {}, acc.token)
console.log('entrou em', g.name, g.channels.map((c) => c.type).join(','))
const text = g.channels.find((c) => c.type === 'text'), vc = g.channels.find((c) => c.type === 'voice')
const s = io(B, { auth: { token: acc.token }, transports: ['websocket'] })
await new Promise((r) => s.on('ready', r))
const hist = await fetch(`${B}/api/channels/${text.id}/messages`, { headers: { authorization: 'Bearer ' + acc.token } }).then((r) => r.json())
console.log('historico:', hist.map((m) => m.content))
console.log('send:', await s.emitWithAck('message:send', { channelId: text.id, content: 'Oi da Bia!' }))
if (hist[0]) s.emit('reaction:toggle', { messageId: hist[0].id, emoji: '🎉' })
console.log('voz:', JSON.stringify(await s.emitWithAck('voice:join', { channelId: vc.id })))
console.log('canal alheio:', await s.emitWithAck('message:send', { channelId: 99999, content: 'x' }))
await new Promise((r) => setTimeout(r, Number(process.argv[3] || 1500)))
s.close()
