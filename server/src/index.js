import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as d from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_MESSAGE = 4000;

// JWT secret: generated once, kept next to the database.
const secretFile = join(d.DATA_DIR, 'secret.key');
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(48).toString('hex'), { mode: 0o600 });
const SECRET = readFileSync(secretFile, 'utf8');

const COLORS = ['#e07a5f', '#3d9a8b', '#d9a441', '#7a6fd1', '#c75d8a', '#5b8fd9', '#6aa84f', '#c9683a'];
// Extensions served as-is. Anything else is stored as .bin and always downloaded.
const SAFE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.mp3', '.ogg', '.wav', '.pdf', '.txt', '.zip']);

const app = Fastify({ bodyLimit: 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: MAX_UPLOAD, files: 1 } });
await app.register(fastifyStatic, {
  root: d.UPLOAD_DIR,
  prefix: '/uploads/',
  setHeaders(res, path) {
    // dependendo da versão do @fastify/static, `res` é a resposta do Node ou a do Fastify
    const set = (k, v) => (typeof res.setHeader === 'function' ? res.setHeader(k, v) : res.header(k, v));
    set('X-Content-Type-Options', 'nosniff');
    if (path.endsWith('.bin')) set('Content-Disposition', 'attachment');
  },
});

const webDist = process.env.TAVERNA_WEB || join(here, '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/', decorateReply: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/uploads/')) {
      return reply.type('text/html').send(readFileSync(join(webDist, 'index.html')));
    }
    reply.code(404).send({ error: 'Não encontrado' });
  });
}

const fail = (reply, code, error) => reply.code(code).send({ error });
const sign = (user) => jwt.sign({ uid: user.id }, SECRET, { expiresIn: '30d' });
function userFromToken(token) {
  try {
    return d.getUser(jwt.verify(token, SECRET).uid) || null;
  } catch {
    return null;
  }
}
const auth = async (req, reply) => {
  const h = req.headers.authorization || '';
  req.user = h.startsWith('Bearer ') ? userFromToken(h.slice(7)) : null;
  if (!req.user) return fail(reply, 401, 'Sessão inválida');
};
const cleanName = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

// ---------- contas ----------
app.post('/api/register', async (req, reply) => {
  const username = cleanName(req.body?.username, 24);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[\p{L}\p{N}_.-]{3,24}$/u.test(username)) return fail(reply, 400, 'Nome: 3 a 24 letras, números, _ . -');
  if (password.length < 6 || password.length > 200) return fail(reply, 400, 'Senha: mínimo 6 caracteres');
  if (d.getUserByName(username)) return fail(reply, 409, 'Esse nome já existe');
  const user = d.createUser(username, await bcrypt.hash(password, 10), COLORS[Math.floor(Math.random() * COLORS.length)]);
  return { token: sign(user), user: d.publicUser(user) };
});

app.post('/api/login', async (req, reply) => {
  const user = d.getUserByName(cleanName(req.body?.username, 24));
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!user || !(await bcrypt.compare(password, user.pass_hash))) return fail(reply, 401, 'Nome ou senha incorretos');
  return { token: sign(user), user: d.publicUser(user) };
});

app.get('/api/me', { preHandler: auth }, async (req) => ({
  user: { ...d.publicUser(req.user), bio: req.user.bio ?? null },
  guilds: d.guildsOf(req.user.id),
  dms: d.dmsOf(req.user.id),
}));

// ---------- perfil ----------
app.patch('/api/me', { preHandler: auth }, async (req, reply) => {
  const b = req.body || {};
  const patch = {};
  if ('displayName' in b) patch.display_name = cleanName(b.displayName, 32) || null;
  if ('status' in b) patch.status = cleanName(b.status, 80) || null;
  if ('bio' in b) patch.bio = cleanName(b.bio, 300) || null;
  if ('color' in b) {
    if (typeof b.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(b.color)) return fail(reply, 400, 'Cor inválida');
    patch.color = b.color.toLowerCase();
  }
  if ('avatar' in b) {
    const ok = b.avatar === null || (typeof b.avatar === 'string' && /^\/uploads\/[a-f0-9]{24}\.(png|jpe?g|gif|webp)$/.test(b.avatar));
    if (!ok) return fail(reply, 400, 'Foto inválida: use PNG, JPG, GIF ou WebP');
    patch.avatar = b.avatar;
  }
  const user = d.updateUser(req.user.id, patch);
  const pub = d.publicUser(user);
  // sockets abertos guardam uma cópia do usuário (mensagens, sala de voz): atualiza no lugar
  for (const sid of online.get(user.id) || []) {
    const s = io.sockets.sockets.get(sid);
    if (s) Object.assign(s.data.user, pub);
  }
  io.emit('user:update', pub);
  return { ...pub, bio: user.bio ?? null };
});

app.get('/api/users/:id', { preHandler: auth }, async (req, reply) => {
  const user = d.getUser(Number(req.params.id));
  if (!user) return fail(reply, 404, 'Usuário não encontrado');
  return { ...d.publicUser(user), bio: user.bio ?? null };
});

// ---------- servidores e canais ----------
app.post('/api/guilds', { preHandler: auth }, async (req, reply) => {
  const name = cleanName(req.body?.name, 40);
  if (!name) return fail(reply, 400, 'Dê um nome ao servidor');
  const id = d.createGuild(name, req.user.id, randomBytes(5).toString('hex'));
  joinGuildRooms(req.user.id, id);
  return d.guildsOf(req.user.id).find((g) => g.id === id);
});

app.post('/api/invites/:code/join', { preHandler: auth }, async (req, reply) => {
  const guild = d.getGuildByInvite(String(req.params.code).trim());
  if (!guild) return fail(reply, 404, 'Convite inválido');
  const already = d.isMember(guild.id, req.user.id);
  d.addMember(guild.id, req.user.id);
  joinGuildRooms(req.user.id, guild.id);
  if (!already) io.to(`guild:${guild.id}`).emit('member:join', { guildId: guild.id, user: d.publicUser(req.user) });
  return d.guildsOf(req.user.id).find((g) => g.id === guild.id);
});

app.post('/api/guilds/:id/channels', { preHandler: auth }, async (req, reply) => {
  const guild = d.getGuild(Number(req.params.id));
  if (!guild || !d.isMember(guild.id, req.user.id)) return fail(reply, 404, 'Servidor não encontrado');
  if (guild.owner_id !== req.user.id) return fail(reply, 403, 'Só o dono cria canais');
  const name = cleanName(req.body?.name, 32);
  const type = req.body?.type === 'voice' ? 'voice' : 'text';
  if (!name) return fail(reply, 400, 'Dê um nome ao canal');
  const channel = d.createChannel(guild.id, name, type);
  io.to(`guild:${guild.id}`).emit('channel:new', { guildId: guild.id, channel });
  return channel;
});

app.get('/api/guilds/:id/members', { preHandler: auth }, async (req, reply) => {
  const id = Number(req.params.id);
  if (!d.isMember(id, req.user.id)) return fail(reply, 404, 'Servidor não encontrado');
  return d.membersOf(id);
});

// ---------- mensagens ----------
app.get('/api/channels/:id/messages', { preHandler: auth }, async (req, reply) => {
  const ch = d.accessibleChannel(req.user.id, Number(req.params.id));
  if (!ch) return fail(reply, 404, 'Canal não encontrado');
  const before = Number(req.query.before) || null;
  return d.listMessages(ch.id, before);
});

app.post('/api/dms', { preHandler: auth }, async (req, reply) => {
  const other = d.getUserByName(cleanName(req.body?.username, 24));
  if (!other) return fail(reply, 404, 'Usuário não encontrado');
  if (other.id === req.user.id) return fail(reply, 400, 'Não dá pra conversar consigo mesmo');
  const { id, created } = d.findOrCreateDm(req.user.id, other.id);
  if (created) io.to(`user:${other.id}`).emit('dm:new', { id, user: d.publicUser(req.user) });
  return { id, user: d.publicUser(other) };
});

app.post('/api/upload', { preHandler: auth }, async (req, reply) => {
  const file = await req.file();
  if (!file) return fail(reply, 400, 'Nenhum arquivo');
  const ext = extname(file.filename || '').toLowerCase();
  const stored = randomBytes(12).toString('hex') + (SAFE_EXT.has(ext) ? ext : '.bin');
  await pipeline(file.file, createWriteStream(join(d.UPLOAD_DIR, stored)));
  if (file.file.truncated) return fail(reply, 413, 'Arquivo acima de 25 MB');
  return {
    url: `/uploads/${stored}`,
    name: String(file.filename || 'arquivo').slice(0, 120),
    mime: SAFE_EXT.has(ext) ? String(file.mimetype || '') : 'application/octet-stream',
    size: file.file.bytesRead,
  };
});

// ---------- tempo real ----------
const io = new Server(app.server, { maxHttpBufferSize: 1e6 });
const online = new Map(); // userId -> Set<socketId>
const voice = new Map(); // channelId -> Map<socketId, { user, muted, video, screen }>

function joinGuildRooms(userId, guildId) {
  for (const sid of online.get(userId) || []) io.sockets.sockets.get(sid)?.join(`guild:${guildId}`);
}
/** Send an event to everyone who can see the channel. */
function emitToChannel(ch, event, payload) {
  if (ch.type === 'dm') for (const uid of d.dmMembers(ch.id)) io.to(`user:${uid}`).emit(event, payload);
  else io.to(`guild:${ch.guild_id}`).emit(event, payload);
}
function voiceList(channelId) {
  return [...(voice.get(channelId) || [])].map(([socketId, p]) => ({ socketId, ...p }));
}
function leaveVoice(socket) {
  const channelId = socket.data.voiceChannel;
  if (!channelId) return;
  socket.data.voiceChannel = null;
  const room = voice.get(channelId);
  room?.delete(socket.id);
  if (room && room.size === 0) voice.delete(channelId);
  socket.leave(`voice:${channelId}`);
  io.to(`voice:${channelId}`).emit('voice:peer-left', { socketId: socket.id });
  const ch = d.getChannel(channelId);
  if (ch) emitToChannel(ch, 'voice:occupancy', { channelId, peers: voiceList(channelId) });
}

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = d.publicUser(user);
  next();
});

io.on('connection', (socket) => {
  const me = socket.data.user;
  socket.join(`user:${me.id}`);
  for (const g of d.guildsOf(me.id)) socket.join(`guild:${g.id}`);

  if (!online.has(me.id)) online.set(me.id, new Set());
  online.get(me.id).add(socket.id);
  if (online.get(me.id).size === 1) io.emit('presence', { userId: me.id, online: true });

  const occupancy = {};
  for (const channelId of voice.keys()) {
    if (d.accessibleChannel(me.id, channelId)) occupancy[channelId] = voiceList(channelId);
  }
  socket.emit('ready', { online: [...online.keys()], occupancy });

  socket.on('message:send', ({ channelId, content, attachment } = {}, ack) => {
    const ch = d.accessibleChannel(me.id, Number(channelId));
    if (!ch || ch.type === 'voice') return ack?.({ error: 'Canal inválido' });
    const text = typeof content === 'string' ? content.trim().slice(0, MAX_MESSAGE) : '';
    const att = attachment && typeof attachment.url === 'string' && /^\/uploads\/[a-f0-9]{24}\.[a-z0-9]+$/.test(attachment.url)
      ? { url: attachment.url, name: String(attachment.name || 'arquivo').slice(0, 120), mime: String(attachment.mime || ''), size: Number(attachment.size) || 0 }
      : null;
    if (!text && !att) return ack?.({ error: 'Mensagem vazia' });
    const msg = d.createMessage(ch.id, me.id, text, att);
    emitToChannel(ch, 'message:new', msg);
    ack?.({ ok: true });
  });

  socket.on('message:edit', ({ id, content } = {}) => {
    const msg = d.getMessage(Number(id));
    const text = typeof content === 'string' ? content.trim().slice(0, MAX_MESSAGE) : '';
    if (!msg || msg.author.id !== me.id || !text) return;
    const ch = d.accessibleChannel(me.id, msg.channelId);
    if (ch) emitToChannel(ch, 'message:update', d.editMessage(msg.id, text));
  });

  socket.on('message:delete', ({ id } = {}) => {
    const msg = d.getMessage(Number(id));
    if (!msg) return;
    const ch = d.accessibleChannel(me.id, msg.channelId);
    if (!ch) return;
    const isOwner = ch.guild_id && d.getGuild(ch.guild_id)?.owner_id === me.id;
    if (msg.author.id !== me.id && !isOwner) return;
    d.deleteMessage(msg.id);
    emitToChannel(ch, 'message:delete', { id: msg.id, channelId: msg.channelId });
  });

  socket.on('reaction:toggle', ({ messageId, emoji } = {}) => {
    const msg = d.getMessage(Number(messageId));
    if (!msg || typeof emoji !== 'string' || !emoji || emoji.length > 16) return;
    const ch = d.accessibleChannel(me.id, msg.channelId);
    if (!ch) return;
    const reactions = d.toggleReaction(msg.id, me.id, emoji);
    emitToChannel(ch, 'reaction:update', { messageId: msg.id, channelId: msg.channelId, reactions });
  });

  socket.on('typing', ({ channelId } = {}) => {
    const ch = d.accessibleChannel(me.id, Number(channelId));
    if (ch) emitToChannel(ch, 'typing', { channelId: ch.id, user: me });
  });

  // ---- voz / vídeo / tela: o servidor só repassa a sinalização WebRTC ----
  socket.on('voice:join', ({ channelId } = {}, ack) => {
    const ch = d.accessibleChannel(me.id, Number(channelId));
    if (!ch || ch.type === 'text') return ack?.({ error: 'Canal inválido' });
    leaveVoice(socket);
    const peers = voiceList(ch.id);
    if (!voice.has(ch.id)) voice.set(ch.id, new Map());
    const state = { user: me, muted: false, deaf: false, video: false, screen: false };
    voice.get(ch.id).set(socket.id, state);
    socket.data.voiceChannel = ch.id;
    socket.to(`voice:${ch.id}`).emit('voice:peer-joined', { socketId: socket.id, ...state });
    socket.join(`voice:${ch.id}`);
    emitToChannel(ch, 'voice:occupancy', { channelId: ch.id, peers: voiceList(ch.id) });
    ack?.({ peers });
  });

  socket.on('voice:leave', () => leaveVoice(socket));

  socket.on('voice:signal', ({ to, data } = {}) => {
    const room = voice.get(socket.data.voiceChannel);
    if (!room || typeof to !== 'string' || !room.has(to)) return;
    io.to(to).emit('voice:signal', { from: socket.id, data });
  });

  socket.on('voice:state', (patch = {}) => {
    const channelId = socket.data.voiceChannel;
    const state = voice.get(channelId)?.get(socket.id);
    if (!state) return;
    for (const k of ['muted', 'deaf', 'video', 'screen']) if (typeof patch[k] === 'boolean') state[k] = patch[k];
    // ids dos streams, pra quem recebe saber qual faixa é câmera e qual é tela
    for (const k of ['cameraStream', 'screenStream']) {
      if (typeof patch[k] === 'string' || patch[k] === null) state[k] = patch[k]?.slice(0, 80) ?? null;
    }
    io.to(`voice:${channelId}`).emit('voice:state', { socketId: socket.id, ...state });
    const ch = d.getChannel(channelId);
    if (ch) emitToChannel(ch, 'voice:occupancy', { channelId, peers: voiceList(channelId) });
  });

  socket.on('voice:speaking', ({ speaking } = {}) => {
    const channelId = socket.data.voiceChannel;
    if (!channelId || !voice.get(channelId)?.has(socket.id)) return;
    const ch = d.getChannel(channelId);
    if (ch) emitToChannel(ch, 'voice:speaking', { channelId, socketId: socket.id, speaking: speaking === true });
  });

  socket.on('disconnect', () => {
    leaveVoice(socket);
    const set = online.get(me.id);
    set?.delete(socket.id);
    if (set && set.size === 0) {
      online.delete(me.id);
      io.emit('presence', { userId: me.id, online: false });
    }
  });
});

await app.listen({ port: PORT, host: HOST });
console.log(`Taverna no ar: http://localhost:${PORT}`);
