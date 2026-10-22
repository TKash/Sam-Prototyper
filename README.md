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
- A connector fires on a **key press**, a **click**, or **after the video ends**. Each clip can have only one "after video ends" connector.
- Clips that aren't followed automatically either **loop** or **hold** their last frame.
- Animation: **Instant** or **Dissolve** (50–3000 ms).
- **Reverse with a key**: press a key on the target clip to rewind back to where you came from. The player remembers the route you actually took, so back keys retrace that path.
- Undo/redo, and **Play from here** on any clip (opens the player with `?start=<clipId>`).

## Player

`/p/<id>` downloads every video, prepares the first frame of each, then starts. Switching clips happens within a frame, with no flash or load. Double-click toggles full screen.

Rewinds use a reversed copy of the video that the editor makes in your browser (`public/reverse.js`, using WebCodecs). The copy is made once per video and saved with the project. If you press back during an animation, the player waits until that clip has settled, then plays the full rewind.

## Sharing

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
| `server.js` | Local server: projects, media, export, offline file, Pages publish |
| `worker/index.js`, `wrangler.toml` | Hosted version on Cloudflare Workers + KV |
