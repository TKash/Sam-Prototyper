// Runs ffmpeg (its WebAssembly build) off the main thread to re-encode a video
// the browser can't play — e.g. MPEG-4 Part 2 ("mp4v") exports — as plain
// H.264. ffmpeg brings its own decoders, so it can read files Chrome can't.
// The single-thread build needs no special headers (no SharedArrayBuffer).

const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

let core = null;
let log = [];

async function load() {
  if (core) return core;
  postMessage({ type: 'phase', phase: 'load' });
  const { default: createCore } = await import(`${CORE}/ffmpeg-core.js`);
  core = await createCore({ locateFile: f => (f.endsWith('.wasm') ? `${CORE}/ffmpeg-core.wasm` : f) });
  core.setLogger(({ message }) => { log.push(message); if (log.length > 30) log.shift(); });
  core.setProgress(({ progress }) => postMessage({ type: 'progress', pct: Math.min(1, Math.max(0, progress)) }));
  return core;
}

self.onmessage = async ({ data }) => {
  const input = `in${data.ext || '.mp4'}`;
  try {
    const ff = await load();
    postMessage({ type: 'phase', phase: 'convert' });
    log = [];
    ff.FS.writeFile(input, new Uint8Array(data.buf));
    // Video only (the player is muted), every frame kept as-is, 4:2:0 and even
    // dimensions for H.264, a keyframe every second for quick seeking.
    const ret = ff.exec(
      '-i', input,
      '-map', '0:v:0', '-an',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-vsync', 'passthrough',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-force_key_frames', 'expr:gte(t,n_forced*1)',
      '-movflags', '+faststart',
      'out.mp4',
    );
    if (ret !== 0) throw new Error(log.filter(l => /error|invalid|could not|no such/i.test(l)).pop() || `ffmpeg exited with code ${ret}`);
    const out = ff.FS.readFile('out.mp4');
    postMessage({ type: 'done', buf: out.buffer }, [out.buffer]);
  } catch (e) {
    postMessage({ type: 'error', message: e?.message || String(e) });
  } finally {
    for (const f of [input, 'out.mp4']) { try { core?.FS.unlink(f); } catch {} }
    core?.reset();
  }
};
