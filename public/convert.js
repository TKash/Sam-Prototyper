// In-browser ffmpeg jobs (convert-worker.js): "Fix video" re-encodes a clip as
// plain H.264, and reversed copies for rewinds are made frame-exact. One
// worker is kept so ffmpeg (about 32 MB, cached by the browser) loads once
// per page; jobs run in turn.

let worker = null;
let queue = Promise.resolve();

function getWorker() {
  worker ||= new Worker(new URL('./convert-worker.js', import.meta.url), { type: 'module' });
  return worker;
}

function enqueue(job) {
  const next = queue.then(job);
  queue = next.catch(() => {});
  return next;
}

// onProgress(phase, pct): phase 'download' | 'load' | 'convert', pct 0..1.
export function fixVideo(src, onProgress = () => {}) {
  return enqueue(async () => {
    const { buf } = await run(src, { op: 'fix' }, onProgress);
    return new Blob([buf], { type: 'video/mp4' });
  });
}

// Resolves to { blob, fps, frames, sourceFrames, settle } (see reverse() in the worker).
export function reverseWithFfmpeg(src, onProgress = () => {}, { trimStill = false } = {}) {
  return enqueue(async () => {
    const { buf, type, ...meta } = await run(src, { op: 'reverse', trimStill }, onProgress);
    return { blob: new Blob([buf], { type: 'video/mp4' }), ...meta };
  });
}

async function run(src, msg, onProgress) {
  onProgress('download', 0);
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Couldn't download the video (${res.status})`);
  const buf = await res.arrayBuffer();
  const ext = (src.match(/\.\w+$/) || ['.mp4'])[0].toLowerCase();

  const w = getWorker();
  return new Promise((resolve, reject) => {
    let phase = 'load';
    w.onmessage = ({ data }) => {
      if (data.type === 'phase') { phase = data.phase; onProgress(phase, 0); }
      else if (data.type === 'progress') onProgress(phase, data.pct);
      else if (data.type === 'done') resolve(data);
      else if (data.type === 'error') reject(new Error(data.message));
    };
    w.onerror = e => {
      e.preventDefault?.();
      worker = null; // a broken worker is replaced on the next job
      reject(new Error(e.message || "Couldn't start the converter (needs internet the first time)"));
    };
    w.postMessage({ ...msg, buf, ext }, [buf]);
  });
}
