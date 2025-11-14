import compression from "compression";
import express from "express";
import morgan from "morgan";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { load } from "cheerio";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8787;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const CACHE_TTL = Number(process.env.POWERTHROUGH_CACHE_TTL ?? 15_000);
const ENABLE_CACHE = CACHE_TTL > 0;
const ENABLE_HEADLESS = process.env.POWERTHROUGH_HEADLESS === "true";
const HEADLESS_MAX_CONCURRENCY = Number(process.env.POWERTHROUGH_HEADLESS_MAX ?? 2);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

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
const upstreamRewriteRules = [
  { test: /duckduckgo\.com/i, csp: "duckduckgo-hardened" },
  { test: /google\./i, csp: "google-compatible" },
  { test: /bing\.com/i, csp: "bing-compatible" },
];
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
class ProxyError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

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
  const targetParam = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  const renderHint = extractRenderHint(req);

  try {
    const result = await executeProxyCall({
      targetParam,
      renderHint,
      clientRequest: {
        method: req.method,
        headers: req.headers,
        bodyStream: req,
      },
    });
    return applyProxyResult(res, result);
  } catch (error) {
    const isProxyError = error instanceof ProxyError;
    if (!isProxyError || error.status >= 500) {
      metrics.upstreamErrors += 1;
      console.error("[powerthrough] proxy error", error);
    }
    const status = isProxyError ? error.status : 502;
    const payload = {
      error: isProxyError ? error.message : "Failed to reach target upstream.",
    };
    const details = isProxyError ? error.details : error.message;
    if (details) {
      payload.details = details;
    }
    if (!res.headersSent) {
      res.status(status).json(payload);
    } else {
      res.end();
    }
  }
});

server.on("upgrade", (request, socket, head) => {
  const { url = "" } = request;
  const originHost = request.headers.host ? `http://${request.headers.host}` : `http://localhost:${PORT}`;
  let pathname;
  try {
    pathname = new URL(url, originHost).pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname === "/safezone") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  setupSafezoneConnection(ws);
});

async function executeProxyCall(params) {
  metrics.requests += 1;
  const start = Date.now();
  try {
    return await handleProxyRequest(params);
  } finally {
    metrics.totalLatencyMs += Date.now() - start;
  }
}

async function handleProxyRequest({ targetParam, renderHint, clientRequest }) {
  const urlParam = typeof targetParam === "string" ? targetParam : "";
  if (!urlParam) {
    throw new ProxyError(400, "Missing url query parameter.");
  }

  let targetUrl;
  try {
    targetUrl = normalizeTargetUrl(urlParam);
  } catch (error) {
    throw new ProxyError(400, "Invalid URL provided.", error.message);
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    throw new ProxyError(400, "Only HTTP(S) targets are supported.");
  }

  if (isBlockedHost(targetUrl.hostname)) {
    throw new ProxyError(403, "Target host is not allowed.");
  }

  const method = (clientRequest.method || "GET").toUpperCase();
  const wantsHeadless = ENABLE_HEADLESS && method === "GET" && renderHint === "headless";
  if (wantsHeadless && metrics.headlessActive >= HEADLESS_MAX_CONCURRENCY) {
    throw new ProxyError(429, "Headless renderer is busy. Try again shortly.");
  }

  const cacheKey =
    ENABLE_CACHE && method === "GET" ? buildCacheKey(targetUrl, wantsHeadless ? "headless" : "direct") : null;
  if (cacheKey) {
    const cached = cacheStore.get(cacheKey);
    if (cached && Date.now() - cached.added < CACHE_TTL) {
      metrics.cacheHits += 1;
      return {
        status: cached.status,
        headers: cloneHeaderList(cached.headers),
        body: Buffer.from(cached.body),
        fromCache: true,
        renderer: cached.renderer,
      };
    }
    metrics.cacheMisses += 1;
  }

  if (wantsHeadless) {
    metrics.headlessRequests += 1;
    const headlessResult = await renderWithHeadless(targetUrl);
    const headers = normalizeHeaderList(headlessResult.headers);
    headers.push(["x-renderer", "headless"]);
    const rewritten = rewriteHtmlDocument(headlessResult.body, targetUrl);
    const bodyBuffer = Buffer.from(rewritten);
    if (cacheKey) {
      persistCacheEntry(cacheKey, {
        status: headlessResult.status,
        headers,
        body: bodyBuffer,
        renderer: "headless",
      });
    }
    return {
      status: headlessResult.status,
      headers,
      body: bodyBuffer,
      renderer: "headless",
    };
  }

  try {
    const upstream = await fetch(targetUrl.href, buildFetchOptions(clientRequest, targetUrl));
    const headers = buildForwardHeaders(upstream.headers);
    const contentType = upstream.headers.get("content-type") || "";
    const rewriteProfile = selectRewriteProfile(targetUrl.hostname);

    if (contentType.includes("text/html")) {
      const html = await upstream.text();
      let rewritten = rewriteHtmlDocument(html, targetUrl);
      if (rewriteProfile?.csp === "duckduckgo-hardened") {
        rewritten = patchDuckduckgoPage(rewritten);
      } else if (rewriteProfile?.csp === "google-compatible") {
        rewritten = patchGooglePage(rewritten);
      }
      const bodyBuffer = Buffer.from(rewritten);
      setHeaderValue(headers, "content-type", "text/html; charset=utf-8");
      setHeaderValue(headers, "x-frame-options", "ALLOWALL");
      if (rewriteProfile?.csp) {
        normalizeResponseSecurityHeaders(headers, rewriteProfile.csp);
      }
      if (cacheKey) {
        persistCacheEntry(cacheKey, {
          status: upstream.status,
          headers,
          body: bodyBuffer,
          renderer: "direct",
        });
      }
      return {
        status: upstream.status,
        headers,
        body: bodyBuffer,
      };
    }

    if (contentType.includes("text/css")) {
      const css = await upstream.text();
      const rewritten = rewriteCssUrls(css, targetUrl);
      const bodyBuffer = Buffer.from(rewritten);
      setHeaderValue(headers, "content-type", contentType);
      if (cacheKey) {
        persistCacheEntry(cacheKey, {
          status: upstream.status,
          headers,
          body: bodyBuffer,
          renderer: "direct",
        });
      }
      return {
        status: upstream.status,
        headers,
        body: bodyBuffer,
      };
    }

    if (upstream.body) {
      return {
        status: upstream.status,
        headers,
        stream: Readable.fromWeb(upstream.body),
      };
    }

    return {
      status: upstream.status,
      headers,
    };
  } catch (error) {
    throw error instanceof ProxyError ? error : new ProxyError(502, "Failed to reach target upstream.", error.message);
  }
}

function applyProxyResult(res, result) {
  res.status(result.status);
  applyHeaderList(res, result.headers);
  if (result.fromCache) {
    res.set("x-cache", "HIT");
  }

  if (result.body) {
    return res.send(result.body);
  }
  if (result.stream) {
    return result.stream.pipe(res);
  }
  return res.end();
}

function extractRenderHint(req) {
  const queryValue = Array.isArray(req.query.render) ? req.query.render[0] : req.query.render;
  const headerValueRaw = req.headers["x-powerthrough-render"];
  const headerValue = Array.isArray(headerValueRaw) ? headerValueRaw[0] : headerValueRaw;
  return queryValue || headerValue || undefined;
}

function setupSafezoneConnection(ws) {
  const activeStreams = new Map();

  ws.on("message", (data, isBinary) => {
    handleSafezoneMessage(ws, activeStreams, data, isBinary).catch((error) => {
      console.error("[safezone] failed to handle message", error);
      sendSafezoneMessage(ws, { type: "error", message: "Internal safezone failure." });
    });
  });

  ws.on("close", () => {
    for (const stream of activeStreams.values()) {
      stream.destroy();
    }
    activeStreams.clear();
  });
}

async function handleSafezoneMessage(ws, activeStreams, rawData, isBinary) {
  if (isBinary) {
    sendSafezoneMessage(ws, { type: "error", message: "Binary safezone frames are not supported." });
    return;
  }

  let payload;
  try {
    const asString = typeof rawData === "string" ? rawData : rawData.toString("utf8");
    payload = JSON.parse(asString);
  } catch {
    sendSafezoneMessage(ws, { type: "error", message: "Invalid safezone message payload." });
    return;
  }

  if (!payload || typeof payload !== "object") {
    sendSafezoneMessage(ws, { type: "error", message: "Malformed safezone payload." });
    return;
  }

  if (payload.type === "request") {
    await processSafezoneRequest(ws, activeStreams, payload);
    return;
  }

  if (payload.type === "cancel") {
    const { id } = payload;
    if (typeof id === "string" && activeStreams.has(id)) {
      const stream = activeStreams.get(id);
      activeStreams.delete(id);
      stream.destroy(new Error("Client cancelled."));
    }
    return;
  }

  sendSafezoneMessage(ws, { type: "error", message: `Unsupported safezone message type: ${payload.type}` });
}

async function processSafezoneRequest(ws, activeStreams, payload) {
  const { id, url, method, headers, renderHint, body, bodyEncoding } = payload;
  if (!id || typeof id !== "string") {
    sendSafezoneMessage(ws, { type: "error", message: "Request id is required." });
    return;
  }

  const normalizedMethod = typeof method === "string" ? method.toUpperCase() : "GET";
  let normalizedHeaders;
  try {
    normalizedHeaders = sanitizeHeaderBag(headers);
  } catch (error) {
    sendSafezoneMessage(ws, { type: "error", id, message: error.message || "Invalid headers provided." });
    return;
  }

  let bodyStream;
  let bodyLength = 0;
  try {
    const materialized = buildBodyStreamFromMessage(normalizedMethod, body, bodyEncoding);
    bodyStream = materialized.stream;
    bodyLength = materialized.length;
  } catch (error) {
    const message = error instanceof ProxyError ? error.message : "Invalid request body.";
    sendSafezoneMessage(ws, {
      type: "error",
      id,
      status: error instanceof ProxyError ? error.status : 400,
      message,
      details: error.details,
    });
    return;
  }

  if (bodyStream && !hasHeader(normalizedHeaders, "content-length")) {
    normalizedHeaders["content-length"] = String(bodyLength);
  }

  try {
    const result = await executeProxyCall({
      targetParam: url,
      renderHint,
      clientRequest: {
        method: normalizedMethod,
        headers: normalizedHeaders,
        bodyStream,
      },
    });

    sendSafezoneMessage(ws, {
      type: "response",
      id,
      status: result.status,
      headers: result.headers,
      fromCache: Boolean(result.fromCache),
      renderer: result.renderer || "direct",
    });

    if (result.body) {
      sendBodyChunk(ws, id, result.body, true);
      return;
    }

    if (result.stream) {
      streamProxyBody(ws, id, result.stream, activeStreams);
      return;
    }

    sendBodyChunk(ws, id, Buffer.alloc(0), true);
  } catch (error) {
    const isProxyError = error instanceof ProxyError;
    if (!isProxyError || error.status >= 500) {
      metrics.upstreamErrors += 1;
      console.error("[safezone] proxy error", error);
    }
    sendSafezoneMessage(ws, {
      type: "error",
      id,
      status: isProxyError ? error.status : 502,
      message: isProxyError ? error.message : "Failed to reach target upstream.",
      details: isProxyError ? error.details : error.message,
    });
  }
}

function sendSafezoneMessage(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    ws.send(JSON.stringify(payload));
  } catch (error) {
    console.error("[safezone] failed to send payload", error);
  }
}

function sendBodyChunk(ws, id, chunk, final = false) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? "");
  sendSafezoneMessage(ws, {
    type: "body",
    id,
    data: buffer.length ? buffer.toString("base64") : "",
    final: Boolean(final),
  });
}

function streamProxyBody(ws, id, stream, activeStreams) {
  activeStreams.set(id, stream);
  stream.on("data", (chunk) => {
    sendBodyChunk(ws, id, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), false);
  });
  stream.once("end", () => {
    activeStreams.delete(id);
    sendBodyChunk(ws, id, Buffer.alloc(0), true);
  });
  stream.once("error", (error) => {
    activeStreams.delete(id);
    sendSafezoneMessage(ws, {
      type: "error",
      id,
      status: 502,
      message: "Stream relay failed.",
      details: error.message,
    });
  });
}

function sanitizeHeaderBag(headers) {
  if (!headers || typeof headers !== "object") {
    return {};
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      sanitized[key] = value.map((entry) => String(entry));
    } else {
      sanitized[key] = String(value);
    }
  }
  return sanitized;
}

function hasHeader(headers, target) {
  const targetLower = target.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === targetLower);
}

function buildBodyStreamFromMessage(method, bodyPayload, bodyEncoding) {
  if (!bodyPayload || ["GET", "HEAD"].includes(method)) {
    return { stream: undefined, length: 0 };
  }
  const encoding = typeof bodyEncoding === "string" ? bodyEncoding.toLowerCase() : "base64";
  if (typeof bodyPayload !== "string") {
    throw new ProxyError(400, "Body payload must be a string.");
  }
  let buffer;
  try {
    if (encoding === "base64") {
      buffer = Buffer.from(bodyPayload, "base64");
    } else if (encoding === "utf8") {
      buffer = Buffer.from(bodyPayload, "utf8");
    } else {
      throw new ProxyError(400, `Unsupported body encoding: ${encoding}`);
    }
  } catch (error) {
    if (error instanceof ProxyError) {
      throw error;
    }
    throw new ProxyError(400, "Failed to decode request body.", error.message);
  }
  return { stream: Readable.from(buffer), length: buffer.byteLength };
}

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

server.listen(PORT, () => {
  console.log(`Unidentified backend online at http://localhost:${PORT}`);
});

function buildFetchOptions(clientRequest, targetUrl) {
  const incomingHeaders = clientRequest.headers || {};
  const headers = {};

  for (const [key, value] of Object.entries(incomingHeaders)) {
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

  const method = (clientRequest.method || "GET").toUpperCase();
  const options = {
    method,
    headers,
    redirect: "manual",
  };

  if (!["GET", "HEAD"].includes(method) && clientRequest.bodyStream) {
    options.body = clientRequest.bodyStream;
    options.duplex = "half";
  }

  return options;
}

function buildForwardHeaders(upstreamHeaders) {
  const forwarded = [];
  upstreamHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      hopByHopHeaders.has(lower) ||
      lower === "access-control-allow-origin" ||
      lower === "access-control-allow-credentials"
    ) {
      return;
    }
    if (lower === "x-frame-options" || lower === "content-security-policy") {
      return;
    }
    if (lower === "set-cookie") {
      return;
    }
    forwarded.push([key, value]);
  });
  const setCookies = upstreamHeaders.getSetCookie?.() ?? [];
  for (const cookie of setCookies) {
    forwarded.push(["set-cookie", cookie]);
  }
  return forwarded;
}

function applyHeaderList(res, headers = []) {
  for (const [key, value] of headers) {
    if (key.toLowerCase() === "set-cookie") {
      res.append("set-cookie", value);
    } else {
      res.setHeader(key, value);
    }
  }
}

function setHeaderValue(headers, key, value) {
  const lower = key.toLowerCase();
  for (let i = headers.length - 1; i >= 0; i -= 1) {
    if (headers[i][0].toLowerCase() === lower) {
      headers.splice(i, 1);
    }
  }
  headers.push([key, value]);
}

function normalizeHeaderList(entries = []) {
  return entries.map(([key, value]) => [key, value]);
}

function cloneHeaderList(entries = []) {
  return entries.map(([key, value]) => [key, value]);
}

function persistCacheEntry(cacheKey, payload) {
  if (!cacheKey || !payload || !payload.body) {
    return;
  }
  pruneCache();
  cacheStore.set(cacheKey, {
    status: payload.status,
    headers: cloneHeaderList(payload.headers),
    body: Buffer.from(payload.body),
    renderer: payload.renderer || "direct",
    added: Date.now(),
  });
}

function buildCacheKey(targetUrl, variant = "direct") {
  return `${variant}:${targetUrl.toString()}`;
}

function selectRewriteProfile(hostname) {
  if (!hostname) return null;
  return upstreamRewriteRules.find((rule) => rule.test.test(hostname)) || null;
}

function normalizeResponseSecurityHeaders(headers, profile) {
  if (!profile) return;
  stripHeader(headers, "content-security-policy");
  stripHeader(headers, "content-security-policy-report-only");
  stripHeader(headers, "x-content-security-policy");
  stripHeader(headers, "x-frame-options");

  if (profile === "duckduckgo-hardened") {
    setHeaderValue(headers, "content-security-policy", "default-src * data: blob:; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'");
  } else if (profile === "google-compatible") {
    setHeaderValue(headers, "content-security-policy", "default-src * blob: data:; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'");
  } else if (profile === "bing-compatible") {
    setHeaderValue(headers, "content-security-policy", "default-src * data: blob:; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'");
  }
}

function stripHeader(headers, target) {
  const lowerTarget = target.toLowerCase();
  for (let i = headers.length - 1; i >= 0; i -= 1) {
    if (headers[i][0].toLowerCase() === lowerTarget) {
      headers.splice(i, 1);
    }
  }
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

function patchDuckduckgoPage(html) {
  return html.replace(/href="\/\//g, 'href="https://').replace(/integrity="[^"]+"/g, "");
}

function patchGooglePage(html) {
  return html.replace(/nonce="[^"]+"/g, "");
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
    return new URL(`https://duckduckgo.com/?q=${encodeURIComponent(input)}`);
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

function pruneCache() {
  if (cacheStore.size < 200) return;
  const now = Date.now();
  for (const [key, value] of cacheStore.entries()) {
    if (now - value.added > CACHE_TTL || cacheStore.size > 150) {
      cacheStore.delete(key);
    }
    if (cacheStore.size <= 150) break;
  }
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


