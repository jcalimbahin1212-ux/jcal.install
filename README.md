# SuperSonic (formerly Unidentified)

SuperSonic is a comfort-first, Sonic-soaked incognito portal. The UI lives in `public/` and a custom Node-powered relay in `backend/` (codename **SuperSonic Safezone**, formerly Powerthrough) rewrites outbound traffic so you can browse through a single host without depending on Scramjet, Ultraviolet, or Rammerhead.

## Project layout

```
public/   - Static assets (HTML, CSS, JS)
backend/  - Express server + SuperSonic relay proxy
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

## Configuration knobs

Environment variable | Purpose | Default
--- | --- | ---
`PORT` | HTTP port for the combined UI + relay server | `8787`
`POWERTHROUGH_CACHE_TTL` | Upper bound (ms) for cached GET responses | `15000`
`POWERTHROUGH_CACHE_MAX` | Max in-memory cache entries before LRU eviction | `400`
`POWERTHROUGH_CACHE_RESPECT` | When set to `false`, ignore upstream cache-control headers | `true`
`POWERTHROUGH_BLOCKLIST` | Comma-separated hostnames to block in addition to localhost/private ranges | _empty_
`POWERTHROUGH_DOMAIN_FAIL_THRESHOLD` | Number of consecutive upstream failures before a domain is cooled off | `3`
`POWERTHROUGH_DOMAIN_FAIL_WINDOW` | Rolling window (ms) for counting failures | `30000`
`POWERTHROUGH_DOMAIN_FAIL_COOLDOWN` | How long (ms) to keep a failing domain paused | `45000`
`POWERTHROUGH_ADMIN_TOKEN` | Enables authenticated cache purge endpoint (`POST /metrics/purge`) when set | _unset_
`POWERTHROUGH_HEADLESS` | Enable headless Playwright rendering for complex pages | `false`
`POWERTHROUGH_HEADLESS_MAX` | Max concurrent headless render jobs | `2`
`POWERTHROUGH_HEADLESS_TIMEOUT` | Timeout (ms) for headless navigation | `30000`
`POWERTHROUGH_HEADLESS_UA` | Custom user-agent for headless sessions | modern Chromium UA
`POWERTHROUGH_FALLBACK_UA` | User-agent used for direct fetches when the client omits one | modern Chromium UA

## Diagnostics & monitoring

- `/metrics` now returns cache stats, latency averages, domain cooling state, and safezone counters. The frontend polls this every ~15s and renders it inside the **Live diagnostics** card.
- `/status` exposes a lighter-weight snapshot for pings or uptime monitors.
- A manual cache purge is available at `POST /metrics/purge` when `POWERTHROUGH_ADMIN_TOKEN` is configured and supplied via the `x-supersonic-admin` header.
- The in-app diagnostics panel surfaces cache hit-rate, active headless renderers, last request ID, safezone status, and a trimmed event log so you can see trust-but-verify level detail without leaving the UI.

## SuperSonic relay overview

- Rewrites HTML `href`, `src`, `action`, and `srcset` attributes so follow-up requests also flow through `/powerthrough`.
- Streams non-HTML responses untouched while preserving headers like `Content-Type` and `Set-Cookie`.
- Blocks obvious private hosts (`localhost`, `127.0.0.1`, `0.0.0.0`, RFC1918 ranges) so the relay cannot poke your LAN.
- Cools off flaky upstream domains automatically (circuit breaker) so one bad host does not lock the entire proxy.
- Offers three personalities (SuperSonic Balanced/Headless/Lite). They currently map to the same endpoint but give us room to tune behavior per mode.

## Customizing

- Update the hero copy and mission statement in `public/index.html`.
- Tweak the palette in `public/style.css`.
- Adjust relay behavior, sanitization, or rewriting in `backend/server.js`.
- Modify the UI logic (search normalization, panic shortcut, history toggle) in `public/app.js`.
- Tune the SuperSonic workspace experience (in-page iframe, tab cloak, about:blank helper) inside `public/index.html` + `public/app.js`.

PRs and experiments are welcome. This project is intentionally lightweight so you can riff on the idea. Stay safe out there.
