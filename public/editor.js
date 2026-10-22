// Editor: an infinite canvas of video frames. Drag from a frame's edge to
// another frame to connect them; click a connector to set its trigger
// (key / click / after the video ends) and animation.

import { reverseVideo } from './reverse.js';
import { fixVideo } from './convert.js';
import { mountTimeline } from './timeline.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

const FRAME_W = 320;          // frame width in canvas units
const EDGE_PX = 9;            // screen px around a frame's border that start a connection
const MIN_Z = 0.1, MAX_Z = 4;

const state = {
  project: null,
  sel: null,         // { type: 'clip' | 'conn', id }
  view: { x: 0, y: 0, z: 1 },
  uploads: [],       // { id, name, pct, x, y }
  listening: null,   // trigger waiting for a key press
  saveTimer: null,
  saving: false,
  lan: [],
  hosted: false,     // running on the hosted (Cloudflare Workers) version
  publishing: false,
  undo: [],
  redo: [],
  spaceDown: false,
  drag: null,
  revJobs: new Map(), // source file -> { pct, error } while a reversed copy is being made
  fixJobs: new Map(), // clip id -> { phase, pct, error } while "Fix video" runs
};

// ---------------------------------------------------------------- utils

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
}

const uid = () => Math.random().toString(36).slice(2, 9);
const fmtTime = x => (x ? `${x.toFixed(1)}s` : '');
const fmtSize = b => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let toastTimer;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
}

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') {
    renderLogin();
    throw new Error('Please sign in');
  }
  if (!r.ok) throw Object.assign(new Error(body.error || `Request failed (${r.status})`), { status: r.status });
  return body;
}

// Hosted version only: the editor is behind a password (play links stay public).
function renderLogin() {
  if (document.getElementById('login-form')) return;
  document.title = 'Sign in · Clip Proto';
  const input = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'warn', hidden: true });
  const submit = async e => {
    e.preventDefault();
    error.hidden = true;
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password: input.value }) });
      route();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      input.select();
    }
  };
  app.replaceChildren(h('div', { class: 'home' },
    h('form', { id: 'login-form', class: 'login', onsubmit: submit },
      h('h1', {}, 'Clip Proto'),
      h('p', { class: 'lead' }, 'Enter the editor password.'),
      input,
      h('button', { class: 'primary', type: 'submit' }, 'Sign in'),
      error,
    ),
  ));
  input.focus();
}

function keyLabel(e) {
  const named = { ' ': 'Space', ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc' };
  if (named[e.key]) return named[e.key];
  if (e.key.length === 1) return e.key.toUpperCase();
  return e.key;
}

const isTyping = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
const playerUrl = (base = location.origin) => `${base}/p/${state.project.id}`;
const clipById = id => state.project?.clips.find(c => c.id === id);
const frameH = c => Math.round(FRAME_W * ((c.height && c.width) ? c.height / c.width : 9 / 16));

function findConn(id) {
  for (const c of state.project.clips) {
    const t = c.triggers.find(t => t.id === id);
    if (t) return { from: c, t };
  }
  return null;
}

const TRASH_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.75 6.5v4.5M9.25 6.5v4.5"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>';

// Two-click confirm: the first click arms it, a second click within 3s confirms.
// (Native confirm() dialogs are blocked in some embedded browsers.)
function confirmButton({ cls = '', label, armedLabel = 'Delete?', title, onConfirm }) {
  let timer = null;
  const btn = h('button', { class: `confirm-btn ${cls}`, title, 'aria-label': title });
  const idle = () => { btn.classList.remove('armed'); btn.innerHTML = label; };
  idle();
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = armedLabel;
      timer = setTimeout(idle, 3000);
      return;
    }
    clearTimeout(timer);
    onConfirm();
  });
  return btn;
}

// ---------------------------------------------------------------- routing

window.addEventListener('hashchange', route);
route();

async function route() {
  const m = location.hash.match(/^#\/edit\/([\w-]+)/);
  if (!m) return renderHome();
  try {
    const proj = await api(`/api/projects/${m[1]}`);
    state.sel = null;
    state.undo = [];
    state.redo = [];
    const info = await api('/api/info');
    state.lan = info.lan || [];
    state.hosted = Boolean(info.hosted);
    state.timeline = null;
    if (proj.mode === 'timeline') {
      state.project = proj;
      state.timeline = mountTimeline(timelineContext());
      ensureCover();
      return;
    }
    state.project = migrate(proj);
    renderEditor();
    fitView();
    ensureCover();
  } catch (e) {
    toast(e.message);
    location.hash = '';
  }
}

// Older projects stored "go to when it ends" on the clip and had no canvas
// positions. Turn the former into an "after video ends" connector and lay
// frames out left-to-right along the flow.
function migrate(p) {
  let changed = false;
  for (const c of p.clips) {
    c.triggers ||= [];
    c.end ||= { type: 'loop' };
    if (c.end.type === 'goto') {
      if (c.end.to && !c.triggers.some(t => t.type === 'end')) c.triggers.push({ id: uid(), type: 'end', to: c.end.to });
      c.end = { type: 'hold' };
      changed = true;
    }
  }
  if (p.clips.some(c => typeof c.x !== 'number')) {
    autoLayout(p, p.clips.filter(c => typeof c.x !== 'number'));
    changed = true;
  }
  if (changed) setTimeout(save, 0);
  return p;
}

function autoLayout(p, targets) {
  const placed = new Set(p.clips.filter(c => !targets.includes(c)).map(c => c.id));
  const depth = new Map();
  const queue = [p.startClip || p.clips[0]?.id].filter(Boolean);
  if (queue[0]) depth.set(queue[0], 0);
  while (queue.length) {
    const id = queue.shift();
    const c = p.clips.find(x => x.id === id);
    for (const t of c?.triggers || []) {
      if (t.to && !depth.has(t.to)) { depth.set(t.to, depth.get(id) + 1); queue.push(t.to); }
    }
  }
  const maxDepth = Math.max(-1, ...depth.values());
  const rows = new Map();
  const baseY = placed.size ? Math.max(...p.clips.filter(c => placed.has(c.id)).map(c => c.y + frameH(c))) + 160 : 0;
  for (const c of targets) {
    const col = depth.has(c.id) ? depth.get(c.id) : maxDepth + 1;
    const row = rows.get(col) || 0;
    rows.set(col, row + 1);
    c.x = col * (FRAME_W + 140);
    c.y = baseY + row * (frameH(c) + 110);
  }
}

// ---------------------------------------------------------------- home

async function renderHome() {
  state.project = null;
  document.title = 'Clip Proto';
  const list = h('div', { class: 'project-list' });
  const create = async mode => {
    const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Untitled prototype', mode }) });
    location.hash = `#/edit/${p.id}`;
  };
  app.replaceChildren(h('div', { class: 'home' },
    h('h1', {}, 'Clip Proto'),
    h('p', { class: 'lead' }, 'Turn a UI recording into an interactive prototype and share a link that plays full-screen with no UI. Everything is preloaded, so it never buffers.'),
    h('div', { class: 'new-choices' },
      h('button', { class: 'new-choice primary-choice', onclick: () => create('timeline') },
        h('strong', {}, 'Single video with stops'),
        h('span', {}, 'One recording. Mark the frames where it should pause and wait for a key press.')),
      h('button', { class: 'new-choice', onclick: () => create('canvas') },
        h('strong', {}, 'Clips on a canvas'),
        h('span', {}, 'Several videos connected like Figma frames, with branching paths.')),
    ),
    gallerySection(),
    h('h3', {}, 'Your prototypes'),
    list,
  ));
  const projects = await api('/api/projects');
  const thumbs = new Map();
  list.replaceChildren(...projects.map(p => h('div', { class: 'project-item' },
    thumbs.set(p.id, h('div', { class: 'thumb' }, p.cover ? h('img', { src: `/media/${p.cover}`, alt: '' }) : null)).get(p.id),
    h('a', { href: `#/edit/${p.id}` }, p.name),
    h('span', { class: 'muted' }, p.mode === 'timeline' ? `Single video · ${p.stops} stop${p.stops === 1 ? '' : 's'}` : `Canvas · ${p.clips} clip${p.clips === 1 ? '' : 's'}`),
    h('label', { class: 'gallery-toggle', title: 'Show this prototype in the client gallery' },
      h('input', { type: 'checkbox', checked: p.gallery !== false, onchange: e => setInGallery(p.id, e.target.checked, e.target) }),
      'In gallery'),
    h('button', { class: 'ghost', onclick: () => window.open(`/p/${p.id}`, '_blank') }, 'Play'),
    confirmButton({
      cls: 'ghost danger',
      label: 'Delete',
      title: `Delete ${p.name}`,
      onConfirm: async () => {
        await api(`/api/projects/${p.id}`, { method: 'DELETE' });
        renderHome();
      },
    }),
  )));
  backfillCovers(projects.filter(p => !p.cover && p.gallery !== false && (p.mode === 'timeline' ? p.hasVideo : p.clips > 0)), thumbs);
}

// ---------------------------------------------------------------- client gallery
//
// /gallery lists every prototype that's "In gallery", each with a cover image
// (a still from its start video, made here and uploaded as a small .jpg).
// Prototypes opened from it get ?menu, so M returns to it; R restarts.

function gallerySection() {
  const url = `${location.origin}/gallery`;
  return h('div', { class: 'gallery-box' },
    h('div', {},
      h('strong', {}, 'Client gallery'),
      h('p', { class: 'hint' }, 'One link with every prototype marked "In gallery". In a prototype opened from it, R restarts and M comes back to the gallery.')),
    h('div', { class: 'link-box' }, h('input', { readOnly: true, value: url, onfocus: e => e.target.select() })),
    h('div', { class: 'row' },
      h('button', { onclick: async () => { await navigator.clipboard.writeText(url).catch(() => {}); toast('Gallery link copied'); } }, 'Copy link'),
      h('button', { class: 'ghost', onclick: () => window.open('/gallery', '_blank') }, 'Open')),
  );
}

async function setInGallery(id, on, input) {
  input.disabled = true;
  try {
    const p = await api(`/api/projects/${id}`);
    if (on) delete p.gallery; else p.gallery = false;
    await api(`/api/projects/${id}`, { method: 'PUT', headers: p.updatedAt ? { 'If-Match': p.updatedAt } : {}, body: JSON.stringify(p) });
  } catch (e) {
    toast(e.message);
    input.checked = !on;
  }
  input.disabled = false;
}

const coverSource = p => (p.mode === 'timeline' ? p.video?.file : (p.clips.find(c => c.id === p.startClip) || p.clips[0])?.file) || null;

async function uploadCover(src) {
  const url = await poster(src);
  if (!url) return null;
  const blob = await (await fetch(url)).blob();
  const r = await fetch('/api/upload', { method: 'POST', headers: { 'x-filename': 'cover.jpg' }, body: blob });
  const res = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(res.error || 'cover upload failed');
  return res.file;
}

// Keeps the open prototype's cover in step with its start video.
let coverJob = null;
async function ensureCover() {
  const p = state.project;
  const src = p && coverSource(p);
  if (!src || p.cover?.src === src || coverJob === `${p.id}:${src}`) return;
  coverJob = `${p.id}:${src}`;
  try {
    const file = await uploadCover(src);
    if (file && state.project === p && coverSource(p) === src) {
      p.cover = { file, src };
      save();
    }
  } catch { /* the gallery shows a placeholder instead */ }
  coverJob = null;
}

// Prototypes made before covers existed: make theirs one at a time.
async function backfillCovers(list, thumbs) {
  for (const item of list) {
    if (state.project) return; // an editor was opened meanwhile
    try {
      const p = await api(`/api/projects/${item.id}`);
      const src = coverSource(p);
      if (!src || p.cover?.src === src) continue;
      const file = await uploadCover(src);
      if (!file) continue;
      p.cover = { file, src };
      await api(`/api/projects/${p.id}`, { method: 'PUT', headers: p.updatedAt ? { 'If-Match': p.updatedAt } : {}, body: JSON.stringify(p) });
      thumbs.get(item.id)?.replaceChildren(h('img', { src: `/media/${file}`, alt: '' }));
    } catch { /* try again next time the list opens */ }
  }
}

// ---------------------------------------------------------------- saving + undo

function save() {
  if (!state.project) return;
  ensureCover();
  if (state.project.publicUrl) state.project.unpublishedChanges = true;
  state.saving = true;
  updateSaved();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    try {
      await putProject(state.project);
      state.saving = false;
    } catch (e) {
      if (e.status !== 409) toast(`Save failed: ${e.message}`);
    }
    updateSaved();
  }, 300);
}

// Saves run one at a time and say which version they're based on (If-Match:
// updatedAt). If the prototype was changed elsewhere meanwhile — another tab,
// another laptop — the server refuses (409) and we load the latest instead of
// silently overwriting it.
let saveChain = Promise.resolve();
function putProject(p) {
  const run = async () => {
    try {
      const saved = await api(`/api/projects/${p.id}`, {
        method: 'PUT',
        headers: p.updatedAt ? { 'If-Match': p.updatedAt } : {},
        body: JSON.stringify(p),
      });
      p.updatedAt = saved.updatedAt;
      return saved;
    } catch (e) {
      if (e.status === 409 && state.project?.id === p.id) {
        toast('This prototype was changed somewhere else, so the latest version was loaded. Please redo your last change.', 7000);
        route();
      }
      throw e;
    }
  };
  const next = saveChain.then(run, run);
  saveChain = next.catch(() => {});
  return next;
}

function updateSaved() {
  const el = document.getElementById('saved');
  if (el) el.textContent = state.saving ? 'Saving…' : 'Saved';
}

function snapshot() {
  state.undo.push(JSON.stringify(state.project));
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
}

// Every structural change goes through here so it can be undone.
function commit(fn) {
  snapshot();
  fn();
  reconcileReverse();
  save();
  renderAll();
}

function restore(from, to) {
  const json = from.pop();
  if (!json) return;
  to.push(JSON.stringify(state.project));
  // Publish info and already-made reversed videos are never undone.
  const p = state.project;
  const keep = { publicUrl: p.publicUrl, pagesProject: p.pagesProject, publishedAt: p.publishedAt, reversed: p.reversed, cover: p.cover, updatedAt: p.updatedAt };
  state.project = Object.assign(JSON.parse(json), keep);
  if (state.sel && !(state.sel.type === 'clip' ? clipById(state.sel.id) : findConn(state.sel.id))) state.sel = null;
  reconcileReverse();
  save();
  renderAll();
}

// ---------------------------------------------------------------- editor shell

const dom = {};

function renderEditor() {
  const p = state.project;
  document.title = `${p.name} · Clip Proto`;
  const fileInput = h('input', {
    type: 'file', multiple: true, hidden: true,
    accept: 'video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm',
    onchange: e => { uploadFiles(e.target.files, nextFreeSpot()); e.target.value = ''; },
  });

  dom.world = h('div', { class: 'world' });
  dom.svg = s('svg', { class: 'wires' });
  dom.wireLayer = s('g');
  dom.tempLayer = s('g');
  dom.svg.append(dom.wireLayer, dom.tempLayer);
  dom.frames = h('div', { class: 'frames' });
  dom.chips = h('div', { class: 'chips' });
  dom.world.append(dom.svg, dom.frames, dom.chips);
  dom.popover = h('div', { class: 'popover', hidden: true });
  dom.zoomLabel = h('button', { class: 'zoom-label', title: 'Reset to 100%', onclick: () => zoomTo(1) }, '100%');
  dom.empty = h('div', { class: 'canvas-empty' },
    h('h2', {}, 'Drop MP4s anywhere on the canvas'),
    h('p', { class: 'muted' }, 'Each video becomes a frame. Drag from a frame\'s edge to another frame to connect them.'),
    h('button', { class: 'primary', onclick: () => fileInput.click() }, 'Add videos'),
  );
  dom.canvas = h('div', { class: 'canvas', tabIndex: 0 },
    dom.world,
    dom.empty,
    dom.popover,
    h('div', { class: 'zoom-ctl' },
      h('button', { title: 'Zoom out', onclick: () => zoomTo(state.view.z / 1.25) }, '−'),
      dom.zoomLabel,
      h('button', { title: 'Zoom in', onclick: () => zoomTo(state.view.z * 1.25) }, '+'),
      h('button', { title: 'Fit all frames', onclick: fitView }, 'Fit'),
    ),
    h('div', { class: 'canvas-hint' }, 'Drag a frame\'s edge to connect · drag empty space to pan · Ctrl/⌘ + scroll to zoom'),
  );
  dom.inspector = h('div', { class: 'inspector' });
  dom.frameEls = new Map();

  app.replaceChildren(h('div', { class: 'editor' },
    h('div', { class: 'topbar' },
      h('button', { class: 'ghost', title: 'All prototypes', onclick: () => (location.hash = '') }, '←'),
      h('input', {
        class: 'title', value: p.name, 'aria-label': 'Prototype name',
        oninput: e => { p.name = e.target.value; document.title = `${p.name} · Clip Proto`; save(); },
      }),
      h('span', { id: 'saved', class: 'saved' }, 'Saved'),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => fileInput.click() }, '+ Add videos'),
      fileInput,
      h('button', { onclick: copyLink }, 'Copy link'),
      h('button', { class: 'primary', onclick: () => window.open(playerUrl(), '_blank'), disabled: !p.clips.length }, '▶ Play'),
    ),
    h('div', { class: 'body' }, dom.canvas, dom.inspector),
  ));

  bindCanvas();
  renderAll();
}

function renderAll() {
  if (state.project?.mode === 'timeline') return state.timeline?.render();
  if (!dom.canvas?.isConnected) return;
  renderFrames();
  renderWires();
  renderPopover();
  renderInspector();
  dom.empty.hidden = state.project.clips.length > 0 || state.uploads.length > 0;
}

// ---------------------------------------------------------------- view

function applyView() {
  const { x, y, z } = state.view;
  dom.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  dom.world.style.setProperty('--z', z);
  dom.canvas.style.setProperty('--grid', `${24 * z}px`);
  dom.canvas.style.backgroundPosition = `${x}px ${y}px`;
  dom.zoomLabel.textContent = `${Math.round(z * 100)}%`;
  renderWires();
  positionPopover();
}

function toWorld(clientX, clientY) {
  const r = dom.canvas.getBoundingClientRect();
  return { x: (clientX - r.left - state.view.x) / state.view.z, y: (clientY - r.top - state.view.y) / state.view.z };
}

function toScreen(wx, wy) {
  return { x: wx * state.view.z + state.view.x, y: wy * state.view.z + state.view.y };
}

function zoomTo(z, cx, cy) {
  const r = dom.canvas.getBoundingClientRect();
  cx ??= r.width / 2;
  cy ??= r.height / 2;
  const nz = clamp(z, MIN_Z, MAX_Z);
  const v = state.view;
  v.x = cx - ((cx - v.x) / v.z) * nz;
  v.y = cy - ((cy - v.y) / v.z) * nz;
  v.z = nz;
  applyView();
}

function fitView() {
  const clips = state.project.clips;
  const r = dom.canvas.getBoundingClientRect();
  if (!clips.length) { state.view = { x: r.width / 2 - FRAME_W / 2, y: r.height / 2 - 90, z: 1 }; return applyView(); }
  const minX = Math.min(...clips.map(c => c.x)), minY = Math.min(...clips.map(c => c.y)) - 30;
  const maxX = Math.max(...clips.map(c => c.x + FRAME_W)), maxY = Math.max(...clips.map(c => c.y + frameH(c)));
  const pad = 60;
  const z = clamp(Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY)), MIN_Z, 1);
  state.view = { z, x: (r.width - (maxX - minX) * z) / 2 - minX * z, y: (r.height - (maxY - minY) * z) / 2 - minY * z };
  applyView();
}

function nextFreeSpot() {
  const clips = state.project.clips;
  if (!clips.length) {
    const r = dom.canvas.getBoundingClientRect();
    return toWorld(r.left + r.width / 2 - FRAME_W / 2 * state.view.z, r.top + r.height / 2 - 90 * state.view.z);
  }
  return { x: Math.max(...clips.map(c => c.x)) + FRAME_W + 140, y: Math.min(...clips.map(c => c.y)) };
}

// ---------------------------------------------------------------- frames

const posters = new Map(); // file -> Promise<dataURL | null>

// Whether this browser can decode a video at all (e.g. Chrome can't play
// MPEG-4 Part 2 "mp4v" exports). Unknown until checked; frames re-render then.
const playable = new Map(); // file -> true | false
const playChecks = new Set();
function checkPlayable(file) {
  if (playable.has(file) || playChecks.has(file)) return;
  playChecks.add(file);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  const done = ok => {
    if (playable.has(file)) return;
    playable.set(file, ok);
    v.removeAttribute('src');
    v.load();
    if (!ok) renderAll();
  };
  v.addEventListener('loadeddata', () => done(v.videoWidth > 0), { once: true });
  v.addEventListener('error', () => done(false), { once: true });
  setTimeout(() => done(true), 20000); // slow to load isn't the same as broken
  v.src = `/media/${file}`;
}

// Poster = the most "content-ful" of a few sampled frames, so clips that fade in
// from black don't get a black thumbnail.
function poster(file) {
  if (posters.has(file)) return posters.get(file);
  const job = new Promise(resolve => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = `/media/${file}`;
    const c = document.createElement('canvas');
    const g = c.getContext('2d', { willReadFrequently: true });
    let best = null;
    const seek = t => new Promise(r => { v.addEventListener('seeked', r, { once: true }); v.currentTime = t; });
    v.addEventListener('error', () => resolve(null), { once: true });
    v.addEventListener('loadeddata', async () => {
      c.width = 640;
      c.height = Math.round(640 * (v.videoHeight / v.videoWidth || 9 / 16));
      const d = v.duration || 1;
      for (const t of [Math.max(0, d - 0.05), d * 0.5, Math.min(0.1, d)]) {
        await seek(t);
        g.drawImage(v, 0, 0, c.width, c.height);
        const px = g.getImageData(0, 0, c.width, c.height).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 64) sum += px[i] + px[i + 1] + px[i + 2];
        if (!best || sum > best.sum) best = { sum, url: c.toDataURL('image/jpeg', 0.82) };
      }
      resolve(best?.url || null);
      v.removeAttribute('src');
      v.load();
    }, { once: true });
  });
  posters.set(file, job);
  return job;
}

function renderFrames() {
  const p = state.project;
  const alive = new Set();
  for (const c of p.clips) {
    alive.add(c.id);
    let f = dom.frameEls.get(c.id);
    if (f && f.file !== c.file) { f.el.remove(); dom.frameEls.delete(c.id); f = null; }
    if (!f) f = createFrame(c);
    f.el.style.left = `${c.x}px`;
    f.el.style.top = `${c.y}px`;
    f.el.style.width = `${FRAME_W}px`;
    f.el.style.height = `${frameH(c)}px`;
    f.el.classList.toggle('selected', state.sel?.type === 'clip' && state.sel.id === c.id);
    f.name.textContent = c.name;
    f.badge.hidden = c.id !== p.startClip;
    f.el.classList.toggle('broken', playable.get(c.file) === false);
  }
  for (const [id, f] of dom.frameEls) if (!alive.has(id)) { f.el.remove(); dom.frameEls.delete(id); }

  dom.frames.querySelectorAll('.frame.uploading').forEach(el => el.remove());
  for (const u of state.uploads) {
    dom.frames.append(h('div', { class: 'frame uploading', style: `left:${u.x}px;top:${u.y}px;width:${FRAME_W}px;height:${Math.round(FRAME_W * 9 / 16)}px` },
      h('div', { class: 'frame-label' }, h('span', { class: 'frame-name' }, u.name)),
      h('div', { class: 'frame-body' }, h('div', { class: 'upload-msg' }, `Uploading… ${Math.round(u.pct)}%`, h('div', { class: 'bar' }, h('div', { style: `width:${u.pct}%` })))),
    ));
  }
}

function createFrame(c) {
  const img = h('img', { class: 'poster', alt: '', draggable: 'false' });
  const body = h('div', { class: 'frame-body' }, img);
  const play = h('button', { class: 'play-btn', title: 'Preview video', 'aria-label': `Preview ${c.name}` });
  play.innerHTML = PLAY_ICON;
  const name = h('span', { class: 'frame-name' });
  const badge = h('span', { class: 'start-badge' }, '▶ Start');
  const el = h('div', { class: 'frame', 'data-id': c.id },
    h('div', { class: 'hit' }),
    h('div', { class: 'frame-label' }, badge, name),
    body,
    play,
    h('div', { class: 'broken-msg' }, h('strong', {}, "Can't play this video"), 'Select it and click Fix video'),
    h('div', { class: 'handle', title: 'Drag to connect' }),
  );
  const f = { el, body, img, play, name, badge, video: null, file: c.file };
  poster(c.file).then(url => { if (url) img.src = url; });
  checkPlayable(c.file);
  play.addEventListener('pointerdown', e => e.stopPropagation());
  play.addEventListener('click', e => { e.stopPropagation(); togglePreview(c, f); });
  dom.frames.append(el);
  dom.frameEls.set(c.id, f);
  return f;
}

function togglePreview(c, f) {
  if (!f.video) {
    f.video = h('video', { class: 'preview', src: `/media/${c.file}`, muted: true, loop: true, playsInline: true, autoplay: true });
    f.video.addEventListener('ended', () => setPlayIcon(f, false));
    f.body.append(f.video);
    setPlayIcon(f, true);
    return;
  }
  if (f.video.paused) { f.video.play(); setPlayIcon(f, true); }
  else { f.video.pause(); setPlayIcon(f, false); }
}

function setPlayIcon(f, playing) {
  f.play.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  f.el.classList.toggle('previewing', playing);
}

// ---------------------------------------------------------------- connector geometry

function rectOf(c) { return { x: c.x, y: c.y, w: FRAME_W, h: frameH(c) }; }

function pickSides(a, b) {
  const gap = 24;
  if (b.x >= a.x + a.w + gap) return ['right', 'left'];
  // Backwards along the same row: loop underneath instead of cutting through frames in between.
  const sameRow = b.y < a.y + a.h && b.y + b.h > a.y;
  if (b.x + b.w + gap <= a.x) return sameRow && b.h ? ['bottom', 'bottom'] : ['left', 'right'];
  if (b.y >= a.y + a.h) return ['bottom', 'top'];
  if (b.y + b.h <= a.y) return ['top', 'bottom'];
  return ['right', 'left'];
}

function pointOn(r, side, f) {
  switch (side) {
    case 'right': return { x: r.x + r.w, y: r.y + r.h * f };
    case 'left': return { x: r.x, y: r.y + r.h * f };
    case 'top': return { x: r.x + r.w * f, y: r.y };
    default: return { x: r.x + r.w * f, y: r.y + r.h };
  }
}

const NORMAL = { right: [1, 0], left: [-1, 0], top: [0, -1], bottom: [0, 1] };

function connectorGeometry() {
  const p = state.project;
  const list = [];
  for (const c of p.clips) {
    for (const t of c.triggers) {
      const to = clipById(t.to);
      if (!to || to === c) continue;
      const a = rectOf(c), b = rectOf(to);
      const [sa, sb] = pickSides(a, b);
      list.push({ from: c, to, t, a, b, sa, sb });
    }
  }
  // Spread several connectors leaving/entering the same side so they don't overlap.
  const spread = (keyFn, setFn, sortFn) => {
    const groups = new Map();
    for (const g of list) {
      const k = keyFn(g);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(g);
    }
    for (const arr of groups.values()) {
      arr.sort(sortFn);
      arr.forEach((g, i) => setFn(g, (i + 1) / (arr.length + 1)));
    }
  };
  const cross = (side, r) => (side === 'left' || side === 'right' ? r.y + r.h / 2 : r.x + r.w / 2);
  spread(g => `${g.from.id}|${g.sa}`, (g, f) => (g.fa = f), (m, n) => cross(m.sa, m.b) - cross(n.sa, n.b) || m.t.id.localeCompare(n.t.id));
  spread(g => `${g.to.id}|${g.sb}`, (g, f) => (g.fb = f), (m, n) => cross(m.sb, m.a) - cross(n.sb, n.a) || m.t.id.localeCompare(n.t.id));
  for (const g of list) {
    g.p1 = pointOn(g.a, g.sa, g.fa);
    g.p2 = pointOn(g.b, g.sb, g.fb);
    g.pts = elbow(g.p1, g.sa, g.p2, g.sb);
  }
  return list;
}

function elbow(p1, side, p2, side2) {
  if (side === 'bottom' && side2 === 'bottom') {
    const y = Math.max(p1.y, p2.y) + 48;
    return [p1, { x: p1.x, y }, { x: p2.x, y }, p2];
  }
  if (side === 'left' || side === 'right') {
    if (Math.abs(p1.y - p2.y) < 0.5) return [p1, p2];
    const mx = (p1.x + p2.x) / 2;
    return [p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2];
  }
  if (Math.abs(p1.x - p2.x) < 0.5) return [p1, p2];
  const my = (p1.y + p2.y) / 2;
  return [p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2];
}

function roundedPath(pts, radius) {
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y), d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    const a = { x: p1.x + ((p0.x - p1.x) / d1) * r, y: p1.y + ((p0.y - p1.y) / d1) * r };
    const b = { x: p1.x + ((p2.x - p1.x) / d2) * r, y: p1.y + ((p2.y - p1.y) / d2) * r };
    d += ` L${a.x},${a.y} Q${p1.x},${p1.y} ${b.x},${b.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x},${last.y}`;
}

function midpoint(pts) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segs.push(len);
    total += len;
  }
  let half = total / 2;
  for (let i = 0; i < segs.length; i++) {
    if (half <= segs[i]) {
      const k = segs[i] ? half / segs[i] : 0;
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * k, y: pts[i].y + (pts[i + 1].y - pts[i].y) * k };
    }
    half -= segs[i];
  }
  return pts[0];
}

function arrowHead(tip, from, size) {
  const dx = tip.x - from.x, dy = tip.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const bx = tip.x - ux * size, by = tip.y - uy * size;
  const w = size * 0.6;
  return `${tip.x},${tip.y} ${bx - uy * w},${by + ux * w} ${bx + uy * w},${by - ux * w}`;
}

function triggerText(t) {
  if (t.type === 'end') return t.delay ? `On end +${+(t.delay / 1000).toFixed(2)}s` : 'On end';
  if (t.type === 'click') return 'Click';
  return t.label || 'Set key';
}

// ---------------------------------------------------------------- connector rendering

function renderWires() {
  if (!dom.wireLayer) return;
  const z = state.view.z;
  const u = 1 / z; // one screen pixel in canvas units
  const dragging = state.drag?.type === 'reconnect' ? state.drag.connId : null;
  dom.wireLayer.replaceChildren();
  dom.chips.replaceChildren();

  for (const g of connectorGeometry()) {
    if (g.t.id === dragging) continue;
    const selected = state.sel?.type === 'conn' && state.sel.id === g.t.id;
    const d = roundedPath(g.pts, 14 * u);
    const grp = s('g', { class: `wire${selected ? ' selected' : ''}${g.t.type === 'key' && !g.t.code ? ' incomplete' : ''}`, 'data-conn': g.t.id });
    grp.append(
      s('path', { class: 'wire-hit', d, 'stroke-width': 14 * u }),
      s('path', { class: 'wire-line', d, 'stroke-width': (selected ? 2.5 : 2) * u }),
      s('circle', { class: 'wire-dot', cx: g.p1.x, cy: g.p1.y, r: 4.5 * u, 'stroke-width': 2 * u }),
      s('polygon', { class: 'wire-arrow', points: arrowHead(g.p2, g.pts[g.pts.length - 2], 10 * u) }),
    );
    if (selected) {
      for (const [end, pt] of [['from', g.p1], ['to', g.p2]]) {
        grp.append(s('circle', { class: 'wire-handle', 'data-end': end, cx: pt.x, cy: pt.y, r: 6 * u, 'stroke-width': 2 * u }));
      }
    }
    dom.wireLayer.append(grp);

    const m = midpoint(g.pts);
    dom.chips.append(h('div', {
      class: `chip${selected ? ' selected' : ''}${g.t.type === 'key' && !g.t.code ? ' incomplete' : ''}`,
      'data-conn': g.t.id,
      style: `left:${m.x}px;top:${m.y}px`,
    }, [
      triggerText(g.t),
      g.t.anim?.type === 'dissolve' ? ' · Dissolve' : '',
      g.t.reverse?.enabled ? ` · ${g.t.reverse.label || '?'} back` : '',
    ].join('')));
  }
}

function drawTemp(p1, side, p2) {
  const u = 1 / state.view.z;
  dom.tempLayer.replaceChildren();
  if (!p1) return;
  const [nx, ny] = NORMAL[side] || [1, 0];
  const k = Math.max(40 * u, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2.5);
  const d = `M${p1.x},${p1.y} C${p1.x + nx * k},${p1.y + ny * k} ${p2.x},${p2.y} ${p2.x},${p2.y}`;
  dom.tempLayer.append(
    s('path', { class: 'wire-line temp', d, 'stroke-width': 2 * u }),
    s('circle', { class: 'wire-dot', cx: p1.x, cy: p1.y, r: 4.5 * u, 'stroke-width': 2 * u }),
    s('circle', { class: 'wire-cursor', cx: p2.x, cy: p2.y, r: 4 * u }),
  );
}

// ---------------------------------------------------------------- canvas interaction

function frameAt(wx, wy, slack = 0) {
  const clips = state.project.clips;
  for (let i = clips.length - 1; i >= 0; i--) {
    const r = rectOf(clips[i]);
    if (wx >= r.x - slack && wx <= r.x + r.w + slack && wy >= r.y - slack && wy <= r.y + r.h + slack) return clips[i];
  }
  return null;
}

// Distance (in screen px) from a point to the frame's border; negative = inside.
function edgeInfo(c, wx, wy) {
  const r = rectOf(c);
  const dl = wx - r.x, dr = r.x + r.w - wx, dt = wy - r.y, db = r.y + r.h - wy;
  const inside = Math.min(dl, dr, dt, db);
  const side = inside === dl ? 'left' : inside === dr ? 'right' : inside === dt ? 'top' : 'bottom';
  return { side, px: inside * state.view.z };
}

function setHoverFrame(id) {
  for (const [cid, f] of dom.frameEls) f.el.classList.toggle('target', cid === id);
}

function bindCanvas() {
  const cv = dom.canvas;

  cv.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = cv.getBoundingClientRect();
      zoomTo(state.view.z * Math.exp(-e.deltaY * 0.0025 * (e.deltaMode ? 30 : 1)), e.clientX - r.left, e.clientY - r.top);
    } else {
      state.view.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      state.view.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      applyView();
    }
  }, { passive: false });

  cv.addEventListener('pointermove', e => {
    if (state.drag) return onDragMove(e);
    // Hover feedback: crosshair on frame edges.
    const w = toWorld(e.clientX, e.clientY);
    const c = frameAt(w.x, w.y, EDGE_PX / state.view.z);
    let edgeId = null;
    if (c && !e.target.closest('.play-btn')) {
      const { px } = edgeInfo(c, w.x, w.y);
      if (px < EDGE_PX || e.target.closest('.handle')) edgeId = c.id;
    }
    for (const [cid, f] of dom.frameEls) {
      f.el.classList.toggle('edge', cid === edgeId);
      f.el.classList.toggle('hover', c?.id === cid);
    }
  });

  cv.addEventListener('pointerleave', () => {
    if (state.drag) return;
    for (const f of dom.frameEls.values()) f.el.classList.remove('edge', 'hover');
  });

  cv.addEventListener('pointerdown', e => {
    if (e.target.closest('.popover, .zoom-ctl, .canvas-empty button')) return;
    cv.focus({ preventScroll: true });
    if (state.listening) { state.listening = null; renderPopover(); }
    const w = toWorld(e.clientX, e.clientY);
    const start = { sx: e.clientX, sy: e.clientY, w, moved: false };

    if (e.button === 1 || state.spaceDown) {
      e.preventDefault();
      return beginDrag(e, { type: 'pan', ...start, vx: state.view.x, vy: state.view.y });
    }
    if (e.button !== 0) return;

    const handle = e.target.closest('.wire-handle');
    if (handle) {
      const connId = handle.closest('[data-conn]').dataset.conn;
      return beginDrag(e, { type: 'reconnect', ...start, connId, end: handle.dataset.end });
    }
    const connEl = e.target.closest('[data-conn]');
    if (connEl) return beginDrag(e, { type: 'conn-click', ...start, connId: connEl.dataset.conn });

    const c = frameAt(w.x, w.y, EDGE_PX / state.view.z);
    if (c) {
      const edge = edgeInfo(c, w.x, w.y);
      if (edge.px < EDGE_PX || e.target.closest('.handle')) {
        const side = e.target.closest('.handle') ? 'right' : edge.side;
        const r = rectOf(c);
        const p1 = side === 'right' && e.target.closest('.handle') ? { x: r.x + r.w, y: r.y + r.h / 2 } : snapToEdge(r, side, w);
        return beginDrag(e, { type: 'connect', ...start, from: c.id, side, p1 });
      }
      return beginDrag(e, { type: 'move', ...start, id: c.id, ox: c.x, oy: c.y });
    }
    beginDrag(e, { type: 'pan', ...start, vx: state.view.x, vy: state.view.y, deselect: true });
  });

  cv.addEventListener('pointerup', onDragEnd);
  cv.addEventListener('pointercancel', onDragEnd);

  cv.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); cv.classList.add('file-over'); } });
  cv.addEventListener('dragleave', e => { if (e.target === cv) cv.classList.remove('file-over'); });
  cv.addEventListener('drop', e => {
    e.preventDefault();
    cv.classList.remove('file-over');
    if (e.dataTransfer.files.length) {
      const w = toWorld(e.clientX, e.clientY);
      uploadFiles(e.dataTransfer.files, { x: w.x - FRAME_W / 2, y: w.y - 90 });
    }
  });

  new ResizeObserver(() => positionPopover()).observe(cv);
}

function snapToEdge(r, side, w) {
  const pt = { x: clamp(w.x, r.x, r.x + r.w), y: clamp(w.y, r.y, r.y + r.h) };
  if (side === 'left') pt.x = r.x;
  if (side === 'right') pt.x = r.x + r.w;
  if (side === 'top') pt.y = r.y;
  if (side === 'bottom') pt.y = r.y + r.h;
  return pt;
}

function beginDrag(e, drag) {
  state.drag = drag;
  dom.canvas.setPointerCapture(e.pointerId);
  if (drag.type === 'pan') dom.canvas.classList.add('panning');
}

function onDragMove(e) {
  const d = state.drag;
  const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
  if (!d.moved && Math.hypot(dx, dy) > 3) {
    d.moved = true;
    if (d.type === 'move') snapshot();
    if (d.type === 'reconnect') { renderWires(); }
  }
  if (!d.moved) return;
  const w = toWorld(e.clientX, e.clientY);

  if (d.type === 'pan') {
    state.view.x = d.vx + dx;
    state.view.y = d.vy + dy;
    applyView();
  } else if (d.type === 'move') {
    const c = clipById(d.id);
    c.x = Math.round(d.ox + dx / state.view.z);
    c.y = Math.round(d.oy + dy / state.view.z);
    const f = dom.frameEls.get(c.id);
    f.el.style.left = `${c.x}px`;
    f.el.style.top = `${c.y}px`;
    renderWires();
    positionPopover();
  } else if (d.type === 'connect' || d.type === 'reconnect') {
    const target = frameAt(w.x, w.y);
    let anchor, side, tip = w;
    if (d.type === 'connect') {
      anchor = d.p1; side = d.side;
    } else {
      const { from, t } = findConn(d.connId);
      // Keep the fixed end anchored on its frame, on the side facing the pointer.
      const or = rectOf(d.end === 'to' ? from : clipById(t.to));
      side = pickSides(or, { x: w.x, y: w.y, w: 0, h: 0 })[0];
      anchor = pointOn(or, side, 0.5);
    }
    const valid = target && (d.type === 'connect' ? target.id !== d.from : true);
    setHoverFrame(valid ? target.id : null);
    drawTemp(anchor, side, tip);
  }
}

function onDragEnd(e) {
  const d = state.drag;
  if (!d) return;
  state.drag = null;
  dom.canvas.classList.remove('panning');
  try { dom.canvas.releasePointerCapture(e.pointerId); } catch {}
  dom.tempLayer.replaceChildren();
  setHoverFrame(null);
  const w = toWorld(e.clientX, e.clientY);

  if (d.type === 'pan') {
    if (!d.moved && d.deselect && state.sel) { state.sel = null; renderAll(); }
  } else if (d.type === 'move') {
    if (d.moved) save();
    state.sel = { type: 'clip', id: d.id };
    renderAll();
  } else if (d.type === 'conn-click') {
    state.sel = { type: 'conn', id: d.connId };
    renderAll();
  } else if (d.type === 'connect') {
    const target = frameAt(w.x, w.y);
    if (!d.moved || !target || target.id === d.from) return;
    const from = clipById(d.from);
    const t = { id: uid(), type: 'key', code: null, label: null, to: target.id, anim: { type: 'instant', duration: 300 } };
    commit(() => from.triggers.push(t));
    state.sel = { type: 'conn', id: t.id };
    renderAll();
    // Ask for the key right away — after this pointerup's click event has passed.
    setTimeout(() => { state.listening = t; renderPopover(); }, 0);
  } else if (d.type === 'reconnect') {
    const conn = findConn(d.connId);
    if (!conn || !d.moved) { renderWires(); return; }
    const target = frameAt(w.x, w.y);
    if (!target) {
      // Dropped on empty canvas: remove the connector (like Figma).
      commit(() => { conn.from.triggers = conn.from.triggers.filter(x => x !== conn.t); });
      state.sel = null;
      renderAll();
      toast('Connection removed — Ctrl+Z to undo');
      return;
    }
    commit(() => {
      if (d.end === 'to') {
        if (target.id !== conn.from.id) conn.t.to = target.id;
      } else if (target.id !== conn.t.to && target !== conn.from) {
        conn.from.triggers = conn.from.triggers.filter(x => x !== conn.t);
        if (conn.t.type === 'end' && target.triggers.some(x => x.type === 'end')) conn.t.type = 'key';
        target.triggers.push(conn.t);
      }
    });
  }
}

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', e => {
  // Key capture for a key-press trigger. Capture phase so it never reaches inputs.
  const t = state.listening;
  if (t) {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    snapshot();
    t.code = e.code;
    t.label = keyLabel(e);
    state.listening = null;
    save();
    renderAll();
    return;
  }
  if (!state.project || state.project.mode === 'timeline' || !dom.canvas?.isConnected || isTyping()) return;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) restore(state.redo, state.undo);
    else restore(state.undo, state.redo);
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    restore(state.redo, state.undo);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel) {
    e.preventDefault();
    deleteSelection();
  } else if (e.key === 'Escape') {
    state.sel = null;
    renderAll();
  } else if (e.code === 'Space' && !state.spaceDown) {
    state.spaceDown = true;
    dom.canvas.classList.add('space');
    e.preventDefault();
  } else if (e.shiftKey && e.key === '!') {
    fitView();
  }
}, true);

window.addEventListener('keyup', e => {
  if (e.code === 'Space') {
    state.spaceDown = false;
    dom.canvas?.classList.remove('space');
  }
});

function deleteSelection() {
  const sel = state.sel;
  if (sel?.type === 'conn') {
    const conn = findConn(sel.id);
    if (!conn) return;
    commit(() => { conn.from.triggers = conn.from.triggers.filter(x => x !== conn.t); });
    state.sel = null;
    renderAll();
  } else if (sel?.type === 'clip') {
    const c = clipById(sel.id);
    if (c) deleteClip(c);
  }
}

// Removes the clip and every connector pointing at it.
function deleteClip(c) {
  const p = state.project;
  commit(() => {
    p.clips = p.clips.filter(x => x !== c);
    for (const o of p.clips) o.triggers = o.triggers.filter(t => t.to !== c.id);
    p.globalTriggers = p.globalTriggers.filter(t => t.to !== c.id);
    if (p.startClip === c.id) p.startClip = p.clips[0]?.id || null;
    state.sel = null;
  });
  toast(`Deleted "${c.name}" — Ctrl+Z to undo`);
}

// ---------------------------------------------------------------- connector popover

function renderPopover() {
  const pop = dom.popover;
  if (!pop) return;
  const conn = state.sel?.type === 'conn' ? findConn(state.sel.id) : null;
  if (!conn) { pop.hidden = true; return; }
  const { from, t } = conn;
  t.anim ||= { type: 'instant', duration: 300 };
  const otherEnd = from.triggers.find(x => x.type === 'end' && x !== t);

  const set = fn => commit(fn);
  const seg = (options, value, onPick) => h('div', { class: 'seg' }, options.map(o => h('button', {
    class: value === o.value ? 'on' : '',
    disabled: o.disabled,
    title: o.title,
    onclick: () => onPick(o.value),
  }, o.label)));

  const keepScroll = pop.hidden || pop.dataset.conn !== t.id ? 0 : pop.scrollTop;
  pop.dataset.conn = t.id;
  queueMicrotask(() => { pop.scrollTop = keepScroll; });
  pop.replaceChildren(...[
    h('div', { class: 'pop-head' },
      h('strong', {}, 'Interaction'),
      h('span', { class: 'muted pop-route' }, `${from.name} → ${clipById(t.to)?.name || '?'}`),
      h('button', { class: 'ghost icon', title: 'Close', onclick: () => { state.sel = null; renderAll(); } }, '✕'),
    ),
    h('div', { class: 'pop-field' },
      h('span', {}, 'Trigger'),
      seg([
        { value: 'key', label: 'Key press' },
        { value: 'click', label: 'Click' },
        { value: 'end', label: 'After video ends', disabled: !!otherEnd, title: otherEnd ? 'This clip already has an "after video ends" connection' : null },
      ], t.type, v => {
        set(() => { t.type = v; if (v !== 'key') { delete t.code; delete t.label; } if (v !== 'end') delete t.delay; });
        if (v === 'key' && !t.code) { state.listening = t; renderPopover(); }
      }),
    ),
    t.type === 'key' ? h('div', { class: 'pop-field' },
      h('span', {}, 'Key'),
      h('button', {
        class: `keycap${state.listening === t ? ' listening' : ''}`,
        onclick: e => { e.stopPropagation(); state.listening = t; renderPopover(); },
      }, state.listening === t ? 'Press a key…' : t.label || 'Click to set'),
      duplicateKeyWarning(from, t),
    ) : null,
    t.type === 'end' ? h('div', { class: 'pop-field' },
      h('span', {}, 'Delay'),
      h('label', { class: 'inline' },
        h('input', {
          type: 'number', min: 0, max: 60000, step: 100, value: String(t.delay || 0),
          onchange: e => set(() => { const d = clamp(Math.round(Number(e.target.value) || 0), 0, 60000); if (d) t.delay = d; else delete t.delay; }),
        }), 'ms'),
      h('p', { class: 'hint' }, t.delay
        ? `When this clip finishes, its last frame stays on screen for ${+(t.delay / 1000).toFixed(2)}s, then the next clip plays (looping is turned off for this clip).`
        : 'Plays the next clip as soon as this one finishes (looping is turned off for this clip). Add a delay to hold the last frame first.'),
    ) : null,
    h('div', { class: 'pop-field' },
      h('span', {}, 'Navigate to'),
      h('select', { onchange: e => set(() => { t.to = e.target.value; }) },
        state.project.clips.filter(c => c !== from).map(c => h('option', { value: c.id, selected: c.id === t.to }, c.name))),
    ),
    h('div', { class: 'pop-field' },
      h('span', {}, 'Animation'),
      seg([{ value: 'instant', label: 'Instant' }, { value: 'dissolve', label: 'Dissolve' }], t.anim.type, v => set(() => { t.anim.type = v; })),
      t.anim.type === 'dissolve' ? h('label', { class: 'inline' },
        h('input', {
          type: 'number', min: 50, max: 3000, step: 50, value: String(t.anim.duration || 300),
          onchange: e => set(() => { t.anim.duration = clamp(Number(e.target.value) || 300, 50, 3000); }),
        }), 'ms') : null,
    ),
    reverseSection(from, t),
    h('div', { class: 'pop-foot' },
      h('button', { class: 'danger-text', onclick: deleteSelection }, 'Delete connection'),
      h('span', { class: 'muted' }, 'or drag an end into empty space'),
    ),
  ].filter(Boolean));
  pop.hidden = false;
  positionPopover();
}

// ---------------------------------------------------------------- reverse interactions
//
// A connector A → B can also go back: pressing the back key while on B plays
// a video backwards and lands on A. Browsers can't play backwards smoothly, so
// a reversed copy of the chosen video is made once (reverse.js), uploaded, and
// cached per source file in project.reversed.

const reverseSource = (from, t) => (t.reverse?.clip === 'from' ? from : clipById(t.to));

function reverseSection(from, t) {
  const to = clipById(t.to);
  const r = t.reverse;
  const toggle = h('label', { class: 'row rev-toggle' },
    h('input', { type: 'checkbox', checked: !!r?.enabled, onchange: e => toggleReverse(t, e.target.checked) }),
    h('strong', {}, 'Reverse with a key'));
  if (!r?.enabled) {
    return h('div', { class: 'pop-field rev' }, toggle,
      h('p', { class: 'hint' }, `Press a key while on ${to?.name} to rewind back to ${from.name}.`));
  }

  const src = reverseSource(from, t);
  const job = src && state.revJobs.get(src.file);
  let status = null;
  if (job?.error) {
    status = h('p', { class: 'warn' }, `Couldn't make the reversed video: ${job.error} `,
      h('button', { class: 'link-btn', onclick: () => ensureReversed(src.file) }, 'Retry'));
  } else if (job) {
    status = h('div', { class: 'rev-progress' }, `Making reversed video… ${Math.round(job.pct * 100)}%`,
      h('div', { class: 'bar' }, h('div', { style: `width:${job.pct * 100}%` })));
  } else if (r.file) {
    status = h('p', { class: 'hint ok' }, '✓ Reversed video ready');
  }

  return h('div', { class: 'pop-field rev' },
    toggle,
    h('span', {}, `Back key (while on ${to?.name})`),
    h('button', {
      class: `keycap${state.listening === r ? ' listening' : ''}`,
      onclick: e => { e.stopPropagation(); state.listening = r; renderPopover(); },
    }, state.listening === r ? 'Press a key…' : r.label || 'Click to set'),
    reverseKeyWarning(to, r),
    h('span', {}, 'Plays backwards'),
    h('div', { class: 'seg' }, [['to', to?.name], ['from', from.name]].map(([value, label]) => h('button', {
      class: (r.clip || 'to') === value ? 'on' : '',
      title: label,
      onclick: () => commit(() => { r.clip = value; }),
    }, label))),
    h('p', { class: 'hint' }, (r.clip || 'to') === 'to'
      ? `Rewinds ${to?.name} and stops on the last frame of ${from.name} — smooth when ${from.name} ends where ${to?.name} begins.`
      : `Rewinds ${from.name} and stops on its first frame.`),
    status,
  );
}

function toggleReverse(t, on) {
  commit(() => {
    t.reverse = { clip: 'to', code: null, label: null, ...(t.reverse || {}), enabled: on };
  });
  if (on && !t.reverse.code) setTimeout(() => { state.listening = t.reverse; renderPopover(); }, 0);
}

function reverseKeyWarning(to, r) {
  if (!r.code || !to) return null;
  if (to.triggers.some(x => x.type === 'key' && x.code === r.code)) {
    return h('p', { class: 'warn' }, `${to.name} already uses ${r.label} for a forward connection, which takes priority.`);
  }
  const others = state.project.clips.flatMap(c => c.triggers.filter(x => x.to === to.id && x.reverse?.enabled && x.reverse !== r && x.reverse.code === r.code));
  // Fine: the player remembers the route taken and rewinds only that one.
  return others.length ? h('p', { class: 'hint' }, `${r.label} also goes back along another route into ${to.name}. The player rewinds whichever route was actually taken.`) : null;
}

// Point every reverse-enabled connector at its cached reversed file, and start
// making any that are missing. Runs after every change (reconnecting a
// connector or switching which clip plays backwards changes the source).
function reconcileReverse() {
  const p = state.project;
  for (const c of p.clips) {
    for (const t of c.triggers) {
      if (!t.reverse?.enabled) continue;
      const src = reverseSource(c, t);
      const cached = src && p.reversed?.[src.file];
      t.reverse.file = cached?.file || null;
      t.reverse.size = cached?.size || 0;
      // When the source comes to rest (trimmed copies only); the player waits for it.
      if (cached?.settle != null) t.reverse.settle = cached.settle; else delete t.reverse.settle;
      if (src && !cached && !state.revJobs.has(src.file)) ensureReversed(src.file);
    }
  }
}

let revRenderQueued = false;
function renderReverseProgress() {
  if (revRenderQueued) return;
  revRenderQueued = true;
  requestAnimationFrame(() => {
    revRenderQueued = false;
    if (state.project?.mode === 'timeline') state.timeline?.renderInspector();
    else renderPopover();
  });
}

async function ensureReversed(file) {
  const existing = state.revJobs.get(file);
  if (existing && !existing.error) return;
  const job = { pct: 0, error: null };
  state.revJobs.set(file, job);
  renderReverseProgress();
  try {
    // Canvas rewinds skip the source's final still; single-video prototypes need the full copy.
    const trimStill = state.project.mode !== 'timeline';
    const { blob, settle } = await reverseVideo(`/media/${file}`, pct => { job.pct = pct; renderReverseProgress(); }, { trimStill });
    const r = await fetch('/api/upload', { method: 'POST', headers: { 'x-filename': `reversed-${file.replace(/\.\w+$/, '')}.mp4` }, body: blob });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || 'upload failed');
    state.project.reversed ||= {};
    state.project.reversed[file] = { file: res.file, size: res.size, ...(trimStill ? { settle } : {}) };
    state.revJobs.delete(file);
    reconcileReverse();
    save();
    renderAll();
  } catch (e) {
    job.error = e.message || String(e);
    renderAll();
  }
}

function duplicateKeyWarning(from, t) {
  if (!t.code) return null;
  const dup = from.triggers.find(x => x !== t && x.type === 'key' && x.code === t.code);
  return dup ? h('p', { class: 'warn' }, `${t.label} is also used for → ${clipById(dup.to)?.name}. The first one wins.`) : null;
}

function positionPopover() {
  const pop = dom.popover;
  if (!pop || pop.hidden) return;
  const g = connectorGeometry().find(x => x.t.id === state.sel?.id);
  if (!g) return;
  const m = toScreen(...Object.values(midpoint(g.pts)));
  const cw = dom.canvas.clientWidth, ch = dom.canvas.clientHeight;
  // Below or above the connector (frames sit beside it) — whichever has more
  // room. It never covers the connector; if it's too tall it scrolls instead.
  const gap = 22, margin = 12;
  const below = ch - margin - (m.y + gap), above = m.y - gap - margin;
  pop.style.maxHeight = 'none';
  const ph = pop.offsetHeight, pw = pop.offsetWidth;
  const useBelow = below >= ph || below >= above;
  const room = Math.max(120, useBelow ? below : above);
  const height = Math.min(ph, room);
  pop.style.maxHeight = `${room}px`;
  pop.style.left = `${clamp(m.x - pw / 2, margin, Math.max(margin, cw - pw - margin))}px`;
  pop.style.top = `${useBelow ? m.y + gap : m.y - gap - height}px`;
}

// ---------------------------------------------------------------- inspector

function clipOptions(selected, placeholder = 'Choose clip…') {
  return [
    h('option', { value: '', selected: !selected }, placeholder),
    ...state.project.clips.map(c => h('option', { value: c.id, selected: c.id === selected }, c.name)),
  ];
}

function renderInspector() {
  const p = state.project;
  const c = state.sel?.type === 'clip' ? clipById(state.sel.id) : null;
  const sections = [];

  if (c) {
    const hasEnd = c.triggers.some(t => t.type === 'end');
    sections.push(h('div', { class: 'section' },
      h('h3', {}, 'Frame'),
      h('label', { class: 'field' }, h('span', {}, 'Name'),
        h('input', {
          value: c.name,
          onfocus: () => snapshot(),
          oninput: e => { c.name = e.target.value; dom.frameEls.get(c.id).name.textContent = c.name; save(); },
        })),
      h('p', { class: 'hint' }, [c.width && `${c.width}×${c.height}`, fmtTime(c.duration), c.size && fmtSize(c.size)].filter(Boolean).join(' · ')),
      h('div', { class: 'row' },
        c.id === p.startClip
          ? h('span', { class: 'muted' }, h('span', { class: 'badge' }, 'Start'), 'Prototype starts here')
          : h('button', { onclick: () => commit(() => { p.startClip = c.id; }) }, 'Set as start'),
        h('button', { onclick: () => window.open(`${playerUrl()}?start=${c.id}`, '_blank') }, 'Play from here'),
      ),
      h('label', { class: 'field' }, h('span', {}, 'When it ends'),
        hasEnd
          ? h('p', { class: 'hint' }, 'Goes to the next clip — it has an "after video ends" connection.')
          : h('select', { onchange: e => commit(() => { c.end.type = e.target.value; }) },
            h('option', { value: 'loop', selected: c.end.type === 'loop' }, 'Loop'),
            h('option', { value: 'hold', selected: c.end.type === 'hold' }, 'Hold last frame'),
          )),
      fixSection(c),
      h('div', { class: 'row' },
        confirmButton({ cls: 'danger-outline', label: `${TRASH_ICON} Delete frame`, armedLabel: 'Click again to delete', title: `Delete ${c.name}`, onConfirm: () => deleteClip(c) }),
      ),
    ));
  }

  if (!c) {
    sections.push(h('div', { class: 'section' },
      h('h3', {}, 'Prototype'),
      h('label', { class: 'field' }, h('span', {}, 'Starts on'),
        h('select', { onchange: e => commit(() => { p.startClip = e.target.value || null; }) }, clipOptions(p.startClip))),
      h('label', { class: 'field' }, h('span', {}, 'Scaling'),
        h('select', { onchange: e => commit(() => { p.fit = e.target.value; }) },
          h('option', { value: 'contain', selected: p.fit !== 'cover' }, 'Fit (letterbox)'),
          h('option', { value: 'cover', selected: p.fit === 'cover' }, 'Fill (crop)'),
        )),
      h('label', { class: 'row' },
        h('input', { type: 'checkbox', checked: !!p.sound, onchange: e => commit(() => { p.sound = e.target.checked; }) }),
        'Play audio (starts after the first key press)'),
    ));
    sections.push(globalTriggersSection());
  }

  sections.push(publishSection(), localSection());

  dom.inspector.replaceChildren(...sections);
}

// ---------------------------------------------------------------- fix video
//
// Re-encodes the frame's video as plain H.264 (video only) in the browser —
// for exports browsers can't play, or that play badly — then swaps the new
// file in. Connections stay; undo goes back to the original file.

const FIX_PHASES = {
  download: 'Reading the video…',
  load: 'Loading the converter (about 32 MB, first time only)…',
  convert: 'Converting…',
};

function fixSection(c) {
  const job = state.fixJobs.get(c.id);
  const broken = playable.get(c.file) === false;
  if (job && !job.error) {
    return h('div', { class: 'field fix' },
      h('span', {}, 'Fix video'),
      h('div', { class: 'rev-progress', 'data-fix': c.id }, fixStatus(job)));
  }
  return h('div', { class: 'field fix' },
    h('span', {}, 'Fix video'),
    job?.error ? h('p', { class: 'warn' }, `Couldn't fix the video: ${job.error}`)
      : broken ? h('p', { class: 'warn' }, "This browser can't play this video (it uses an unsupported format). Fix it to convert it to standard H.264.")
        : h('p', { class: 'hint' }, "Converts the video to standard H.264 without sound. Use it if the video doesn't play, or stutters."),
    h('div', { class: 'row' }, h('button', { class: broken ? 'primary' : '', onclick: () => fixClip(c.id) }, job?.error ? 'Try again' : 'Fix video')),
  );
}

function fixStatus(job) {
  const pct = job.phase === 'convert' ? job.pct : 0;
  return [
    `${FIX_PHASES[job.phase] || 'Working…'}${job.phase === 'convert' ? ` ${Math.round(pct * 100)}%` : ''}`,
    h('div', { class: 'bar' }, h('div', { style: `width:${pct * 100}%` })),
  ];
}

// Progress updates only touch the status line, so typing in the panel isn't interrupted.
function updateFixStatus(id) {
  const el = document.querySelector(`[data-fix="${id}"]`);
  const job = state.fixJobs.get(id);
  if (el && job) el.replaceChildren(...fixStatus(job));
}

async function fixClip(id) {
  const c = clipById(id);
  if (!c) return;
  const running = state.fixJobs.get(id);
  if (running && !running.error) return;
  const file = c.file;
  const job = { phase: 'download', pct: 0, error: null };
  state.fixJobs.set(id, job);
  renderInspector();
  try {
    const blob = await fixVideo(`/media/${file}`, (phase, pct) => {
      job.phase = phase;
      job.pct = pct;
      updateFixStatus(id);
    });
    const name = `${(c.name || 'video').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'video'}-fixed.mp4`;
    const r = await fetch('/api/upload', { method: 'POST', headers: { 'x-filename': encodeURIComponent(name) }, body: blob });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || 'upload failed');
    const meta = await probe(`/media/${res.file}`);
    if (!meta.width) throw new Error("the converted video still won't play in this browser");
    playable.set(res.file, true);
    state.fixJobs.delete(id);
    const clip = clipById(id);
    // Only swap if the frame still shows the video that was converted.
    if (clip && clip.file === file) {
      commit(() => Object.assign(clip, { file: res.file, size: res.size, ...meta }));
      toast(`${clip.name}: video fixed`);
    } else renderAll();
  } catch (e) {
    job.error = e.message || String(e);
    renderAll();
  }
}

function globalTriggersSection() {
  const list = state.project.globalTriggers;
  return h('div', { class: 'section' },
    h('h3', {}, 'From any frame'),
    h('p', { class: 'hint' }, 'Keys that work everywhere, unless the current frame has its own connection for that key — e.g. R → start to restart.'),
    ...list.map(t => h('div', { class: 'trigger' },
      t.type === 'key'
        ? h('button', { class: `keycap${state.listening === t ? ' listening' : ''}`, onclick: e => { e.stopPropagation(); state.listening = t; renderInspector(); } }, state.listening === t ? 'Press a key…' : t.label || 'Set key')
        : h('button', { class: 'keycap', disabled: true }, 'Click'),
      h('select', { 'aria-label': 'Go to', onchange: e => commit(() => { t.to = e.target.value || null; }) }, clipOptions(t.to, 'Go to…')),
      h('button', { class: 'ghost danger', title: 'Remove', onclick: () => commit(() => list.splice(list.indexOf(t), 1)) }, '✕'),
    )),
    h('div', { class: 'row' },
      h('button', { onclick: e => { e.stopPropagation(); const t = { id: uid(), type: 'key', code: null, label: null, to: null }; commit(() => list.push(t)); state.listening = t; renderInspector(); } }, '+ Key'),
    ),
  );
}

const hasMedia = p => (p.mode === 'timeline' ? !!p.video : p.clips.length > 0);

function localSection() {
  const p = state.project;
  if (state.hosted) {
    return h('div', { class: 'section' },
      h('h3', {}, 'Offline file'),
      h('p', { class: 'hint' }, `One .html file with every video inside (about ${fmtSize(offlineBytes(p))}). Share it on Teams, SharePoint or email — viewers double-click it; no internet or server needed.`),
      h('div', { class: 'row' }, h('button', { onclick: e => buildOfflineFile(e.currentTarget), disabled: !hasMedia(p) }, 'Download offline file')),
    );
  }
  return h('div', { class: 'section' },
    h('h3', {}, 'Local preview'),
    h('div', { class: 'link-box' }, h('input', { readOnly: true, value: playerUrl(), onfocus: e => e.target.select() })),
    state.lan.length ? h('p', { class: 'hint' }, 'Same Wi-Fi: ', state.lan.map(b => playerUrl(b)).join(', ')) : null,
    h('div', { class: 'row' }, h('button', { onclick: exportFolder, disabled: !hasMedia(p) }, 'Export folder')),
    h('h3', { class: 'sub-h' }, 'Offline file'),
    h('p', { class: 'hint' }, `One .html file with every video inside (about ${fmtSize(offlineBytes(p))}). Share it on Teams, SharePoint or email — viewers double-click it; no internet or server needed.`),
    h('div', { class: 'row' },
      hasMedia(p)
        ? h('a', { class: 'button-link', href: `/api/projects/${p.id}/offline`, download: '' }, 'Download offline file')
        : h('button', { disabled: true }, 'Download offline file'),
    ),
  );
}

// Every media file the player loads (same rule as server.js mediaFiles).
function mediaFiles(p) {
  const files = p.clips.map(c => c.file);
  for (const t of p.clips.flatMap(c => c.triggers || [])) if (t.reverse?.enabled && t.reverse.file && t.reverse.code) files.push(t.reverse.file);
  if (p.mode === 'timeline' && p.video) {
    files.push(p.video.file);
    const rev = p.keys?.back?.enabled && p.keys.back.code && p.reversed?.[p.video.file];
    if (rev) files.push(rev.file);
  }
  return [...new Set(files)];
}

// Hosted version: build the offline .html in the browser (the hosted server has
// too little CPU time for base64-encoding videos). Same layout as server.js
// sendOfflineFile, which the player's embedded-data path reads.
async function buildOfflineFile(button) {
  const p = state.project;
  const label = button.textContent;
  button.disabled = true;
  try {
    const text = async f => { const r = await fetch(`/${f}`); if (!r.ok) throw new Error(`Couldn't load ${f}`); return r.text(); };
    const [html, css, js] = await Promise.all([text('player.html'), text('player.css'), text('player.js')]);
    // Inline <script>/<style> content must never contain a closing tag.
    const safe = x => x.replace(/<\/(script|style)/gi, '<\\/$1');
    const { pagesProject, publicUrl, publishedAt, unpublishedChanges, ...playable } = p;
    const [head, tail] = html
      .replace('<link rel="stylesheet" href="player.css">', `<style>\n${safe(css)}\n</style>`)
      .replace(/<script type="module" src="player.js"><\/script>/, '%%PLAYER%%')
      .split('%%PLAYER%%');
    if (tail === undefined) throw new Error('player.html layout changed');
    const projectJson = JSON.stringify(playable).replace(/</g, '\\u003c');
    const parts = [head, `<script type="application/json" id="cp-project">${projectJson}</script>\n`];
    const files = mediaFiles(p);
    for (let i = 0; i < files.length; i++) {
      button.textContent = `Preparing ${i + 1} / ${files.length}…`;
      const r = await fetch(`/media/${files[i]}`);
      if (!r.ok) throw new Error(`Couldn't load video ${files[i]}`);
      const blob = await r.blob();
      const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
      const type = r.headers.get('content-type') || 'video/mp4';
      parts.push(`<script type="application/octet-stream" data-cp-media="${files[i]}" data-type="${type}">`, dataUrl.slice(dataUrl.indexOf(',') + 1), '</script>\n');
    }
    parts.push(`<script type="module">\n${safe(js)}\n</script>`, tail);
    const fileName = (p.name || 'prototype').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'prototype';
    const a = h('a', { href: URL.createObjectURL(new Blob(parts, { type: 'text/html' })), download: `${fileName}.html` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  } catch (e) {
    toast(e.message, 6000);
  } finally {
    button.textContent = label;
    button.disabled = false;
  }
}

// Rough size of the offline .html: every media file the player loads, base64-encoded (×4/3).
function offlineBytes(p) {
  let bytes = 0;
  if (p.mode === 'timeline') {
    if (p.video) bytes += p.video.size || 0;
    const rev = p.video && p.keys?.back?.enabled && p.reversed?.[p.video.file];
    if (rev) bytes += rev.size || 0;
  } else {
    const seen = new Set();
    const add = (file, size) => { if (file && !seen.has(file)) { seen.add(file); bytes += size || 0; } };
    for (const c of p.clips) {
      add(c.file, c.size);
      for (const t of c.triggers || []) if (t.reverse?.enabled && t.reverse.file) add(t.reverse.file, t.reverse.size);
    }
  }
  return Math.round(bytes * 4 / 3) + 60_000;
}

// Everything the single-video timeline editor (timeline.js) borrows from here.
function timelineContext() {
  return {
    app, state, h, api, toast, save, snapshot, keyLabel, confirmButton,
    publishSection, localSection, copyLink, playerUrl, ensureReversed,
    undoRedo: redo => (redo ? restore(state.redo, state.undo) : restore(state.undo, state.redo)),
  };
}

function publishSection() {
  const p = state.project;
  if (state.hosted) {
    // Hosted: the play link is already public; edits are live once saved.
    return h('div', { class: 'section' },
      h('h3', {}, 'Share link'),
      h('div', { class: 'link-box' },
        h('input', { readOnly: true, value: playerUrl(), onfocus: e => e.target.select() }),
        h('button', { onclick: copyLink }, 'Copy'),
      ),
      h('p', { class: 'hint' }, 'Anyone with this link can play the prototype. Changes go live as soon as they are saved.'),
      h('div', { class: 'row' }, h('button', { onclick: () => window.open(playerUrl(), '_blank'), disabled: !hasMedia(p) }, 'Open')),
    );
  }
  return h('div', { class: 'section' },
    h('h3', {}, 'Public link'),
    p.publicUrl
      ? h('div', { class: 'link-box' },
        h('input', { readOnly: true, value: p.publicUrl, onfocus: e => e.target.select() }),
        h('button', { onclick: copyLink }, 'Copy'),
      )
      : h('p', { class: 'hint' }, 'Publish to get a permanent public URL on Cloudflare Pages. Anyone with the link can view it.'),
    p.publicUrl && p.unpublishedChanges ? h('p', { class: 'warn' }, 'You have changes that aren\'t live yet — publish to update the link.') : null,
    p.publicUrl && p.publishedAt ? h('p', { class: 'hint' }, `Last published ${new Date(p.publishedAt).toLocaleString()}`) : null,
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: publish, disabled: !hasMedia(p) || state.publishing },
        state.publishing ? 'Publishing…' : p.publicUrl ? 'Update public link' : 'Publish to web'),
      p.publicUrl && h('button', { onclick: () => window.open(p.publicUrl, '_blank') }, 'Open'),
    ),
    state.publishing ? h('p', { class: 'hint' }, 'Uploading clips to Cloudflare — this can take a minute.') : null,
  );
}

// ---------------------------------------------------------------- uploads

function uploadFiles(fileList, at) {
  let i = 0;
  for (const file of fileList) {
    const u = { id: uid(), name: file.name, pct: 0, x: Math.round(at.x + i * (FRAME_W + 60)), y: Math.round(at.y) };
    i++;
    state.uploads.push(u);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = e => { u.pct = (e.loaded / e.total) * 100; renderFrames(); };
    xhr.onloadend = async () => {
      state.uploads.splice(state.uploads.indexOf(u), 1);
      let res;
      try { res = JSON.parse(xhr.responseText); } catch { res = { error: 'Upload failed' }; }
      if (xhr.status !== 201) { toast(`${file.name}: ${res.error || 'upload failed'}`); renderAll(); return; }
      const meta = await probe(`/media/${res.file}`);
      const clip = {
        id: uid(),
        name: file.name.replace(/\.[^.]+$/, ''),
        file: res.file,
        size: res.size,
        ...meta,
        x: u.x,
        y: u.y,
        end: { type: 'loop' },
        triggers: [],
      };
      commit(() => {
        state.project.clips.push(clip);
        if (!state.project.startClip) state.project.startClip = clip.id;
      });
    };
    xhr.send(file);
  }
  renderAll();
}

function probe(src) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => resolve({ duration: 0, width: 0, height: 0 });
    v.src = src;
  });
}

// ---------------------------------------------------------------- share

async function copyLink() {
  const url = state.hosted ? playerUrl() : state.project.publicUrl || playerUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast(state.project.publicUrl ? 'Public link copied' : 'Local link copied — publish for a public one');
  } catch {
    toast(url, 5000);
  }
}

const renderPanel = () => (state.project?.mode === 'timeline' ? state.timeline?.renderInspector() : renderInspector());

async function publish() {
  const p = state.project;
  state.publishing = true;
  renderPanel();
  try {
    clearTimeout(state.saveTimer); // make sure the latest edits are on disk first
    await putProject(p);
    const res = await api(`/api/projects/${p.id}/publish`, { method: 'POST' });
    Object.assign(p, { publicUrl: res.publicUrl, pagesProject: res.pagesProject, publishedAt: res.publishedAt, unpublishedChanges: false });
    toast(`Live at ${res.publicUrl}`, 5000);
  } catch (e) {
    toast(e.message, 9000);
  }
  state.publishing = false;
  renderPanel();
}

async function exportFolder() {
  try {
    const { dir } = await api(`/api/projects/${state.project.id}/export`, { method: 'POST' });
    toast(`Exported to ${dir}`, 6000);
  } catch (e) {
    toast(e.message);
  }
}

window.addEventListener('click', e => {
  if (!state.listening || e.target.closest('.keycap, .popover')) return;
  state.listening = null;
  renderAll();
});
