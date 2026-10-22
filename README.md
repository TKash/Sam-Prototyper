# Clip Proto

Turn UI screen recordings into an interactive prototype. Drop in MP4s, connect them with key presses (or clicks), and share a link that plays full-screen with no UI.

## Run

```bash
node mp4-proto/server.js
```

Open http://localhost:5180. Needs Node 18+; no `npm install`.

## How it works

- **Clips**: each MP4 is one state. When a clip ends it can **loop**, **hold the last frame**, or **go to another clip** (use this for transition clips).
- **Triggers**: "While this clip plays" maps a key to a target clip. "From any clip" is the fallback, for example `R` → start clip to restart.
- **Player** (`/p/<id>`): downloads every clip into memory, decodes frame 0 of each one, then starts on the start clip. A key press switches which video is visible within a single frame and plays the new clip from 0, so nothing has to load over the network or decode first. Double-click toggles full screen, and the cursor hides when idle.
- **Testing**: `?start=<clipId>` starts at a specific clip. The editor's "Play from this clip" button uses it.

## Sharing

- On the same Wi-Fi, use the LAN link shown in the editor. It points to this machine, so it only works while the server is running.
- To host it publicly, click **Export folder**. This writes `exports/<name>-<id>/` (index.html, player files, project.json, media/), which you can upload to any static host such as Netlify Drop, Vercel or S3. It has to be served over http(s). Opening it from `file://` won't work.

Data lives in `data/`: project JSON files, plus uploaded videos stored by content hash.

## Hosted version (Cloudflare Workers)

The editor and player are also hosted at https://clip-proto.clip-proto.workers.dev. Projects and videos live in Cloudflare KV on the free plan.

- **Editor:** open to anyone with the link unless a password is set (`npx wrangler secret put EDITOR_PASSWORD`); with one set, the editor asks for it. **Play links** (`/p/<id>`) are always public. Edits go live as soon as they save, so the Publish button isn't needed there.
- **Code:** `worker/index.js` and `wrangler.toml` (KV binding `STORE`). Videos are stored in 24 MB pieces.
- **Redeploy after editing anything in `public/` or `worker/`:** `npx wrangler deploy`
- **Change the editor password:** `npx wrangler secret put EDITOR_PASSWORD`
- **Free-plan limits:** about 1 GB of KV storage, 1,000 writes a day, and 100 MB per upload.
- **Local and hosted are separate:** projects made in the local app (`node server.js`) aren't on the hosted site, and the reverse is true too.
