import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.TAVERNA_DATA || join(here, '..', 'data');
export const UPLOAD_DIR = join(DATA_DIR, 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'taverna.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  invite_code TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS members (
  guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (guild_id, user_id)
);
-- type: 'text' | 'voice' | 'dm'. DMs have guild_id NULL.
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  guild_id INTEGER REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_members (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  attachment TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
`);

// colunas de perfil, adicionadas depois da primeira versão
for (const col of ['display_name TEXT', 'avatar TEXT', 'bio TEXT', 'status TEXT']) {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${col}`);
  } catch {
    // coluna já existe
  }
}

const q = (sql) => db.prepare(sql);

export const publicUser = (u) => u && {
  id: u.id, username: u.username, color: u.color,
  displayName: u.display_name ?? null, avatar: u.avatar ?? null, status: u.status ?? null,
};
const PROFILE_COLUMNS = ['display_name', 'avatar', 'bio', 'status', 'color'];
export function updateUser(id, patch) {
  for (const [col, value] of Object.entries(patch)) {
    if (PROFILE_COLUMNS.includes(col)) q(`UPDATE users SET ${col} = ? WHERE id = ?`).run(value, id);
  }
  return getUser(id);
}

export function getUser(id) {
  return q('SELECT * FROM users WHERE id = ?').get(id);
}
export function getUserByName(name) {
  return q('SELECT * FROM users WHERE username = ?').get(name);
}
export function createUser(username, passHash, color) {
  const r = q('INSERT INTO users (username, pass_hash, color, created_at) VALUES (?,?,?,?)').run(
    username, passHash, color, Date.now());
  return getUser(Number(r.lastInsertRowid));
}

export function guildsOf(userId) {
  const guilds = q(`SELECT g.* FROM guilds g JOIN members m ON m.guild_id = g.id
                    WHERE m.user_id = ? ORDER BY g.id`).all(userId);
  return guilds.map((g) => ({
    id: g.id, name: g.name, ownerId: g.owner_id, inviteCode: g.invite_code,
    channels: q('SELECT id, name, type FROM channels WHERE guild_id = ? ORDER BY id').all(g.id),
  }));
}
export function getGuild(id) {
  return q('SELECT * FROM guilds WHERE id = ?').get(id);
}
export function getGuildByInvite(code) {
  return q('SELECT * FROM guilds WHERE invite_code = ?').get(code);
}
export function isMember(guildId, userId) {
  return !!q('SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
}
export function addMember(guildId, userId) {
  q('INSERT OR IGNORE INTO members (guild_id, user_id) VALUES (?,?)').run(guildId, userId);
}
export function membersOf(guildId) {
  return q(`SELECT u.* FROM users u JOIN members m ON m.user_id = u.id
            WHERE m.guild_id = ? ORDER BY u.username`).all(guildId).map(publicUser);
}
export function createGuild(name, ownerId, inviteCode) {
  const r = q('INSERT INTO guilds (name, owner_id, invite_code) VALUES (?,?,?)').run(name, ownerId, inviteCode);
  const id = Number(r.lastInsertRowid);
  addMember(id, ownerId);
  createChannel(id, 'geral', 'text');
  createChannel(id, 'Sala de voz', 'voice');
  return id;
}
export function createChannel(guildId, name, type) {
  const r = q('INSERT INTO channels (guild_id, name, type) VALUES (?,?,?)').run(guildId, name, type);
  return { id: Number(r.lastInsertRowid), name, type };
}
export function getChannel(id) {
  return q('SELECT * FROM channels WHERE id = ?').get(id);
}

export function dmsOf(userId) {
  return q(`SELECT c.id AS cid, u.*
            FROM channels c
            JOIN dm_members me ON me.channel_id = c.id AND me.user_id = ?
            JOIN dm_members ot ON ot.channel_id = c.id AND ot.user_id != ?
            JOIN users u ON u.id = ot.user_id
            WHERE c.type = 'dm' ORDER BY c.id DESC`).all(userId, userId)
    .map((r) => ({ id: r.cid, user: publicUser(r) }));
}
export function dmMembers(channelId) {
  return q('SELECT user_id FROM dm_members WHERE channel_id = ?').all(channelId).map((r) => r.user_id);
}
export function findOrCreateDm(a, b) {
  const found = q(`SELECT x.channel_id AS id FROM dm_members x JOIN dm_members y
                   ON x.channel_id = y.channel_id WHERE x.user_id = ? AND y.user_id = ?`).get(a, b);
  if (found) return { id: found.id, created: false };
  const r = q("INSERT INTO channels (guild_id, name, type) VALUES (NULL, 'dm', 'dm')").run();
  const id = Number(r.lastInsertRowid);
  q('INSERT INTO dm_members (channel_id, user_id) VALUES (?,?)').run(id, a);
  q('INSERT INTO dm_members (channel_id, user_id) VALUES (?,?)').run(id, b);
  return { id, created: true };
}

/** Returns the channel row if the user may read/write it, else null. */
export function accessibleChannel(userId, channelId) {
  const ch = getChannel(channelId);
  if (!ch) return null;
  if (ch.type === 'dm') return dmMembers(ch.id).includes(userId) ? ch : null;
  return isMember(ch.guild_id, userId) ? ch : null;
}

function reactionsOf(messageId) {
  const rows = q('SELECT emoji, user_id FROM reactions WHERE message_id = ?').all(messageId);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.emoji)) map.set(r.emoji, []);
    map.get(r.emoji).push(r.user_id);
  }
  return [...map].map(([emoji, userIds]) => ({ emoji, userIds }));
}
function shapeMessage(m) {
  return {
    id: m.id, channelId: m.channel_id, content: m.content,
    attachment: m.attachment ? JSON.parse(m.attachment) : null,
    createdAt: m.created_at, editedAt: m.edited_at,
    author: publicUser({ ...m, id: m.author_id }),
    reactions: reactionsOf(m.id),
  };
}
const MSG_SELECT = `SELECT m.*, u.username, u.color, u.display_name, u.avatar, u.status FROM messages m JOIN users u ON u.id = m.author_id`;

export function getMessage(id) {
  const m = q(`${MSG_SELECT} WHERE m.id = ?`).get(id);
  return m ? shapeMessage(m) : null;
}
export function listMessages(channelId, before, limit = 50) {
  const rows = before
    ? q(`${MSG_SELECT} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(channelId, before, limit)
    : q(`${MSG_SELECT} WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT ?`).all(channelId, limit);
  return rows.reverse().map(shapeMessage);
}
export function createMessage(channelId, authorId, content, attachment) {
  const r = q('INSERT INTO messages (channel_id, author_id, content, attachment, created_at) VALUES (?,?,?,?,?)')
    .run(channelId, authorId, content, attachment ? JSON.stringify(attachment) : null, Date.now());
  return getMessage(Number(r.lastInsertRowid));
}
export function editMessage(id, content) {
  q('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, Date.now(), id);
  return getMessage(id);
}
export function deleteMessage(id) {
  q('DELETE FROM messages WHERE id = ?').run(id);
}
export function toggleReaction(messageId, userId, emoji) {
  const has = q('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(messageId, userId, emoji);
  if (has) q('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, userId, emoji);
  else q('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?,?,?)').run(messageId, userId, emoji);
  return reactionsOf(messageId);
}
