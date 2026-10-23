// UI-less player. Downloads every clip into memory first, keeps one decoded
// <video> per clip stacked on top of each other, and switches by flipping
// which one is visible — so a key press cuts to frame 0 of the next clip
// with no network or decode wait.

const served = location.pathname.match(/^\/p\/([\w-]+)\/?$/);
const PROJECT_URL = served ? `/api/projects/${served[1]}` : 'project.json';
const MEDIA_BASE = served ? '/media/' : 'media/';
// Offline single-file build: project + media are embedded in the page itself
// (see /api/projects/:id/offline), so nothing is fetched at all.
const EMBEDDED = document.getElementById('cp-project');
// Inside the offline gallery file: the gallery page around this frame holds
// the videos (shared between prototypes) and closes the frame on M.
const GALLERY = (() => { try { return window.parent !== window ? window.parent.cpGallery || null : null; } catch { return null; } })();

const stage = document.getElementById('stage');
const bar = document.querySelector('#progress div');
const errorBox = document.getElementById('error');

const videos = new Map(); // clipId -> <video>
let project;
let clips;
let current = null;
let soundPending = false;

main().catch(err => {
  hideLoadingTitle();
  errorBox.textContent = `Couldn't load this prototype.\n${err.message}`;
  errorBox.hidden = false;
});

// While the videos load: the prototype's name in the middle of the screen,
// faded out once the first frame is up.
let loadingTitle = null;
function showLoadingTitle(name) {
  if (!name) return;
  loadingTitle = document.createElement('div');
  loadingTitle.id = 'loading-title';
  loadingTitle.textContent = name;
  document.body.append(loadingTitle);
}
function hideLoadingTitle() {
  const el = loadingTitle;
  if (!el) return;
  loadingTitle = null;
  el.classList.add('done');
  setTimeout(() => el.remove(), 600);
}

async function main() {
  if (EMBEDDED) {
    project = JSON.parse(EMBEDDED.textContent);
  } else {
    const r = await fetch(PROJECT_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Project request failed (${r.status})`);
    project = await r.json();
  }
  showLoadingTitle(project.name);
  if (project.mode === 'timeline') return runTimeline();
  clips = new Map(project.clips.map(c => [c.id, c]));
  if (!clips.size) throw new Error('This prototype has no clips yet.');
  document.title = project.name || 'Prototype';
  if (project.fit === 'cover') stage.classList.add('cover');

  // Reversed copies used by "reverse with a key" connectors are preloaded like
  // any other clip, as hidden pseudo-clips "rev:<file>".
  const revClips = [];
  for (const c of project.clips) {
    for (const t of c.triggers || []) {
      const r = t.reverse;
      if (!r?.enabled || !r.file || !r.code || !clips.has(t.to)) continue;
      const id = `rev:${r.file}`;
      if (!clips.has(id)) {
        const rc = { id, name: 'reversed', file: r.file, size: r.size || 0, end: { type: 'hold' }, triggers: [] };
        clips.set(id, rc);
        revClips.push(rc);
      }
    }
  }
  const all = [...project.clips, ...revClips];

  const blobs = await preloadAll(all);
  await Promise.all(all.map(c => prepareVideo(c, blobs.get(c.file))));

  document.getElementById('progress').classList.add('done');
  const requested = new URLSearchParams(location.search).get('start');
  const first = clips.has(requested) ? requested : clips.has(project.startClip) ? project.startClip : project.clips[0].id;
  sizeCover();
  window.addEventListener('resize', () => {
    sizeCover();
    if (cover.classList.contains('on') && current) paintStill(current);
  });
  stage.classList.add('ready');
  hideLoadingTitle();
  startClip = first;
  helpContent = canvasHelp();
  show(first);
  bindInput();
}

// Decode one embedded base64 media file into a Blob URL, a few MB at a time so
// the progress bar can repaint between chunks.
async function decodeEmbedded(file, onProgress) {
  const el = document.querySelector(`script[data-cp-media="${file}"]`);
  if (!el) throw new Error(`Missing embedded video ${file}`);
  const b64 = el.textContent.replace(/\s+/g, '');
  const type = el.dataset.type || 'video/mp4';
  el.remove(); // let the browser drop the DOM copy of the text
  const STEP = 4 * 1024 * 1024; // a multiple of 4 base64 characters
  const parts = [];
  let got = 0;
  for (let i = 0; i < b64.length; i += STEP) {
    const bin = atob(b64.slice(i, i + STEP));
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    parts.push(bytes);
    got += bytes.length;
    onProgress(got);
    await new Promise(r => setTimeout(r, 0));
  }
  return URL.createObjectURL(new Blob(parts, { type }));
}

// Fetch each unique file fully into a Blob, reporting byte progress on the bar.
async function preloadAll(list) {
  const files = [...new Map(list.map(c => [c.file, c.size || 0])).entries()];
  const total = files.reduce((s, [, size]) => s + size, 0) || 1;
  const loaded = new Map();
  const blobs = new Map();
  const tick = () => {
    const sum = [...loaded.values()].reduce((a, b) => a + b, 0);
    bar.style.width = `${Math.min(100, (sum / total) * 100)}%`;
  };

  if (GALLERY) {
    for (const [file] of files) blobs.set(file, URL.createObjectURL(await GALLERY.media(file, got => { loaded.set(file, got); tick(); })));
    return blobs;
  }
  if (EMBEDDED) {
    for (const [file] of files) blobs.set(file, await decodeEmbedded(file, got => { loaded.set(file, got); tick(); }));
    return blobs;
  }

  const queue = [...files];
  const worker = async () => {
    while (queue.length) {
      const [file] = queue.shift();
      const res = await fetch(MEDIA_BASE + file);
      if (!res.ok) throw new Error(`Missing video ${file} (${res.status})`);
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        loaded.set(file, got);
        tick();
      }
      blobs.set(file, URL.createObjectURL(new Blob(parts, { type: res.headers.get('content-type') || 'video/mp4' })));
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
  return blobs;
}

function prepareVideo(clip, src) {
  const v = document.createElement('video');
  v.src = src;
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.disablePictureInPicture = true;
  // An "after video ends" connector (or the older end-goto setting) wins over looping.
  const onEnd = (clip.triggers || []).find(t => t.type === 'end' && clips.has(t.to))
    || (clip.end?.type === 'goto' && clips.has(clip.end.to) ? { to: clip.end.to } : null);
  v.loop = !onEnd && clip.end?.type === 'loop';
  v.addEventListener('ended', () => {
    if (current !== clip.id) return;
    if (v._onEnd) { const f = v._onEnd; v._onEnd = null; return f(); } // a reverse finishing
    if (!onEnd) return; // hold the last frame
    if (!(onEnd.delay > 0)) return follow(onEnd);
    // Hold the last frame for the delay. Any switch meanwhile (a key, a click,
    // a rewind) changes switchToken, which cancels it.
    const token = switchToken;
    setTimeout(() => { if (token === switchToken && current === clip.id) follow(onEnd); }, onEnd.delay);
  });
  stage.append(v);
  videos.set(clip.id, v);
  // Resolves once frame 0 is decoded, after keeping a still copy of it.
  return new Promise((resolve, reject) => {
    const ready = () => createImageBitmap(v).then(b => stills.set(clip.id, b), () => {}).then(resolve);
    if (v.readyState >= 2) return ready();
    v.addEventListener('loadeddata', ready, { once: true });
    v.addEventListener('error', () => reject(new Error(`Can't decode "${clip.name}"`)), { once: true });
  });
}

// ---------------------------------------------------------------- switching
//
// A switch must never depend on how fast the browser can (re)start a video
// decoder — Chrome unloads decoders of videos left paused for a while. So each
// clip's first frame is kept as a still image. On a switch that still is
// painted on a canvas above everything immediately; the video starts beneath
// it, and the still is removed only once the video has presented a real frame.

const cover = document.getElementById('cover');
const coverCtx = cover.getContext('2d');
const stills = new Map(); // clipId -> ImageBitmap of frame 0
let switchToken = 0;

function sizeCover() {
  const dpr = window.devicePixelRatio || 1;
  cover.width = Math.round(innerWidth * dpr);
  cover.height = Math.round(innerHeight * dpr);
}

function paintStill(id) {
  const img = stills.get(id);
  if (!img) return false;
  const W = cover.width, H = cover.height;
  const s = project.fit === 'cover' ? Math.max(W / img.width, H / img.height) : Math.min(W / img.width, H / img.height);
  const w = img.width * s, h = img.height * s;
  coverCtx.fillStyle = '#000';
  coverCtx.fillRect(0, 0, W, H);
  coverCtx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  cover.classList.add('on');
  return true;
}

// Dissolve: fade the next clip's first-frame still in over the current clip
// (which keeps playing underneath), then hand over exactly like an instant cut.
let fading = null;

function show(id, anim) {
  const next = videos.get(id);
  if (!next) return;
  if (fading) { fading.cancel(); fading = null; }
  if (anim?.type === 'dissolve' && stills.has(id) && current && current !== id) {
    const token = ++switchToken;
    current = id;
    paintStill(id);
    fading = cover.animate([{ opacity: 0 }, { opacity: 1 }], { duration: anim.duration || 300, easing: 'ease-in-out' });
    fading.onfinish = () => { fading = null; if (token === switchToken) cut(id); };
    return;
  }
  ++switchToken;
  current = id;
  cut(id);
}

function cut(id) {
  const next = videos.get(id);
  const token = switchToken;

  paintStill(id);

  hideOthers(next);
  next.classList.add('active');
  if (next.currentTime !== 0) next.currentTime = 0;
  play(next);
  watchForStall(next, token);

  let done = false;
  const lift = () => {
    if (done) return;
    done = true;
    if (token === switchToken) cover.classList.remove('on');
    warmNeighbors(id);
  };
  if (next.requestVideoFrameCallback) next.requestVideoFrameCallback(() => lift());
  else next.addEventListener('timeupdate', () => requestAnimationFrame(lift), { once: true });
  setTimeout(lift, 2000); // the still is frame 0 anyway; never leave it up forever
}

function hideOthers(keep) {
  for (const v of videos.values()) {
    if (v !== keep && v.classList.contains('active')) {
      v.classList.remove('active');
      v.pause();
      v._onEnd = null;
      v.currentTime = 0; // rewind while covered so it is ready next time
    }
  }
}

// ---------------------------------------------------------------- reverse
//
// Connector A → B with "reverse with a key": while on B, the back key plays a
// pre-reversed copy (of B, or of A) and then lands on A — on A's last frame
// when B was reversed (B starts where A ends), or A's first frame when A was.
// A is shown paused there, with its own keys active again.

// Route history: every forward move records the connection it used, so a back
// key always rewinds the way you actually came — even when several routes lead
// into the same frame with the same back key. A rewind removes its step, so
// pressing back again keeps retracing the route.
const routes = [];

function follow(t) {
  routes.push({ from: current, t });
  show(t.to, t.anim);
}

function reverseFor(code) {
  const candidates = [];
  for (const c of project.clips) {
    for (const t of c.triggers || []) {
      const r = t.reverse;
      if (t.to === current && r?.enabled && r.file && r.code === code && videos.has(`rev:${r.file}`)) candidates.push({ from: c, t });
    }
  }
  const arrival = routes[routes.length - 1];
  // We know how we got here: only that connection's rewind applies (a back key
  // belonging to a different route into this frame does nothing).
  if (arrival && arrival.t.to === current) return candidates.find(x => x.t === arrival.t) || null;
  // No history (e.g. started mid-flow): fall back to the first matching rewind.
  return candidates[0] || null;
}

function startReverse({ from, t }) {
  const revId = `rev:${t.reverse.file}`;
  const rev = videos.get(revId);
  const rewindsCurrent = (t.reverse.clip || 'to') === 'to';
  const cur = videos.get(current);
  const run = () => {
    const arrival = routes[routes.length - 1];
    if (arrival && arrival.t === t) routes.pop();
    show(revId);
    rev._onEnd = () => land(from.id, rewindsCurrent ? 'end' : 'start');
  };
  // Pressed while the current clip is still animating: wait for the animation to
  // finish, then play the full rewind. The reversed copy leaves out the clip's
  // final still picture, and `settle` (saved with the project) is when that still
  // begins — from then on the clip counts as finished, so a press during the
  // still ending rewinds at once. Without a saved settle time we wait for the
  // clip's end. Looping clips never finish, so they rewind straight away;
  // pressing another key meanwhile cancels the wait.
  const settle = rewindsCurrent && typeof t.reverse.settle === 'number' ? t.reverse.settle : null;
  const finished = () => cur.ended || cur.paused || (settle != null && cur.currentTime >= settle - 0.5 / 30);
  if (cur && !cur.loop && !finished()) {
    const id = current;
    let done = false;
    const go = () => {
      if (done || current !== id) return;
      done = true;
      cur._onEnd = null;
      run();
    };
    cur._onEnd = go; // reaching the end counts too
    const watch = () => {
      if (done || current !== id) return;
      if (finished()) return go();
      if (cur.requestVideoFrameCallback) cur.requestVideoFrameCallback(watch);
      else setTimeout(watch, 33);
    };
    watch();
    return;
  }
  run();
}

// If the clip on screen stops presenting new frames while it should be playing
// (it happens on some machines' hardware decoders), nudge it; if it's a rewind
// that stays stuck, finish it by landing, so it can never sit frozen half-way.
function watchForStall(v, token) {
  let last = performance.now();
  let nudged = false;
  const onFrame = () => { last = performance.now(); if (token === switchToken && !v.ended) v.requestVideoFrameCallback?.(onFrame); };
  v.requestVideoFrameCallback?.(onFrame);
  const onTime = () => { last = performance.now(); };
  v.addEventListener('timeupdate', onTime);
  const stop = () => { clearInterval(timer); v.removeEventListener('timeupdate', onTime); };
  const timer = setInterval(() => {
    if (token !== switchToken || v.ended || v.paused) return stop();
    const idle = performance.now() - last;
    if (idle > 500 && !nudged) { nudged = true; v.play().catch(() => {}); }
    if (idle > 1200) {
      stop();
      if (v._onEnd) { const f = v._onEnd; v._onEnd = null; f(); }
    }
  }, 250);
}

// Where a clip sits when a rewind lands on it: its last frame (the rewound clip
// began where it ended) or its first.
const landingTime = (v, at) => (at === 'end' ? Math.max(0, v.duration - 0.01) : 0);

function land(id, at) {
  const v = videos.get(id);
  if (!v) return;
  if (v.loop) return show(id); // looping states just resume looping
  const token = ++switchToken;
  current = id;
  const target = landingTime(v, at);
  // The reversed video stays on screen, frozen on its last frame (which is the
  // frame we're landing on), until A has presented that frame — then swap.
  let done = false;
  const swap = () => {
    if (done) return;
    done = true;
    v._landing = false;
    if (token !== switchToken) return;
    hideOthers(v);
    v.classList.add('active');
    cover.classList.remove('on');
    warmNeighbors(id);
  };
  v._landing = true;
  v.pause();
  if (Math.abs(v.currentTime - target) < 0.005 && v.readyState >= 2) return swap();
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => swap());
  v.addEventListener('seeked', () => requestAnimationFrame(() => requestAnimationFrame(swap)), { once: true });
  setTimeout(swap, 500);
  v.currentTime = target;
}

// Clips the current one can switch to (forward targets, reversed copies of
// rewinds into it, and the clips those rewinds land on).
function neighbors(id) {
  const c = clips.get(id);
  const ids = [...(c?.triggers || []), ...(project.globalTriggers || [])].map(t => t.to);
  if (c?.end?.type === 'goto') ids.push(c.end.to);
  // Reverse connectors into this clip: their reversed video, and the clip they land on.
  for (const o of project.clips) {
    for (const t of o.triggers || []) {
      if (t.to === id && t.reverse?.enabled && t.reverse.file) ids.push(`rev:${t.reverse.file}`, o.id);
    }
  }
  return [...new Set(ids)].filter(x => x && x !== id && videos.has(x));
}

// Clips a rewind into `id` lands on, with where they land (see landingTime).
function landingSpots(id) {
  const spots = new Map();
  for (const o of project.clips) {
    for (const t of o.triggers || []) {
      if (t.to === id && t.reverse?.enabled && t.reverse.file) spots.set(o.id, (t.reverse.clip || 'to') === 'to' ? 'end' : 'start');
    }
  }
  return spots;
}

// Keep the clips the current one can switch to ready, cheaply: one seek each
// (decodes a single frame and keeps Chrome from unloading the decoder),
// staggered so they don't all decode at once — instead of playing them, which
// competes with the clip on screen on slower machines. A clip a rewind lands
// on is parked on its landing frame, so the landing is instant.
let warmTimers = [];
function warmNeighbors(id) {
  warmTimers.forEach(clearTimeout);
  const spots = landingSpots(id);
  warmTimers = neighbors(id).map((n, i) => setTimeout(() => {
    const v = videos.get(n);
    if (current !== id || !v.paused || v.classList.contains('active') || v._landing) return;
    v.muted = true;
    v.currentTime = spots.has(n) ? landingTime(v, spots.get(n)) : 0;
  }, 150 * (i + 1)));
}

setInterval(() => current && warmNeighbors(current), 8000);

function play(v) {
  v.muted = !project.sound || soundPending;
  v.play().catch(err => {
    if (err.name !== 'NotAllowedError' || v.muted) return;
    // Browser blocked audio before any interaction: keep playing silently,
    // unmute on the first key press or click.
    soundPending = true;
    v.muted = true;
    v.play().catch(() => {});
  });
}

function unlockSound() {
  if (!soundPending) return;
  soundPending = false;
  const v = videos.get(current);
  if (v) v.muted = false;
}

// Built-in keys, used only when the prototype doesn't use the key itself:
// R restarts; M returns to the client gallery and N / P move to the next or
// previous prototype in it, when opened from it (?menu, or the offline
// gallery file).
let startClip = null;
const MENU_URL = new URLSearchParams(location.search).has('menu') ? '/gallery' : null;
const toMenu = GALLERY ? () => GALLERY.close() : MENU_URL ? () => { location.href = MENU_URL; } : null;

// N / P: the next or previous prototype in the gallery, wrapping round. Only
// when opened from the gallery, like M. Online, the gallery page leaves its
// order in sessionStorage (so a key press doesn't cost a server request);
// it's fetched only if that's missing.
const toSibling = GALLERY ? by => GALLERY.step(by) : MENU_URL ? async by => {
  const id = served?.[1];
  let order = null;
  try { order = JSON.parse(sessionStorage.getItem('cp-gallery')); } catch {}
  if (!Array.isArray(order) || !order.includes(id)) {
    order = await fetch('/api/gallery').then(r => (r.ok ? r.json() : [])).then(list => list.map(p => p.id)).catch(() => []);
    try { sessionStorage.setItem('cp-gallery', JSON.stringify(order)); } catch {}
  }
  if (!order.length) return;
  const i = order.indexOf(id);
  const next = order[((i < 0 ? (by > 0 ? -1 : 0) : i) + by + order.length) % order.length];
  try { sessionStorage.setItem('cp-last', next); } catch {} // M then returns to this card
  location.href = `/p/${encodeURIComponent(next)}?menu`;
} : null;

function builtInKey(e, restart) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.code === 'KeyR') { e.preventDefault(); restart(); return true; }
  if (e.code === 'KeyM' && toMenu) { e.preventDefault(); toMenu(); return true; }
  if ((e.code === 'KeyN' || e.code === 'KeyP') && toSibling) { e.preventDefault(); toSibling(e.code === 'KeyN' ? 1 : -1); return true; }
  if (e.code === 'KeyH') { e.preventDefault(); toggleHelp(); return true; }
  if (e.code === 'Escape' && helpBox) { e.preventDefault(); toggleHelp(false); return true; }
  return false;
}

// ---------------------------------------------------------------- help (H)
//
// A see-through panel over the running prototype: the designer's notes (or a
// map of every screen when there are none), what works on the current screen,
// and the general controls. It stays open while you navigate and follows along.
// `helpContent` is set by the canvas or single-video player and returns
// { title, about: [nodes], here: [[keys, what]], aboutTitle }.

let helpContent = null;
let helpBox = null;
let helpTimer = null;
let helpKey = '';

const hEl = (tag, cls, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
};
const kbd = label => hEl('kbd', '', label);

function toggleHelp(open = !helpBox) {
  if (!open) {
    clearInterval(helpTimer);
    helpBox?.remove();
    helpBox = null;
    return;
  }
  if (!helpContent) return;
  helpBox = hEl('aside', 'help');
  helpBox.setAttribute('role', 'dialog');
  helpBox.setAttribute('aria-label', 'Help');
  document.body.append(helpBox);
  helpKey = '';
  renderHelp();
  helpTimer = setInterval(renderHelp, 150); // follows navigation while open
}

function renderHelp() {
  const c = helpContent();
  const key = JSON.stringify([c.title, c.aboutKey, c.here]);
  if (key === helpKey) return;
  helpKey = key;
  const controls = [
    [[kbd('H')], 'Show or hide this help'],
    [[kbd('R')], project.mode !== 'timeline' && clips?.has(project.restartClip) ? `Restart from ${clips.get(project.restartClip).name}` : 'Restart from the beginning'],
    toMenu ? [[kbd('M')], 'Back to the menu of prototypes'] : null,
    toSibling ? [[kbd('P'), kbd('N')], 'Previous or next prototype'] : null,
    [['Double-click'], 'Full screen on or off'],
  ].filter(Boolean);
  const rows = list => hEl('dl', 'help-rows', list.map(([keys, what]) => [hEl('dt', '', keys), hEl('dd', '', what)]));
  helpBox.replaceChildren(
    hEl('header', 'help-head', hEl('h2', '', c.title), hEl('span', 'help-close', kbd('H'), ' or ', kbd('Esc'), ' to close')),
    hEl('section', '', hEl('h3', '', c.aboutTitle || 'About this prototype'), c.about),
    hEl('section', '', hEl('h3', '', 'On this screen'),
      c.here.length ? rows(c.here.map(([keys, what]) => [keys.map(k => (typeof k === 'string' && k.startsWith('key:') ? kbd(k.slice(4)) : k)), what])) : hEl('p', 'help-muted', 'Nothing to press here. This screen just plays.')),
    hEl('section', '', hEl('h3', '', 'Controls'), rows(controls)),
  );
}

// Designer text: blank lines separate paragraphs.
const paragraphs = text => String(text || '').trim().split(/\n\s*\n/).filter(Boolean).map(t => hEl('p', '', t.trim()));

function canvasHelp() {
  let screenId = null;
  return () => {
    if (clips.has(current) && !String(current).startsWith('rev:')) screenId = current;
    const here = clips.get(screenId) || clips.get(startClip);
    const nameOf = id => clips.get(id)?.name || 'another screen';
    const k = t => `key:${t.label || t.code || '?'}`;
    const actions = [];
    for (const t of here?.triggers || []) {
      if (!clips.has(t.to)) continue;
      if (t.type === 'key' && t.code) actions.push([[k(t)], `Go to ${nameOf(t.to)}`]);
      else if (t.type === 'click') actions.push([['Click'], `Go to ${nameOf(t.to)}`]);
      else if (t.type === 'end') actions.push([['Wait'], `${nameOf(t.to)} plays ${t.delay ? `${+(t.delay / 1000).toFixed(2)}s after` : 'when'} this video ends`]);
    }
    for (const c of project.clips) {
      for (const t of c.triggers || []) {
        const r = t.reverse;
        if (t.to === here?.id && r?.enabled && r.file && r.code) actions.push([[`key:${r.label || r.code}`], `Rewind back to ${c.name}`]);
      }
    }
    for (const t of project.globalTriggers || []) {
      if (t.type === 'key' && t.code && clips.has(t.to) && !actions.some(a => a[0][0] === k(t))) actions.push([[k(t)], `Go to ${nameOf(t.to)} (works on every screen)`]);
    }
    // No designer text: a map of every screen and where its keys lead.
    let about = paragraphs(project.help);
    if (here?.note) about.push(hEl('p', 'help-note', here.note));
    if (!project.help) {
      about = [
        here?.note ? hEl('p', 'help-note', here.note) : null,
        hEl('ol', 'help-map', project.clips.map(c => {
          const exits = (c.triggers || []).filter(t => clips.has(t.to)).map(t => (t.type === 'key' ? `${t.label || '?'} → ${nameOf(t.to)}` : t.type === 'click' ? `click → ${nameOf(t.to)}` : `then ${nameOf(t.to)}`));
          return hEl('li', c.id === here?.id ? 'here' : '', hEl('strong', '', c.name), exits.length ? hEl('span', '', exits.join(' · ')) : null);
        })),
      ];
    }
    return { title: project.name || 'Prototype', aboutTitle: project.help ? 'About this prototype' : 'All screens', aboutKey: [here?.id, project.help], about, here: actions };
  };
}

// R goes to the prototype's chosen restart frame, or else where it started.
const restartTarget = () => (clips.has(project.restartClip) ? project.restartClip : startClip);

function restartPrototype() {
  if (!restartTarget()) return;
  routes.length = 0;
  for (const v of videos.values()) v._onEnd = null;
  show(restartTarget());
}

function findTrigger(match) {
  const clip = clips.get(current);
  return (clip?.triggers || []).find(match) || (project.globalTriggers || []).find(match);
}

function bindInput() {
  window.addEventListener('keydown', e => {
    if (e.repeat) return;
    unlockSound();
    const match = t => t.type === 'key' && t.code === e.code && t.to;
    // Priority: this clip's own forward keys, then back keys into it, then global keys.
    const own = (clips.get(current)?.triggers || []).find(match);
    const back = !own && reverseFor(e.code);
    const global = !own && !back && (project.globalTriggers || []).find(match);
    if (own || global) {
      e.preventDefault();
      follow(own || global);
    } else if (back) {
      e.preventDefault();
      startReverse(back);
    } else builtInKey(e, restartPrototype);
  });
  window.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    unlockSound();
    const t = findTrigger(t => t.type === 'click' && t.to);
    if (t) follow(t);
  });
  window.addEventListener('dblclick', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  let idle;
  window.addEventListener('pointermove', () => {
    document.body.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(() => document.body.classList.add('idle'), 1500);
  });
}

// ================================================================ single video with stops
//
// One video plays forwards and freezes exactly on each stop frame until the
// continue key. With a back key, a pre-reversed copy of the whole video plays
// from the current stop back to the previous one, then the forward video takes
// over on that same frame. Both videos are preloaded into memory.
//
// Frame f is shown by seeking to the middle of it, (f + 0.5) / fps. In the
// reversed copy, forward frame f is frame (n - 1 - f).

async function runTimeline() {
  const v = project.video;
  if (!v) throw new Error('This prototype has no video yet.');
  document.title = project.name || 'Prototype';
  if (project.fit === 'cover') stage.classList.add('cover');

  const keys = project.keys || {};
  const rev = keys.back?.enabled && keys.back.code ? project.reversed?.[v.file] : null;
  const list = [{ id: 'F', file: v.file, size: v.size }];
  if (rev) list.push({ id: 'R', file: rev.file, size: rev.size });
  const blobs = await preloadAll(list);

  const make = file => {
    const el = document.createElement('video');
    el.src = blobs.get(file);
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.disablePictureInPicture = true;
    stage.append(el);
    return new Promise((resolve, reject) => {
      el.addEventListener('loadeddata', () => resolve(el), { once: true });
      el.addEventListener('error', () => reject(new Error('Could not decode the video')), { once: true });
    });
  };
  const F = await make(v.file);
  const R = rev ? await make(rev.file) : null;
  document.getElementById('progress').classList.add('done');

  const fps = v.fps || 30;
  const n = v.frames || Math.max(1, Math.round(F.duration * fps));
  const last = n - 1;
  const at = f => Math.min(F.duration - 0.001, (f + 0.5) / fps);
  const rat = f => Math.min((R?.duration || F.duration) - 0.001, (last - f + 0.5) / fps); // forward frame f, in R
  const stops = [...new Set((project.stops || []).map(s => s.frame))].filter(f => f >= 0 && f <= last).sort((a, b) => a - b);
  const stopKey = new Map((project.stops || []).filter(s => s.key?.code).map(s => [s.frame, s.key.code]));

  // mode: 'paused' (frozen on `frame`), 'forward', 'reverse'
  let mode = 'paused';
  let frame = 0;
  let token = 0;

  sizeCover();
  window.addEventListener('resize', sizeCover);

  // Cover the screen with the frame `el` is showing (drawn synchronously), so
  // swaps and resumes never show anything but a real picture.
  const coverWith = el => {
    try {
      const W = cover.width, H = cover.height;
      const ar = (el.videoWidth / el.videoHeight) || 16 / 9;
      const fitW = project.fit === 'cover' ? Math.max(W, H * ar) : Math.min(W, H * ar);
      const w = fitW, h = fitW / ar;
      coverCtx.fillStyle = '#000';
      coverCtx.fillRect(0, 0, W, H);
      coverCtx.drawImage(el, (W - w) / 2, (H - h) / 2, w, h);
      cover.classList.add('on');
    } catch { /* not drawable yet: keep whatever is showing */ }
  };
  const uncoverWhenPresented = (el, tk) => {
    let done = false;
    const lift = () => { if (!done && tk === token) { done = true; cover.classList.remove('on'); } };
    if (el.requestVideoFrameCallback) el.requestVideoFrameCallback(() => lift());
    el.addEventListener('seeked', () => requestAnimationFrame(() => requestAnimationFrame(lift)), { once: true });
    setTimeout(lift, 600);
  };
  const showOnly = el => {
    F.classList.toggle('active', el === F);
    if (R) R.classList.toggle('active', el === R);
  };

  // Play `el` until it reaches frame `target` (in its own numbering) and
  // freeze exactly on that frame, then call done().
  function runTo(el, target, done) {
    const tk = token;
    const stopAt = target / fps; // start time of the target frame
    const arrive = () => {
      el.pause();
      el.currentTime = Math.min(el.duration - 0.001, (target + 0.5) / fps);
      done();
    };
    if (el.requestVideoFrameCallback) {
      const check = (now, meta) => {
        if (tk !== token) return;
        // The presented frame is target-1 or later: pause and land on target.
        if (meta.mediaTime >= stopAt - 1.5 / fps) return arrive();
        el.requestVideoFrameCallback(check);
      };
      el.requestVideoFrameCallback(check);
    } else {
      const poll = () => {
        if (tk !== token) return;
        if (el.currentTime >= stopAt - 1.5 / fps) return arrive();
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }
    play(el);
  }

  const nextStop = f => stops.find(s => s > f);
  const prevStop = f => [...stops].reverse().find(s => s < f);

  function goForward() {
    if (mode !== 'paused') return;
    if (frame >= last) {
      if (project.end === 'restart') restart();
      return;
    }
    const target = nextStop(frame);
    const tk = ++token;
    mode = 'forward';
    // Resume: cover with the frozen frame until playback has presented a new one.
    coverWith(F);
    uncoverWhenPresented(F, tk);
    if (target == null) {
      F.onended = () => { if (tk === token) arrive(last); };
      play(F);
      return;
    }
    runTo(F, target, () => arrive(target));
  }

  // Back pressed while moving forward: finish reaching the next stop first,
  // then rewind that whole stretch.
  let backQueued = false;
  function arrive(f) {
    mode = 'paused';
    frame = f;
    prepareBack();
    if (backQueued) { backQueued = false; goBack(); }
  }

  // While frozen, line the reversed copy up on the same frame so going back starts instantly.
  function prepareBack() {
    if (!R) return;
    R.pause();
    R.currentTime = rat(frame);
  }

  function goBack() {
    if (!R || mode === 'reverse') return;
    if (mode === 'forward') { backQueued = true; return; }
    const from = frame;
    const target = prevStop(from) ?? (from > 0 ? 0 : null);
    if (target == null) return;
    const tk = ++token;
    mode = 'reverse';
    coverWith(F);
    const begin = () => {
      if (tk !== token) return;
      showOnly(R);
      uncoverWhenPresented(R, tk);
      // Meanwhile put the forward video on the landing frame, hidden underneath.
      F.currentTime = at(target);
      runTo(R, last - target, () => land(target, tk));
    };
    if (Math.abs(R.currentTime - rat(from)) < 0.5 / fps && !R.seeking) begin();
    else { R.addEventListener('seeked', begin, { once: true }); R.currentTime = rat(from); }
  }

  // Reverse reached the previous stop: swap back to the forward video, frozen there.
  function land(target, tk) {
    const swap = () => {
      if (tk !== token) return;
      showOnly(F);
      mode = 'paused';
      frame = target;
      prepareBack();
    };
    // R stays on screen (frozen on the same image) until F has that frame ready.
    if (Math.abs(F.currentTime - at(target)) < 0.5 / fps && !F.seeking) return requestAnimationFrame(swap);
    F.addEventListener('seeked', () => requestAnimationFrame(swap), { once: true });
    F.currentTime = at(target);
  }

  function restart() {
    backQueued = false;
    const tk = ++token;
    coverWith(F);
    showOnly(F);
    F.currentTime = at(0);
    mode = 'paused';
    frame = 0;
    uncoverWhenPresented(F, tk);
    if (!stops.includes(0)) goForward();
  }

  function unlockTimelineSound() {
    if (!soundPending) return;
    soundPending = false;
    F.muted = false;
  }

  // Start on frame 0: wait there if it is a stop, otherwise play to the first stop.
  showOnly(F);
  stage.classList.add('ready');
  hideLoadingTitle();
  if (stops.includes(0)) { F.currentTime = at(0); prepareBack(); }
  else goForward();

  helpContent = () => {
    const at = frame >= last ? 'end' : stops.indexOf(frame);
    const custom = (project.stops || []).find(st => st.frame === frame && st.key?.code)?.key;
    const cont = `key:${custom?.label || keys.next?.label || '?'}`;
    const here = [];
    if (mode === 'paused') {
      if (frame < last) here.push([[cont], nextStop(frame) != null ? 'Play on to the next stop' : 'Play to the end']);
      else if (project.end === 'restart') here.push([[cont], 'Start again from the beginning']);
      if (keys.click && frame < last) here.push([['Click'], 'Also plays on']);
    } else here.push([['…'], mode === 'forward' ? 'Playing to the next stop' : 'Playing backwards']);
    if (R && keys.back?.enabled && frame > 0) here.push([[`key:${keys.back.label || '?'}`], prevStop(frame) != null ? 'Back to the previous stop' : 'Back to the start']);
    const named = (project.stops || []).filter(st => stops.includes(st.frame)).sort((x, y) => x.frame - y.frame);
    const about = project.help ? paragraphs(project.help) : [
      hEl('p', '', named.length ? `One video that pauses at ${named.length} stop${named.length === 1 ? '' : 's'}.` : 'One video that plays straight through.'),
      named.length ? hEl('ol', 'help-map', named.map((st, i) => hEl('li', st.frame === frame ? 'here' : '', hEl('strong', '', st.name || `Stop ${i + 1}`)))) : null,
    ];
    return { title: project.name || 'Prototype', aboutTitle: project.help ? 'About this prototype' : 'Stops', aboutKey: [at, mode, project.help], about, here };
  };

  const continueCode = () => stopKey.get(frame) || keys.next?.code;
  window.addEventListener('keydown', e => {
    if (e.repeat) return;
    unlockTimelineSound();
    if (e.code === continueCode()) { e.preventDefault(); goForward(); }
    else if (R && e.code === keys.back.code) { e.preventDefault(); goBack(); }
    else builtInKey(e, restart);
  });
  window.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    unlockTimelineSound();
    if (keys.click) goForward();
  });
  window.addEventListener('dblclick', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  let idle;
  window.addEventListener('pointermove', () => {
    document.body.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(() => document.body.classList.add('idle'), 1500);
  });

  // Read-only handle for automated checks.
  window.__timeline = { get mode() { return mode; }, get frame() { return frame; }, F, R, stops, fps, n };
}
