// Prévia de links (título, descrição, imagem), buscada pelo servidor de quem hospeda.
// Só busca endereços públicos: recusa a rede local e o próprio PC, inclusive depois de redirecionamentos
// e no momento da conexão (a checagem fica no `lookup`, então trocar o DNS no meio não engana).
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 4;
const cache = new Map(); // url -> { at, data }
const CACHE_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;

function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // rede "este", privada, loopback, multicast/reservada
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT (Tailscale e afins)
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return false;
    if (v.startsWith('::ffff:')) return isPublicIp(v.slice(7));
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff')) return false; // ULA, link-local, multicast
    return true;
  }
  return false;
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const ok = addresses.filter((a) => isPublicIp(a.address));
    if (ok.length === 0) return callback(new Error('endereço não público'));
    if (options.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}

/** Recusa IP escrito direto no link quando não é público (o Node não passa IPs pelo lookup). */
function assertPublicHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isPublicIp(host)) throw new Error('endereço não público');
}

function fetchOnce(url, want = 'html') {
  return new Promise((resolve, reject) => {
    try {
      assertPublicHost(url);
    } catch (e) {
      return reject(e);
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; CGL-LinkPreview/1.0)',
          accept: want === 'json' ? 'application/json' : 'text/html,application/xhtml+xml',
          'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: new URL(res.headers.location, url) });
        }
        const type = res.headers['content-type'] || '';
        if (status !== 200 || !(want === 'json' ? /json/i : /text\/html|application\/xhtml/i).test(type)) {
          res.resume();
          return reject(new Error('não é uma página'));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          chunks.push(c);
          // as metatags ficam no começo; 1 MB basta
          if (size >= MAX_BYTES) res.destroy();
        });
        res.on('close', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), finalUrl: url }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
    req.end();
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
  );

function parse(html, pageUrl) {
  const head = html.slice(0, 300000);
  const meta = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const attr = (n) => tag.match(new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    const key = attr('property') || attr('name') || attr('itemprop');
    const content = attr('content');
    if (!key || !content) continue;
    const k = (key[2] ?? key[3] ?? key[4]).toLowerCase();
    if (!(k in meta)) meta[k] = decode(content[2] ?? content[3] ?? content[4]).trim();
  }
  const titleTag = head.match(/<title[^>]*>([^<]*)<\/title>/i);
  const pick = (...keys) => keys.map((k) => meta[k]).find((v) => v);
  const abs = (u) => {
    try {
      const x = new URL(u, pageUrl);
      return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
    } catch {
      return null;
    }
  };
  const image = pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
  const color = pick('theme-color');
  return {
    url: pageUrl.href,
    site: (pick('og:site_name', 'application-name') || pageUrl.hostname.replace(/^www\./, '')).slice(0, 100),
    title: (pick('og:title', 'twitter:title') || (titleTag ? decode(titleTag[1]).trim() : '')).slice(0, 300),
    description: (pick('og:description', 'twitter:description', 'description') || '').slice(0, 600),
    image: image ? abs(image) : null,
    largeImage: pick('twitter:card') === 'summary_large_image' || pick('og:type') === 'video.other' || pick('og:type')?.startsWith('video') || false,
    color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null,
  };
}

export async function unfurl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('link inválido');
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('link inválido');
  const key = url.href;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const yt = youtubeId(url);
  if (yt) {
    const o = new URL('https://www.youtube.com/oembed');
    o.searchParams.set('url', `https://www.youtube.com/watch?v=${yt}`);
    o.searchParams.set('format', 'json');
    const r = await fetchOnce(o, 'json');
    const j = JSON.parse(r.html);
    const data = {
      url: url.href,
      site: 'YouTube',
      title: String(j.title || '').slice(0, 300),
      description: j.author_name ? String(j.author_name).slice(0, 200) : '',
      image: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`,
      largeImage: true,
      color: '#ff0033',
      youtube: yt,
    };
    remember(key, data);
    return data;
  }

  let current = url;
  let data = null;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!/^https?:$/.test(current.protocol)) throw new Error('link inválido');
    const r = await fetchOnce(current);
    if (r.redirect) {
      current = r.redirect;
      continue;
    }
    data = parse(r.html, r.finalUrl);
    break;
  }
  if (!data) throw new Error('redirecionamentos demais');
  // página que só devolve o nome do site (ex.: Instagram sem login) não vira cartão
  if (!data.description && !data.image) throw new Error('sem prévia');
  remember(key, data);
  return data;
}

function remember(key, data) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), data });
}

/** Id do vídeo para links youtube.com/watch, youtu.be, /shorts e /embed. */
export function youtubeId(url) {
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') || url.pathname.match(/^\/(shorts|embed|live)\/([^/?#]+)/)?.[2] || null;
  }
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}

export const _test = { isPublicIp, parse };
