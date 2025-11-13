# Unidentified

Unidentified is a comfort-first, purple-soaked incognito portal. The UI lives in `public/` and a custom Node-powered relay in `backend/` (codename **Powerthrough**) rewrites outbound traffic so you can browse through a single host without depending on Scramjet, Ultraviolet, or Rammerhead.

## Project layout

```
public/   - Static assets (HTML, CSS, JS)
backend/  - Express server + Powerthrough relay proxy
index.html - Redirect helper for static hosts
```

## Running locally

```bash
cd backend
pnpm install          # first run
pnpm start            # or: pnpm dev for hot reload
```

The server hosts both the relay API and the static UI at `http://localhost:8787`. To change the port, run `PORT=XXXX pnpm start`.

### Just the static UI

If you only want the mock UI without proxy behavior you can still run a quick file server:

```bash
python -m http.server 3000
# browse to http://localhost:3000/public/
```

## Deploying

1. Deploy `backend/` to your server or platform of choice (Render, Fly.io, a VPS, etc.).
2. Ensure the backend can reach outbound HTTPS traffic and exposes `/powerthrough`.
3. Serve `public/` from the same origin as the backend to avoid CORS headaches. The provided Express server already does this when deployed together.
4. For static hosting (GitHub Pages, Netlify), you must also deploy the backend somewhere public and update the URLs in `public/app.js` to point at it.

## Powerthrough relay overview

- Rewrites HTML `href`, `src`, `action`, and `srcset` attributes so follow-up requests also flow through `/powerthrough`.
- Streams non-HTML responses untouched while preserving headers like `Content-Type` and `Set-Cookie`.
- Blocks obvious private hosts (`localhost`, `127.0.0.1`, `0.0.0.0`, RFC1918 ranges) so the relay cannot poke your LAN.
- Offers three personalities (Powerthrough, Prism, Phantom). They currently map to the same endpoint but give us room to tune behavior per mode.

## Customizing

- Update the hero copy and mission statement in `public/index.html`.
- Tweak the palette in `public/style.css`.
- Adjust relay behavior, sanitization, or rewriting in `backend/server.js`.
- Modify the UI logic (search normalization, panic shortcut, history toggle) in `public/app.js`.
- Tune the Powerthrough workspace experience (in-page iframe, tab cloak, about:blank helper) inside `public/index.html` + `public/app.js`.

PRs and experiments are welcome. This project is intentionally lightweight so you can riff on the idea. Stay safe out there.
