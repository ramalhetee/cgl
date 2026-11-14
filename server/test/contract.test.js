// Teste de contrato do servidor: sobe o servidor de verdade (processo separado, pasta de dados temporária)
// e confere, pela rede, cada rota HTTP e cada evento de socket que a interface usa: formatos, códigos,
// textos de erro e quem recebe cada evento. Não depende da linguagem do servidor: serve para validar
// qualquer reescrita (ex.: servidor em Rust) contra o comportamento atual.
//
// Rodar: npm test -w server            (sobe o servidor de server/src/index.js)
//        CGL_SERVER_CMD="..." npm test -w server   (outro servidor; recebe PORT/HOST/TAVERNA_DATA/TAVERNA_WEB)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COLORS = ['#e07a5f', '#3d9a8b', '#d9a441', '#7a6fd1', '#c75d8a', '#5b8fd9', '#6aa84f', '#c9683a'];
const HEX24 = /^\/uploads\/[a-f0-9]{24}\.[a-z0-9]+$/;

// ---------- infraestrutura ----------
let base;
let proc;
let tmp;
const sockets = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer() {
  tmp = mkdtempSync(join(tmpdir(), 'cgl-contract-'));
  const data = join(tmp, 'data');
  const web = join(tmp, 'web');
  mkdirSync(data);
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>cgl-spa</title>');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', TAVERNA_DATA: data, TAVERNA_WEB: web };
  const cmd = process.env.CGL_SERVER_CMD;
  proc = cmd
    ? spawn(cmd, { shell: true, env, cwd: root })
    : spawn(process.execPath, [join(root, 'server', 'src', 'index.js')], { env, cwd: root });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`servidor não subiu em 15 s:\n${log}`)), 15000);
    const onData = (b) => {
      log += b;
      if (log.includes(`:${port}`)) {
        clearTimeout(t);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (b) => (log += b));
    proc.once('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`servidor saiu (código ${code}):\n${log}`));
    });
  });
  base = `http://127.0.0.1:${port}`;
}

async function http(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // não é JSON
  }
  return { status: res.status, headers: res.headers, data };
}
const get = (path, token) => http('GET', path, { token });
const post = (path, body, token) => http('POST', path, { body, token });

function connect(token) {
  const s = io(base, { auth: { token }, transports: ['websocket'], autoConnect: false, reconnection: false });
  sockets.push(s);
  const ready = new Promise((resolve, reject) => {
    s.once('ready', resolve);
    s.once('connect_error', reject);
  });
  s.connect();
  return { s, ready };
}

/** Espera um evento (registrado já, antes da ação que o dispara). */
function waitFor(s, event, pred = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      s.off(event, h);
      reject(new Error(`não chegou "${event}" em ${ms} ms`));
    }, ms);
    function h(payload) {
      if (!pred(payload)) return;
      clearTimeout(t);
      s.off(event, h);
      resolve(payload);
    }
    s.on(event, h);
  });
}
/** Confere que o evento NÃO chega dentro do prazo. */
function expectNone(s, event, pred = () => true, ms = 400) {
  return new Promise((resolve, reject) => {
    const h = (payload) => {
      if (!pred(payload)) return;
      s.off(event, h);
      clearTimeout(t);
      reject(new Error(`"${event}" não deveria ter chegado: ${JSON.stringify(payload)}`));
    };
    const t = setTimeout(() => {
      s.off(event, h);
      resolve();
    }, ms);
    s.on(event, h);
  });
}
const ack = (s, event, payload) => s.timeout(3000).emitWithAck(event, payload);

function assertPublicUser(u, expected) {
  assert.deepEqual(Object.keys(u).sort(), ['avatar', 'color', 'displayName', 'id', 'status', 'username']);
  for (const [k, v] of Object.entries(expected)) assert.equal(u[k], v, `user.${k}`);
}
function assertMessage(m) {
  assert.deepEqual(Object.keys(m).sort(), ['attachment', 'author', 'channelId', 'content', 'createdAt', 'editedAt', 'id', 'reactions']);
  assert.equal(typeof m.id, 'number');
  assert.equal(typeof m.createdAt, 'number');
  assert.ok(Array.isArray(m.reactions));
}

// ---------- estado compartilhado entre os testes (rodam em ordem) ----------
const ana = { name: 'ana', pass: 'senha-ana-1' };
const bia = { name: 'bia', pass: 'senha-bia-1' };
const caio = { name: 'caio', pass: 'senha-caio-1' };
let guild;
let text; // canal de texto da guild
let vc; // canal de voz da guild
let dm; // DM ana↔caio

before(async () => {
  await startServer();
});
after(async () => {
  for (const s of sockets) s.close();
  proc?.kill();
  await new Promise((r) => (proc?.exitCode !== null ? r() : proc.once('exit', r)));
  rmSync(tmp, { recursive: true, force: true });
});

describe('contas', () => {
  test('cadastro valida nome e senha', async () => {
    let r = await post('/api/register', { username: 'a b', password: 'senha-123' });
    assert.equal(r.status, 400);
    assert.deepEqual(r.data, { error: 'Nome: 3 a 24 letras, números, _ . -' });
    r = await post('/api/register', { username: 'ab', password: 'senha-123' });
    assert.equal(r.status, 400);
    // nome longo não é recusado: é cortado em 24 caracteres
    r = await post('/api/register', { username: 'x'.repeat(30), password: 'senha-123' });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.username, 'x'.repeat(24));
  });

  test('cadastro valida tamanho da senha', async () => {
    let r = await post('/api/register', { username: 'zeca', password: '12345' });
    assert.equal(r.status, 400);
    assert.deepEqual(r.data, { error: 'Senha: mínimo 6 caracteres' });
    r = await post('/api/register', { username: 'zeca', password: 'x'.repeat(201) });
    assert.equal(r.status, 400);
    r = await post('/api/register', { username: 'zeca', password: 123456 });
    assert.equal(r.status, 400);
  });

  test('cadastro devolve token e usuário público', async () => {
    for (const u of [ana, bia, caio]) {
      const r = await post('/api/register', { username: u.name, password: u.pass });
      assert.equal(r.status, 200);
      assert.equal(typeof r.data.token, 'string');
      assertPublicUser(r.data.user, { username: u.name, displayName: null, avatar: null, status: null });
      assert.ok(COLORS.includes(r.data.user.color));
      u.token = r.data.token;
      u.id = r.data.user.id;
    }
  });

  test('nome repetido (sem diferenciar maiúsculas) é recusado', async () => {
    const r = await post('/api/register', { username: 'ANA', password: 'outra-senha' });
    assert.equal(r.status, 409);
    assert.deepEqual(r.data, { error: 'Esse nome já existe' });
  });

  test('login', async () => {
    let r = await post('/api/login', { username: 'ana', password: 'errada' });
    assert.equal(r.status, 401);
    assert.deepEqual(r.data, { error: 'Nome ou senha incorretos' });
    r = await post('/api/login', { username: 'ninguem', password: 'x' });
    assert.equal(r.status, 401);
    assert.deepEqual(r.data, { error: 'Nome ou senha incorretos' });
    r = await post('/api/login', { username: '  ANA ', password: ana.pass });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.id, ana.id);
    assert.equal(typeof r.data.token, 'string');
  });

  test('rotas protegidas exigem token válido', async () => {
    for (const token of [undefined, 'lixo']) {
      const r = await get('/api/me', token);
      assert.equal(r.status, 401);
      assert.deepEqual(r.data, { error: 'Sessão inválida' });
    }
    const r = await http('GET', '/api/me', { token: undefined });
    assert.equal(r.status, 401);
  });

  test('GET /api/me', async () => {
    const r = await get('/api/me', ana.token);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.data).sort(), ['dms', 'guilds', 'settings', 'user']);
    assert.equal(r.data.user.bio, null);
    assert.deepEqual(r.data.settings, {});
    assert.deepEqual(r.data.guilds, []);
    assert.deepEqual(r.data.dms, []);
  });

  test('GET /api/users/:id', async () => {
    let r = await get(`/api/users/${bia.id}`, ana.token);
    assert.equal(r.status, 200);
    assert.equal(r.data.username, 'bia');
    assert.equal(r.data.bio, null);
    r = await get('/api/users/99999', ana.token);
    assert.equal(r.status, 404);
    assert.deepEqual(r.data, { error: 'Usuário não encontrado' });
  });
});

describe('preferências (PUT /api/me/settings)', () => {
  test('limpa e normaliza cada campo', async () => {
    const r = await http('PUT', '/api/me/settings', {
      token: ana.token,
      body: {
        input: { id: 'mic1', label: 'Microfone' },
        output: { id: 5 },
        sounds: { enabled: false, volume: 150 },
        hotkeys: { mute: 'Ctrl+M', deafen: 'tecla ruim' },
        theme: { preset: 'inexistente', accent: '#AABBCC' },
        volumes: { 12: { voice: 250, screen: -5, x: 1 }, abc: { voice: 1 }, 13: {} },
        lixo: 1,
      },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, {
      input: { id: 'mic1', label: 'Microfone' },
      output: null,
      sounds: { enabled: false, volume: 100 },
      hotkeys: { mute: 'Ctrl+M' },
      theme: { preset: 'taverna', accent: '#aabbcc' },
      volumes: { 12: { voice: 200, screen: 0 } },
    });
  });

  test('mescla com o que já estava salvo e aparece no /me', async () => {
    let r = await http('PUT', '/api/me/settings', {
      token: ana.token,
      body: { sounds: { volume: 'abc' }, hotkeys: { mute: '', deafen: 'Ctrl+Shift+=' }, theme: { preset: 'claro', accent: 'azul' } },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.sounds, { enabled: true, volume: 0 });
    assert.deepEqual(r.data.hotkeys, { mute: '', deafen: 'Ctrl+Shift+=' });
    assert.deepEqual(r.data.theme, { preset: 'claro', accent: null });
    assert.deepEqual(r.data.input, { id: 'mic1', label: 'Microfone' });
    r = await get('/api/me', ana.token);
    assert.deepEqual(r.data.settings.theme, { preset: 'claro', accent: null });
  });

  test('filtro de ruído: só os modos conhecidos', async () => {
    for (const mode of ['off', 'browser', 'rnnoise']) {
      const r = await http('PUT', '/api/me/settings', { token: bia.token, body: { noise: mode } });
      assert.equal(r.status, 200);
      assert.equal(r.data.noise, mode);
    }
    for (const bad of ['krisp', null, 1]) {
      const r = await http('PUT', '/api/me/settings', { token: bia.token, body: { noise: bad } });
      assert.equal(r.data.noise, 'browser', `inválido (${bad}) volta ao padrão`);
    }
  });

  test('volumes inválidos', async () => {
    const r = await http('PUT', '/api/me/settings', { token: ana.token, body: { volumes: null } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.data, { error: 'Volumes inválidos' });
  });
});

describe('tempo real: conexão e presença', () => {
  test('token inválido é recusado', async () => {
    const { ready } = connect('lixo');
    await assert.rejects(ready, (e) => e.message === 'unauthorized');
  });

  test('ready e presença', async () => {
    const a = connect(ana.token);
    const r = await a.ready;
    ana.s = a.s;
    assert.deepEqual(r, { online: [ana.id], occupancy: {} });

    const online = waitFor(ana.s, 'presence', (p) => p.userId === bia.id);
    const b = connect(bia.token);
    bia.s = b.s;
    const rb = await b.ready;
    assert.deepEqual(rb.online.sort(), [ana.id, bia.id].sort());
    assert.deepEqual(await online, { userId: bia.id, online: true });

    const c = connect(caio.token);
    caio.s = c.s;
    await c.ready;
  });

  test('segunda conexão da mesma pessoa não repete presença', async () => {
    const none = expectNone(ana.s, 'presence', (p) => p.userId === bia.id);
    const b2 = connect(bia.token);
    await b2.ready;
    b2.s.close();
    await none;
  });
});

describe('perfil (PATCH /api/me)', () => {
  test('valida cor e foto', async () => {
    let r = await http('PATCH', '/api/me', { token: ana.token, body: { color: 'vermelho' } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.data, { error: 'Cor inválida' });
    r = await http('PATCH', '/api/me', { token: ana.token, body: { avatar: '/uploads/x.exe' } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.data, { error: 'Foto inválida: use PNG, JPG, GIF ou WebP' });
  });

  test('atualiza, corta textos e avisa todo mundo', async () => {
    const avatar = `/uploads/${'a'.repeat(24)}.png`;
    const update = waitFor(bia.s, 'user:update', (u) => u.id === ana.id);
    const r = await http('PATCH', '/api/me', {
      token: ana.token,
      body: { displayName: '  Ana Maria  ', status: 's'.repeat(100), bio: 'oi', color: '#ABCDEF', avatar },
    });
    assert.equal(r.status, 200);
    const expected = { id: ana.id, username: 'ana', color: '#abcdef', displayName: 'Ana Maria', avatar, status: 's'.repeat(80) };
    assert.deepEqual(r.data, { ...expected, bio: 'oi' });
    assert.deepEqual(await update, expected);
    ana.pub = expected;
  });

  test('texto vazio limpa o campo', async () => {
    const r = await http('PATCH', '/api/me', { token: caio.token, body: { displayName: '   ', avatar: null } });
    assert.equal(r.status, 200);
    assert.equal(r.data.displayName, null);
    assert.equal(r.data.avatar, null);
    caio.pub = { id: caio.id, username: 'caio', color: r.data.color, displayName: null, avatar: null, status: null };
  });
});

describe('servidores, canais e membros', () => {
  test('criar servidor', async () => {
    let r = await post('/api/guilds', { name: '   ' }, ana.token);
    assert.equal(r.status, 400);
    assert.deepEqual(r.data, { error: 'Dê um nome ao servidor' });
    r = await post('/api/guilds', { name: '  Taverna  ' }, ana.token);
    assert.equal(r.status, 200);
    guild = r.data;
    assert.deepEqual(Object.keys(guild).sort(), ['channels', 'id', 'inviteCode', 'name', 'ownerId']);
    assert.equal(guild.name, 'Taverna');
    assert.equal(guild.ownerId, ana.id);
    assert.match(guild.inviteCode, /^[a-f0-9]{10}$/);
    assert.deepEqual(guild.channels.map(({ name, type }) => ({ name, type })), [
      { name: 'geral', type: 'text' },
      { name: 'Sala de voz', type: 'voice' },
    ]);
    [text, vc] = guild.channels;
  });

  test('entrar por convite avisa os membros (só na primeira vez)', async () => {
    let r = await post('/api/invites/naoexiste/join', {}, bia.token);
    assert.equal(r.status, 404);
    assert.deepEqual(r.data, { error: 'Convite inválido' });

    const joined = waitFor(ana.s, 'member:join');
    r = await post(`/api/invites/${guild.inviteCode}/join`, {}, bia.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, guild);
    const ev = await joined;
    assert.equal(ev.guildId, guild.id);
    assertPublicUser(ev.user, { id: bia.id, username: 'bia' });

    const none = expectNone(ana.s, 'member:join');
    r = await post(`/api/invites/  ${guild.inviteCode}  /join`, {}, bia.token);
    assert.equal(r.status, 200);
    await none;
  });

  test('criar canal: só membro, só dono, nome obrigatório; avisa os membros conectados', async () => {
    let r = await post(`/api/guilds/${guild.id}/channels`, { name: 'x' }, caio.token);
    assert.equal(r.status, 404);
    assert.deepEqual(r.data, { error: 'Servidor não encontrado' });
    r = await post('/api/guilds/99999/channels', { name: 'x' }, ana.token);
    assert.equal(r.status, 404);
    r = await post(`/api/guilds/${guild.id}/channels`, { name: 'x' }, bia.token);
    assert.equal(r.status, 403);
    assert.deepEqual(r.data, { error: 'Só o dono cria canais' });
    r = await post(`/api/guilds/${guild.id}/channels`, { name: ' ' }, ana.token);
    assert.equal(r.status, 400);
    assert.deepEqual(r.data, { error: 'Dê um nome ao canal' });

    // bia já estava conectada antes de entrar: o socket dela precisa ter entrado na sala da guild
    const created = waitFor(bia.s, 'channel:new');
    r = await post(`/api/guilds/${guild.id}/channels`, { name: 'jogos', type: 'esquisito' }, ana.token);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.data).sort(), ['id', 'name', 'type']);
    assert.equal(r.data.type, 'text');
    assert.deepEqual(await created, { guildId: guild.id, channel: r.data });

    r = await post(`/api/guilds/${guild.id}/channels`, { name: 'v'.repeat(40), type: 'voice' }, ana.token);
    assert.equal(r.data.type, 'voice');
    assert.equal(r.data.name, 'v'.repeat(32));
  });

  test('membros', async () => {
    let r = await get(`/api/guilds/${guild.id}/members`, caio.token);
    assert.equal(r.status, 404);
    assert.deepEqual(r.data, { error: 'Servidor não encontrado' });
    r = await get(`/api/guilds/${guild.id}/members`, bia.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.map((u) => u.username), ['ana', 'bia']);
    assertPublicUser(r.data[0], ana.pub);
  });

  test('/me lista os servidores', async () => {
    const r = await get('/api/me', bia.token);
    assert.equal(r.data.guilds.length, 1);
    assert.equal(r.data.guilds[0].channels.length, 4);
  });
});

describe('mensagens', () => {
  let first;

  test('enviar: canal inválido, canal de voz, mensagem vazia', async () => {
    assert.deepEqual(await ack(ana.s, 'message:send', { channelId: 99999, content: 'x' }), { error: 'Canal inválido' });
    assert.deepEqual(await ack(caio.s, 'message:send', { channelId: text.id, content: 'x' }), { error: 'Canal inválido' });
    assert.deepEqual(await ack(ana.s, 'message:send', { channelId: vc.id, content: 'x' }), { error: 'Canal inválido' });
    assert.deepEqual(await ack(ana.s, 'message:send', { channelId: text.id, content: '   ' }), { error: 'Mensagem vazia' });
    assert.deepEqual(
      await ack(ana.s, 'message:send', { channelId: text.id, content: '', attachment: { url: '/uploads/../segredo' } }),
      { error: 'Mensagem vazia' },
    );
  });

  test('enviar chega para os membros com o nome novo do perfil', async () => {
    const atBia = waitFor(bia.s, 'message:new');
    const atAna = waitFor(ana.s, 'message:new');
    const none = expectNone(caio.s, 'message:new');
    assert.deepEqual(await ack(ana.s, 'message:send', { channelId: String(text.id), content: `  ${'x'.repeat(5000)}  ` }), { ok: true });
    const m = await atBia;
    assertMessage(m);
    assert.deepEqual(await atAna, m);
    assert.equal(m.channelId, text.id);
    assert.equal(m.content, 'x'.repeat(4000));
    assert.equal(m.attachment, null);
    assert.equal(m.editedAt, null);
    assert.deepEqual(m.reactions, []);
    // o socket da ana conectou antes do PATCH: o autor precisa sair com o perfil atualizado
    assert.deepEqual(m.author, ana.pub);
    await none;
    first = m;
  });

  test('anexo é limpo', async () => {
    const atBia = waitFor(bia.s, 'message:new');
    const url = `/uploads/${'b'.repeat(24)}.png`;
    await ack(bia.s, 'message:send', { channelId: text.id, attachment: { url, name: 'n'.repeat(200), mime: 'image/png', size: '12', extra: 1 } });
    const m = await atBia;
    assert.equal(m.content, '');
    assert.deepEqual(m.attachment, { url, name: 'n'.repeat(120), mime: 'image/png', size: 12 });
  });

  test('editar: só o autor, texto não vazio', async () => {
    const none = expectNone(ana.s, 'message:update');
    bia.s.emit('message:edit', { id: first.id, content: 'invadido' });
    ana.s.emit('message:edit', { id: first.id, content: '   ' });
    await none;
    const upd = waitFor(bia.s, 'message:update');
    ana.s.emit('message:edit', { id: first.id, content: ' editada ' });
    const m = await upd;
    assertMessage(m);
    assert.equal(m.id, first.id);
    assert.equal(m.content, 'editada');
    assert.equal(typeof m.editedAt, 'number');
  });

  test('reações alternam', async () => {
    const none = expectNone(ana.s, 'reaction:update');
    bia.s.emit('reaction:toggle', { messageId: first.id, emoji: 'x'.repeat(17) });
    bia.s.emit('reaction:toggle', { messageId: first.id, emoji: '' });
    caio.s.emit('reaction:toggle', { messageId: first.id, emoji: '🎉' });
    await none;

    let upd = waitFor(ana.s, 'reaction:update');
    bia.s.emit('reaction:toggle', { messageId: first.id, emoji: '🎉' });
    assert.deepEqual(await upd, { messageId: first.id, channelId: text.id, reactions: [{ emoji: '🎉', userIds: [bia.id] }] });
    upd = waitFor(ana.s, 'reaction:update');
    bia.s.emit('reaction:toggle', { messageId: first.id, emoji: '🎉' });
    assert.deepEqual(await upd, { messageId: first.id, channelId: text.id, reactions: [] });
  });

  test('digitando', async () => {
    const t = waitFor(bia.s, 'typing');
    const none = expectNone(caio.s, 'typing');
    ana.s.emit('typing', { channelId: text.id });
    assert.deepEqual(await t, { channelId: text.id, user: ana.pub });
    await none;
  });

  test('histórico com paginação', async () => {
    let r = await get(`/api/channels/${text.id}/messages`, caio.token);
    assert.equal(r.status, 404);
    assert.deepEqual(r.data, { error: 'Canal não encontrado' });

    const flood = (await post(`/api/guilds/${guild.id}/channels`, { name: 'flood' }, ana.token)).data;
    const ids = [];
    for (let i = 0; i < 52; i++) {
      const got = waitFor(ana.s, 'message:new', (m) => m.content === `m${i}`);
      await ack(ana.s, 'message:send', { channelId: flood.id, content: `m${i}` });
      ids.push((await got).id);
    }
    r = await get(`/api/channels/${flood.id}/messages`, bia.token);
    assert.equal(r.status, 200);
    assert.equal(r.data.length, 50);
    assert.deepEqual(r.data.map((m) => m.content), Array.from({ length: 50 }, (_, i) => `m${i + 2}`));
    assertMessage(r.data[0]);
    r = await get(`/api/channels/${flood.id}/messages?before=${ids[2]}`, bia.token);
    assert.deepEqual(r.data.map((m) => m.content), ['m0', 'm1']);
  });

  test('apagar: autor ou dono do servidor', async () => {
    const own = waitFor(bia.s, 'message:new', (m) => m.content === 'da ana');
    await ack(ana.s, 'message:send', { channelId: text.id, content: 'da ana' });
    const anaMsg = await own;
    const other = waitFor(ana.s, 'message:new', (m) => m.content === 'da bia');
    await ack(bia.s, 'message:send', { channelId: text.id, content: 'da bia' });
    const biaMsg = await other;

    const none = expectNone(ana.s, 'message:delete');
    bia.s.emit('message:delete', { id: anaMsg.id }); // não é autora nem dona
    caio.s.emit('message:delete', { id: biaMsg.id }); // nem membro é
    await none;

    let del = waitFor(bia.s, 'message:delete');
    ana.s.emit('message:delete', { id: biaMsg.id }); // dona apaga a dos outros
    assert.deepEqual(await del, { id: biaMsg.id, channelId: text.id });
    del = waitFor(ana.s, 'message:delete');
    bia.s.emit('message:delete', { id: first.id + 1 }); // a própria (anexo)
    assert.deepEqual(await del, { id: first.id + 1, channelId: text.id });
  });
});

describe('conversas diretas', () => {
  test('abrir: validações', async () => {
    let r = await post('/api/dms', { username: 'ninguem' }, ana.token);
    assert.equal(r.status, 404);
    assert.deepEqual(r.data, { error: 'Usuário não encontrado' });
    r = await post('/api/dms', { username: 'ana' }, ana.token);
    assert.equal(r.status, 400);
    assert.deepEqual(r.data, { error: 'Não dá pra conversar consigo mesmo' });
  });

  test('abrir avisa o outro só na criação', async () => {
    const created = waitFor(caio.s, 'dm:new');
    let r = await post('/api/dms', { username: ' CAIO ' }, ana.token);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.data).sort(), ['id', 'user']);
    assert.deepEqual(r.data.user, caio.pub);
    dm = r.data.id;
    assert.deepEqual(await created, { id: dm, user: ana.pub });

    const none = expectNone(ana.s, 'dm:new');
    r = await post('/api/dms', { username: 'ana' }, caio.token);
    assert.deepEqual(r.data, { id: dm, user: ana.pub });
    await none;

    r = await get('/api/me', caio.token);
    assert.deepEqual(r.data.dms, [{ id: dm, user: ana.pub }]);
  });

  test('mensagem na DM só chega aos dois', async () => {
    const atCaio = waitFor(caio.s, 'message:new');
    const none = expectNone(bia.s, 'message:new');
    assert.deepEqual(await ack(ana.s, 'message:send', { channelId: dm, content: 'oi caio' }), { ok: true });
    assert.equal((await atCaio).channelId, dm);
    await none;
    assert.deepEqual(await ack(bia.s, 'message:send', { channelId: dm, content: 'x' }), { error: 'Canal inválido' });
    const r = await get(`/api/channels/${dm}/messages`, bia.token);
    assert.equal(r.status, 404);
    assert.equal((await get(`/api/channels/${dm}/messages`, caio.token)).data.length, 1);
  });
});

describe('anexos (POST /api/upload)', () => {
  const upload = (blob, filename, token = ana.token) => {
    const form = new FormData();
    if (blob) form.append('file', blob, filename);
    else form.append('campo', 'sem arquivo');
    return http('POST', '/api/upload', { token, form });
  };

  test('exige sessão', async () => {
    const r = await upload(new Blob(['x']), 'a.txt', 'lixo');
    assert.equal(r.status, 401);
  });

  test('formulário sem arquivo', async () => {
    const r = await upload(null);
    assert.equal(r.status, 400);
    assert.deepEqual(r.data, { error: 'Nenhum arquivo' });
  });

  test('extensão segura é servida como está', async () => {
    const r = await upload(new Blob([Buffer.from('89504e47', 'hex')], { type: 'image/png' }), 'Foto.PNG');
    assert.equal(r.status, 200);
    assert.match(r.data.url, HEX24);
    assert.ok(r.data.url.endsWith('.png'));
    assert.deepEqual({ ...r.data, url: 'x' }, { url: 'x', name: 'Foto.PNG', mime: 'image/png', size: 4 });
    const f = await fetch(base + r.data.url);
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(f.headers.get('content-disposition'), null);
  });

  test('outra extensão vira .bin e sempre baixa', async () => {
    const r = await upload(new Blob(['MZ'], { type: 'application/x-msdownload' }), `${'n'.repeat(150)}.exe`);
    assert.equal(r.status, 200);
    assert.ok(r.data.url.endsWith('.bin'));
    assert.equal(r.data.mime, 'application/octet-stream');
    assert.equal(r.data.name, `${'n'.repeat(120)}`);
    const f = await fetch(base + r.data.url);
    assert.equal(f.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(f.headers.get('content-disposition'), 'attachment');
  });

  test('acima de 25 MB', async () => {
    const r = await upload(new Blob([Buffer.alloc(25 * 1024 * 1024 + 1)]), 'grande.zip');
    assert.equal(r.status, 413);
    assert.deepEqual(r.data, { error: 'Arquivo acima de 25 MB' });
  });
});

describe('prévia de links (GET /api/unfurl)', () => {
  test('endereço da rede local não tem prévia', async () => {
    for (const url of ['http://127.0.0.1/', 'http://localhost:3210/', 'http://192.168.0.1/', 'file:///c:/windows', '']) {
      const r = await get(`/api/unfurl?url=${encodeURIComponent(url)}`, caio.token);
      assert.equal(r.status, 404, url);
      assert.deepEqual(r.data, { error: 'Sem prévia' });
    }
  });

  test('limite de 60 por minuto por pessoa', async () => {
    // caio já usou 5 no teste anterior
    for (let i = 5; i < 60; i++) assert.equal((await get('/api/unfurl?url=http://10.0.0.1/', caio.token)).status, 404);
    const r = await get('/api/unfurl?url=http://10.0.0.1/', caio.token);
    assert.equal(r.status, 429);
    assert.deepEqual(r.data, { error: 'Muitas prévias em pouco tempo' });
    assert.equal((await get('/api/unfurl?url=http://10.0.0.1/', bia.token)).status, 404, 'limite é por pessoa');
  });
});

describe('voz (sinalização)', () => {
  const fresh = { muted: false, deaf: false, video: false, screen: false, screenAudio: false };

  test('entrar: canal de texto é recusado', async () => {
    assert.deepEqual(await ack(ana.s, 'voice:join', { channelId: text.id }), { error: 'Canal inválido' });
    assert.deepEqual(await ack(caio.s, 'voice:join', { channelId: vc.id }), { error: 'Canal inválido' });
  });

  test('entrar avisa a sala e a ocupação', async () => {
    const occ = waitFor(bia.s, 'voice:occupancy', (o) => o.channelId === vc.id);
    const noneCaio = expectNone(caio.s, 'voice:occupancy');
    assert.deepEqual(await ack(ana.s, 'voice:join', { channelId: vc.id }), { peers: [] });
    const anaPeer = { socketId: ana.s.id, user: ana.pub, ...fresh };
    assert.deepEqual(await occ, { channelId: vc.id, peers: [anaPeer] });
    await noneCaio;

    const joined = waitFor(ana.s, 'voice:peer-joined');
    const res = await ack(bia.s, 'voice:join', { channelId: vc.id });
    assert.deepEqual(res, { peers: [anaPeer] });
    const ev = await joined;
    assert.equal(ev.socketId, bia.s.id);
    assertPublicUser(ev.user, { id: bia.id });
    assert.deepEqual({ ...ev, user: null }, { socketId: bia.s.id, user: null, ...fresh });
  });

  test('nova conexão recebe a ocupação dos canais que enxerga', async () => {
    const b2 = connect(bia.token);
    const r = await b2.ready;
    assert.deepEqual(Object.keys(r.occupancy), [String(vc.id)]);
    assert.equal(r.occupancy[vc.id].length, 2);
    b2.s.close();
    const c2 = connect(caio.token);
    assert.deepEqual((await c2.ready).occupancy, {});
    c2.s.close();
  });

  test('sinal e "assistindo" só vão para quem está na sala', async () => {
    let sig = waitFor(bia.s, 'voice:signal');
    ana.s.emit('voice:signal', { to: bia.s.id, data: { sdp: 'x' } });
    assert.deepEqual(await sig, { from: ana.s.id, data: { sdp: 'x' } });

    const none = expectNone(caio.s, 'voice:signal');
    ana.s.emit('voice:signal', { to: caio.s.id, data: 1 });
    caio.s.emit('voice:signal', { to: bia.s.id, data: 1 });
    await none;

    let w = waitFor(bia.s, 'voice:watch');
    ana.s.emit('voice:watch', { to: bia.s.id, watching: false });
    assert.deepEqual(await w, { from: ana.s.id, watching: false });
    w = waitFor(bia.s, 'voice:watch');
    ana.s.emit('voice:watch', { to: bia.s.id });
    assert.deepEqual(await w, { from: ana.s.id, watching: true });
  });

  test('estado: só booleanos, ids de stream cortados', async () => {
    const st = waitFor(bia.s, 'voice:state');
    const occ = waitFor(caio.s, 'voice:occupancy', () => true, 400).catch(() => null);
    ana.s.emit('voice:state', { muted: true, video: 'sim', screen: true, cameraStream: 'c'.repeat(100), screenStream: null, outro: 1 });
    assert.deepEqual(await st, {
      socketId: ana.s.id,
      user: ana.pub,
      ...fresh,
      muted: true,
      screen: true,
      cameraStream: 'c'.repeat(80),
      screenStream: null,
    });
    assert.equal(await occ, null, 'quem não é membro não recebe ocupação');
  });

  test('falando', async () => {
    let sp = waitFor(bia.s, 'voice:speaking');
    ana.s.emit('voice:speaking', { speaking: true });
    assert.deepEqual(await sp, { channelId: vc.id, socketId: ana.s.id, speaking: true });
    sp = waitFor(bia.s, 'voice:speaking');
    ana.s.emit('voice:speaking', { speaking: 'sim' });
    assert.deepEqual(await sp, { channelId: vc.id, socketId: ana.s.id, speaking: false });
    const none = expectNone(bia.s, 'voice:speaking');
    caio.s.emit('voice:speaking', { speaking: true }); // fora de sala
    await none;
  });

  test('prévia da transmissão: só de quem transmite, só para quem enxerga o canal', async () => {
    const jpeg = `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`;
    const get = (s, socketId) => ack(s, 'voice:preview:get', { socketId });
    // ana está transmitindo (teste de estado acima); ainda sem prévia enviada
    assert.deepEqual(await get(bia.s, ana.s.id), { data: null });
    ana.s.emit('voice:preview', { data: jpeg });
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(await get(bia.s, ana.s.id), { data: jpeg });
    assert.deepEqual(await get(caio.s, ana.s.id), { data: null }, 'quem não é membro não vê');
    assert.deepEqual(await get(bia.s, 'nao-existe'), { data: null });
    // formato inválido ou grande demais é ignorado (fica a anterior)
    ana.s.emit('voice:preview', { data: 'data:text/html;base64,PHNjcmlwdD4=' });
    ana.s.emit('voice:preview', { data: `data:image/jpeg;base64,${'A'.repeat(400_000)}` });
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(await get(bia.s, ana.s.id), { data: jpeg });
    // quem não transmite não manda prévia
    bia.s.emit('voice:preview', { data: jpeg });
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(await get(ana.s, bia.s.id), { data: null });
    // parou de transmitir: a prévia some
    const st = waitFor(bia.s, 'voice:state', (x) => x.socketId === ana.s.id && x.screen === false);
    ana.s.emit('voice:state', { screen: false });
    await st;
    assert.deepEqual(await get(bia.s, ana.s.id), { data: null });
  });

  test('voz na DM funciona', async () => {
    assert.deepEqual(await ack(caio.s, 'voice:join', { channelId: dm }), { peers: [] });
    caio.s.emit('voice:leave');
  });

  test('sair e desconectar avisam a sala', async () => {
    const left = waitFor(ana.s, 'voice:peer-left');
    const occ = waitFor(ana.s, 'voice:occupancy', (o) => o.channelId === vc.id && o.peers.length === 1);
    bia.s.emit('voice:leave');
    assert.deepEqual(await left, { socketId: bia.s.id });
    await occ;

    const empty = waitFor(bia.s, 'voice:occupancy', (o) => o.channelId === vc.id && o.peers.length === 0);
    const offline = waitFor(bia.s, 'presence', (p) => p.userId === ana.id);
    ana.s.close();
    await empty;
    assert.deepEqual(await offline, { userId: ana.id, online: false });
  });
});

describe('arquivos da interface', () => {
  test('rotas da interface caem no index.html', async () => {
    for (const path of ['/', '/canal/1']) {
      const r = await get(path);
      assert.equal(r.status, 200, path);
      assert.match(String(r.data), /cgl-spa/);
    }
  });

  test('API desconhecida dá 404 em JSON', async () => {
    for (const method of ['GET', 'POST']) {
      const r = await http(method, '/api/nada');
      assert.equal(r.status, 404);
      assert.deepEqual(r.data, { error: 'Não encontrado' });
    }
  });
});
