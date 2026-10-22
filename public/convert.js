// "Fix video": re-encodes a clip as plain H.264 (video only) in the browser,
// using ffmpeg in a worker (convert-worker.js). One worker is kept so ffmpeg
// (about 32 MB, cached by the browser) loads once per page; jobs run in turn.

let worker = null;
let queue = Promise.resolve();

function getWorker() {
  worker ||= new Worker(new URL('./convert-worker.js', import.meta.url), { type: 'module' });
  return worker;
}

// onProgress(phase, pct): phase 'download' | 'load' | 'convert', pct 0..1.
export function fixVideo(src, onProgress = () => {}) {
  const job = queue.then(() => run(src, onProgress));
  queue = job.catch(() => {});
  return job;
}

async function run(src, onProgress) {
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
      else if (data.type === 'done') resolve(new Blob([data.buf], { type: 'video/mp4' }));
      else if (data.type === 'error') reject(new Error(data.message));
    };
    w.onerror = e => {
      e.preventDefault?.();
      worker = null; // a broken worker is replaced on the next job
      reject(new Error(e.message || "Couldn't start the converter (needs internet the first time)"));
    };
    w.postMessage({ buf, ext }, [buf]);
  });
}
