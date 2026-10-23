# Clip Proto

Turn UI screen recordings into keyboard-driven prototypes. Drop in MP4s, connect them, and share a link that plays full-screen with no UI. Every video is preloaded into memory before playback starts, so nothing buffers.

## Run locally

```bash
node server.js        # or: npm start
```

Open http://localhost:5180 (set `PORT` to change it). Needs Node 18+. Nothing to install, except `npm install` if you want **Publish to web** (it uses wrangler).

## Two kinds of prototype

**Single video with stops**: one recording. Mark the exact frames where it should pause and wait for a key press.
- A **continue key** plays on to the next stop. An optional **back key** plays in reverse to the previous stop (the two can be the same key).
- Any stop can use its own "Continue with" key instead of the default.

**Clips on a canvas**: several videos laid out like Figma frames and joined by connectors, with branching paths.
- A connector fires on a **key press**, a **click**, or **after the video ends**. Each clip can have only one "after video ends" connector, and it can have a **delay** (ms) that holds the clip's last frame before moving on. A key press or click during the delay takes over.
- Clips that aren't followed automatically either **loop** or **hold** their last frame.
- Animation: **Instant** or **Dissolve** (50–3000 ms).
- **Reverse with a key**: press a key on the target clip to rewind back to where you came from. The player remembers the route you actually took, so back keys retrace that path.
- Undo/redo, and **Play from here** on any clip (opens the player with `?start=<clipId>`).
- **Image frames:** drop a PNG (or JPG / WebP) to add a static screen. The editor turns it into a 1-second still video (H.264, near-lossless) in your browser, holds it on screen, and keeps the original image too. Transparent areas become black. Any frame's panel has **Download video**, plus **Download image** for image frames.
- **Fix video** (in a frame's panel): re-encodes the frame's video as standard H.264 without sound, in your browser, and swaps it in. Frames the browser can't play (for example MPEG-4 Part 2 exports) are marked "Can't play this video". It uses ffmpeg compiled to WebAssembly, loaded from jsDelivr (about 32 MB the first time).

## Player

If someone presses 3 keys in a row that do nothing on the current screen, a small **Try one of these** box shows what does work there (or R / M at the end of a flow).

Press **H** for help: a see-through panel over the running prototype with the prototype's help text (or, without one, a map of every screen and where its keys lead, or the list of stops), the keys and actions that work on the current screen, and the general controls (H, R, M, double-click). It follows along as you navigate; H or Esc closes it. Write the help text in the Prototype panel (or the single-video panel), and an optional **Screen note** per frame.

`/p/<id>` downloads every video, prepares the first frame of each, then starts. Switching clips happens within a frame, with no flash or load. Double-click toggles full screen.

Rewinds use a reversed copy of the video that the editor makes in your browser with ffmpeg (`public/reverse.js` and `convert-worker.js`). It reads every frame by number, at a constant frame rate, so 29.97 fps and variable-frame-rate exports come out frame-exact with the original timing, and it encodes at constant quality (x264, CRF 15). If ffmpeg can't load, it falls back to the older WebCodecs method. The copy is made once per video and saved with the project. The panel has **Download** and **Remake** links, and copies made with the older method are flagged for a remake. If you press back during an animation, the player waits until that clip has settled, then plays the full rewind.

## Sharing

- **Client gallery:** `/gallery` shows every prototype marked **In gallery** (a switch on the editor's home screen) as a grid of cards, in the order set in the editor's Client gallery box (**Order**, with ↑ / ↓); any without a set place come after, by name. Arrow keys and Enter choose one. Inside a prototype opened from the gallery, **M** goes back to it and **N** / **P** go to the next / previous prototype (wrapping round). **R** restarts any prototype, from the start frame or from the frame chosen in the Prototype panel's **R restarts from**. A prototype's own key connections take priority over R and M. Each card's cover is a still from the prototype's start video, made by the editor.
- **Phone remote:** the panel on the right of the gallery shows a QR code and whether a phone is linked; scan it and the phone becomes a TV remote (`/remote`, from the [Figma TV Remote](https://github.com/TKash/figma-remote-)): D-pad = arrow keys, OK = Enter, Back = Backspace, Home = R, Main Menu = M, Help = H, Voice = V, Prev/Next Proto = P/N. The gallery and every prototype opened in that browser follow it; the pairing code is made on the first visit and kept in the browser (**New code** replaces it). The panel also lists all the controls. Both devices talk through a free public MQTT relay (HiveMQ), so they need internet but not the same Wi-Fi. Code: `public/remote-link.js`, `public/remote.html`.
- **Gallery offline file:** the Client gallery box on the editor's home screen has **Download offline file**: one .html with the gallery, every prototype in it and all their videos (each video once, even if several prototypes use it). Opened from disk it shows the same gallery and plays a prototype in a full-screen frame over it; R restarts, M closes it. Only the open prototype's videos are unpacked.
- **Local preview / same Wi-Fi:** the editor shows a link that points to this machine. It only works while the server is running.
- **Offline file:** one `.html` file with every video inside. Send it over Teams, SharePoint or email, and viewers just double-click it. No internet or server needed.
- **Export folder:** writes `exports/<name>-<id>/` (index.html, player files, project.json, media/) for any static host. It has to be served over http(s); opening it from `file://` won't work.
- **Publish to web:** pushes that folder to Cloudflare Pages and gives you a permanent public URL. Needs `npm install` and `npx wrangler login` first.

Local data lives in `data/` (project JSON files, plus videos stored by content hash). It is git-ignored on purpose. Never commit it.

## Hosted version (Cloudflare Workers)

The editor and player are also hosted at https://clip-proto.clip-proto.workers.dev. Projects and videos live in Cloudflare KV on the free plan.

- **Editor:** open to anyone with the link unless a password is set (`npx wrangler secret put EDITOR_PASSWORD`). With one set, the editor asks for it. **Play links** (`/p/<id>`) are always public. Edits go live as soon as they save.
- **Offline file:** built in the browser, because free-plan Workers only get about 10 ms of CPU per request.
- **Code:** `worker/index.js` and `wrangler.toml` (KV binding `STORE`). Videos are stored in 24 MiB pieces.
- **Redeploy after editing anything in `public/` or `worker/`:** `npx wrangler deploy` (needs `npx wrangler login`)
- **Free-plan limits:** about 1 GB of KV storage, 1,000 writes a day, and 100 MB per upload.
- **Local and hosted are separate:** projects made in the local app aren't on the hosted site, and the reverse is true too.

## Files

| Path | What it is |
| --- | --- |
| `public/editor.js`, `editor.css`, `index.html` | Canvas editor, home screen, publish/share panels |
| `public/timeline.js` | Single-video editor (stops, continue/back keys) |
| `public/player.js`, `player.html`, `player.css` | UI-less player |
| `public/reverse.js` | In-browser reversed-video generator |
| `public/convert.js`, `convert-worker.js` | Fix video: in-browser H.264 re-encode (ffmpeg.wasm) |
| `server.js` | Local server: projects, media, export, offline file, Pages publish |
| `worker/index.js`, `wrangler.toml` | Hosted version on Cloudflare Workers + KV |
