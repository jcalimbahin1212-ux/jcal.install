import compression from "compression";
import express from "express";
import morgan from "morgan";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { load } from "cheerio";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8787;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const CACHE_TTL = Number(process.env.POWERTHROUGH_CACHE_TTL ?? 15_000);
const CACHE_MAX_ENTRIES = Math.max(50, Number(process.env.POWERTHROUGH_CACHE_MAX ?? 400));
const CACHE_RESPECT_CONTROL = process.env.POWERTHROUGH_CACHE_RESPECT !== "false";
const ENABLE_CACHE = CACHE_TTL > 0;
const ENABLE_HEADLESS = process.env.POWERTHROUGH_HEADLESS === "true";
const HEADLESS_MAX_CONCURRENCY = Number(process.env.POWERTHROUGH_HEADLESS_MAX ?? 2);
const DOMAIN_FAILURE_THRESHOLD = Number(process.env.POWERTHROUGH_DOMAIN_FAIL_THRESHOLD ?? 3);
const DOMAIN_FAILURE_WINDOW = Number(process.env.POWERTHROUGH_DOMAIN_FAIL_WINDOW ?? 30_000);
const DOMAIN_FAILURE_COOLDOWN = Number(process.env.POWERTHROUGH_DOMAIN_FAIL_COOLDOWN ?? 45_000);
const ADMIN_TOKEN = process.env.POWERTHROUGH_ADMIN_TOKEN || "";
const REQUEST_ID_HEADER = "x-safetynet-request-id";

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
const envBlocked = (process.env.POWERTHROUGH_BLOCKLIST || "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
envBlocked.forEach((host) => blockedHosts.add(host));
const upstreamRewriteRules = [
  { test: /duckduckgo\.com/i, csp: "duckduckgo-hardened" },
  { test: /google\./i, csp: "google-compatible" },
  { test: /bing\.com/i, csp: "bing-compatible" },
];
const cacheStore = new Map();
const domainHealth = new Map();
const metrics = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  cacheEvictions: 0,
  upstreamErrors: 0,
  totalLatencyMs: 0,
  headlessRequests: 0,
  headlessFailures: 0,
  headlessActive: 0,
  safezoneRequests: 0,
  safezoneErrors: 0,
  domainBlocks: 0,
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
  const requestId = createRequestId("http");
  res.setHeader(REQUEST_ID_HEADER, requestId);

  try {
    const result = await executeProxyCall({
      targetParam,
      renderHint,
      clientRequest: {
        method: req.method,
        headers: req.headers,
        bodyStream: req,
      },
    }, { requestId });
    if (!res.headersSent && result?.requestId && result.requestId !== requestId) {
      res.setHeader(REQUEST_ID_HEADER, result.requestId);
    }
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

async function executeProxyCall(params, context = {}) {
  metrics.requests += 1;
  const start = Date.now();
  try {
    return await handleProxyRequest(params, context);
  } finally {
    metrics.totalLatencyMs += Date.now() - start;
  }
}

async function handleProxyRequest({ targetParam, renderHint, clientRequest }, context = {}) {
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
    if (cached && (!cached.expiresAt || cached.expiresAt > Date.now())) {
      metrics.cacheHits += 1;
      return withRequestContext(
        {
        status: cached.status,
        headers: cloneHeaderList(cached.headers),
        body: Buffer.from(cached.body),
        fromCache: true,
        renderer: cached.renderer,
        },
        context
      );
    }
    if (cached) {
      cacheStore.delete(cacheKey);
    }
    metrics.cacheMisses += 1;
  }

  ensureDomainHealthy(targetUrl.hostname);

  if (wantsHeadless) {
    metrics.headlessRequests += 1;
    try {
      const headlessResult = await renderWithHeadless(targetUrl);
      const headers = normalizeHeaderList(headlessResult.headers);
      headers.push(["x-renderer", "headless"]);
      const rewritten = rewriteHtmlDocument(headlessResult.body, targetUrl, {
        ...context,
        renderer: "headless",
      });
      const bodyBuffer = Buffer.from(rewritten);
      if (cacheKey) {
        persistCacheEntry(cacheKey, {
          status: headlessResult.status,
          headers,
          body: bodyBuffer,
          renderer: "headless",
        });
      }
      recordDomainSuccess(targetUrl.hostname);
      return withRequestContext({
        status: headlessResult.status,
        headers,
        body: bodyBuffer,
        renderer: "headless",
      }, context);
    } catch (error) {
      recordDomainFailure(targetUrl.hostname);
      throw error;
    }
  }

  try {
    const upstream = await fetch(targetUrl.href, buildFetchOptions(clientRequest, targetUrl));
    const headers = buildForwardHeaders(upstream.headers);
    const contentType = upstream.headers.get("content-type") || "";
    const rewriteProfile = selectRewriteProfile(targetUrl.hostname);

    if (contentType.includes("text/html")) {
  const html = await upstream.text();
  const htmlContext = { ...context, renderer: "direct" };
  let rewritten = rewriteHtmlDocument(html, targetUrl, htmlContext);
      if (rewriteProfile?.csp === "duckduckgo-hardened") {
        rewritten = patchDuckduckgoPage(rewritten);
      } else if (rewriteProfile?.csp === "google-compatible") {
        rewritten = patchGooglePage(rewritten);
      }
      const bodyBuffer = Buffer.from(rewritten);
      setHeaderValue(headers, "content-type", "text/html; charset=utf-8");
      setHeaderValue(headers, "x-frame-options", "ALLOWALL");
  setHeaderValue(headers, "x-renderer", "direct");
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
      recordDomainSuccess(targetUrl.hostname);
      return withRequestContext({
        status: upstream.status,
        headers,
        body: bodyBuffer,
      }, context);
    }

    if (contentType.includes("text/css")) {
      const css = await upstream.text();
      const rewritten = rewriteCssUrls(css, targetUrl);
      const bodyBuffer = Buffer.from(rewritten);
      setHeaderValue(headers, "content-type", contentType);
  setHeaderValue(headers, "x-renderer", "direct");
      if (cacheKey) {
        persistCacheEntry(cacheKey, {
          status: upstream.status,
          headers,
          body: bodyBuffer,
          renderer: "direct",
        });
      }
      recordDomainSuccess(targetUrl.hostname);
      return withRequestContext({
        status: upstream.status,
        headers,
        body: bodyBuffer,
      }, context);
    }

    if (upstream.body) {
      setHeaderValue(headers, "x-renderer", "direct");
      recordDomainSuccess(targetUrl.hostname);
      return withRequestContext({
        status: upstream.status,
        headers,
        stream: Readable.fromWeb(upstream.body),
      }, context);
    }

    setHeaderValue(headers, "x-renderer", "direct");
    recordDomainSuccess(targetUrl.hostname);
    return withRequestContext({
      status: upstream.status,
      headers,
    }, context);
  } catch (error) {
    recordDomainFailure(targetUrl.hostname);
    throw error instanceof ProxyError ? error : new ProxyError(502, "Failed to reach target upstream.", error.message);
  }
}

function applyProxyResult(res, result) {
  res.status(result.status);
  applyHeaderList(res, result.headers);
  if (result.requestId) {
    res.set(REQUEST_ID_HEADER, result.requestId);
  }
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
  const channels = new Map();

  ws.on("message", (data, isBinary) => {
    handleSafezoneMessage(ws, channels, data, isBinary).catch((error) => {
      console.error("[safezone] failed to handle message", error);
      sendSafezoneFrame(ws, { op: SAFEZONE_OP.ERROR, payload: { message: "Internal safezone failure." } });
    });
  });

  ws.on("close", () => {
    for (const channel of channels.values()) {
      channel.stream?.destroy();
    }
    channels.clear();
    metrics.safezoneActiveChannels = 0;
  });
}

async function handleSafezoneMessage(ws, channels, rawData, isBinary) {
  if (isBinary) {
    sendSafezoneFrame(ws, { op: SAFEZONE_OP.ERROR, payload: { message: "Binary safezone frames are not supported." } });
    return;
  }

  let frame;
  try {
    const asString = typeof rawData === "string" ? rawData : rawData.toString("utf8");
    frame = JSON.parse(asString);
  } catch {
    sendSafezoneFrame(ws, { op: SAFEZONE_OP.ERROR, payload: { message: "Invalid safezone frame payload." } });
    return;
  }

  if (!frame || typeof frame !== "object" || typeof frame.op !== "string") {
    sendSafezoneFrame(ws, { op: SAFEZONE_OP.ERROR, payload: { message: "Malformed safezone frame." } });
    return;
  }

  const channelId = Number(frame.ch);
  if (!Number.isInteger(channelId) || channelId < 0 || channelId > 65535) {
    sendSafezoneFrame(ws, { op: SAFEZONE_OP.ERROR, payload: { message: "Invalid channel id." } });
    return;
  }

  switch (frame.op) {
    case SAFEZONE_OP.OPEN:
      await processSafezoneOpen(ws, channels, channelId, frame);
      break;
    case SAFEZONE_OP.CANCEL:
      closeSafezoneChannel(channels, channelId, "Client cancelled.");
      break;
    case SAFEZONE_OP.PING:
      sendSafezoneFrame(ws, { ch: channelId, op: SAFEZONE_OP.PONG, payload: frame.payload });
      break;
    default:
      sendSafezoneFrame(ws, {
        ch: channelId,
        op: SAFEZONE_OP.ERROR,
        payload: { message: `Unsupported safezone op: ${frame.op}` },
      });
      break;
  }
}

async function processSafezoneOpen(ws, channels, channelId, frame) {
  const payload = frame.payload || {};
  const { url, method, headers, renderHint, body, bodyEncoding } = payload;
  metrics.safezoneRequests += 1;

  if (channels.has(channelId)) {
    sendSafezoneFrame(ws, {
      ch: channelId,
      op: SAFEZONE_OP.ERROR,
      payload: { message: "Channel already in use." },
    });
    return;
  }

  const normalizedMethod = typeof method === "string" ? method.toUpperCase() : "GET";
  let normalizedHeaders;
  try {
    normalizedHeaders = sanitizeHeaderBag(headers);
  } catch (error) {
    sendSafezoneFrame(ws, {
      ch: channelId,
      op: SAFEZONE_OP.ERROR,
      payload: { message: error.message || "Invalid headers provided." },
    });
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
    sendSafezoneFrame(ws, {
      ch: channelId,
      op: SAFEZONE_OP.ERROR,
      payload: {
        status: error instanceof ProxyError ? error.status : 400,
        message,
        details: error.details,
      },
    });
    return;
  }

  if (bodyStream && !hasHeader(normalizedHeaders, "content-length")) {
    normalizedHeaders["content-length"] = String(bodyLength);
  }

  const requestContext = { requestId: createRequestId("safezone") };

  try {
    const result = await executeProxyCall(
      {
        targetParam: url,
        renderHint,
        clientRequest: {
          method: normalizedMethod,
          headers: normalizedHeaders,
          bodyStream,
        },
      },
      requestContext
    );

    sendSafezoneFrame(ws, {
      ch: channelId,
      op: SAFEZONE_OP.HEADERS,
      payload: {
        status: result.status,
        headers: result.headers,
        fromCache: Boolean(result.fromCache),
        renderer: result.renderer || "direct",
        requestId: requestContext.requestId,
      },
    });

    if (result.body) {
      sendSafezoneDataFrame(ws, channelId, result.body, true);
      return;
    }

    if (result.stream) {
      metrics.safezoneActiveChannels += 1;
      streamProxyBody(ws, channelId, result.stream, channels);
      return;
    }

    sendSafezoneFrame(ws, { ch: channelId, op: SAFEZONE_OP.END });
  } catch (error) {
    metrics.safezoneErrors += 1;
    const isProxyError = error instanceof ProxyError;
    if (!isProxyError || error.status >= 500) {
      metrics.upstreamErrors += 1;
      console.error("[safezone] proxy error", error);
    }
    sendSafezoneFrame(ws, {
      ch: channelId,
      op: SAFEZONE_OP.ERROR,
      payload: {
        status: isProxyError ? error.status : 502,
        message: isProxyError ? error.message : "Failed to reach target upstream.",
        details: isProxyError ? error.details : error.message,
        requestId: requestContext.requestId,
      },
    });
  }
}

function closeSafezoneChannel(channels, channelId, reason) {
  const channel = channels.get(channelId);
  if (!channel) return;
  channels.delete(channelId);
  metrics.safezoneActiveChannels = Math.max(0, metrics.safezoneActiveChannels - 1);
  if (channel.stream) {
    try {
      channel.stream.destroy(new Error(reason || "Channel closed."));
    } catch {
      // ignore
    }
  }
}

function sendSafezoneFrame(ws, frame) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    ws.send(JSON.stringify(frame));
  } catch (error) {
    console.error("[safezone] failed to send payload", error);
  }
}

function sendSafezoneDataFrame(ws, channelId, chunk, final = false) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? "");
  sendSafezoneFrame(ws, {
    ch: channelId,
    op: SAFEZONE_OP.DATA,
    payload: {
      data: buffer.length ? buffer.toString("base64") : "",
      final: Boolean(final),
    },
  });
  if (final) {
    sendSafezoneFrame(ws, { ch: channelId, op: SAFEZONE_OP.END });
  }
}

function streamProxyBody(ws, channelId, stream, channels) {
  channels.set(channelId, { stream });
  stream.on("data", (chunk) => {
    sendSafezoneDataFrame(ws, channelId, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), false);
  });
  stream.once("end", () => {
    channels.delete(channelId);
    metrics.safezoneActiveChannels = Math.max(0, metrics.safezoneActiveChannels - 1);
    sendSafezoneFrame(ws, { ch: channelId, op: SAFEZONE_OP.END });
  });
  stream.once("error", (error) => {
    channels.delete(channelId);
    metrics.safezoneActiveChannels = Math.max(0, metrics.safezoneActiveChannels - 1);
    sendSafezoneFrame(ws, {
      ch: channelId,
      op: SAFEZONE_OP.ERROR,
      payload: {
        status: 502,
        message: "Stream relay failed.",
        details: error.message,
      },
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
  const totalCacheOps = metrics.cacheHits + metrics.cacheMisses;
  const cacheHitRate = totalCacheOps > 0 ? metrics.cacheHits / totalCacheOps : 0;
  const avgLatency = metrics.requests > 0 ? metrics.totalLatencyMs / metrics.requests : 0;
  res.json({
    ...metrics,
    cacheSize: cacheStore.size,
    cacheTtlMs: CACHE_TTL,
    cacheMaxEntries: CACHE_MAX_ENTRIES,
    cacheEnabled: ENABLE_CACHE,
    cacheHitRate,
    avgLatencyMs: Math.round(avgLatency),
    domainHealth: summarizeDomainHealth(),
  });
});

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    timestamp: Date.now(),
    cache: {
      enabled: ENABLE_CACHE,
      size: cacheStore.size,
      ttlMs: CACHE_TTL,
      maxEntries: CACHE_MAX_ENTRIES,
    },
    safezone: {
      requests: metrics.safezoneRequests,
      errors: metrics.safezoneErrors,
      headlessActive: metrics.headlessActive,
    },
    domainHealth: summarizeDomainHealth(),
  });
});

if (ADMIN_TOKEN) {
  app.post("/metrics/purge", requireAdminToken, (_req, res) => {
    const removed = cacheStore.size;
    cacheStore.clear();
    res.json({ status: "purged", removed });
  });
}

app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

server.listen(PORT, () => {
  console.log(`Unidentified backend online at http://localhost:${PORT}`);
});

function requireAdminToken(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(501).json({ error: "Admin token not configured." });
  }
  const supplied = req.headers["x-safetynet-admin"];
  if (supplied !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return next();
}

function createRequestId(prefix = "req") {
  try {
    return `${prefix}-${randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
  }
}

function withRequestContext(payload, context = {}) {
  if (context?.requestId && !payload.requestId) {
    payload.requestId = context.requestId;
  }
  return payload;
}

function ensureDomainHealthy(hostname) {
  if (!hostname || DOMAIN_FAILURE_THRESHOLD <= 0) {
    return;
  }
  const entry = domainHealth.get(hostname.toLowerCase());
  if (entry && entry.blockedUntil && entry.blockedUntil > Date.now()) {
    metrics.domainBlocks += 1;
    const remaining = Math.max(0, entry.blockedUntil - Date.now());
    throw new ProxyError(
      503,
      `Upstream for ${hostname} is cooling down.`,
      `Retry in ${Math.ceil(remaining / 1000)}s.`
    );
  }
}

function recordDomainFailure(hostname) {
  if (!hostname || DOMAIN_FAILURE_THRESHOLD <= 0) {
    return;
  }
  const key = hostname.toLowerCase();
  const now = Date.now();
  const entry = domainHealth.get(key) || { failures: 0, lastFailureAt: 0, blockedUntil: 0 };
  if (entry.blockedUntil && entry.blockedUntil > now) {
    domainHealth.set(key, entry);
    return;
  }
  if (now - entry.lastFailureAt > DOMAIN_FAILURE_WINDOW) {
    entry.failures = 0;
  }
  entry.failures += 1;
  entry.lastFailureAt = now;
  if (entry.failures >= DOMAIN_FAILURE_THRESHOLD) {
    entry.blockedUntil = now + DOMAIN_FAILURE_COOLDOWN;
  }
  domainHealth.set(key, entry);
}

function recordDomainSuccess(hostname) {
  if (!hostname || DOMAIN_FAILURE_THRESHOLD <= 0) {
    return;
  }
  domainHealth.delete(hostname.toLowerCase());
}

function summarizeDomainHealth() {
  const now = Date.now();
  return Array.from(domainHealth.entries()).map(([host, info]) => ({
    host,
    failures: info.failures,
    coolingOff: Boolean(info.blockedUntil && info.blockedUntil > now),
    blockedUntil: info.blockedUntil && info.blockedUntil > now ? info.blockedUntil : null,
  }));
}

function resolveCacheTtl(headers = []) {
  if (!ENABLE_CACHE) {
    return 0;
  }
  if (!CACHE_RESPECT_CONTROL) {
    return Math.max(0, CACHE_TTL);
  }
  const cacheControl = findHeaderValue(headers, "cache-control");
  if (cacheControl) {
    if (/no-store|private/i.test(cacheControl)) {
      return 0;
    }
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
    if (maxAgeMatch) {
      const parsed = Number(maxAgeMatch[1]) * 1000;
      if (Number.isFinite(parsed) && parsed > 0) {
        return CACHE_TTL > 0 ? Math.min(parsed, CACHE_TTL) : parsed;
      }
    }
  }
  return Math.max(0, CACHE_TTL);
}

function findHeaderValue(headers = [], target) {
  if (!headers) {
    return null;
  }
  const lowerTarget = target.toLowerCase();
  for (const [key, value] of headers) {
    if (key.toLowerCase() === lowerTarget) {
      return value;
    }
  }
  return null;
}

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
  const ttlMs = resolveCacheTtl(payload.headers);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return;
  }
  pruneCache();
  const expiresAt = Date.now() + ttlMs;
  cacheStore.set(cacheKey, {
    status: payload.status,
    headers: cloneHeaderList(payload.headers),
    body: Buffer.from(payload.body),
    renderer: payload.renderer || "direct",
    added: Date.now(),
    expiresAt,
  });
  enforceCacheCapacity();
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

function rewriteHtmlDocument(html, baseUrl, context = {}) {
  const $ = load(html, { decodeEntities: false });
  if ($("head").length === 0) {
    $("html").prepend("<head></head>");
  }
  const head = $("head").first();
  const headMeta = [
    ["safetynet-request-id", context.requestId],
    ["safetynet-renderer", context.renderer || "direct"],
    ["safetynet-target", baseUrl?.toString?.() ?? ""],
  ];
  headMeta.forEach(([name, value]) => {
    if (!value) return;
    const existing = head.find(`meta[name='${name}']`).first();
    if (existing.length) {
      existing.attr("content", value);
    } else {
      head.prepend(`<meta name="${name}" content="${value}">`);
    }
  });

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
  purgeExpiredCacheEntries();
  enforceCacheCapacity();
}

function purgeExpiredCacheEntries() {
  const now = Date.now();
  for (const [key, value] of cacheStore.entries()) {
    if (value.expiresAt && value.expiresAt <= now) {
      cacheStore.delete(key);
    }
  }
}

function enforceCacheCapacity() {
  if (cacheStore.size <= CACHE_MAX_ENTRIES) {
    return;
  }
  while (cacheStore.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cacheStore.keys().next().value;
    if (!oldestKey) {
      break;
    }
    cacheStore.delete(oldestKey);
    metrics.cacheEvictions += 1;
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


