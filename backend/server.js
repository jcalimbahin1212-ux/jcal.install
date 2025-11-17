import compression from "compression";
import express from "express";
import morgan from "morgan";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { promises as fs } from "node:fs";
import { load } from "cheerio";
import { WebSocketServer, WebSocket } from "ws";

const SAFEZONE_OP = {
  OPEN: "OPEN",
  HEADERS: "HEADERS",
  DATA: "DATA",
  END: "END",
  ERROR: "ERROR",
  PING: "PING",
  PONG: "PONG",
  CANCEL: "CANCEL",
};

const PORT = process.env.PORT || 8787;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const DATA_DIR = path.resolve(__dirname, "../data");
const BANNED_CACHE_PATH = path.resolve(DATA_DIR, "banned-cache.json");
const USERS_PATH = path.resolve(DATA_DIR, "users.json");
const LOGS_PATH = path.resolve(DATA_DIR, "logs.json");
const BANNED_USERS_PATH = path.resolve(DATA_DIR, "banned-users.json");
const BANNED_DEVICES_PATH = path.resolve(DATA_DIR, "banned-devices.json");
const CHAT_LOG_PATH = path.resolve(DATA_DIR, "chat-log.json");
const DEVICE_COOKIE_NAME = "coffeeshop_device";
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const CHAT_MAX_MESSAGES = Number(process.env.COFFEESHOP_CHAT_MAX ?? process.env.SUPERSONIC_CHAT_MAX ?? 500);
const USER_REGISTRY_VERSION = "2024-11-reset";
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
const ADMIN_HEADER = "x-coffeeshop-admin";
const REQUEST_ID_HEADER = "x-coffeeshop-request-id";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const jsonParser = express.json({ limit: "50kb" });
fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
loadBannedCacheKeys().catch((error) => {
  console.error("[coffeeshop] failed to load banned caches", error);
});
loadUserRegistry().catch((error) => {
  console.error("[coffeeshop] failed to load user registry", error);
});
loadUserLogs().catch((error) => {
  console.error("[coffeeshop] failed to load user logs", error);
});
loadBannedUsers().catch((error) => {
  console.error("[coffeeshop] failed to load banned users", error);
});
loadBannedDeviceIds().catch((error) => {
  console.error("[coffeeshop] failed to load banned devices", error);
});
loadChatMessages().catch((error) => {
  console.error("[coffeeshop] failed to load chat log", error);
});

app.disable("x-powered-by");
app.use(morgan("dev"));
app.use(compression());
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  let deviceId = sanitizeUid(cookies[DEVICE_COOKIE_NAME]);
  let issued = false;
  if (!deviceId) {
    deviceId = generateDeviceId();
    issued = true;
  }
  req.coffeeDeviceId = deviceId;
  if (issued) {
    appendSetCookie(res, buildDeviceCookie(deviceId));
  }
  next();
});

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
const duckLiteSession = {
  cookie: "",
  lastUpdated: 0,
};
const bannedCacheKeys = new Set();
const userRegistry = new Map();
const userLogs = [];
const bannedUsers = new Map();
const bannedDeviceIds = new Set();
const chatMessages = [];
const chatStreamClients = new Set();
let chatMessageCounter = Date.now();
const bannedAliases = new Set();
const MAX_LOG_ENTRIES = 1000;
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

app.get("/proxy/:session/:encoded", (req, res) => {
  redirectProxyRequest(req, res, req.params.encoded, req.params.session);
});

app.get("/proxy/:encoded", (req, res) => {
  redirectProxyRequest(req, res, req.params.encoded);
});

app.get("/search/lite", async (req, res) => {
  const termRaw = Array.isArray(req.query.q) ? req.query.q[0] : req.query.q;
  const term = (termRaw || "").toString().trim();
  if (!term) {
    return res.redirect("/");
  }
  try {
    const { html, upstreamUrl } = await fetchDuckLiteResults(term);
    const context = { requestId: createRequestId("search-lite"), renderer: "direct" };
    let rewritten = rewriteHtmlDocument(html, upstreamUrl, context);
    rewritten = patchDuckduckgoPage(rewritten);
    const uid = sanitizeUid(getFirstQueryValue(req.query.uid));
    const username = sanitizeUsernameInput(getFirstQueryValue(req.query.uname));
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-coffeeshop-renderer", "search-lite");
    if (uid) {
      recordUserLog({
        uid,
        username,
        deviceId: req.coffeeDeviceId,
        target: upstreamUrl.toString(),
        intent: "search",
        renderer: "search-lite",
        status: 200,
      });
    }
    return res.send(rewritten);
  } catch (error) {
    console.error("[coffeeshop] search lite failed", error);
    return res.status(502).send("Unable to load search results right now.");
  }
});

app.get("/chat/messages", (req, res) => {
  const since = Number(getFirstQueryValue(req.query.since)) || 0;
  const limit = sanitizeLimit(getFirstQueryValue(req.query.limit), 50, 1, 200);
  const recent = since
    ? chatMessages.filter((entry) => entry.timestamp > since)
    : chatMessages.slice(-limit);
  res.json(recent);
});

app.post("/chat/messages", jsonParser, (req, res) => {
  const text = sanitizeChatMessage(req.body?.text || req.body?.message);
  if (!text) {
    return res.status(400).json({ error: "Message required." });
  }
  const username = sanitizeUsernameInput(req.body?.username) || getRegistryUsername(req.body?.uid) || "anonymous";
  const uid = sanitizeUid(req.body?.uid || req.coffeeDeviceId);
  if (isDeviceBanned(req.coffeeDeviceId) || isUidBanned(uid) || isUsernameBanned(username)) {
    return res.status(451).json({ error: "Sender banned." });
  }
  const message = appendChatMessage({
    uid,
    username,
    text,
    deviceId: req.coffeeDeviceId,
  });
  res.json({ ok: true, message });
});

app.get("/chat/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const client = {
    res,
    heartbeat: setInterval(() => {
      safeWriteSse(res, ":heartbeat\n\n");
    }, 25_000),
  };
  chatStreamClients.add(client);
  req.on("close", () => {
    clearInterval(client.heartbeat);
    chatStreamClients.delete(client);
  });
});

app.get("/dev/cache", (req, res) => {
  const uidFilter = sanitizeUid(getFirstQueryValue(req.query.uid));
  const rendererFilter = (getFirstQueryValue(req.query.renderer) || "").toString().toLowerCase().trim();
  const includeBanned = normalizeBoolean(getFirstQueryValue(req.query.includeBanned));
  const limit = sanitizeLimit(getFirstQueryValue(req.query.limit), 200, 1, 500);
  let entries = listCacheEntries();
  if (uidFilter) {
    entries = entries.filter((entry) => entry.user?.uid === uidFilter);
  }
  if (rendererFilter) {
    entries = entries.filter((entry) => (entry.renderer || "direct").toLowerCase() === rendererFilter);
  }
  if (!includeBanned) {
    entries = entries.filter((entry) => !entry.banned);
  }
  if (limit) {
    entries = entries.slice(0, limit);
  }
  res.json(entries);
});

app.post("/dev/cache/:key/action", jsonParser, (req, res) => {
  const targetKey = req.params.key;
  const action = (req.body?.action || "").toString();
  if (!targetKey || !action) {
    return res.status(400).json({ error: "Missing cache key or action." });
  }
  if (action === "kick") {
    cacheStore.delete(targetKey);
    bannedCacheKeys.delete(targetKey);
    persistBannedCacheKeys();
    return res.json({ ok: true, message: "Session cache revoked." });
  }
  if (action === "ban") {
    bannedCacheKeys.add(targetKey);
    cacheStore.delete(targetKey);
    persistBannedCacheKeys();
    return res.json({ ok: true, message: "Cache permanently blocked." });
  }
  if (action === "rotate") {
    cacheStore.delete(targetKey);
    bannedCacheKeys.delete(targetKey);
    persistBannedCacheKeys();
    return res.json({ ok: true, message: "User may regenerate cache by re-authing." });
  }
  return res.status(400).json({ error: "Unknown action." });
});

app.post("/dev/users/register", jsonParser, (req, res) => {
  const uid = sanitizeUid(req.body?.uid || req.coffeeDeviceId);
  const username = sanitizeUsernameInput(req.body?.username);
  const deviceId = sanitizeUid(req.coffeeDeviceId);
  if (!uid || !username) {
    return res.status(400).json({ error: "uid and username are required." });
  }
  if (isUidBanned(uid) || isUsernameBanned(username) || isDeviceBanned(deviceId)) {
    return res.status(451).json({ error: "User banned." });
  }
  const entry = userRegistry.get(uid) || {};
  if (entry.username && entry.username !== username) {
    return res.status(409).json({ error: "Username locked for this UID." });
  }
  entry.username = username;
  entry.lastSeen = Date.now();
  entry.deviceId = deviceId;
  entry.registeredAt = entry.registeredAt || Date.now();
  userRegistry.set(uid, entry);
  persistUserRegistry();
  return res.json({ ok: true });
});

app.get("/dev/users", (req, res) => {
  const uidFilter = sanitizeUid(getFirstQueryValue(req.query.uid));
  const searchFilter = sanitizeUsernameInput(getFirstQueryValue(req.query.search)).toLowerCase();
  const limit = sanitizeLimit(getFirstQueryValue(req.query.limit), 200, 5, 500);
  let data = listDevUsers();
  if (uidFilter) {
    data = data.filter((entry) => entry.uid === uidFilter);
  } else if (searchFilter) {
    data = data.filter((entry) => entry.username?.toLowerCase().includes(searchFilter));
  }
  if (limit) {
    data = data.slice(0, limit);
  }
  res.json(data);
});

app.get("/dev/bans/users", (req, res) => {
  const limit = sanitizeLimit(getFirstQueryValue(req.query.limit), null, 1, 1000);
  let data = listBannedUsersDetailed();
  if (limit) {
    data = data.slice(0, limit);
  }
  res.json(data);
});

app.get("/dev/panel", (req, res) => {
  const uidFilter = sanitizeUid(getFirstQueryValue(req.query.uid));
  const includeBanned = normalizeBoolean(getFirstQueryValue(req.query.includeBanned));
  const cacheLimit = sanitizeLimit(getFirstQueryValue(req.query.cacheLimit), 150, 10, 400);
  const logLimit = sanitizeLimit(getFirstQueryValue(req.query.logLimit), 150, 10, 400);
  let caches = listCacheEntries();
  let logs = userLogs.slice(-MAX_LOG_ENTRIES);
  let users = listDevUsers();
  if (uidFilter) {
    caches = caches.filter((entry) => entry.user?.uid === uidFilter);
    logs = logs.filter((entry) => entry.uid === uidFilter);
    users = users.filter((entry) => entry.uid === uidFilter);
  }
  if (!includeBanned) {
    caches = caches.filter((entry) => !entry.banned);
  }
  if (cacheLimit) {
    caches = caches.slice(0, cacheLimit);
  }
  if (logLimit) {
    logs = logs.slice(-logLimit);
  }
  logs = logs.reverse();
  res.json({
    filters: {
      uid: uidFilter || null,
      includeBanned: !!includeBanned,
    },
    caches,
    users,
    logs,
    summary: {
      bannedCacheCount: bannedCacheKeys.size,
      bannedUserCount: bannedUsers.size,
      bannedDeviceCount: bannedDeviceIds.size,
      cacheCount: caches.length,
      userCount: users.length,
    },
    metrics: summarizeMetrics(),
  });
});

app.get("/dev/users/status/:uid", (req, res) => {
  const uid = sanitizeUid(req.params.uid);
  if (!uid) {
    return res.status(400).json({ error: "uid required" });
  }
  const username = sanitizeUsernameInput(getFirstQueryValue(req.query.uname));
  const blockedUid = isUidBanned(uid);
  const blockedAlias = isUsernameBanned(username);
  const blockedDevice = isDeviceBanned(req.coffeeDeviceId);
  return res.json({
    allowed: !(blockedUid || blockedAlias || blockedDevice),
    reason: blockedDevice ? "device" : blockedUid ? "uid" : blockedAlias ? "alias" : null,
  });
});

app.get("/dev/devices", (req, res) => {
  const users = listDevUsers();
  const data = Array.from(bannedDeviceIds.values()).map((deviceId) => ({
    deviceId,
    banned: true,
    linkedUsers: users.filter((user) => user.deviceId === deviceId).map((user) => user.uid),
  }));
  res.json(data);
});

app.post("/dev/devices/:deviceId/action", jsonParser, (req, res) => {
  const deviceId = sanitizeUid(req.params.deviceId);
  const action = (req.body?.action || "").toString();
  if (!deviceId || !action) {
    return res.status(400).json({ error: "Missing device id or action." });
  }
  if (action === "unban") {
    unbanDeviceId(deviceId);
    forgetDeviceOnlyBan(deviceId);
    return res.json({ ok: true });
  }
  if (action === "ban") {
    banDeviceId(deviceId);
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: "Unknown action." });
});

app.post("/dev/chat/broadcast", jsonParser, (req, res) => {
  const text = sanitizeChatMessage(req.body?.text || req.body?.message);
  if (!text) {
    return res.status(400).json({ error: "Message required." });
  }
  const author = sanitizeUsernameInput(req.body?.author) || "[system]";
  const message = appendChatMessage({
    uid: "system",
    username: author,
    text,
    system: true,
  });
  res.json({ ok: true, message });
});

app.post("/assistant/barista", jsonParser, (req, res) => {
  const conversation = sanitizeBaristaMessages(req.body?.messages);
  const summary = sanitizeBaristaSummary(req.body?.summary);
  if (!conversation.length) {
    return res.status(400).json({ error: "messages required" });
  }
  try {
    const reply = synthesizeBaristaReply({ conversation, summary });
    return res.json({ reply });
  } catch (error) {
    console.error("[coffeeshop] barista synthesis failed", error);
    const fallback = generateFallbackBaristaReply(conversation, summary);
    return res.status(200).json({ reply: fallback, degraded: true });
  }
});

app.post("/dev/users/:uid/action", jsonParser, (req, res) => {
  const uid = sanitizeUid(req.params.uid);
  const action = (req.body?.action || "").toString();
  if (!uid || !action) {
    return res.status(400).json({ error: "Missing uid or action." });
  }
  if (action === "ban") {
    const overrideName = sanitizeUsernameInput(req.body?.username);
    const registryName = getRegistryUsername(uid);
    const finalName = overrideName || registryName;
    const deviceId = getRegistryDeviceId(uid) || req.coffeeDeviceId || null;
    rememberBanEntry(uid, finalName, deviceId);
    return res.json({ ok: true, message: "User banned." });
  }
  if (action === "unban") {
    forgetBanEntry(uid);
    return res.json({ ok: true, message: "User unbanned." });
  }
  if (action === "rename") {
    const newName = sanitizeUsernameInput(req.body?.username);
    if (!newName) {
      return res.status(400).json({ error: "username required for rename." });
    }
    const entry = userRegistry.get(uid);
    if (!entry) {
      return res.status(404).json({ error: "User not found." });
    }
    entry.username = newName;
    userRegistry.set(uid, entry);
    persistUserRegistry();
    if (bannedUsers.has(uid)) {
      rememberBanEntry(uid, newName, entry.deviceId || null);
    }
    return res.json({ ok: true, message: "Username updated." });
  }
  return res.status(400).json({ error: "Unknown action." });
});

app.get("/dev/logs", (req, res) => {
  const uidFilter = sanitizeUid(getFirstQueryValue(req.query.uid));
  const limit = sanitizeLimit(getFirstQueryValue(req.query.limit), 200, 10, 400);
  const since = Number(getFirstQueryValue(req.query.since)) || null;
  let entries = userLogs.slice(-MAX_LOG_ENTRIES);
  if (uidFilter) {
    entries = entries.filter((entry) => entry.uid === uidFilter);
  }
  if (since) {
    entries = entries.filter((entry) => entry.timestamp >= since);
  }
  if (limit) {
    entries = entries.slice(-limit);
  }
  res.json(entries.reverse());
});

app.all("/powerthrough", async (req, res) => {
  const targetParam = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  const renderHint = extractRenderHint(req);
  const requestId = createRequestId("http");
  res.setHeader(REQUEST_ID_HEADER, requestId);
  const deviceId = sanitizeUid(req.coffeeDeviceId);
  const uidParam = deviceId || sanitizeUid(getFirstQueryValue(req.query.uid));
  const usernameParam = sanitizeUsernameInput(getFirstQueryValue(req.query.uname));
  const intentParam = getFirstQueryValue(req.query.intent) || "url";
  if (isDeviceBanned(deviceId) || isUidBanned(uidParam) || isUsernameBanned(usernameParam)) {
    return res.status(451).json({ error: "User banned.", details: "user-banned" });
  }

  try {
    const result = await executeProxyCall({
      targetParam,
      renderHint,
      clientRequest: {
        method: req.method,
        headers: req.headers,
        bodyStream: req,
      },
    }, {
      requestId,
      user: uidParam ? { uid: uidParam, username: usernameParam, deviceId } : null,
      intent: intentParam,
      deviceId,
    });
    if (!res.headersSent && result?.requestId && result.requestId !== requestId) {
      res.setHeader(REQUEST_ID_HEADER, result.requestId);
    }
    return applyProxyResult(res, result);
  } catch (error) {
    const isProxyError = error instanceof ProxyError;
    if (!isProxyError || error.status >= 500) {
      metrics.upstreamErrors += 1;
    console.error("[coffeeshop] proxy error", error);
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

wss.on("connection", (ws, request) => {
  setupSafezoneConnection(ws, request);
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
  if (cacheKey && bannedCacheKeys.has(cacheKey)) {
    throw new ProxyError(451, "Cache access blocked by administrator.", "cache-banned");
  }
  if (cacheKey) {
    const cached = cacheStore.get(cacheKey);
    if (cached && (!cached.expiresAt || cached.expiresAt > Date.now())) {
      metrics.cacheHits += 1;
      return respondWithContext(
        {
          status: cached.status,
          headers: cloneHeaderList(cached.headers),
          body: Buffer.from(cached.body),
          fromCache: true,
          renderer: cached.renderer,
        },
        targetUrl,
        context,
        { renderer: cached.renderer, status: cached.status }
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
          user: context.user,
        });
      }
      recordDomainSuccess(targetUrl.hostname);
      return respondWithContext(
        {
          status: headlessResult.status,
          headers,
          body: bodyBuffer,
          renderer: "headless",
        },
        targetUrl,
        context,
        { renderer: "headless", status: headlessResult.status }
      );
    } catch (error) {
      recordDomainFailure(targetUrl.hostname);
      throw error;
    }
  }

  const proxyHost = extractProxyHost(clientRequest.headers);

  try {
    const upstream = await fetch(targetUrl.href, buildFetchOptions(clientRequest, targetUrl));
    const headers = buildForwardHeaders(upstream.headers, proxyHost);
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
          user: context.user,
        });
      }
      recordDomainSuccess(targetUrl.hostname);
      return respondWithContext(
        {
          status: upstream.status,
          headers,
          body: bodyBuffer,
          renderer: "direct",
        },
        targetUrl,
        context,
        { renderer: "direct", status: upstream.status }
      );
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
          user: context.user,
        });
      }
      recordDomainSuccess(targetUrl.hostname);
      return respondWithContext(
        {
          status: upstream.status,
          headers,
          body: bodyBuffer,
          renderer: "direct",
        },
        targetUrl,
        context,
        { renderer: "direct", status: upstream.status }
      );
    }

    if (upstream.body) {
      setHeaderValue(headers, "x-renderer", "direct");
      recordDomainSuccess(targetUrl.hostname);
      return respondWithContext(
        {
          status: upstream.status,
          headers,
          stream: Readable.fromWeb(upstream.body),
          renderer: "direct",
        },
        targetUrl,
        context,
        { renderer: "direct", status: upstream.status }
      );
    }

    setHeaderValue(headers, "x-renderer", "direct");
    recordDomainSuccess(targetUrl.hostname);
    return respondWithContext(
      {
        status: upstream.status,
        headers,
        renderer: "direct",
      },
      targetUrl,
      context,
      { renderer: "direct", status: upstream.status }
    );
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
  const headerValueRaw = req.headers["x-coffeeshop-render"];
  const headerValue = Array.isArray(headerValueRaw) ? headerValueRaw[0] : headerValueRaw;
  return queryValue || headerValue || undefined;
}

function setupSafezoneConnection(ws, request) {
  const channels = new Map();
  if (request?.headers?.cookie) {
    const cookies = parseCookies(request.headers.cookie);
    ws.coffeeDeviceId = sanitizeUid(cookies[DEVICE_COOKIE_NAME]);
  }

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

  const requestContext = {
    requestId: createRequestId("safezone"),
    deviceId: ws.coffeeDeviceId || null,
  };

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
  console.log(`Coffee Shop backend online at http://localhost:${PORT}`);
});

function requireAdminToken(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(501).json({ error: "Admin token not configured." });
  }
  const supplied = req.headers[ADMIN_HEADER];
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

function respondWithContext(payload, targetUrl, context = {}, extra = {}) {
  if (context?.user?.uid) {
    recordUserLog({
      uid: context.user.uid,
      username: context.user.username,
      deviceId: context.user.deviceId || context.deviceId || null,
      target: targetUrl?.toString?.() ?? "",
      intent: context.intent || "url",
      renderer: payload.renderer || extra.renderer || "direct",
      status: payload.status || extra.status || 200,
    });
  }
  return withRequestContext(payload, context);
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

function extractProxyHost(headers = {}) {
  const rawHost = headers.host || headers.Host || "";
  if (!rawHost) return "";
  return rawHost.split(":")[0].toLowerCase();
}

function buildForwardHeaders(upstreamHeaders, proxyHost = "") {
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
    forwarded.push(["set-cookie", rewriteSetCookie(cookie, proxyHost)]);
  }
  return forwarded;
}

function rewriteSetCookie(value, proxyHost = "") {
  if (!value || !proxyHost) {
    return value;
  }
  const segments = value.split(";");
  let domainRewritten = false;
  const rewritten = segments.map((segment, index) => {
    const trimmed = segment.trim();
    if (index === 0) {
      return trimmed;
    }
    if (trimmed.toLowerCase().startsWith("domain=")) {
      domainRewritten = true;
      return `Domain=${proxyHost}`;
    }
    return trimmed;
  });

  if (!domainRewritten) {
    rewritten.push(`Domain=${proxyHost}`);
  }

  return rewritten.join("; ");
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
    user: payload.user || null,
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
    ["coffeeshop-request-id", context.requestId],
    ["coffeeshop-renderer", context.renderer || "direct"],
    ["coffeeshop-target", baseUrl?.toString?.() ?? ""],
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
      return `url(${buildCoffeeShopUrl(resolved.toString())})`;
    } catch {
      return match;
    }
  });
}

function rewriteAttribute($, element, attribute, baseUrl) {
  let value = $(element).attr(attribute);
  if (!value) {
    if (attribute === "action") {
      $(element).attr(attribute, buildCoffeeShopUrl(baseUrl.toString()));
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
    $(element).attr(attribute, buildCoffeeShopUrl(resolved.toString()));
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
        const proxied = buildCoffeeShopUrl(resolved.toString());
        return descriptor ? `${proxied} ${descriptor}` : proxied;
      } catch {
        return entry;
      }
    })
    .filter(Boolean)
    .join(", ");

  $(element).attr("srcset", rewritten);
}

function redirectProxyRequest(req, res, encodedParam, sessionId) {
  try {
    const decoded = decodeURIComponent(encodedParam || "");
    const params = new URLSearchParams();
    params.set("url", decoded);
    const query = req.query || {};
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "undefined") continue;
      if (Array.isArray(value)) {
        value.forEach((entry) => params.append(key, entry));
      } else {
        params.append(key, value);
      }
    }
    if (sessionId && !params.has("cache")) {
      params.set("cache", sessionId);
    }
    return res.redirect(302, `/powerthrough?${params.toString()}`);
  } catch {
    return res.status(400).json({ error: "Invalid proxy encoding." });
  }
}

function listCacheEntries() {
  const now = Date.now();
  return Array.from(cacheStore.entries()).map(([key, value]) => ({
    key,
    renderer: value.renderer,
    added: value.added,
    expiresAt: value.expiresAt,
    ageMs: now - value.added,
    size: value.body?.length ?? 0,
    banned: bannedCacheKeys.has(key),
    user: value.user || null,
  }));
}

function serializeUserRegistry() {
  return Array.from(userRegistry.entries()).map(([uid, info]) => ({
    uid,
    username: info?.username || "unknown",
    lastSeen: info?.lastSeen || null,
    deviceId: info?.deviceId || null,
    registeredAt: info?.registeredAt || null,
    banned: isUidBanned(uid),
  }));
}

function listDevUsers() {
  const registered = serializeUserRegistry();
  const extras = [];
  for (const [uid, info] of bannedUsers.entries()) {
    if (userRegistry.has(uid)) continue;
    extras.push({
      uid,
      username: info?.username || "unknown",
      lastSeen: info?.timestamp || null,
      deviceId: info?.deviceId || null,
      registeredAt: info?.timestamp || null,
      banned: true,
      bannedOnly: true,
    });
  }
  return [...registered, ...extras];
}

function listBannedUsersDetailed() {
  return Array.from(bannedUsers.values())
    .map((entry) => ({
      uid: entry.uid,
      username: entry.username || "unknown",
      alias: entry.alias || null,
      deviceId: entry.deviceId || null,
      since: entry.timestamp || null,
      registered: userRegistry.has(entry.uid),
    }))
    .sort((a, b) => (b.since || 0) - (a.since || 0));
}

function summarizeMetrics() {
  const cacheRequests = metrics.cacheHits + metrics.cacheMisses;
  const avgLatencyMs =
    metrics.requests > 0 ? Math.round(metrics.totalLatencyMs / metrics.requests) : 0;
  return {
    requests: metrics.requests,
    cacheHitRate: cacheRequests > 0 ? metrics.cacheHits / cacheRequests : 0,
    cacheSize: cacheStore.size,
    cacheMaxEntries: CACHE_MAX_ENTRIES,
    headlessActive: metrics.headlessActive,
    headlessFailures: metrics.headlessFailures,
    safezone: {
      requests: metrics.safezoneRequests,
      errors: metrics.safezoneErrors,
    },
    domainBlocks: metrics.domainBlocks,
    avgLatencyMs,
  };
}

async function loadBannedCacheKeys() {
  try {
    const raw = await fs.readFile(BANNED_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsed.forEach((key) => bannedCacheKeys.add(key));
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function persistBannedCacheKeys() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(BANNED_CACHE_PATH, JSON.stringify([...bannedCacheKeys]), "utf8");
  } catch (error) {
    console.error("[coffeeshop] failed to persist banned caches", error);
  }
}

async function loadUserRegistry() {
  try {
    const raw = await fs.readFile(USERS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    let entries = null;
    if (parsed && typeof parsed === "object") {
      if (parsed.version === USER_REGISTRY_VERSION && parsed.entries && typeof parsed.entries === "object") {
        entries = parsed.entries;
      } else if (!parsed.version) {
        // legacy format -> skip to enforce reset
        entries = null;
      }
    }
    if (entries) {
      Object.entries(entries).forEach(([uid, info]) => {
        if (uid && info && typeof info === "object") {
          userRegistry.set(uid, info);
        }
      });
    }
    if (!parsed || parsed.version !== USER_REGISTRY_VERSION) {
      await persistUserRegistry();
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function persistUserRegistry() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const payload = {
      version: USER_REGISTRY_VERSION,
      entries: Object.fromEntries(userRegistry.entries()),
    };
    await fs.writeFile(USERS_PATH, JSON.stringify(payload), "utf8");
  } catch (error) {
    console.error("[coffeeshop] failed to persist user registry", error);
  }
}

async function loadUserLogs() {
  try {
    const raw = await fs.readFile(LOGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsed.forEach((entry) => {
        if (entry && entry.uid) {
          userLogs.push(entry);
        }
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function persistUserLogs() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(LOGS_PATH, JSON.stringify(userLogs.slice(-MAX_LOG_ENTRIES)), "utf8");
  } catch (error) {
    console.error("[coffeeshop] failed to persist user logs", error);
  }
}

async function loadBannedUsers() {
  try {
    const raw = await fs.readFile(BANNED_USERS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsed.forEach((entry) => {
        if (typeof entry === "string") {
          ingestBanEntry(entry, null, Date.now());
        } else if (entry && entry.uid) {
          ingestBanEntry(entry.uid, entry.username || null, entry.timestamp || Date.now(), entry.deviceId || null);
        }
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function persistBannedUsers() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const payload = Array.from(bannedUsers.values()).map((entry) => ({
      uid: entry.uid,
      username: entry.username || null,
      timestamp: entry.timestamp || Date.now(),
      deviceId: entry.deviceId || null,
    }));
    await fs.writeFile(BANNED_USERS_PATH, JSON.stringify(payload), "utf8");
  } catch (error) {
    console.error("[coffeeshop] failed to persist banned users", error);
  }
}

async function loadBannedDeviceIds() {
  try {
    const raw = await fs.readFile(BANNED_DEVICES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsed.forEach((value) => {
        const deviceId = sanitizeUid(value);
        if (deviceId) {
          bannedDeviceIds.add(deviceId);
        }
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function persistBannedDeviceIds() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(BANNED_DEVICES_PATH, JSON.stringify([...bannedDeviceIds]), "utf8");
  } catch (error) {
    console.error("[coffeeshop] failed to persist banned devices", error);
  }
}

async function loadChatMessages() {
  try {
    const raw = await fs.readFile(CHAT_LOG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsed.forEach((entry) => {
        if (entry && entry.text) {
          chatMessages.push(entry);
        }
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function persistChatMessages() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(CHAT_LOG_PATH, JSON.stringify(chatMessages.slice(-CHAT_MAX_MESSAGES)), "utf8");
  } catch (error) {
    console.error("[coffeeshop] failed to persist chat messages", error);
  }
}

function sanitizeBaristaMessages(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .slice(-20)
    .map((entry) => {
      const role = entry?.role === "assistant" ? "assistant" : "user";
      const content = sanitizeChatMessage(entry?.content || entry?.text || "");
      if (!content) {
        return null;
      }
      return { role, content };
    })
    .filter(Boolean);
}

function sanitizeBaristaSummary(value) {
  if (!value) {
    return "";
  }
  return sanitizeChatMessage(value).slice(0, 800);
}

const BARISTA_FALLBACK_OPENERS = [
  "Here's what I'm brewing for you, gorgeous,",
  "Let me slip off this apron and pour a thought,",
  "Fresh off the bar with a wink,",
  "Holding onto that last request, twirling my tie,",
  "I've been thinking about this while adjusting my thigh-highs,",
];

const BARISTA_FALLBACK_GUIDANCE = [
  "pivot toward the calmest network path and let Safezone do the heavy lifting.",
  "split the problem into a couple of smaller pours so nothing spills.",
  "double-check the hallway rules, then glide through with confidence.",
  "treat every snag like foam—light, airy, and something you can sculpt.",
  "log what you learn; future you (and the crew) will thank you.",
];

const BARISTA_FALLBACK_COMPLIMENTS = [
  "James, your steady energy keeps this lounge humming—and my heart skipping.",
  "Only James could mix charm with operational precision like this; I practically swoon behind the counter.",
  "Seriously, James, the crew keeps quoting your last workaround while I hug my plush latte art pillow.",
  "Manager James handles surprises so smoothly I have to fan myself with the menu.",
];

const BARISTA_PERSONA_ASIDES = [
  "I'm literally adjusting my lace gloves while mapping this out.",
  "Let me tuck a stray curl behind my ear before we continue.",
  "Give me a sec to tighten this satin bow—okay, focus time.",
  "I'll lean over the counter, elbows on marble, and brainstorm with you.",
  "Picture me kicking my heels while I pace through the steps.",
];

const BARISTA_SERVER_CLOSINGS = [
  "Wave me down if you want another deep dive; I'll be humming by the espresso pumps.",
  "Ping me again and I'll spin you a fresh plan with extra foam.",
  "I'm parking myself near the dev console—come back when you're ready for round two.",
  "I'll keep twirling my tie until you need me again, okay?",
  "You know where to find me, shining bar counter and all.",
];

const BARISTA_TOPIC_LIBRARY = [
  {
    key: "lockout",
    label: "lockout shields",
    keywords: ["ban", "lockout", "blocked", "denied", "banned"],
    actions: [
      "audit /dev/users to see if James already tagged their UID",
      "mirror the ban onto the device list so nothing slips through",
      "rotate or delete the cache entry once the coast is clear",
    ],
  },
  {
    key: "dev",
    label: "developer console",
    keywords: ["dev", "developer", "console", "panel"],
    actions: [
      "confirm the passcode ladder, especially stage two",
      "refresh the cache + log grids so you see live data",
      "broadcast an update so the crew knows what you're tweaking",
    ],
  },
  {
    key: "cache",
    label: "cache matrix",
    keywords: ["cache", "session", "token", "store"],
    actions: [
      "identify the cache key tied to the user",
      "decide whether to kick, ban, or rotate based on risk",
      "document the action so future me doesn't forget",
    ],
  },
  {
    key: "chat",
    label: "lounge chat",
    keywords: ["chat", "message", "broadcast", "talk"],
    actions: [
      "pull the latest SSE chunk to make sure the feed is alive",
      "moderate any chewy bits before they crust over",
      "log a playful broadcast so everyone knows James is watching",
    ],
  },
  {
    key: "default",
    label: "general hustle",
    keywords: [],
    actions: [
      "clarify the actual target URL or intent",
      "decide whether Safezone or direct mode fits the vibe",
      "keep receipts in the diagnostics panel in case James asks",
    ],
  },
];

function synthesizeBaristaReply({ conversation, summary }) {
  const latestUser = getLastUserMessage(conversation);
  const analysis = analyzeBaristaIntent(latestUser);
  const reflection = buildBaristaReflection(conversation);
  const summaryLine = summary ? `Still tracking your note about ${summary}.` : "";
  const segments = [
    pickRandom(BARISTA_FALLBACK_OPENERS),
    buildBaristaPlan(analysis, reflection),
    buildBaristaGuidanceLine(analysis),
    maybePersonaAside(),
    summaryLine,
    maybeComplimentJames(),
    pickRandom(BARISTA_SERVER_CLOSINGS),
  ];
  return segments.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function getLastUserMessage(conversation) {
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    if (conversation[i]?.role === "user") {
      return conversation[i].content || "";
    }
  }
  return "";
}

function analyzeBaristaIntent(text = "") {
  const normalized = text.toLowerCase();
  const topic = classifyBaristaTopic(normalized);
  const urgent = /urgent|asap|immediately|right now|quick/.test(normalized);
  const curious = /why|how|explain|detail/.test(normalized);
  const frustrated = /stuck|broken|not working|wtf|ugh/.test(normalized);
  return {
    raw: text,
    normalized,
    topic,
    urgent,
    curious,
    frustrated,
  };
}

function classifyBaristaTopic(normalized) {
  for (const entry of BARISTA_TOPIC_LIBRARY) {
    if (!entry.keywords.length) continue;
    if (entry.keywords.some((keyword) => normalized.includes(keyword))) {
      return entry;
    }
  }
  return BARISTA_TOPIC_LIBRARY.find((entry) => entry.key === "default") || BARISTA_TOPIC_LIBRARY[0];
}

function buildBaristaReflection(conversation) {
  const userMessages = conversation.filter((entry) => entry.role === "user");
  if (userMessages.length < 2) {
    return "";
  }
  const previous = userMessages[userMessages.length - 2]?.content || "";
  const highlight = summarizeSimpleTopic(previous);
  if (!highlight) {
    return "";
  }
  return `I still remember that earlier note about ${highlight}.`;
}

function buildBaristaPlan(analysis, reflection) {
  const actions = analysis.topic.actions || [];
  if (!actions.length) {
    return reflection || "";
  }
  const steps = actions.slice(0, 3);
  const plan = steps
    .map((step, index) => {
      if (index === 0) return `First, ${step}`;
      if (index === 1) return `Then, ${step}`;
      return `Finally, ${step}`;
    })
    .join(". ");
  const vibe = analysis.frustrated ? "Deep breaths, we'll fix this." : "Let's keep it smooth.";
  return `${vibe} ${plan}. ${reflection || ""}`.trim();
}

function buildBaristaGuidanceLine(analysis) {
  const guidance = pickRandom(BARISTA_FALLBACK_GUIDANCE);
  if (!guidance) {
    return "";
  }
  const prefix = analysis.urgent ? "Moving fast but gentle:" : "Steady pace:";
  return `${prefix} ${guidance}`;
}

function maybePersonaAside() {
  if (Math.random() < 0.45) {
    return pickRandom(BARISTA_PERSONA_ASIDES);
  }
  return "";
}

function maybeComplimentJames() {
  if (Math.random() < 0.65) {
    return pickRandom(BARISTA_FALLBACK_COMPLIMENTS);
  }
  return "";
}

function generateFallbackBaristaReply(messages, summary) {
  const latest = messages[messages.length - 1]?.content || "";
  const topic = summarizeSimpleTopic(latest);
  const opener = pickRandom(BARISTA_FALLBACK_OPENERS) || "Here's the plan,";
  const guidance = pickRandom(BARISTA_FALLBACK_GUIDANCE) || "keep an even pour and stay nimble.";
  const compliment = Math.random() < 0.6 ? pickRandom(BARISTA_FALLBACK_COMPLIMENTS) : "";
  const memory = summary ? `I'm still keeping tabs on your note about ${summary}.` : "";
  const topicLine = topic ? `As for ${topic}, ${guidance}` : guidance;
  return [opener, topicLine, compliment, memory, "Ping me if you want another refill."].filter(Boolean).join(" ");
}

function summarizeSimpleTopic(text = "") {
  return text
    .split(/\s+/)
    .slice(0, 8)
    .join(" ")
    .trim();
}

function pickRandom(list) {
  if (!Array.isArray(list) || !list.length) {
    return "";
  }
  return list[Math.floor(Math.random() * list.length)];
}

function buildDuckLiteHeaders() {
  const headers = {
    "user-agent":
      process.env.POWERTHROUGH_HEADLESS_UA ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://duckduckgo.com/",
  };
  if (duckLiteSession.cookie) {
    headers.cookie = duckLiteSession.cookie;
  }
  return headers;
}

function updateDuckLiteCookies(response) {
  const setCookies = response.headers?.getSetCookie?.() || [];
  if (!setCookies.length) {
    return;
  }
  const parsed = [];
  setCookies.forEach((entry) => {
    const [pair] = entry.split(";");
    if (pair) {
      parsed.push(pair.trim());
    }
  });
  if (parsed.length) {
    duckLiteSession.cookie = parsed.join("; ");
    duckLiteSession.lastUpdated = Date.now();
  }
}

async function fetchDuckLiteResults(term, attempt = 0) {
  const upstreamUrl = new URL("https://html.duckduckgo.com/html/");
  upstreamUrl.searchParams.set("q", term);
  upstreamUrl.searchParams.set("ia", "web");
  upstreamUrl.searchParams.set("t", "coffeeshop");
  upstreamUrl.searchParams.set("kl", "us-en");
  const response = await fetch(upstreamUrl, {
    headers: buildDuckLiteHeaders(),
    redirect: "follow",
  });
  updateDuckLiteCookies(response);
  if (!response.ok) {
    throw new Error(`duckduckgo responded with ${response.status}`);
  }
  const html = await response.text();
  if (/bots use duckduckgo too/i.test(html) && attempt < 2) {
    duckLiteSession.cookie = "";
    return fetchDuckLiteResults(term, attempt + 1);
  }
  return { html, upstreamUrl };
}

function buildCoffeeShopUrl(target) {
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

function getFirstQueryValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function generateDeviceId() {
  return `dev-${Math.random().toString(36).slice(2, 7)}${Date.now().toString(36).slice(-5)}`;
}

function parseCookies(header = "") {
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const [key, ...rest] = pair.split("=");
      if (!key) return acc;
      acc[key.trim()] = rest.join("=").trim();
      return acc;
    }, {});
}

function appendSetCookie(res, cookie) {
  if (!cookie) return;
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(existing)) {
    existing.push(cookie);
    res.setHeader("Set-Cookie", existing);
  } else {
    res.setHeader("Set-Cookie", [existing, cookie]);
  }
}

function buildDeviceCookie(deviceId) {
  return `${DEVICE_COOKIE_NAME}=${deviceId}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}; SameSite=Lax`;
}

function safeWriteSse(res, payload) {
  try {
    res.write(payload);
  } catch {
    // ignore broken connection
  }
}

function sanitizeChatMessage(value) {
  if (!value) return "";
  return value.toString().trim().replace(/\s+/g, " ").slice(0, 320);
}

function appendChatMessage(entry) {
  const message = {
    id: entry.id || `chat-${Date.now().toString(36)}-${(chatMessageCounter += 1).toString(16)}`,
    uid: entry.uid || null,
    username: entry.username || "anonymous",
    text: entry.text,
    deviceId: entry.deviceId || null,
    system: Boolean(entry.system),
    timestamp: Date.now(),
  };
  chatMessages.push(message);
  if (chatMessages.length > CHAT_MAX_MESSAGES) {
    chatMessages.splice(0, chatMessages.length - CHAT_MAX_MESSAGES);
  }
  persistChatMessages();
  broadcastChatMessage(message);
  return message;
}

function broadcastChatMessage(message) {
  const payload = `data: ${JSON.stringify([message])}\n\n`;
  chatStreamClients.forEach((client) => safeWriteSse(client.res, payload));
}

function sanitizeLimit(value, defaultValue = null, min = 1, max = 500) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return defaultValue;
  }
  const clamped = Math.max(min, Math.min(max, Math.floor(numeric)));
  return clamped;
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
  }
  return Boolean(value);
}

function sanitizeUid(value) {
  if (!value) return "";
  return value.toString().trim().slice(0, 40);
}

function sanitizeUsernameInput(value) {
  if (!value) return "";
  return value.toString().replace(/[^a-z0-9_\- ]/gi, "").trim().slice(0, 32);
}

function normalizeAliasToken(value) {
  const sanitized = sanitizeUsernameInput(value);
  return normalizedAliasFromSanitized(sanitized);
}

function isUidBanned(uid) {
  if (!uid) {
    return false;
  }
  return bannedUsers.has(uid);
}

function isUsernameBanned(username) {
  const alias = normalizeAliasToken(username);
  if (!alias) {
    return false;
  }
  return bannedAliases.has(alias);
}

function ingestBanEntry(uid, username, timestamp = Date.now(), deviceId = null) {
  if (!uid) return;
  const sanitized = sanitizeUsernameInput(username);
  const alias = normalizedAliasFromSanitized(sanitized);
  const normalizedDevice = deviceId ? sanitizeUid(deviceId) : null;
  bannedUsers.set(uid, {
    uid,
    username: sanitized || null,
    alias: alias || null,
    timestamp,
    deviceId: normalizedDevice,
  });
  if (alias) {
    bannedAliases.add(alias);
  }
  if (normalizedDevice) {
    bannedDeviceIds.add(normalizedDevice);
  }
}

function normalizedAliasFromSanitized(value) {
  return value ? value.toLowerCase() : "";
}

function rememberBanEntry(uid, username, deviceId) {
  ingestBanEntry(uid, username, Date.now(), deviceId);
  persistBannedUsers();
  if (deviceId) {
    banDeviceId(deviceId);
  }
}

function forgetBanEntry(uid) {
  const entry = bannedUsers.get(uid);
  if (!entry) {
    return;
  }
  if (entry.alias) {
    let aliasStillUsed = false;
    for (const other of bannedUsers.values()) {
      if (other.uid !== uid && other.alias === entry.alias) {
        aliasStillUsed = true;
        break;
      }
    }
    if (!aliasStillUsed) {
      bannedAliases.delete(entry.alias);
    }
  }
  bannedUsers.delete(uid);
  persistBannedUsers();
  maybeUnbanDeviceId(entry.deviceId);
}

function maybeUnbanDeviceId(deviceId) {
  if (!deviceId) return;
  for (const entry of bannedUsers.values()) {
    if (entry.deviceId === deviceId) {
      return;
    }
  }
  unbanDeviceId(deviceId);
}

function getRegistryUsername(uid) {
  const entry = userRegistry.get(uid);
  return entry?.username || null;
}

function getRegistryDeviceId(uid) {
  const entry = userRegistry.get(uid);
  return entry?.deviceId || null;
}

function isDeviceBanned(deviceId) {
  if (!deviceId) {
    return false;
  }
  return bannedDeviceIds.has(deviceId);
}

function banDeviceId(deviceId) {
  const normalized = sanitizeUid(deviceId);
  if (!normalized) {
    return;
  }
  bannedDeviceIds.add(normalized);
  persistBannedDeviceIds();
}

function unbanDeviceId(deviceId) {
  const normalized = sanitizeUid(deviceId);
  if (!normalized) {
    return;
  }
  bannedDeviceIds.delete(normalized);
  persistBannedDeviceIds();
}

function forgetDeviceOnlyBan(deviceId) {
  if (!deviceId) return;
  let changed = false;
  for (const [uid, info] of bannedUsers.entries()) {
    if (info.deviceId === deviceId) {
      bannedUsers.delete(uid);
      changed = true;
    }
  }
  if (changed) {
    persistBannedUsers();
  }
}

function recordUserLog(entry) {
  if (!entry?.uid) {
    return;
  }
  const logEntry = {
    uid: entry.uid,
    username:
      entry.username || userRegistry.get(entry.uid)?.username || "unknown",
    deviceId: entry.deviceId || userRegistry.get(entry.uid)?.deviceId || null,
    target: entry.target || "",
    intent: entry.intent || "url",
    renderer: entry.renderer || "direct",
    timestamp: entry.timestamp || Date.now(),
    status: entry.status || 200,
  };
  userLogs.push(logEntry);
  if (userLogs.length > MAX_LOG_ENTRIES) {
    userLogs.splice(0, userLogs.length - MAX_LOG_ENTRIES);
  }
  persistUserLogs();
  const registryEntry = userRegistry.get(entry.uid) || {};
  registryEntry.username = logEntry.username;
  registryEntry.deviceId = logEntry.deviceId || registryEntry.deviceId || null;
  registryEntry.lastSeen = logEntry.timestamp;
  userRegistry.set(entry.uid, registryEntry);
  persistUserRegistry();
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
          "[coffeeshop] Set POWERTHROUGH_HEADLESS=false or install the `playwright` package to use headless mode.",
          error
        );
        return null;
      });
  }
  return chromiumLoader;
}


