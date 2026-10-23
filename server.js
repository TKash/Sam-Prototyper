// Clip Proto server: stores projects + uploaded MP4s, serves the editor,
// the UI-less player at /p/:id, exports static player folders, and publishes
// them to Cloudflare Pages. Node 18+; wrangler (dev dependency) only for publishing.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5180;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const PROJECTS = path.join(DATA, 'projects');
const MEDIA = path.join(DATA, 'media');
const EXPORTS = path.join(ROOT, 'exports');
for (const d of [PROJECTS, MEDIA, EXPORTS]) fs.mkdirSync(d, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const UPLOAD_EXT = new Set([...VIDEO_EXT, '.jpg']); // .jpg: prototype covers for the gallery
const PLAYER_FILES = ['player.html', 'player.js', 'player.css'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const newId = () => crypto.randomBytes(6).toString('base64url');
const validId = id => /^[\w-]{4,32}$/.test(id);
const projectFile = id => {
  if (!validId(id)) throw new HttpError(400, 'Bad project id');
  return path.join(PROJECTS, `${id}.json`);
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 2e6) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function loadProject(id) {
  try { return JSON.parse(await fsp.readFile(projectFile(id), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw new HttpError(404, 'Project not found'); throw e; }
}

async function saveProject(p) {
  p.updatedAt = new Date().toISOString();
  await fsp.writeFile(projectFile(p.id), JSON.stringify(p, null, 2));
  return p;
}

// Uploads are content-addressed, so the same MP4 used twice is stored once.
async function receiveUpload(req) {
  const name = decodeURIComponent(req.headers['x-filename'] || 'clip.mp4');
  const ext = path.extname(name).toLowerCase();
  if (!UPLOAD_EXT.has(ext)) throw new HttpError(415, 'Only .mp4, .m4v, .mov or .webm files');
  const tmp = path.join(MEDIA, `upload-${newId()}.part`);
  const hash = crypto.createHash('sha1');
  const out = fs.createWriteStream(tmp);
  let size = 0;
  try {
    for await (const c of req) {
      hash.update(c);
      size += c.length;
      if (!out.write(c)) await new Promise(r => out.once('drain', r));
    }
    await new Promise((r, j) => out.end(err => (err ? j(err) : r())));
  } catch (e) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  const file = `${hash.digest('hex')}${ext}`;
  const dest = path.join(MEDIA, file);
  if (fs.existsSync(dest)) await fsp.rm(tmp, { force: true });
  else await fsp.rename(tmp, dest);
  return { file, size };
}

function sendFile(req, res, file, cache) {
  const size = fs.statSync(file).size;
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
  };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal)
    .map(a => `http://${a.address}:${PORT}`);
}

// Every media file the player will load: clips (or the single video) plus reversed copies.
function mediaFiles(p) {
  const files = p.clips.map(c => c.file);
  // Same rule as the player: a reverse copy is only used once it has a back key.
  for (const t of p.clips.flatMap(c => c.triggers || [])) if (t.reverse?.enabled && t.reverse.file && t.reverse.code) files.push(t.reverse.file);
  if (p.mode === 'timeline' && p.video) {
    files.push(p.video.file);
    const rev = p.keys?.back?.enabled && p.keys.back.code && p.reversed?.[p.video.file];
    if (rev) files.push(rev.file);
  }
  return [...new Set(files)];
}

// Writes a self-contained folder (player + project.json + media) that any static host can serve.
// One self-contained .html: player CSS/JS, project.json and every media file
// (base64) inline. Opens by double-click (file://) with no server or network,
// for viewers whose networks block the public link. Streamed so large videos
// never sit in memory as one big string.
async function sendOfflineFile(res, id) {
  const p = await loadProject(id);
  const files = mediaFiles(p);
  if (!files.length) throw new HttpError(400, 'Nothing to export yet.');
  for (const f of files) if (!fs.existsSync(path.join(MEDIA, f))) throw new HttpError(404, `Missing media file ${f}`);

  const read = f => fsp.readFile(path.join(PUBLIC, f), 'utf8');
  const [html, css, js] = await Promise.all([read('player.html'), read('player.css'), read('player.js')]);
  // Inline <script>/<style> content must never contain a closing tag.
  const safe = s => s.replace(/<\/(script|style)/gi, '<\\/$1');
  const { pagesProject, publicUrl, publishedAt, unpublishedChanges, ...playable } = p;
  const projectJson = JSON.stringify(playable).replace(/</g, '\\u003c');
  const [head, tail] = html
    .replace('<link rel="stylesheet" href="player.css">', `<style>\n${safe(css)}\n</style>`)
    .replace(/<script type="module" src="player.js"><\/script>/, '%%PLAYER%%')
    .split('%%PLAYER%%');
  if (tail === undefined) throw new HttpError(500, 'player.html layout changed; cannot build offline file');

  const name = (p.name || 'prototype').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'prototype';
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}.html"; filename*=UTF-8''${encodeURIComponent(name)}.html`,
    'Cache-Control': 'no-store',
  });
  const write = s => (res.write(s) ? null : new Promise(r => res.once('drain', r)));

  await write(head);
  await write(`<script type="application/json" id="cp-project">${projectJson}</script>\n`);
  for (const f of files) {
    const type = MIME[path.extname(f).toLowerCase()] || 'video/mp4';
    await write(`<script type="application/octet-stream" data-cp-media="${f}" data-type="${type}">`);
    // Read in multiples of 3 bytes so each chunk base64-encodes without padding.
    let carry = Buffer.alloc(0);
    for await (const chunk of fs.createReadStream(path.join(MEDIA, f), { highWaterMark: 3 * 1024 * 1024 })) {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 3);
      if (usable) await write(buf.subarray(0, usable).toString('base64'));
      carry = buf.subarray(usable);
    }
    if (carry.length) await write(carry.toString('base64'));
    await write('</script>\n');
  }
  await write(`<script type="module">\n${safe(js)}\n</script>`);
  res.end(tail);
}

async function exportProject(id) {
  const p = await loadProject(id);
  const slug = (p.name || 'prototype').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'prototype';
  const dir = path.join(EXPORTS, `${slug}-${p.id}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(path.join(dir, 'media'), { recursive: true });
  for (const f of PLAYER_FILES) {
    await fsp.copyFile(path.join(PUBLIC, f), path.join(dir, f === 'player.html' ? 'index.html' : f));
  }
  for (const file of mediaFiles(p)) {
    await fsp.copyFile(path.join(MEDIA, file), path.join(dir, 'media', file));
  }
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(p));
  // Cloudflare Pages / Netlify header rules: media names are content hashes, so cache forever.
  await fsp.writeFile(path.join(dir, '_headers'), '/media/*\n  Cache-Control: public, max-age=31536000, immutable\n/project.json\n  Cache-Control: no-cache\n');
  return dir;
}

// ---------------------------------------------------------------- publishing

const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const PUBLISH_FIELDS = ['pagesProject', 'publicUrl', 'publishedAt'];
const publishing = new Set();

function wrangler(args) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(WRANGLER)) return reject(new HttpError(500, 'wrangler is not installed — run "npm install" in mp4-proto.'));
    const child = spawn(process.execPath, [WRANGLER, ...args], { cwd: ROOT, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (out += d));
    child.on('error', reject);
    child.on('close', code => resolve({ code, out }));
  });
}

async function publishProject(id) {
  if (publishing.has(id)) throw new HttpError(409, 'Already publishing this prototype.');
  publishing.add(id);
  try {
    const p = await loadProject(id);
    if (!mediaFiles(p).length) throw new HttpError(400, p.mode === 'timeline' ? 'Add a video first.' : 'Add at least one clip first.');
    const dir = await exportProject(id);
    const slug = (p.name || 'prototype').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'prototype';
    const name = p.pagesProject || `${slug}-${p.id.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 58);

    if (!p.pagesProject) {
      const created = await wrangler(['pages', 'project', 'create', name, '--production-branch', 'main']);
      if (created.code !== 0 && !/already exists/i.test(created.out)) throw publishError(created.out);
    }
    const deployed = await wrangler(['pages', 'deploy', dir, '--project-name', name, '--branch', 'main', '--commit-dirty=true']);
    if (deployed.code !== 0) throw publishError(deployed.out);

    // Deploy prints a per-deployment URL (https://<hash>.<project>.pages.dev); the production alias drops the hash.
    const deploymentUrl = (deployed.out.match(/https:\/\/[a-z0-9.-]+\.pages\.dev/i) || [])[0];
    if (!deploymentUrl) throw new HttpError(502, `Deployed, but could not find the URL in wrangler's output:\n${deployed.out.slice(-800)}`);
    const host = new URL(deploymentUrl).hostname.split('.');
    const publicUrl = `https://${host.length > 3 ? host.slice(1).join('.') : host.join('.')}`;

    const fresh = await loadProject(id); // the editor may have saved meanwhile
    Object.assign(fresh, { pagesProject: name, publicUrl, publishedAt: new Date().toISOString(), unpublishedChanges: false });
    await saveProject(fresh);
    return { publicUrl, deploymentUrl, pagesProject: name, publishedAt: fresh.publishedAt };
  } finally {
    publishing.delete(id);
  }
}

function publishError(raw) {
  const out = raw.replace(/\x1b\[[0-9;]*m/g, '');
  if (/not authenticated|wrangler login|Authentication error|code: 10000\]/i.test(out)) {
    return new HttpError(401, 'Not signed in to Cloudflare. In the mp4-proto folder run:  npx wrangler login');
  }
  if (/code: 8000077/.test(out)) {
    return new HttpError(403, 'Cloudflare needs your account email verified first. Open the verification email from Cloudflare (or dash.cloudflare.com → resend), then publish again.');
  }
  const detail = out.split('\n').filter(l => l.trim() && !/^[⛅─🪵]|wrangler \d|open an issue/.test(l.trim())).slice(-6).join('\n');
  return new HttpError(502, `Cloudflare publish failed:\n${detail}`);
}

// Same fields the hosted worker keeps as KV list metadata.
async function listProjects() {
  const files = (await fsp.readdir(PROJECTS)).filter(f => f.endsWith('.json'));
  const list = await Promise.all(files.map(async f => {
    const p = JSON.parse(await fsp.readFile(path.join(PROJECTS, f), 'utf8'));
    return {
      id: p.id, name: p.name, mode: p.mode || 'canvas', clips: p.clips.length, stops: p.stops?.length || 0, hasVideo: Boolean(p.video),
      cover: p.cover?.file || null, gallery: p.gallery !== false, updatedAt: p.updatedAt,
    };
  }));
  return list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// The client gallery: prototypes with something to play, unless hidden from it.
const galleryList = list => list
  .filter(p => p.gallery !== false && (p.mode === 'timeline' ? p.hasVideo : p.clips > 0))
  .map(({ id, name, mode, clips, stops, cover }) => ({ id, name, mode, clips, stops, cover }))
  .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }));

async function route(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (url.pathname === '/api/info') return json(res, 200, { port: PORT, lan: lanAddresses() });

  if (url.pathname === '/api/projects') {
    if (method === 'GET') {
      return json(res, 200, await listProjects());
    }
    if (method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const p = { id: newId(), name: String(body.name || 'Untitled prototype').slice(0, 120), startClip: null, fit: 'contain', sound: false, clips: [], globalTriggers: [] };
      if (body.mode === 'timeline') {
        Object.assign(p, {
          mode: 'timeline',
          video: null,
          stops: [],
          keys: { next: { code: 'ArrowRight', label: '→' }, back: { enabled: false, code: 'ArrowLeft', label: '←' }, click: true },
          end: 'hold',
        });
      }
      return json(res, 201, await saveProject(p));
    }
  }

  if (parts[0] === 'api' && parts[1] === 'projects' && parts[2]) {
    const id = parts[2];
    if (parts[3] === 'export' && method === 'POST') return json(res, 200, { dir: await exportProject(id) });
    if (parts[3] === 'offline' && method === 'GET') return await sendOfflineFile(res, id);
    if (parts[3] === 'publish' && method === 'POST') return json(res, 200, await publishProject(id));
    if (parts.length === 3 && method === 'GET') return json(res, 200, await loadProject(id));
    if (parts.length === 3 && method === 'PUT') {
      const p = JSON.parse(await readBody(req));
      if (p.id !== id || !Array.isArray(p.clips)) throw new HttpError(400, 'Invalid project');
      // Publish info is owned by the server; never let a stale editor copy wipe it.
      const existing = await loadProject(id).catch(() => ({}));
      for (const f of PUBLISH_FIELDS) if (existing[f] && !p[f]) p[f] = existing[f];
      return json(res, 200, await saveProject(p));
    }
    if (parts.length === 3 && method === 'DELETE') {
      await fsp.rm(projectFile(id), { force: true });
      return json(res, 200, { ok: true });
    }
  }

  if (url.pathname === '/api/upload' && method === 'POST') return json(res, 201, await receiveUpload(req));
  if (url.pathname === '/api/gallery' && method === 'GET') return json(res, 200, galleryList(await listProjects()));
  if (url.pathname === '/gallery' || url.pathname === '/gallery/') return sendFile(req, res, path.join(PUBLIC, 'gallery.html'), 'no-cache');
  if (url.pathname === '/remote' || url.pathname === '/remote/') return sendFile(req, res, path.join(PUBLIC, 'remote.html'), 'no-cache');

  if (parts[0] === 'media' && parts.length === 2) {
    const file = path.join(MEDIA, path.basename(parts[1]));
    if (!/^[a-f0-9]{40}\.\w+$/.test(parts[1]) || !fs.existsSync(file)) throw new HttpError(404, 'Media not found');
    return sendFile(req, res, file, 'public, max-age=31536000, immutable');
  }

  // Player: /p/:id serves player.html; its relative assets resolve to /p/player.js etc.
  if (parts[0] === 'p' && parts.length === 2) {
    const asset = PLAYER_FILES.includes(parts[1]) ? parts[1] : 'player.html';
    return sendFile(req, res, path.join(PUBLIC, asset), 'no-cache');
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw new HttpError(404, 'Not found');
  return sendFile(req, res, file, 'no-cache');
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    await route(req, res, url);
  } catch (err) {
    const status = err.status || (err instanceof SyntaxError ? 400 : 500);
    if (status === 500) console.error(err);
    if (res.headersSent) return res.destroy();
    json(res, status, { error: err.message || 'Server error' });
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Clip Proto editor → http://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(`  on your network → ${a}`);
});
