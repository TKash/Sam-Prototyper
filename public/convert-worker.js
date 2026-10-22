// Runs ffmpeg (its WebAssembly build) off the main thread. Two jobs:
//
// fix:     re-encode a video the browser can't play (e.g. MPEG-4 Part 2
//          "mp4v" exports) as plain H.264. ffmpeg brings its own decoders.
// reverse: make the reversed copy used by rewinds — every frame exactly, in
//          reverse order, at the source's own frame rate (see reverse()).
//
// The single-thread build needs no special headers (no SharedArrayBuffer).

const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

// x264 at constant quality (not a fixed bitrate), so the copy matches the
// source's quality whatever it is; aq-mode 3 keeps dark gradients clean.
// No B-frames: the reversed pieces are joined as raw H.264 (and decoders
// step through it more easily).
const X264 = ['-c:v', 'libx264', '-preset', 'faster', '-crf', '15', '-bf', '0', '-pix_fmt', 'yuv420p', '-x264-params', 'aq-mode=3'];
const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

let core = null;
let log = [];      // recent ffmpeg messages, for error reports
let stdout = [];   // ffprobe output
let onExecProgress = () => {};

async function load() {
  if (core) return core;
  postMessage({ type: 'phase', phase: 'load' });
  try {
    const { default: createCore } = await import(`${CORE}/ffmpeg-core.js`);
    core = await createCore({ locateFile: f => (f.endsWith('.wasm') ? `${CORE}/ffmpeg-core.wasm` : f) });
  } catch {
    throw new Error("Couldn't load the video converter. It needs an internet connection the first time.");
  }
  core.setLogger(({ type, message }) => {
    if (type === 'stdout') stdout.push(message);
    else { log.push(message); if (log.length > 30) log.shift(); }
  });
  core.setProgress(({ progress }) => onExecProgress(Math.min(1, Math.max(0, progress))));
  return core;
}

function run(...args) {
  log = [];
  const ret = core.exec(...args);
  core.reset();
  if (ret !== 0) throw new Error(log.filter(l => /error|invalid|could not|no such|cannot/i.test(l)).pop() || `ffmpeg exited with code ${ret}`);
}

function take(name) {
  const data = core.FS.readFile(name);
  core.FS.unlink(name);
  return data;
}

const progress = pct => postMessage({ type: 'progress', pct });

function fix(input) {
  onExecProgress = progress;
  // Video only (the player is muted), every frame kept as-is, 4:2:0 and even
  // dimensions for H.264, a keyframe every second for quick seeking.
  run('-i', input, '-map', '0:v:0', '-an', '-vf', EVEN, '-vsync', 'passthrough',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-force_key_frames', 'expr:gte(t,n_forced*1)', '-movflags', '+faststart', 'out.mp4');
  return { buf: take('out.mp4') };
}

// The source is first put on a constant frame rate (a picture held for a
// while in a variable-frame-rate export is repeated, as a player shows it), so
// frame N is exactly N / fps seconds and the copy keeps the source's timing.
// Frames are then addressed by number, never by seeking, so 29.97 fps and
// variable-rate sources come out exactly. The source usually ends on a still picture after
// its animation; with trimStill that still is left out (the copy opens on its
// first frame and goes straight into the motion) and `settle` is when it
// begins, in seconds — the player treats the clip as finished from then on.
function reverse(input, trimStill) {
  // 1. Frame rate and size.
  stdout = [];
  core.ffprobe('-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate,width,height', '-of', 'json', input);
  core.reset();
  let st = {};
  try { st = JSON.parse(stdout.join('\n')).streams?.[0] || {}; } catch { /* defaults below */ }
  // The stream's base rate (avg_frame_rate is lower for variable-rate exports),
  // unless it's a container time base rather than a real frame rate.
  const value = r => (/^\d+\/[1-9]\d*$/.test(r || '') ? r.split('/').reduce((a, b) => a / b) : 0);
  const rate = [st.r_frame_rate, st.avg_frame_rate].find(r => value(r) >= 1 && value(r) <= 120) || '30/1';
  const fps = value(rate);
  const CFR = `fps=${rate}`;

  // 2. A 32×18 greyscale thumbnail of every frame (area scaling = block
  //    averages, which catches the slow easing at the end of an animation).
  //    Gives the exact frame count and where the final still begins.
  onExecProgress = p => progress(p * 0.15);
  run('-i', input, '-map', '0:v:0', '-an', '-vsync', 'passthrough', '-vf', `${CFR},scale=32:18:flags=area,format=gray`, '-f', 'rawvideo', 'thumbs.raw');
  const thumbs = take('thumbs.raw');
  const T = 32 * 18;
  const n = Math.floor(thumbs.length / T);
  if (!n) throw new Error('No video frames found');
  let last = n - 1;
  if (trimStill) {
    // Strict: only frames practically identical to the final picture count as
    // still — on average, and in every block, so a change confined to a small
    // area (a highlight moving in a menu) still counts as motion. Compression
    // noise between identical frames stays well under both limits.
    const differs = (i, j) => {
      let s = 0, max = 0;
      for (let k = 0; k < T; k++) { const d = Math.abs(thumbs[i * T + k] - thumbs[j * T + k]); s += d; if (d > max) max = d; }
      return s / T >= 0.4 || max >= 6;
    };
    while (last > 0 && !differs(last - 1, n - 1)) last--;
  }

  // 3. Reverse it in pieces from the end, so only one piece of decoded frames
  //    is held at a time (about 150 MB, whatever the resolution).
  const frameBytes = (st.width || 1920) * (st.height || 1080) * 1.5;
  const CHUNK = Math.max(8, Math.min(60, Math.floor(150e6 / frameBytes)));
  const gop = String(Math.max(1, Math.round(fps))); // a keyframe every second
  const parts = [];
  let done = 0;
  for (let e = last; e >= 0; e -= CHUNK) {
    const s = Math.max(0, e - CHUNK + 1);
    const base = 0.15 + 0.83 * (done / (last + 1)), span = 0.83 * ((e - s + 1) / (last + 1));
    onExecProgress = p => progress(base + span * p);
    run('-i', input, '-map', '0:v:0', '-an', '-vsync', 'passthrough',
      '-vf', `${CFR},trim=start_frame=${s}:end_frame=${e + 1},reverse,setpts=N/(FRAME_RATE*TB),${EVEN}`,
      ...X264, '-g', gop, '-f', 'h264', 'part.h264');
    parts.push(take('part.h264'));
    done += e - s + 1;
  }

  // 4. Join the pieces and put them in an MP4 at the source's frame rate.
  const all = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  parts.reduce((at, p) => { all.set(p, at); return at + p.length; }, 0);
  core.FS.writeFile('all.h264', all);
  onExecProgress = () => {};
  run('-framerate', rate, '-i', 'all.h264', '-c', 'copy', '-movflags', '+faststart', 'out.mp4');
  core.FS.unlink('all.h264');
  progress(1);
  return { buf: take('out.mp4'), fps, frames: last + 1, sourceFrames: n, settle: +(last / fps).toFixed(4) };
}

self.onmessage = async ({ data }) => {
  const input = `in${data.ext || '.mp4'}`;
  try {
    const ff = await load();
    postMessage({ type: 'phase', phase: 'convert' });
    ff.FS.writeFile(input, new Uint8Array(data.buf));
    const result = data.op === 'reverse' ? reverse(input, !!data.trimStill) : fix(input);
    postMessage({ type: 'done', ...result }, [result.buf.buffer]);
  } catch (e) {
    postMessage({ type: 'error', message: e?.message || String(e) });
  } finally {
    for (const f of [input, 'out.mp4', 'thumbs.raw', 'part.h264', 'all.h264']) { try { core?.FS.unlink(f); } catch {} }
    core?.reset();
  }
};
