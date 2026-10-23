// Clip Proto, hosted on Cloudflare Workers. Same API as server.js, backed by
// KV instead of the local disk. Free-plan Workers get ~10 ms of CPU per
// request, so this code only moves bytes: uploads stream into KV in 24 MiB
// parts, media streams back out, and the offline .html is built in the
// browser. The editor sits behind a password; play links (/p/:id), project
// JSON and media stay public because that's what gets shared.
//
// KV keys:  project:<id>   project JSON (list metadata: name, mode, counts)
//           media:<file>   { size, type, parts }
//           part:<file>:<i>  bytes of part i

const PART = 24 * 1024 * 1024; // a multiple of 3 (and under KV's 25 MiB value limit)
const SESSION_COOKIE = 'cp_session';
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.jpg': 'image/jpeg' }; // .jpg: gallery covers
const PLAYER_ASSETS = new Set(['player.js', 'player.css']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

const newId = () => {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const validId = id => /^[\w-]{4,32}$/.test(id);
const validFile = f => /^[\w-]{6,64}\.(mp4|m4v|mov|webm|jpg)$/.test(f);

// ---------------------------------------------------------------- auth

async function sessionToken(env) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.EDITOR_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('clip-proto-session-v1'));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function isAuthed(request, env) {
  // No password configured = open editor. Set one with: npx wrangler secret put EDITOR_PASSWORD
  if (!env.EDITOR_PASSWORD) return true;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{64})`));
  return Boolean(m && m[1] === await sessionToken(env));
}

async function login(request, env) {
  const { password } = await request.json().catch(() => ({}));
  if (!env.EDITOR_PASSWORD || typeof password !== 'string' || password !== env.EDITOR_PASSWORD) {
    await new Promise(r => setTimeout(r, 400)); // slow down guessing
    throw new HttpError(401, 'Wrong password');
  }
  const cookie = `${SESSION_COOKIE}=${await sessionToken(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`;
  return json(200, { ok: true }, { 'Set-Cookie': cookie });
}

// ---------------------------------------------------------------- projects

async function loadProject(env, id) {
  if (!validId(id)) throw new HttpError(400, 'Bad project id');
  const p = await env.STORE.get(`project:${id}`, 'json');
  if (!p) throw new HttpError(404, 'Project not found');
  return p;
}

async function saveProject(env, p) {
  p.updatedAt = new Date().toISOString();
  const metadata = {
    name: String(p.name || '').slice(0, 200), mode: p.mode || 'canvas',
    clips: p.clips?.length || 0, stops: p.stops?.length || 0, hasVideo: Boolean(p.video), updatedAt: p.updatedAt,
    cover: p.cover?.file || null, gallery: p.gallery !== false,
    galleryOrder: Number.isFinite(p.galleryOrder) ? p.galleryOrder : null,
    // KV list metadata is capped at 1 KB, so the card description is trimmed.
    summary: String(p.summary || '').slice(0, 300) || null,
  };
  await env.STORE.put(`project:${p.id}`, JSON.stringify(p), { metadata });
  return p;
}

async function listProjects(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.STORE.list({ prefix: 'project:', cursor });
    for (const k of page.keys) out.push({ id: k.name.slice('project:'.length), ...(k.metadata || {}) });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// The client gallery, straight from list metadata: prototypes with something
// to play, unless hidden from it, in their set order (the editor's Order
// list), then by name. Same as server.js.
const galleryList = list => list
  .filter(p => p.gallery !== false && (p.mode === 'timeline' ? p.hasVideo : p.clips > 0))
  .sort((a, b) => (a.galleryOrder ?? Infinity) - (b.galleryOrder ?? Infinity)
    || (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }))
  .map(({ id, name, mode, clips, stops, cover, summary }) => ({ id, name, mode, clips, stops, cover: cover || null, summary: summary || null }));

function newProject(body) {
  const p = { id: newId(), name: String(body.name || 'Untitled prototype').slice(0, 120), startClip: null, fit: 'contain', sound: false, clips: [], globalTriggers: [] };
  if (body.mode === 'timeline') {
    Object.assign(p, {
      mode: 'timeline', video: null, stops: [],
      keys: { next: { code: 'ArrowRight', label: '→' }, back: { enabled: false, code: 'ArrowLeft', label: '←' }, click: true },
      end: 'hold',
    });
  }
  return p;
}

// ---------------------------------------------------------------- media

// Upload: the body streams into KV in PART-sized pieces. The file id comes
// from the client when it already knows it (x-file-id, used to migrate local
// projects so references stay valid); otherwise a random id is assigned.
async function receiveUpload(request, env) {
  const name = decodeURIComponent(request.headers.get('x-filename') || 'clip.mp4');
  const ext = (name.match(/\.[^.]+$/) || ['.mp4'])[0].toLowerCase();
  if (!MIME[ext]) throw new HttpError(415, 'Only .mp4, .m4v, .mov or .webm files');
  const given = request.headers.get('x-file-id');
  const file = given && validFile(given) ? given : `${newId()}${newId()}${ext}`;
  if (given && await env.STORE.get(`media:${file}`)) {
    const meta = JSON.parse(await env.STORE.get(`media:${file}`));
    return { file, size: meta.size };
  }
  if (!request.body) throw new HttpError(400, 'Empty upload');

  const reader = request.body.getReader();
  let part = 0, size = 0;
  let pending = [], pendingBytes = 0;
  const flush = async () => {
    if (!pendingBytes) return;
    const buf = new Uint8Array(pendingBytes);
    let o = 0;
    for (const c of pending) { buf.set(c, o); o += c.length; }
    await env.STORE.put(`part:${file}:${part++}`, buf);
    pending = []; pendingBytes = 0;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = value;
    while (chunk.length) {
      const take = Math.min(chunk.length, PART - pendingBytes);
      pending.push(chunk.subarray(0, take));
      pendingBytes += take;
      size += take;
      chunk = chunk.subarray(take);
      if (pendingBytes === PART) await flush();
    }
  }
  await flush();
  if (!size) throw new HttpError(400, 'Empty upload');
  await env.STORE.put(`media:${file}`, JSON.stringify({ size, type: MIME[ext], parts: part }));
  return { file, size };
}

async function serveMedia(env, file) {
  if (!validFile(file)) throw new HttpError(404, 'Media not found');
  const metaText = await env.STORE.get(`media:${file}`, { cacheTtl: 86400 });
  if (!metaText) throw new HttpError(404, 'Media not found');
  const meta = JSON.parse(metaText);
  // Concatenate the parts as one stream (pure I/O, no copying in JS).
  const { readable, writable } = new TransformStream();
  (async () => {
    try {
      for (let i = 0; i < meta.parts; i++) {
        const s = await env.STORE.get(`part:${file}:${i}`, { type: 'stream', cacheTtl: 86400 });
        if (!s) throw new Error(`missing part ${i}`);
        await s.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (e) {
      await writable.abort(e).catch(() => {});
    }
  })();
  return new Response(readable, {
    headers: {
      'Content-Type': meta.type || 'video/mp4',
      'Content-Length': String(meta.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Accept-Ranges': 'none',
    },
  });
}

// ---------------------------------------------------------------- routing

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const method = request.method;
  const authed = () => isAuthed(request, env);
  const requireAuth = async () => { if (!(await authed())) throw new HttpError(401, 'Please sign in'); };

  // Public: play links, their assets, project JSON (read), media, the gallery, the phone remote.
  if (parts[0] === 'p' && parts.length === 2) {
    const asset = PLAYER_ASSETS.has(parts[1]) ? parts[1] : 'player.html';
    return env.ASSETS.fetch(new Request(new URL(`/${asset}`, url), request));
  }
  if (parts[0] === 'media' && parts.length === 2 && method === 'GET') return serveMedia(env, parts[1]);
  if (url.pathname === '/gallery' || url.pathname === '/gallery/') return env.ASSETS.fetch(new Request(new URL('/gallery.html', url), request));
  if (url.pathname === '/remote' || url.pathname === '/remote/') return env.ASSETS.fetch(new Request(new URL('/remote.html', url), request));
  if (url.pathname === '/api/gallery' && method === 'GET') return json(200, galleryList(await listProjects(env)));
  if (url.pathname === '/api/info') return json(200, { hosted: true, lan: [], authed: await authed() });
  if (url.pathname === '/api/login' && method === 'POST') return login(request, env);
  if (url.pathname === '/api/logout' && method === 'POST') {
    return json(200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }
  if (parts[0] === 'api' && parts[1] === 'projects' && parts[2] && parts.length === 3 && method === 'GET') {
    return json(200, await loadProject(env, parts[2]));
  }

  // Everything else under /api needs the editor password.
  if (parts[0] === 'api') {
    await requireAuth();
    if (url.pathname === '/api/projects') {
      if (method === 'GET') return json(200, await listProjects(env));
      if (method === 'POST') return json(201, await saveProject(env, newProject(await request.json().catch(() => ({})))));
    }
    if (parts[1] === 'projects' && parts[2]) {
      const id = parts[2];
      if (parts.length === 3 && method === 'PUT') {
        const p = await request.json();
        if (p.id !== id || !Array.isArray(p.clips)) throw new HttpError(400, 'Invalid project');
        // Refuse saves based on an older version (an editor tab opened before
        // someone else saved), so they can't silently overwrite newer changes.
        // KV reads can briefly lag a save, so only refuse when the stored version
        // is genuinely newer than the one the editor started from (ISO times
        // compare as strings); a missing version means an outdated editor tab.
        const existing = await env.STORE.get(`project:${id}`, 'json');
        const base = request.headers.get('If-Match');
        if (existing && (!base || (existing.updatedAt || '') > base)) {
          throw new HttpError(409, 'This prototype was changed somewhere else. Reload to get the latest version.');
        }
        return json(200, await saveProject(env, p));
      }
      if (parts.length === 3 && method === 'DELETE') {
        await env.STORE.delete(`project:${id}`);
        return json(200, { ok: true });
      }
      if (parts[3] === 'publish' || parts[3] === 'export') {
        throw new HttpError(400, 'Not needed here: on the hosted version the /p/ play link is already public.');
      }
    }
    if (url.pathname === '/api/upload' && method === 'POST') return json(201, await receiveUpload(request, env));
    throw new HttpError(404, 'Not found');
  }

  // Static editor files ("/" is the editor's index.html).
  if (url.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 500);
      if (status === 500) console.error(err);
      return json(status, { error: err.message || 'Server error' });
    }
  },
};
