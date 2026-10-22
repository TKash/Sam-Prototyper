// Timeline editor for single-video prototypes: one screen recording, plus
// "stops" — frames where playback freezes until the viewer presses a key.
// Optionally a back key plays the video in reverse to the previous stop.

import { detectFps } from './reverse.js';

const THUMB_W = 96;

export function mountTimeline(ctx) {
  const { state, h, api, toast, save, snapshot, keyLabel, confirmButton } = ctx;
  const p = () => state.project;
  const ui = { selected: null, scrub: null, thumbs: null, raf: 0, uploadPct: null };
  const el = {};

  ensureDefaults(p());

  // ---------------------------------------------------------------- frame math

  const fps = () => p().video?.fps || 30;
  const frames = () => p().video?.frames || 1;
  const timeOf = f => (f + 0.5) / fps();               // middle of frame f — seeks land on it reliably
  const frameOf = t => Math.max(0, Math.min(frames() - 1, Math.floor(t * fps() + 1e-4)));
  const fmt = t => {
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  };
  const sortedStops = () => [...p().stops].sort((a, b) => a.frame - b.frame);
  const stopById = id => p().stops.find(s => s.id === id);
  const stopNumber = s => sortedStops().indexOf(s) + 1;
  const curFrame = () => frameOf(el.video?.currentTime || 0);

  function commit(fn) {
    snapshot();
    fn();
    save();
    render();
  }

  // ---------------------------------------------------------------- shell

  function render() {
    const proj = p();
    if (!el.root?.isConnected) build();
    el.title.value !== proj.name && document.activeElement !== el.title && (el.title.value = proj.name);
    el.play.disabled = !proj.video;
    renderStage();
    renderTrack();
    renderInspector();
  }

  function build() {
    const proj = p();
    document.title = `${proj.name} · Clip Proto`;
    el.file = h('input', {
      type: 'file', hidden: true, accept: 'video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm',
      onchange: e => { if (e.target.files[0]) uploadVideo(e.target.files[0]); e.target.value = ''; },
    });
    el.title = h('input', {
      class: 'title', value: proj.name, 'aria-label': 'Prototype name',
      oninput: e => { p().name = e.target.value; document.title = `${p().name} · Clip Proto`; save(); },
    });
    el.play = h('button', { class: 'primary', onclick: () => window.open(ctx.playerUrl(), '_blank') }, '▶ Play');

    el.video = h('video', { class: 'tl-video', preload: 'auto', playsInline: true });
    el.video.addEventListener('play', updateTransport);
    el.video.addEventListener('pause', updateTransport);
    el.video.addEventListener('loadedmetadata', () => { renderTrack(); tick(); });
    el.stage = h('div', { class: 'tl-stage' }, el.video);
    el.stageEmpty = h('div', { class: 'tl-drop' });
    el.stage.append(el.stageEmpty);
    for (const ev of ['dragover', 'drop']) {
      el.stage.addEventListener(ev, e => {
        if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
        e.preventDefault();
        if (ev === 'drop' && e.dataTransfer.files[0]) uploadVideo(e.dataTransfer.files[0]);
      });
    }

    el.timeLabel = h('span', { class: 'tl-time' });
    el.playBtn = h('button', { class: 'tl-btn tl-playbtn', title: 'Play / pause (Space)', onclick: togglePlay }, '▶');
    el.transport = h('div', { class: 'tl-transport' },
      h('button', { class: 'tl-btn', title: 'Go to start (Home)', onclick: () => seekFrame(0) }, '⏮'),
      h('button', { class: 'tl-btn', title: 'Previous stop ( [ )', onclick: () => jumpStop(-1) }, '◂◆'),
      h('button', { class: 'tl-btn', title: 'Back one frame (←)', onclick: () => step(-1) }, '‹'),
      el.playBtn,
      h('button', { class: 'tl-btn', title: 'Forward one frame (→)', onclick: () => step(1) }, '›'),
      h('button', { class: 'tl-btn', title: 'Next stop ( ] )', onclick: () => jumpStop(1) }, '◆▸'),
      el.timeLabel,
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', title: 'Add a stop at this frame (S)', onclick: () => addStop(curFrame()) }, '◆ Add stop here'),
    );

    el.thumbs = h('canvas', { class: 'tl-thumbs' });
    el.markers = h('div', { class: 'tl-markers' });
    el.playhead = h('div', { class: 'tl-playhead' });
    el.ruler = h('div', { class: 'tl-ruler' });
    el.track = h('div', { class: 'tl-track' }, el.thumbs, el.playhead, el.markers);
    bindTrack();
    el.inspector = h('div', { class: 'inspector' });

    el.root = h('div', { class: 'editor' },
      h('div', { class: 'topbar' },
        h('button', { class: 'ghost', title: 'All prototypes', onclick: () => (location.hash = '') }, '←'),
        el.title,
        h('span', { id: 'saved', class: 'saved' }, 'Saved'),
        h('span', { class: 'spacer' }),
        h('button', { onclick: () => el.file.click() }, 'Replace video'),
        el.file,
        h('button', { onclick: ctx.copyLink }, 'Copy link'),
        el.play,
      ),
      h('div', { class: 'body' },
        h('div', { class: 'tl-main' },
          el.stage,
          el.transport,
          h('div', { class: 'tl-timeline' }, el.track, el.ruler),
          h('p', { class: 'hint tl-help' }, 'Double-click the timeline or press S to add a stop · drag a stop to move it · Space play/pause · ←/→ one frame (Shift: 1s) · [ ] previous/next stop'),
        ),
        el.inspector,
      ),
    );
    ctx.app.replaceChildren(el.root);
    new ResizeObserver(() => { ui.thumbsKey = null; renderTrack(); }).observe(el.track);
    cancelAnimationFrame(ui.raf);
    const loop = () => { if (!el.root.isConnected) return; tick(); ui.raf = requestAnimationFrame(loop); };
    loop();
  }

  // ---------------------------------------------------------------- stage + transport

  function renderStage() {
    const v = p().video;
    const src = v ? `/media/${v.file}` : '';
    if (v && !el.video.src.endsWith(src)) { el.video.src = src; ui.thumbsKey = null; }
    el.video.hidden = !v;
    el.transport.hidden = !v;
    el.track.parentElement.hidden = !v;
    el.stageEmpty.hidden = !!v && ui.uploadPct == null;
    el.stageEmpty.replaceChildren(
      ui.uploadPct != null
        ? h('div', { class: 'upload-msg plain' }, `Uploading… ${Math.round(ui.uploadPct)}%`, h('div', { class: 'bar' }, h('div', { style: `width:${ui.uploadPct}%` })))
        : h('div', { class: 'canvas-empty static' },
          h('h2', {}, 'Drop your screen recording here'),
          h('p', { class: 'muted' }, 'One video. Then add stops where it should pause and wait for a key press.'),
          h('button', { class: 'primary', onclick: () => el.file.click() }, 'Choose video'),
        ),
    );
  }

  function tick() {
    if (!p().video || !el.video.duration) return;
    const t = el.video.currentTime;
    const f = frameOf(t);
    el.playhead.style.left = `${((f + 0.5) / frames()) * 100}%`;
    el.timeLabel.textContent = `${fmt(t)} · frame ${f + 1} / ${frames()}`;
    // In the editor, playback also pauses at stops so you can check them.
    if (!el.video.paused && ui.pauseAt != null && f >= ui.pauseAt) {
      el.video.pause();
      seekFrame(ui.pauseAt);
      ui.pauseAt = null;
    }
  }

  function updateTransport() {
    el.playBtn.textContent = el.video.paused ? '▶' : '❚❚';
  }

  function togglePlay() {
    if (!p().video) return;
    if (el.video.paused) {
      const f = curFrame();
      const next = sortedStops().find(s => s.frame > f);
      ui.pauseAt = next ? next.frame : null;
      if (f >= frames() - 1) el.video.currentTime = 0;
      el.video.play();
    } else {
      el.video.pause();
    }
  }

  function seekFrame(f) {
    if (!p().video) return;
    el.video.pause();
    el.video.currentTime = timeOf(Math.max(0, Math.min(frames() - 1, f)));
  }

  const step = d => seekFrame(curFrame() + d);

  function jumpStop(dir) {
    const f = curFrame();
    const list = sortedStops();
    const s = dir > 0 ? list.find(x => x.frame > f) : [...list].reverse().find(x => x.frame < f);
    if (s) { select(s.id); seekFrame(s.frame); } else seekFrame(dir > 0 ? frames() - 1 : 0);
  }

  // ---------------------------------------------------------------- timeline track

  function frameAtX(clientX) {
    const r = el.track.getBoundingClientRect();
    return Math.max(0, Math.min(frames() - 1, Math.floor(((clientX - r.left) / r.width) * frames())));
  }

  function bindTrack() {
    el.track.addEventListener('pointerdown', e => {
      if (!p().video || e.button !== 0) return;
      const marker = e.target.closest('.tl-marker');
      el.track.setPointerCapture(e.pointerId);
      if (marker) {
        const s = stopById(marker.dataset.id);
        select(s.id);
        seekFrame(s.frame);
        ui.scrub = { type: 'marker', id: s.id, x: e.clientX, from: s.frame, moved: false };
      } else {
        seekFrame(frameAtX(e.clientX));
        ui.scrub = { type: 'scrub' };
      }
    });
    el.track.addEventListener('pointermove', e => {
      const d = ui.scrub;
      if (!d) return;
      const f = frameAtX(e.clientX);
      if (d.type === 'scrub') return seekFrame(f);
      if (!d.moved && Math.abs(e.clientX - d.x) < 3) return;
      if (!d.moved) { d.moved = true; snapshot(); }
      const s = stopById(d.id);
      if (p().stops.some(o => o !== s && o.frame === f)) return; // one stop per frame
      s.frame = f;
      seekFrame(f);
      renderMarkers();
    });
    const end = () => {
      if (ui.scrub?.type === 'marker' && ui.scrub.moved) { save(); render(); }
      ui.scrub = null;
    };
    el.track.addEventListener('pointerup', end);
    el.track.addEventListener('pointercancel', end);
    el.track.addEventListener('dblclick', e => {
      if (!p().video || e.target.closest('.tl-marker')) return;
      addStop(frameAtX(e.clientX));
    });
  }

  function renderTrack() {
    if (!p().video || !el.track) return;
    renderMarkers();
    renderRuler();
    drawThumbs();
  }

  function renderMarkers() {
    el.markers.replaceChildren(...sortedStops().map((s, i) => h('div', {
      class: `tl-marker${ui.selected === s.id ? ' selected' : ''}`,
      'data-id': s.id,
      style: `left:${((s.frame + 0.5) / frames()) * 100}%`,
      title: `${s.name || `Stop ${i + 1}`} — ${fmt(timeOf(s.frame))}, frame ${s.frame + 1}`,
    }, h('span', { class: 'tl-marker-num' }, String(i + 1)), h('span', { class: 'tl-marker-line' }))));
  }

  function renderRuler() {
    const dur = p().video.duration || frames() / fps();
    const w = el.track.clientWidth || 600;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const every = steps.find(s => (s / dur) * w >= 70) || 600;
    const ticks = [];
    for (let t = 0; t <= dur + 1e-6; t += every) ticks.push(h('span', { style: `left:${(t / dur) * 100}%` }, every < 1 ? `${t.toFixed(1)}s` : fmt(t).replace(/\.\d+$/, '')));
    el.ruler.replaceChildren(...ticks);
  }

  // Filmstrip: frames sampled across the video, drawn once per file + width.
  async function drawThumbs() {
    const v = p().video;
    const c = el.thumbs;
    const w = Math.max(1, el.track.clientWidth), hgt = 56;
    const key = `${v.file}|${w}`;
    if (ui.thumbsKey === key) return;
    ui.thumbsKey = key;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(hgt * dpr);
    const g = c.getContext('2d');
    g.fillStyle = '#111';
    g.fillRect(0, 0, c.width, c.height);
    const count = Math.max(1, Math.ceil(w / THUMB_W));
    const src = document.createElement('video');
    src.muted = true;
    src.preload = 'auto';
    src.src = `/media/${v.file}`;
    await new Promise(r => { src.onloadeddata = r; src.onerror = r; });
    const cellW = c.width / count;
    const ar = (v.width && v.height) ? v.width / v.height : 16 / 9;
    for (let i = 0; i < count; i++) {
      if (ui.thumbsKey !== key) return; // a newer redraw started
      await new Promise(r => { src.onseeked = r; src.currentTime = Math.min(src.duration - 0.01, ((i + 0.5) / count) * src.duration); });
      const dh = c.height, dw = dh * ar;
      g.save();
      g.beginPath();
      g.rect(i * cellW, 0, cellW - 1, c.height);
      g.clip();
      g.drawImage(src, i * cellW + (cellW - dw) / 2, 0, dw, dh);
      g.restore();
    }
    src.removeAttribute('src');
    src.load();
  }

  // ---------------------------------------------------------------- stops

  function addStop(f) {
    if (!p().video) return;
    const existing = p().stops.find(s => s.frame === f);
    if (existing) { select(existing.id); return; }
    const s = { id: Math.random().toString(36).slice(2, 9), frame: f, name: '', key: null };
    commit(() => p().stops.push(s));
    select(s.id);
    toast(`Stop ${stopNumber(s)} added at frame ${f + 1}`);
  }

  function deleteStop(s) {
    commit(() => { p().stops = p().stops.filter(x => x !== s); });
    if (ui.selected === s.id) ui.selected = null;
    render();
    toast('Stop removed — Ctrl+Z to undo');
  }

  function select(id) {
    ui.selected = id;
    renderMarkers();
    renderInspector();
  }

  // ---------------------------------------------------------------- upload

  function uploadVideo(file) {
    ui.uploadPct = 0;
    renderStage();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = e => { ui.uploadPct = (e.loaded / e.total) * 100; renderStage(); };
    xhr.onloadend = async () => {
      let res;
      try { res = JSON.parse(xhr.responseText); } catch { res = { error: 'Upload failed' }; }
      if (xhr.status !== 201) { ui.uploadPct = null; renderStage(); toast(`${file.name}: ${res.error || 'upload failed'}`); return; }
      ui.uploadPct = 99;
      renderStage();
      const meta = await probe(`/media/${res.file}`);
      ui.uploadPct = null;
      commit(() => {
        const proj = p();
        const replacing = !!proj.video;
        proj.video = { file: res.file, size: res.size, name: file.name, ...meta };
        // Keep stops when replacing the video, clamped to the new length.
        proj.stops = proj.stops.filter(s => s.frame < meta.frames).map(s => s);
        if (!replacing && /^Untitled/.test(proj.name)) proj.name = file.name.replace(/\.[^.]+$/, '');
      });
      el.title.value = p().name;
      if (p().keys.back.enabled) ctx.ensureReversed(p().video.file);
    };
    xhr.send(file);
  }

  async function probe(src) {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = src;
    await new Promise(r => { v.onloadeddata = r; v.onerror = r; });
    const fpsDetected = await detectFps(v);
    const meta = {
      duration: v.duration || 0,
      width: v.videoWidth,
      height: v.videoHeight,
      fps: fpsDetected,
      frames: Math.max(1, Math.round((v.duration || 0) * fpsDetected)),
    };
    v.removeAttribute('src');
    v.load();
    return meta;
  }

  // ---------------------------------------------------------------- inspector

  function keycap(target) {
    const listening = state.listening === target;
    return h('button', {
      class: `keycap${listening ? ' listening' : ''}`,
      onclick: e => { e.stopPropagation(); state.listening = target; renderInspector(); },
    }, listening ? 'Press a key…' : target.label || 'Click to set');
  }

  function renderInspector() {
    if (!el.inspector) return;
    const proj = p();
    const sections = [];
    const sel = stopById(ui.selected);

    if (sel) {
      const n = stopNumber(sel);
      sel.key ||= null;
      sections.push(h('div', { class: 'section' },
        h('div', { class: 'row' }, h('h3', {}, `Stop ${n}`), h('span', { class: 'spacer' }),
          h('button', { class: 'ghost icon', title: 'Deselect', onclick: () => select(null) }, '✕')),
        h('label', { class: 'field' }, h('span', {}, 'Name (optional)'),
          h('input', { value: sel.name || '', placeholder: `Stop ${n}`, onfocus: snapshot, oninput: e => { sel.name = e.target.value; save(); renderMarkers(); } })),
        h('div', { class: 'row' },
          h('span', { class: 'muted' }, `${fmt(timeOf(sel.frame))} · frame ${sel.frame + 1}`),
          h('span', { class: 'spacer' }),
          h('button', { class: 'tl-btn', title: 'One frame earlier', onclick: () => nudge(sel, -1) }, '‹'),
          h('button', { class: 'tl-btn', title: 'One frame later', onclick: () => nudge(sel, 1) }, '›'),
        ),
        h('div', { class: 'field' }, h('span', {}, 'Continue with'),
          h('div', { class: 'seg' },
            h('button', { class: sel.key ? '' : 'on', onclick: () => commit(() => { sel.key = null; }) }, `Default (${proj.keys.next.label})`),
            h('button', { class: sel.key ? 'on' : '', onclick: () => { if (!sel.key) { commit(() => { sel.key = { code: null, label: null }; }); state.listening = sel.key; renderInspector(); } } }, 'Custom key'),
          ),
          sel.key ? keycap(sel.key) : null,
        ),
        h('div', { class: 'row' },
          confirmButton({ cls: 'danger-outline', label: 'Delete stop', armedLabel: 'Click again to delete', title: `Delete stop ${n}`, onConfirm: () => deleteStop(sel) }),
        ),
      ));
    }

    const list = sortedStops();
    sections.push(h('div', { class: 'section' },
      h('h3', {}, `Stops (${list.length})`),
      list.length
        ? h('div', { class: 'tl-stoplist' }, list.map((s, i) => h('button', {
          class: `tl-stoprow${ui.selected === s.id ? ' selected' : ''}`,
          onclick: () => { select(s.id); seekFrame(s.frame); },
        }, h('span', { class: 'tl-stopnum' }, String(i + 1)), h('span', { class: 'tl-stopname' }, s.name || fmt(timeOf(s.frame))), h('span', { class: 'muted' }, s.key ? `${s.key.label || '?'}` : ''))))
        : h('p', { class: 'hint' }, proj.video ? 'No stops yet — the video would just play through. Double-click the timeline or press S to add one.' : 'Add a video first.'),
    ));

    const back = proj.keys.back;
    const job = proj.video && state.revJobs.get(proj.video.file);
    const revReady = proj.video && proj.reversed?.[proj.video.file];
    let revStatus = null;
    if (back.enabled && proj.video) {
      if (job?.error) revStatus = h('p', { class: 'warn' }, `Couldn't make the reversed video: ${job.error} `, h('button', { class: 'link-btn', onclick: () => ctx.ensureReversed(proj.video.file) }, 'Retry'));
      else if (job) revStatus = h('div', { class: 'rev-progress' }, `Making reversed video… ${Math.round(job.pct * 100)}%`, h('div', { class: 'bar' }, h('div', { style: `width:${job.pct * 100}%` })));
      else if (revReady) revStatus = h('p', { class: 'hint ok' }, '✓ Reversed video ready');
    }

    sections.push(h('div', { class: 'section' },
      h('h3', {}, 'Controls'),
      h('div', { class: 'field' }, h('span', {}, 'Continue key (at every stop)'), keycap(proj.keys.next)),
      h('label', { class: 'row' },
        h('input', { type: 'checkbox', checked: !!proj.keys.click, onchange: e => commit(() => { proj.keys.click = e.target.checked; }) }),
        'Clicking also continues'),
      h('label', { class: 'row rev-toggle' },
        h('input', {
          type: 'checkbox', checked: !!back.enabled,
          onchange: e => {
            commit(() => { back.enabled = e.target.checked; });
            if (back.enabled && proj.video && !proj.reversed?.[proj.video.file]) ctx.ensureReversed(proj.video.file);
          },
        }),
        'Back key plays in reverse to the previous stop'),
      back.enabled ? h('div', { class: 'field' }, h('span', {}, 'Back key'), keycap(back)) : null,
      revStatus,
      keyClashWarning(),
      h('label', { class: 'field' }, h('span', {}, 'At the end of the video'),
        h('select', { onchange: e => commit(() => { proj.end = e.target.value; }) },
          h('option', { value: 'hold', selected: proj.end !== 'restart' }, 'Hold the last frame'),
          h('option', { value: 'restart', selected: proj.end === 'restart' }, 'Next key restarts from the beginning'),
        )),
    ));

    sections.push(h('div', { class: 'section' },
      h('h3', {}, 'Playback'),
      h('label', { class: 'field' }, h('span', {}, 'Scaling'),
        h('select', { onchange: e => commit(() => { proj.fit = e.target.value; }) },
          h('option', { value: 'contain', selected: proj.fit !== 'cover' }, 'Fit (letterbox)'),
          h('option', { value: 'cover', selected: proj.fit === 'cover' }, 'Fill (crop)'),
        )),
      h('label', { class: 'row' },
        h('input', { type: 'checkbox', checked: !!proj.sound, onchange: e => commit(() => { proj.sound = e.target.checked; }) }),
        'Play audio (starts after the first key press)'),
    ));

    sections.push(ctx.publishSection(), ctx.localSection());
    el.inspector.replaceChildren(...sections);
  }

  function keyClashWarning() {
    const k = p().keys;
    if (k.back.enabled && k.back.code && k.back.code === k.next.code) return h('p', { class: 'warn' }, 'Continue and back use the same key.');
    const clash = p().stops.find(s => s.key?.code && k.back.enabled && s.key.code === k.back.code);
    return clash ? h('p', { class: 'warn' }, `Stop ${stopNumber(clash)} continues with ${clash.key.label}, the same as the back key.`) : null;
  }

  function nudge(s, d) {
    const f = Math.max(0, Math.min(frames() - 1, s.frame + d));
    if (p().stops.some(o => o !== s && o.frame === f)) return;
    commit(() => { s.frame = f; });
    seekFrame(f);
  }

  // ---------------------------------------------------------------- keyboard

  function onKey(e) {
    if (p()?.mode !== 'timeline' || !el.root?.isConnected || state.listening) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    let handled = true;
    if (mod && k.toLowerCase() === 'z') ctx.undoRedo(e.shiftKey);
    else if (mod && k.toLowerCase() === 'y') ctx.undoRedo(true);
    else if (mod) handled = false;
    else if (k === ' ') togglePlay();
    else if (k === 'ArrowLeft' || k === ',') step(e.shiftKey ? -Math.round(fps()) : -1);
    else if (k === 'ArrowRight' || k === '.') step(e.shiftKey ? Math.round(fps()) : 1);
    else if (k === 's' || k === 'S' || k === 'm' || k === 'M') addStop(curFrame());
    else if (k === '[') jumpStop(-1);
    else if (k === ']') jumpStop(1);
    else if (k === 'Home') seekFrame(0);
    else if (k === 'End') seekFrame(frames() - 1);
    else if ((k === 'Delete' || k === 'Backspace') && stopById(ui.selected)) deleteStop(stopById(ui.selected));
    else if (k === 'Escape') select(null);
    else handled = false;
    if (handled) e.preventDefault();
  }
  if (!state.timelineKeysBound) {
    window.addEventListener('keydown', e => state.timeline?.onKey(e));
    state.timelineKeysBound = true;
  }

  render();
  return { render, renderInspector, onKey };
}

function ensureDefaults(p) {
  p.stops ||= [];
  p.keys ||= {};
  p.keys.next ||= { code: 'ArrowRight', label: '→' };
  p.keys.back ||= { enabled: false, code: 'ArrowLeft', label: '←' };
  if (p.keys.click == null) p.keys.click = true;
  p.end ||= 'hold';
}
