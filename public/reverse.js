// Builds a reversed copy of an MP4 in the browser. Browsers can't play video
// backwards smoothly, so the player plays this pre-reversed file forwards instead.
//
// Normally ffmpeg does it (convert.js): it addresses frames by number, so the
// copy is frame-exact at any frame rate, and encodes at constant quality. The
// WebCodecs method below is the fallback when ffmpeg can't load (offline):
//
// 1. Step through the source frame by frame (seek) and copy each decoded frame
//    out in its native YUV form — no RGB canvas or JPEG step, so colours and
//    brightness come through exactly (falls back to a canvas copy only if the
//    browser can't hand over raw frames).
// 2. Feed those frames in reverse order to a WebCodecs H.264 encoder, tagged
//    with the source's colour space.
// 3. Mux the result into an MP4 with mp4-muxer.

import { reverseWithFfmpeg } from './convert.js';

const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/+esm';
const CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.420028'];

const once = (el, ev) => new Promise((resolve, reject) => {
  el.addEventListener(ev, resolve, { once: true });
  el.addEventListener('error', () => reject(new Error('Could not read the video')), { once: true });
});

async function seek(v, t) {
  if (Math.abs(v.currentTime - t) < 1e-6) return;
  const done = once(v, 'seeked');
  v.currentTime = t;
  await done;
}

// Frame rate from the gaps between presented frames during a short muted play.
export async function detectFps(v) {
  if (!v.requestVideoFrameCallback) return 30;
  const times = [];
  await new Promise(resolve => {
    const tick = (_, m) => {
      times.push(m.mediaTime);
      if (times.length >= 12) return resolve();
      v.requestVideoFrameCallback(tick);
    };
    v.requestVideoFrameCallback(tick);
    v.play().catch(resolve);
    setTimeout(resolve, 1500);
  });
  v.pause();
  const gaps = times.slice(1).map((t, i) => t - times[i]).filter(d => d > 0.004).sort((a, b) => a - b);
  if (!gaps.length) return 30;
  const fps = 1 / gaps[Math.floor(gaps.length / 2)];
  return [24, 25, 30, 48, 50, 60].reduce((best, f) => (Math.abs(f - fps) < Math.abs(best - fps) ? f : best), 30);
}

// options.trimStill: leave out the source's final still picture (canvas rewinds).
// Single-video prototypes need the full-length copy, so they don't pass it.
// Resolves to { blob, fps, frames, sourceFrames, settle, engine }.
export async function reverseVideo(src, onProgress = () => {}, opts = {}) {
  try {
    // ffmpeg's own progress, after fetching the video and loading ffmpeg itself.
    const r = await reverseWithFfmpeg(src, (phase, pct) => onProgress(phase === 'convert' ? 0.05 + 0.95 * pct : 0.02), opts);
    return { ...r, engine: 'ffmpeg' };
  } catch (e) {
    console.warn('Reversing with ffmpeg failed, trying WebCodecs:', e);
    try {
      return { ...(await reverseWithWebCodecs(src, onProgress, opts)), engine: 'webcodecs' };
    } catch {
      throw e; // ffmpeg's reason is the more useful one
    }
  }
}

async function reverseWithWebCodecs(src, onProgress = () => {}, { trimStill = false } = {}) {
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser can\'t encode video (WebCodecs missing). Use Chrome or Edge.');
  const { Muxer, ArrayBufferTarget } = await import(MUXER_URL);

  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = src;
  await once(v, 'loadeddata');
  const fps = await detectFps(v);
  const W = v.videoWidth & ~1, H = v.videoHeight & ~1; // H.264 wants even sizes
  const n = Math.max(1, Math.round(v.duration * fps));

  let codec = null;
  for (const c of CODECS) {
    const cfg = { codec: c, width: W, height: H, bitrate: 12_000_000, framerate: fps, avc: { format: 'avc' } };
    if ((await VideoEncoder.isConfigSupported(cfg)).supported) { codec = cfg; break; }
  }
  if (!codec) throw new Error(`No H.264 encoder available for ${W}×${H}.`);

  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: W, height: H, frameRate: fps }, fastStart: 'in-memory' });
  let failure = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => (failure = e) });
  encoder.configure(codec);
  const frameUs = Math.round(1e6 / fps);

  // Grab the frame currently shown by `v`. Preferred: a raw copy of the decoded
  // YUV planes (exact colours). Fallback: an RGB canvas copy.
  let canvas = null, g = null;
  // After a seek the element can briefly still hold the previous frame. A frame
  // taken from <video> carries its media time, so wait until it's the frame
  // covering the time we sought to (it starts at most ~1 frame earlier).
  const currentFrame = async (i, t) => {
    for (let tries = 0; ; tries++) {
      const vf = new VideoFrame(v);
      const ts = vf.timestamp / 1e6;
      if (ts <= t + 0.001 && ts > t - 1.5 / fps) return vf;
      vf.close();
      if (tries >= 40) throw new Error(`The browser kept showing the wrong frame (wanted frame ${i}). Try again in a normal, visible browser tab.`);
      await new Promise(r => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => r()) : null, setTimeout(r, 25)));
    }
  };
  const grab = async (i, t) => {
    const vf = await currentFrame(i, t);
    try {
      if (vf.format) {
        const buf = new Uint8Array(vf.allocationSize());
        const layout = await vf.copyTo(buf);
        return { raw: true, buf, layout, format: vf.format, w: vf.visibleRect.width, h: vf.visibleRect.height, colorSpace: vf.colorSpace.toJSON() };
      }
    } catch { /* fall through to the canvas copy */ } finally { vf.close(); }
    canvas ||= new OffscreenCanvas(W, H);
    g ||= canvas.getContext('2d');
    g.drawImage(v, 0, 0, W, H);
    return { raw: false, bmp: await createImageBitmap(canvas) };
  };
  const toFrame = (f, timestamp) => (f.raw
    ? new VideoFrame(f.buf, { format: f.format, codedWidth: f.w, codedHeight: f.h, layout: f.layout, colorSpace: f.colorSpace, timestamp, duration: frameUs })
    : new VideoFrame(f.bmp, { timestamp, duration: frameUs }));

  // Tiny greyscale thumbnail of a grabbed frame (from the Y plane when raw),
  // used to find where the source's final still picture begins.
  const TW = 32, TH = 18;
  let tcanvas = null, tctx = null;
  const thumbOf = f => {
    const out = new Float32Array(TW * TH);
    if (f.raw && /^(NV12|I4)/.test(f.format)) {
      // Average each block of the Y (brightness) plane — single pixels miss
      // the slow easing at the end of an animation. Every 2nd pixel is plenty.
      const { offset, stride } = f.layout[0];
      const bw = f.w / TW, bh = f.h / TH;
      for (let by = 0; by < TH; by++) {
        for (let bx = 0; bx < TW; bx++) {
          let sum = 0, cnt = 0;
          for (let y = Math.floor(by * bh); y < Math.floor((by + 1) * bh); y += 2) {
            const row = offset + y * stride;
            for (let x = Math.floor(bx * bw); x < Math.floor((bx + 1) * bw); x += 2) { sum += f.buf[row + x]; cnt++; }
          }
          out[by * TW + bx] = sum / cnt;
        }
      }
      return out;
    }
    tcanvas ||= new OffscreenCanvas(TW, TH);
    tctx ||= tcanvas.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(f.raw ? v : f.bmp, 0, 0, TW, TH);
    const d = tctx.getImageData(0, 0, TW, TH).data;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8;
    return out;
  };
  // Strict: only frames practically identical to the final picture count as
  // "still" — on average and in every block, so a change in a small area still
  // counts (compression noise between identical frames stays well under both).
  const differs = (a, b) => {
    let s = 0, max = 0;
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); s += d; if (d > max) max = d; }
    return s / a.length >= 0.4 || max >= 6;
  };

  // Work backwards in chunks so long videos never hold every frame in memory:
  // capture a chunk forwards (cheap sequential seeks), then encode it in reverse.
  // Raw 1080p frames are ~3 MB each, so a chunk of 30 stays around 90 MB.
  //
  // The source usually ends on a still picture after its animation is done.
  // Played backwards that would be a stretch where nothing moves, so it's left
  // out: the reversed copy starts on the first frame of that final still and
  // goes straight into the motion. `settle` (seconds into the source) is when
  // that still begins — the player treats the clip as finished from then on.
  const CHUNK = 30;
  let out = 0; // frames encoded so far
  let work = 0; // capture + encode steps done, out of 2n
  let endThumb = null;        // the source's last frame
  let trimming = trimStill;   // still inside the final still picture
  let pendingStill = null;    // earliest frame of that still seen so far
  let settleIndex = n - 1;
  const encodeOne = f => {
    const frame = toFrame(f, out * frameUs);
    encoder.encode(frame, { keyFrame: out % fps === 0 }); // a keyframe every second
    frame.close();
    f.bmp?.close();
    out++;
  };
  for (let end = n; end > 0; end -= CHUNK) {
    const start = Math.max(0, end - CHUNK);
    const frames = [];
    for (let i = start; i < end; i++) {
      // Middle of frame i; the last one is clamped so it really is the final frame.
      const t = Math.min(v.duration - 0.001, (i + 0.5) / fps);
      await seek(v, t);
      frames.push(await grab(i, t));
      onProgress(++work / (2 * n));
    }
    for (let k = frames.length - 1; k >= 0; k--) {
      if (failure) throw failure;
      const f = frames[k], i = start + k;
      if (trimming) {
        const th = thumbOf(f);
        endThumb ||= th;
        if (!differs(th, endThumb)) {
          pendingStill?.bmp?.close();
          pendingStill = f;
          settleIndex = i;
          frames[k] = null;
          onProgress(++work / (2 * n));
          continue;
        }
        trimming = false;
        encodeOne(pendingStill); // the copy opens on the settled picture
        pendingStill = null;
      }
      encodeOne(f);
      frames[k] = null;
      if (encoder.encodeQueueSize > 6) await new Promise(r => encoder.addEventListener('dequeue', r, { once: true }));
      onProgress(++work / (2 * n));
    }
  }
  if (pendingStill) encodeOne(pendingStill); // the whole clip was one still picture
  v.removeAttribute('src');
  v.load();
  await encoder.flush();
  if (failure) throw failure;
  encoder.close();

  // 3. mux
  muxer.finalize();
  return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), fps, frames: out, sourceFrames: n, settle: +(settleIndex / fps).toFixed(4) };
}
