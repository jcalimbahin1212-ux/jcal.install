import compression from "compression";
import express from "express";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { load } from "cheerio";

const PORT = process.env.PORT || 8787;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const CACHE_TTL = Number(process.env.POWERTHROUGH_CACHE_TTL ?? 15_000);
const ENABLE_CACHE = CACHE_TTL > 0;
const ENABLE_HEADLESS = process.env.POWERTHROUGH_HEADLESS === "true";
const HEADLESS_MAX_CONCURRENCY = Number(process.env.POWERTHROUGH_HEADLESS_MAX ?? 2);

const app = express();

app.disable("x-powered-by");
app.use(morgan("dev"));
app.use(compression());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "*");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const blockedHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const cacheStore = new Map();
const metrics = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  upstreamErrors: 0,
  totalLatencyMs: 0,
  headlessRequests: 0,
  headlessFailures: 0,
  headlessActive: 0,
};
let chromiumLoader = null;

app.get("/proxy/:encoded", (req, res) => {
  try {
    const decoded = decodeURIComponent(req.params.encoded || "");
    const redirectTarget = `/powerthrough?url=${encodeURIComponent(decoded)}`;
    return res.redirect(302, redirectTarget);
  } catch {
    return res.status(400).json({ error: "Invalid proxy encoding." });
  }
});

app.all("/powerthrough", async (req, res) => {
  metrics.requests += 1;
  const targetParam = req.query.url;

  if (!targetParam) {
    return res.status(400).json({ error: "Missing url query parameter." });
  }

  let targetUrl;
  try {
    targetUrl = normalizeTargetUrl(targetParam);
  } catch (error) {
    return res.status(400).json({ error: "Invalid URL provided.", details: error.message });
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    return res.status(400).json({ error: "Only HTTP(S) targets are supported." });
  }

  if (isBlockedHost(targetUrl.hostname)) {
    return res.status(403).json({ error: "Target host is not allowed." });
  }

  const start = Date.now();
  const wantsHeadless = ENABLE_HEADLESS && req.method === "GET" && shouldUseHeadless(req);
  if (wantsHeadless && metrics.headlessActive >= HEADLESS_MAX_CONCURRENCY) {
    return res.status(429).json({ error: "Headless renderer is busy. Try again shortly." });
  }
  try {
    if (wantsHeadless) {
      metrics.headlessRequests += 1;
      const headlessResult = await renderWithHeadless(targetUrl);
      res.status(headlessResult.status);
      headlessResult.headers.forEach(([key, value]) => res.set(key, value));
      res.set("x-renderer", "headless");
      const rewritten = rewriteHtmlDocument(headlessResult.body, targetUrl);
      const cacheKey = ENABLE_CACHE && req.method === "GET" ? buildCacheKey(targetUrl) : null;
      if (cacheKey) {
        pruneCache();
        cacheStore.set(cacheKey, {
          status: headlessResult.status,
          headers: collectHeaders(res),
          body: Buffer.from(rewritten),
          added: Date.now(),
        });
      }
      return res.send(rewritten);
    }

    const upstream = await fetch(targetUrl.href, buildFetchOptions(req, targetUrl));
    const contentType = upstream.headers.get("content-type") || "";

    res.status(upstream.status);
    copyResponseHeaders(upstream.headers, res);

    if (contentType.includes("text/html")) {
      const html = await upstream.text();
      const rewritten = rewriteHtmlDocument(html, targetUrl);
      res.set("content-type", "text/html; charset=utf-8");
      res.set("x-frame-options", "ALLOWALL");
      const cacheKey = ENABLE_CACHE && req.method === "GET" ? buildCacheKey(targetUrl) : null;
      if (cacheKey) {
        pruneCache();
        cacheStore.set(cacheKey, {
          status: upstream.status,
          headers: collectHeaders(res),
          body: Buffer.from(rewritten),
          added: Date.now(),
        });
      }
      return res.send(rewritten);
    }

    if (contentType.includes("text/css")) {
      const css = await upstream.text();
      const rewritten = rewriteCssUrls(css, targetUrl);
      res.set("content-type", contentType);
      const cacheKey = ENABLE_CACHE && req.method === "GET" ? buildCacheKey(targetUrl) : null;
      if (cacheKey) {
        pruneCache();
        cacheStore.set(cacheKey, {
          status: upstream.status,
          headers: collectHeaders(res),
          body: Buffer.from(rewritten),
          added: Date.now(),
        });
      }
      return res.send(rewritten);
    }

    if (upstream.body) {
      return Readable.fromWeb(upstream.body).pipe(res);
    }

    return res.end();
  } catch (error) {
    console.error("[powerthrough] proxy error", error);
    metrics.upstreamErrors += 1;
    if (!res.headersSent) {
      res.status(502).json({ error: "Failed to reach target upstream.", details: error.message });
    } else {
      res.end();
    }
  } finally {
    metrics.totalLatencyMs += Date.now() - start;
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

app.get("/metrics", (req, res) => {
  res.json({
    ...metrics,
    cacheSize: cacheStore.size,
    cacheTtlMs: CACHE_TTL,
    cacheEnabled: ENABLE_CACHE,
  });
});

app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Unidentified backend online at http://localhost:${PORT}`);
});

function buildFetchOptions(clientRequest, targetUrl) {
  const headers = {};

  for (const [key, value] of Object.entries(clientRequest.headers)) {
    if (!value) continue;
    const lower = key.toLowerCase();
    if (hopByHopHeaders.has(lower) || lower === "host") {
      continue;
    }
    headers[key] = value;
  }

  headers["accept-encoding"] = "identity";
  headers.host = targetUrl.host;
  headers.origin = targetUrl.origin;
  headers.referer = targetUrl.href;
  if (!headers["user-agent"]) {
    headers["user-agent"] =
      process.env.POWERTHROUGH_FALLBACK_UA ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
  }

  const options = {
    method: clientRequest.method,
    headers,
    redirect: "manual",
  };

  if (!["GET", "HEAD"].includes(clientRequest.method)) {
    options.body = clientRequest;
    options.duplex = "half";
  }

  return options;
}

function copyResponseHeaders(upstreamHeaders, response) {
  upstreamHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      hopByHopHeaders.has(lower) ||
      lower === "access-control-allow-origin" ||
      lower === "access-control-allow-credentials"
    ) {
      return;
    }

    // Strip headers that prevent iframe embedding
    if (lower === "x-frame-options" || lower === "content-security-policy") {
      return;
    }

    if (lower === "set-cookie") {
      response.append("set-cookie", value);
      return;
    }

    response.setHeader(key, value);
  });
}

function rewriteHtmlDocument(html, baseUrl) {
  const $ = load(html, { decodeEntities: false });

  const attributesToRewrite = [
    ["a", "href"],
    ["link", "href"],
    ["img", "src"],
    ["script", "src"],
    ["iframe", "src"],
    ["source", "src"],
    ["video", "src"],
    ["audio", "src"],
    ["track", "src"],
    ["form", "action"],
  ];

  for (const [selector, attribute] of attributesToRewrite) {
    $(selector).each((_, element) => rewriteAttribute($, element, attribute, baseUrl));
  }

  $("[srcset]").each((_, element) => rewriteSrcset($, element, baseUrl));

  return $.html();
}

function rewriteCssUrls(css, baseUrl) {
  // Rewrite url(...) in CSS
  return css.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, url) => {
    if (url.startsWith('data:') || url.startsWith('#')) {
      return match;
    }
    try {
      const resolved = new URL(url, baseUrl);
      return `url(${buildPowerthroughUrl(resolved.toString())})`;
    } catch {
      return match;
    }
  });
}

function rewriteAttribute($, element, attribute, baseUrl) {
  let value = $(element).attr(attribute);
  if (!value) {
    if (attribute === "action") {
      $(element).attr(attribute, buildPowerthroughUrl(baseUrl.toString()));
    }
    return;
  }
  if (value.startsWith("/powerthrough")) {
    return;
  }
  if (value.startsWith("#")) {
    return;
  }
  if (/^(mailto|tel|javascript):/i.test(value)) {
    return;
  }
  try {
    const resolved = new URL(value, baseUrl);
    $(element).attr(attribute, buildPowerthroughUrl(resolved.toString()));
  } catch {
    // Ignore rewrites that fail URL resolution.
  }
}

function rewriteSrcset($, element, baseUrl) {
  const value = $(element).attr("srcset");
  if (!value) return;

  const rewritten = value
    .split(",")
    .map((entry) => {
      const [url, descriptor] = entry.trim().split(/\s+/);
      if (!url) return "";
      if (url.startsWith("/powerthrough")) {
        return entry.trim();
      }
      try {
        const resolved = new URL(url, baseUrl);
        const proxied = buildPowerthroughUrl(resolved.toString());
        return descriptor ? `${proxied} ${descriptor}` : proxied;
      } catch {
        return entry;
      }
    })
    .filter(Boolean)
    .join(", ");

  $(element).attr("srcset", rewritten);
}

function buildPowerthroughUrl(target) {
  return `/powerthrough?url=${encodeURIComponent(target)}`;
}

function normalizeTargetUrl(input) {
  try {
    return new URL(input);
  } catch {
    if (looksLikeDomain(input)) {
      return new URL(`https://${input}`);
    }
    return buildSearchUrl(input);
  }
}

function looksLikeDomain(value) {
  return /^[^\s]+\.[a-z]{2,}$/i.test(value);
}

function isBlockedHost(hostname) {
  if (blockedHosts.has(hostname.toLowerCase())) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return isPrivateIpv4(hostname);
  }
  return false;
}

function isPrivateIpv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function respondFromCache(res, cached) {
  res.status(cached.status);
  cached.headers.forEach(([key, value]) => res.set(key, value));
  res.set("x-cache", "HIT");
  return res.send(Buffer.from(cached.body));
}

function collectHeaders(res) {
  return Object.entries(res.getHeaders());
}

function pruneCache() {
  if (cacheStore.size < 200) return;
  const now = Date.now();
  for (const [key, value] of cacheStore.entries()) {
    if (now - value.added > CACHE_TTL || cacheStore.size > 150) {
      cacheStore.delete(key);
    }
  if (cacheStore.size <= 150) break;
}

function buildSearchUrl(term) {
  const base = process.env.POWERTHROUGH_SEARCH_URL || "https://duckduckgo.com/?q=";
  const encoded = encodeURIComponent(term);
  const url = new URL(`${base}${encoded}`);
  url.searchParams.set("safetynet_term", term);
  return url;
}

function getFallbackSearchUrl(originalUrl) {
  const term = originalUrl.searchParams?.get("safetynet_term");
  if (!term) return null;
  const fallbackBase = process.env.POWERTHROUGH_SEARCH_FALLBACK_URL || "https://lite.bing.com/search?q=";
  try {
    const encoded = encodeURIComponent(term);
    const url = new URL(`${fallbackBase}${encoded}`);
    url.searchParams.set("safetynet_term", term);
    return url;
  } catch {
    return null;
  }
}

async function fetchWithFallbackInline(targetUrl, req, attemptedFallback = false) {
  try {
    const upstream = await fetch(targetUrl.href, buildFetchOptions(req, targetUrl));
    if (upstream.status >= 500 && !attemptedFallback) {
      const fallbackUrl = getFallbackSearchUrl(targetUrl);
      if (fallbackUrl) {
        return fetchWithFallbackInline(fallbackUrl, req, true);
      }
    }
    return { upstream, resolvedUrl: targetUrl };
  } catch (error) {
    const fallbackUrl = !attemptedFallback ? getFallbackSearchUrl(targetUrl) : null;
    if (fallbackUrl) {
      return fetchWithFallbackInline(fallbackUrl, req, true);
    }
    throw error;
  }
}
}

function shouldUseHeadless(req) {
  if (req.query.render === "headless") return true;
  if (req.headers["x-powerthrough-render"] === "headless") return true;
  return false;
}

async function renderWithHeadless(targetUrl) {
  const chromium = await loadChromium();
  if (!chromium) {
    throw new Error("Headless rendering requested but Playwright is unavailable.");
  }
  metrics.headlessActive += 1;
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
    const context = await browser.newContext({
      userAgent:
        process.env.POWERTHROUGH_HEADLESS_UA ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();
    await page.goto(targetUrl.href, {
      waitUntil: "networkidle",
      timeout: Number(process.env.POWERTHROUGH_HEADLESS_TIMEOUT ?? 30_000),
    });
    const body = await page.content();
    await browser.close();
    metrics.headlessActive -= 1;
    return {
      status: 200,
      headers: [["content-type", "text/html; charset=utf-8"]],
      body,
    };
  } catch (error) {
    metrics.headlessActive -= 1;
    metrics.headlessFailures += 1;
    if (browser) {
      await browser.close().catch(() => {});
    }
    throw error;
  }
}

async function loadChromium() {
  if (!chromiumLoader) {
    chromiumLoader = import("playwright")
      .then((mod) => mod.chromium)
      .catch((error) => {
        console.error(
          "[powerthrough] Set POWERTHROUGH_HEADLESS=false or install the `playwright` package to use headless mode.",
          error
        );
        return null;
      });
  }
  return chromiumLoader;
}
function buildCacheKey(url) {
  return url.toString();
}

