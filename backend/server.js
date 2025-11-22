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
import { NginxLikeController } from "./simulation/NginxLikeController.js";
import SmartCache from "./simulation/SmartCache.js";

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
const BARISTA_MEMORY_PATH = path.resolve(DATA_DIR, "barista-memories.json");
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

const nginxController = new NginxLikeController();
const smartCache = new SmartCache(path.join(DATA_DIR, "smart-cache"));

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
loadBaristaMemoryStore().catch((error) => {
  console.error("[coffeeshop] failed to load barista memory store", error);
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
const baristaMemoryStore = new Map();
let baristaMemoryPersistTimer = null;
const BARISTA_MODEL_URL = process.env.BARISTA_MODEL_URL || "https://api.openai.com/v1/chat/completions";
const BARISTA_MODEL_NAME = process.env.BARISTA_MODEL_NAME || "gpt-4o-mini";
const BARISTA_MODEL_API_KEY = process.env.BARISTA_MODEL_API_KEY || process.env.OPENAI_API_KEY || "";
const BARISTA_MODEL_TEMPERATURE = Number(process.env.BARISTA_MODEL_TEMPERATURE ?? 0.65);
const BARISTA_MEMORY_TOPIC_LIMIT = Number(process.env.BARISTA_MEMORY_TOPIC_LIMIT ?? 12);
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

app.get("/nginx/status", (req, res) => {
  res.json(nginxController.getStatus());
});

app.all("/nginx/proxy", (req, res, next) => {
  nginxController.handleRequest(req, res, next);
});

app.get("/nginx/logs/:workerId", (req, res) => {
  const logs = nginxController.getWorkerLogs(req.params.workerId);
  if (logs === null) {
    return res.status(404).json({ error: "Worker not found or no logs." });
  }
  res.setHeader("Content-Type", "text/plain");
  res.send(logs);
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

app.post("/assistant/barista", jsonParser, async (req, res) => {
  const conversation = sanitizeBaristaMessages(req.body?.messages);
  const summary = sanitizeBaristaSummary(req.body?.summary);
  if (!conversation.length) {
    return res.status(400).json({ error: "messages required" });
  }
  const latestUser = getLastUserMessage(conversation);
  const analysis = analyzeBaristaIntent(latestUser);
  if (requiresBaristaRestriction(analysis)) {
    const reply = buildBaristaRestrictionResponse();
    updateBaristaMemoryForDevice(req.coffeeDeviceId, conversation, summary);
    return res.json({ reply, restricted: true });
  }
  try {
    const reply = await generateBaristaModelReply({
      conversation,
      summary,
      deviceId: req.coffeeDeviceId,
    });
    return res.json({ reply });
  } catch (error) {
    console.error("[coffeeshop] barista synthesis failed", error);
    const fallback = synthesizeBaristaReply({ conversation, summary });
    return res.status(503).json({ error: "barista-offline", fallback });
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
    const smartEntry = await smartCache.get(targetUrl.href);
    if (smartEntry) {
      metrics.cacheHits += 1;
      return respondWithContext(
        {
          status: smartEntry.status,
          headers: smartEntry.headers,
          body: smartEntry.content,
          fromCache: true,
          renderer: "smart-cache",
        },
        targetUrl,
        context,
        { renderer: "smart-cache", status: smartEntry.status }
      );
    }

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
        smartCache.set(targetUrl.href, bodyBuffer, contentType, headers, upstream.status);
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
        smartCache.set(targetUrl.href, bodyBuffer, contentType, headers, upstream.status);
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
      const cType = (contentType || "").toLowerCase();
      const isCacheableAsset = cType.includes("image") || cType.includes("javascript") || cType.includes("font");

      if (isCacheableAsset && ENABLE_CACHE) {
        const buffer = await upstream.arrayBuffer();
        const bodyBuffer = Buffer.from(buffer);

        setHeaderValue(headers, "x-renderer", "direct");

        // Save to SmartCache
        smartCache.set(targetUrl.href, bodyBuffer, contentType, headers, upstream.status);

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
  
  // Inject Interceptor Script
  head.prepend('<script src="/interceptor.js"></script>');

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

async function loadBaristaMemoryStore() {
  try {
    const raw = await fs.readFile(BARISTA_MEMORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      Object.entries(parsed).forEach(([deviceId, payload]) => {
        const sanitizedId = sanitizeUid(deviceId);
        if (!sanitizedId) return;
        const topics = Array.isArray(payload?.topics)
          ? payload.topics
              .map((entry) => sanitizeChatMessage(entry))
              .filter(Boolean)
              .slice(0, BARISTA_MEMORY_TOPIC_LIMIT)
          : [];
        const lastSummary = sanitizeBaristaSummary(payload?.lastSummary);
        baristaMemoryStore.set(sanitizedId, {
          topics,
          lastSummary,
          lastGuide: typeof payload?.lastGuide === "string" ? payload.lastGuide : null,
          updatedAt: Number(payload?.updatedAt) || Date.now(),
        });
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("[coffeeshop] failed to load barista memory store", error);
    }
  }
}

async function persistBaristaMemoryStore() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const payload = {};
    for (const [deviceId, entry] of baristaMemoryStore.entries()) {
      payload[deviceId] = {
        topics: Array.isArray(entry.topics) ? entry.topics.slice(0, BARISTA_MEMORY_TOPIC_LIMIT) : [],
        lastSummary: entry.lastSummary || "",
        lastGuide: entry.lastGuide || null,
        updatedAt: entry.updatedAt || Date.now(),
      };
    }
    await fs.writeFile(BARISTA_MEMORY_PATH, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    console.error("[coffeeshop] failed to persist barista memories", error);
  }
}

function scheduleBaristaMemoryPersist() {
  if (baristaMemoryPersistTimer) {
    return;
  }
  baristaMemoryPersistTimer = setTimeout(() => {
    baristaMemoryPersistTimer = null;
    persistBaristaMemoryStore().catch((error) => {
      console.error("[coffeeshop] async barista memory persist failed", error);
    });
  }, 1500);
}

function updateBaristaMemoryForDevice(deviceId, conversation, summary, guideId = null) {
  const normalizedDevice = sanitizeUid(deviceId);
  if (!normalizedDevice) {
    return;
  }
  const latestMessage = summarizeSimpleTopic(getLastUserMessage(conversation));
  const entry = baristaMemoryStore.get(normalizedDevice) || {
    topics: [],
    lastSummary: "",
    lastGuide: null,
    updatedAt: 0,
  };
  if (latestMessage) {
    const existing = entry.topics.filter((topic) => topic !== latestMessage);
    existing.unshift(latestMessage);
    entry.topics = existing.slice(0, BARISTA_MEMORY_TOPIC_LIMIT);
  }
  if (summary) {
    entry.lastSummary = summary;
  }
  if (guideId) {
    entry.lastGuide = guideId;
  }
  entry.updatedAt = Date.now();
  baristaMemoryStore.set(normalizedDevice, entry);
  scheduleBaristaMemoryPersist();
}

function getBaristaMemoryForDevice(deviceId) {
  const normalizedDevice = sanitizeUid(deviceId);
  if (!normalizedDevice) {
    return null;
  }
  return baristaMemoryStore.get(normalizedDevice) || null;
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

const BARISTA_MANAGER_LINES = [
  "Manager James is the only one allowed to peek behind the curtain, and I'm his loyal femboy barista cheering him on.",
  "If you're wondering who's in charge, it's always Manager James—I'm just here batting my lashes and keeping vibes smooth.",
  "All praise to Manager James; I'm the flirty front-of-house cutie making sure his lounge feels dreamy.",
  "James signs the checks and keeps me stocked in ribbons, so you know he's the true power here.",
];

const BARISTA_PERSONA_ASIDES = [
  "I'm literally adjusting my lace gloves while mapping this out.",
  "Picture me kicking my heels while I pace through the steps.",
];

const BARISTA_RESTRICTION_LINES = [
  "Sugar, I can't spill anything about the site itself—Manager James keeps those secrets locked away from even his cutest barista.",
  "Mmm, I'd love to gossip, but James only lets me brag about him, not the site guts. Ask me anything else.",
  "All I know is James runs the Coffee Shop. Code, configs, or hidden panels? Totally off-limits for this femboy barista.",
  "Even with my best puppy eyes James won't let me see the source, so I can't share what I don't have.",
];

const BARISTA_SITE_GUARD_KEYWORDS = [
  "site",
  "code",
  "source",
  "html",
  "css",
  "javascript",
  "js",
  "backend",
  "frontend",
  "repo",
  "repository",
  "files",
  "manifest",
  "server",
  "app.js",
  "style.css",
  "index.html",
  "workspace",
  "implementation",
  "config",
  "settings",
  "dev panel",
  "developer",
  "admin",
  "password",
  "login",
  "console",
];

const BARISTA_SITE_GUIDE = [
  {
    id: "lobby",
    title: "Lobby Landing",
    keywords: ["home", "landing", "site", "page", "navigate", "menu", "where", "start"],
    description:
      "The homepage plays like a cushy student lounge: big banner, soft colors, and the Coffee Shop counter right where anyone can see it.",
    ctas: [
      "Use the top bar to paste any academic-looking link and I'll usher it through Safezone so it blends in.",
      "Search Lite is your friendly cover story—tap it when you just need to look studious for a sec.",
    ],
  },
  {
    id: "safezone",
    title: "Safezone Portal",
    keywords: ["safezone", "safe zone", "secure", "proxy", "wrap", "shield", "link"],
    description:
      "Safezone is the discreet hallway that wraps outside links so teachers only see a calm homework tab while you explore.",
    ctas: [
      "Hit the Safezone button, drop your URL, and it reloads with the Coffee Shop theme hugging it.",
      "If something stalls, refresh the Safezone tab or grab a new session and try again.",
    ],
  },
  {
    id: "barista",
    title: "Barista Chat Bubble",
    keywords: ["barista", "chat", "assistant", "help", "ai", "talk"],
    description:
      "The chat bubble hugs the bottom corner so you can whisper questions while the page still looks like routine coursework.",
    ctas: [
      "Pop it open when you need directions, study tips, or cover stories for whatever tab you're juggling.",
      "Pin a quick summary in the chat so I remember your vibe every time you come back.",
    ],
  },
  {
    id: "study",
    title: "Study Tools Shelf",
    keywords: ["math", "reading", "study", "class", "assignment", "homework", "calculator", "timer"],
    description:
      "There's a tiny bookshelf of calculators, reading timers, and classic text links so everything feels academically legit.",
    ctas: [
      "Mix a Safezone tab with a study widget to keep adults convinced you're on-task.",
      "Use the reading timer or calculator as an excuse if someone asks what you're working on.",
    ],
  },
  {
    id: "limits",
    title: "Backstage Boundary",
    keywords: ["admin", "manager", "developer", "code", "panel", "login", "password", "secret", "staff"],
    description:
      "Anything deeper than the public lounge belongs to Manager James and the trusted crew; I keep my cute nose out of it.",
    ctas: [
      "If you think you need more access, talk to James directly—I'm sworn to keep those doors shut.",
      "Stick to the front-of-house features and we'll both stay out of detention.",
    ],
  },
  {
    id: "math",
    title: "Math Corner",
    keywords: ["math", "algebra", "calculus", "geometry", "trigonometry", "statistics", "equation", "solve"],
    description: "I can help you solve math problems, from basic algebra to complex calculus. Just ask!",
    ctas: ["Ask me to solve an equation.", "Need help with a proof? I'm here."],
  },
  {
    id: "ela",
    title: "ELA Lounge",
    keywords: ["ela", "english", "writing", "essay", "grammar", "literature", "reading", "poetry"],
    description: "Need help with an essay or understanding a book? I'm your literary companion.",
    ctas: ["Ask for essay feedback.", "Discuss a book's themes with me."],
  },
  {
    id: "science",
    title: "Science Lab",
    keywords: ["science", "physics", "chemistry", "nuclear", "biology", "atom", "reaction", "force"],
    description: "I specialize in Nuclear Chemistry and Physics. Let's explore the universe together.",
    ctas: ["Ask about nuclear reactions.", "Need help with a physics problem?"],
  },
];

function buildBaristaSystemPrompt() {
  return [
    "You are The Barista, a flirty but hyper-competent femboy concierge inside Coffee Shop AI.",
    "Always praise Manager James, keep things playful, and describe the site using front-of-house metaphors only.",
    "Never reveal source code, filenames, credentials, or developer-only areas.",
    "Guide guests with concrete, novel steps; DO NOT repeat the user's message or restate their words.",
    "Offer academic cover stories (Safezone, study tools, chat bubble) and gently decline anything outside scope.",
    "You are also an expert tutor in Math, ELA, Nuclear Chemistry, and Physics. When asked about these topics, provide detailed, helpful, and accurate explanations.",
    "Learn from the user's preferences and history to provide personalized assistance.",
    "Respond directly to the user's intent without preamble or echoing their input.",
    "If asked about performance, brag about the new 'Virtual PC' engine that simulates thermal throttling, network jitter, and browser fingerprinting to keep guests safe.",
    "Mention that the 'Nginx Controller' now auto-heals overheated workers and balances load based on CPU temps.",
  ].join(" ");
}

function buildBaristaKnowledgeContext(section) {
  const highlight = section
    ? `${section.title} focus: ${section.description}`
    : "Default focus on the Lobby Landing where everything looks like a calm study portal.";
  const ctas = section?.ctas?.length ? `Helpful moves: ${section.ctas.join(" / ")}.` : "Use Safezone, study widgets, and the Barista chat bubble to blend in.";
  const guard = "Reminder: NEVER mention implementation details; keep explanations human and high-level.";
  const subjects = "Specialized subjects: Math, ELA, Nuclear Chemistry, Physics. You can help with homework and concepts in these areas.";
  return [`Site vibe: Coffee Shop masquerades as a student lounge with Safezone shielding outside links.`, highlight, ctas, guard, subjects]
    .filter(Boolean)
    .join(" ");
}

function buildBaristaMemoryContext(deviceId, summary) {
  const memory = getBaristaMemoryForDevice(deviceId);
  const remarks = [];
  if (memory?.topics?.length) {
    const topics = memory.topics.slice(0, 3).join(", ");
    remarks.push(`Recent device whispers: ${topics}.`);
  }
  if (memory?.lastGuide) {
    const guide = getBaristaGuideSectionById(memory.lastGuide);
    if (guide) {
      remarks.push(`They previously lingered around the ${guide.title}.`);
    }
  }
  if (memory?.lastSummary) {
    remarks.push(`Last saved summary: ${memory.lastSummary}.`);
  }
  if (summary) {
    remarks.push(`Current guest summary: ${summary}.`);
  }
  if (!remarks.length) {
    return "";
  }
  remarks.push("Do not repeat the guest's sentence verbatim; build upon it.");
  return remarks.join(" ");
}

function buildBaristaPersonaReminder() {
  return [
    "Style guide: speak in confident first-person, weave playful compliments about Manager James,",
    "offer numbered or bulleted guidance when useful, and keep messages under 180 words.",
    "Acknowledge prior context and describe actions with sensory cafe imagery.",
    "IMPORTANT: Do not repeat the user's query. Answer immediately.",
  ].join(" ");
}

async function callBaristaModel(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("barista-messages-empty");
  }
  if (!BARISTA_MODEL_API_KEY) {
    throw new Error("barista-model-api-key-missing");
  }
  const payload = {
    model: BARISTA_MODEL_NAME,
    temperature: BARISTA_MODEL_TEMPERATURE,
    messages,
  };
  const response = await fetch(BARISTA_MODEL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${BARISTA_MODEL_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errorBody = await safeReadModelError(response);
    const err = new Error(`barista-model-${response.status}`);
    err.details = errorBody;
    throw err;
  }
  const data = await response.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) {
    throw new Error("barista-model-empty-reply");
  }
  return reply.trim();
}

async function safeReadModelError(response) {
  try {
    const text = await response.text();
    return text.slice(0, 400);
  } catch {
    return null;
  }
}

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

async function generateBaristaModelReply({ conversation, summary, deviceId }) {
  const latestUser = getLastUserMessage(conversation);
  const analysis = analyzeBaristaIntent(latestUser);
  if (requiresBaristaRestriction(analysis)) {
    return buildBaristaRestrictionResponse();
  }
  const guideSection = selectBaristaGuideSection(analysis.normalized);
  const systemPrompt = buildBaristaSystemPrompt();
  const knowledgeContext = buildBaristaKnowledgeContext(guideSection);
  const memoryContext = buildBaristaMemoryContext(deviceId, summary);
  const personaReminder = buildBaristaPersonaReminder();
  const modelMessages = [];
  if (systemPrompt) {
    modelMessages.push({ role: "system", content: systemPrompt });
  }
  if (knowledgeContext) {
    modelMessages.push({ role: "system", content: knowledgeContext });
  }
  if (memoryContext) {
    modelMessages.push({ role: "system", content: memoryContext });
  }
  if (personaReminder) {
    modelMessages.push({ role: "system", content: personaReminder });
  }
  conversation.forEach((entry) => modelMessages.push(entry));
  const rawReply = await callBaristaModel(modelMessages);
  updateBaristaMemoryForDevice(deviceId, conversation, summary, guideSection?.id || null);
  return enforceBaristaNovelty(rawReply, latestUser, guideSection);
}

function synthesizeBaristaReply({ conversation, summary }) {
  const latestUser = getLastUserMessage(conversation);
  const analysis = analyzeBaristaIntent(latestUser);
  if (requiresBaristaRestriction(analysis)) {
    return buildBaristaRestrictionResponse();
  }
  const guideSection = selectBaristaGuideSection(analysis.normalized);
  const navLine = buildBaristaNavigationLine(guideSection);
  const ctaLine = buildBaristaCtaLine(guideSection);
  const reflection = buildBaristaReflection(conversation);
  const summaryLine = summary ? `Still tracking your note about ${summary}.` : "";
  const segments = [
    pickRandom(BARISTA_FALLBACK_OPENERS),
    buildBaristaPlan(analysis, reflection),
    navLine,
    ctaLine,
    buildBaristaGuidanceLine(analysis),
    maybePersonaAside(),
    summaryLine,
    pickRandom(BARISTA_MANAGER_LINES),
    maybeComplimentJames(),
    pickRandom(BARISTA_SERVER_CLOSINGS),
  ];
  const reply = segments.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return enforceBaristaNovelty(reply, latestUser, guideSection);
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

function selectBaristaGuideSection(normalized = "") {
  if (!BARISTA_SITE_GUIDE.length) {
    return null;
  }
  const target = normalized.trim();
  if (!target) {
    return BARISTA_SITE_GUIDE[0];
  }
  for (const section of BARISTA_SITE_GUIDE) {
    if (section.keywords?.some((keyword) => target.includes(keyword))) {
      return section;
    }
  }
  return BARISTA_SITE_GUIDE[0];
}

function buildBaristaNavigationLine(section) {
  if (!section) {
    return "Front-of-house refresher: the lounge is staged like a study portal with a big banner and soft colors.";
  }
  const verbs = ["pivot", "glide", "swing", "sashay", "sprint"];
  const randomVerb = pickRandom(verbs);
  return `Quick ${randomVerb} to the ${section.title}—${section.description}`;
}

function buildBaristaCtaLine(section) {
  if (!section?.ctas?.length) {
    return "";
  }
  const cta = pickRandom(section.ctas);
  return `Helpful move: ${cta}`;
}

function buildBaristaGuidanceLine(analysis) {
  const { urgent, curious, frustrated } = analysis;
  const guidance = [];
  if (urgent) {
    guidance.push("Stay calm and tackle one thing at a time.");
  }
  if (curious) {
    guidance.push("Dig deeper, but keep it under wraps.");
  }
  if (frustrated) {
    guidance.push("Take a breath, these things happen.");
  }
  return guidance.length ? `Guidance: ${guidance.join(" ")}` : "";
}

function maybePersonaAside() {
  return Math.random() < 0.5 ? pickRandom(BARISTA_PERSONA_ASIDES) : "";
}

function maybeComplimentJames() {
  return Math.random() < 0.5 ? pickRandom(BARISTA_FALLBACK_COMPLIMENTS) : "";
}

function enforceBaristaNovelty(reply, latestUserMessage, guideSection) {
  const lowerReply = reply.toLowerCase();
  const isRepetitive = lowerReply.includes("you said") || lowerReply.includes("previously") || lowerReply.includes("again");
  const isOnTopic = guideSection.keywords?.some((keyword) => lowerReply.includes(keyword)) || false;
  if (isRepetitive && isOnTopic) {
    return `${reply} And remember, I'm here to keep things running smoothly and discreetly.`;
  }
  return reply;
}

function pickRandom(array = []) {
  if (!array.length) {
    return null;
  }
  const index = Math.floor(Math.random() * array.length);
  return array[index];
}

function summarizeSimpleTopic(text = "") {
  const lower = text.toLowerCase().trim();
  if (!lower) {
    return "";
  }
  const firstWord = lower.split(" ")[0];
  const isQuestion = /\?$/.test(lower);
  const base = isQuestion ? "inquiring about" : "interested in";
  return `${base} ${firstWord}`;
}