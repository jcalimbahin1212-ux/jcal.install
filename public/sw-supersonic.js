const SHELL_VERSION = "v4";
const SHELL_CACHE = `supersonic-shell-${SHELL_VERSION}`;
const DATA_CACHE = `supersonic-data-${SHELL_VERSION}`;
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/assets/logo.svg",
  "/sw-supersonic.js",
  "/sw-safetynet.js",
  "/manifest.json",
];
const CLIENT_CHANNEL = "supersonic-client";
const SW_CHANNEL = "supersonic-sw";
const SAFEZONE_ENDPOINT = "/safezone";
const SAFEZONE_PROTOCOL = "safezone.v1";
const SAFEZONE_MAX_REPLAY_BUFFER = 32;
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
const ENABLE_SAFEZONE_TRANSPORT = true;
const REQUEST_ID_HEADER = "x-supersonic-request-id";
const SAFEZONE_CONNECT_TIMEOUT = 8000;
const SAFEZONE_REQUEST_TIMEOUT = 12_000;

let safezoneSocket = null;
let safezoneConnectPromise = null;
let safezoneCleanup = null;
const safezonePendingRequests = new Map();
const safezoneReplayBuffer = [];
let safezoneChannelCounter = 1;

function allocateSafezoneChannelId() {
  safezoneChannelCounter = (safezoneChannelCounter + 1) & 0xffff;
  if (safezoneChannelCounter === 0) {
    safezoneChannelCounter = 1;
  }
  return safezoneChannelCounter;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
      keys.map((key) => {
        if (key !== SHELL_CACHE && key !== DATA_CACHE) {
          return caches.delete(key);
        }
        return undefined;
      })
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (shouldProxy(url)) {
    event.respondWith(proxyThroughSuperSonic(url));
    return;
  }

  if (url.origin === self.location.origin && shouldCache(request, url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.destination === "") {
    event.respondWith(networkFirst(request));
  }
});

self.addEventListener("message", (event) => {
  const { data } = event;
  if (!data || data.source !== CLIENT_CHANNEL) {
    return;
  }
  const clientId = resolveClientId(event, data);
  if (!clientId) {
    return;
  }

  switch (data.type) {
    case "safezone-open":
      ensureSafezoneConnection().catch((error) => {
        notifyClient(clientId, {
          type: "safezone-error",
          message: error.message || "Failed to open SuperSonic safezone.",
        });
      });
      break;
    case "safezone-request":
      handleSafezoneRequest(clientId, data).catch((error) => {
        notifyClient(clientId, {
          type: "safezone-error",
          id: data?.id,
          message: error.message || "Unable to dispatch safezone request.",
        });
      });
      break;
    case "safezone-cancel":
      cancelSafezoneRequest(clientId, data);
      break;
    case "safezone-replay":
      replaySafezoneEventsToClient(clientId);
      break;
    default:
      break;
  }
});

function shouldProxy(url) {
  return url.origin === self.location.origin && url.pathname.startsWith("/proxy/");
}

function shouldCache(request, url) {
  const path = url.pathname;
  if (path === "/" || path === "/index.html") return false;
  if (path.startsWith("/search")) return false;
  if (path.startsWith("/powerthrough")) return false;
  if (path.startsWith("/proxy/")) return false;
  if (path.startsWith("/sw-supersonic.js")) return false;
  if (request.destination === "document") return true;
  return ["style", "script", "image", ""].includes(request.destination);
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request, { cache: "no-store" });
    cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

function extractProxyComponents(pathname) {
  const remainder = pathname.replace(/^\/proxy\//, "");
  const slashIndex = remainder.indexOf("/");
  if (slashIndex === -1) {
    return { session: null, encoded: remainder };
  }
  return {
    session: remainder.slice(0, slashIndex) || null,
    encoded: remainder.slice(slashIndex + 1),
  };
}

function proxyThroughSuperSonic(url) {
  const { session, encoded } = extractProxyComponents(url.pathname);
  const decodedTarget = decodeURIComponent(encoded || '');
  const proxyUrl = new URL("/powerthrough", self.location.origin);
  proxyUrl.searchParams.set("url", decodedTarget);
  url.searchParams.forEach((value, key) => {
    if (key !== "url") {
      proxyUrl.searchParams.set(key, value);
    }
  });
  if (session && !proxyUrl.searchParams.has("cache")) {
    proxyUrl.searchParams.set("cache", session);
  }

  const renderHint = url.searchParams.get("render") || undefined;
  const transportHint = url.searchParams.get("transport") || undefined;
  const wantsDirectOnly = transportHint === "direct";
  const wantsSafezoneOnly = transportHint === "safezone";

  if (!wantsDirectOnly && ENABLE_SAFEZONE_TRANSPORT) {
    return performSafezoneProxy(decodedTarget, { renderHint }).catch((error) => {
      sendTelemetry("safezone-fetch-error", { target: decodedTarget, message: error.message });
      if (wantsSafezoneOnly) {
        return buildProxyErrorResponse("Safezone request failed.", error);
      }
      return fetch(proxyUrl.toString(), { credentials: "same-origin" }).catch((fetchError) => {
        sendTelemetry("proxy-fetch-error", { target: decodedTarget, message: fetchError.message });
        return buildProxyErrorResponse("Proxy request failed.", fetchError);
      });
    });
  }

  return fetch(proxyUrl.toString(), { credentials: "same-origin" }).catch((error) => {
    sendTelemetry("proxy-fetch-error", { target: decodedTarget, message: error.message });
    return buildProxyErrorResponse("Proxy request failed.", error);
  });
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(DATA_CACHE);
    cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cache = await caches.open(DATA_CACHE);
    const cached = await cache.match(request);
    if (cached) {
      sendTelemetry("network-fallback-cache", { url: request.url });
      return cached;
    }
    throw error;
  }
}

function sendTelemetry(eventName, payload) {
  clients.matchAll({ includeUncontrolled: true, type: "window" }).then((windows) => {
    windows.forEach((client) => client.postMessage({ source: SW_CHANNEL, event: eventName, payload }));
  });
}

function buildProxyErrorResponse(message, error) {
  return new Response(
    JSON.stringify({
      error: message,
      details: error?.message,
    }),
    {
      status: 502,
      headers: { "content-type": "application/json" },
    }
  );
}

function performSafezoneProxy(targetUrl, options = {}) {
  const channelId = allocateSafezoneChannelId();
  const renderHint = options.renderHint;
  return new Promise((resolve, reject) => {
    const entry = createPendingEntry({
      resolve,
      reject,
      expectBody: true,
      responseChunks: [],
    });
    safezonePendingRequests.set(channelId, entry);
    entry.timeoutId = setTimeout(() => {
      safezonePendingRequests.delete(channelId);
      reject(buildSafezoneError({ message: "Safezone request timed out.", status: 504 }));
      sendSafezoneFrame({ ch: channelId, op: SAFEZONE_OP.CANCEL });
    }, SAFEZONE_REQUEST_TIMEOUT);

    ensureSafezoneConnection()
      .then(() => {
        const payload = {
          url: targetUrl,
          method: "GET",
          headers: {},
        };
        if (renderHint) {
          payload.renderHint = renderHint;
        }
        sendSafezoneFrame({ ch: channelId, op: SAFEZONE_OP.OPEN, payload });
      })
      .catch((error) => {
        safezonePendingRequests.delete(channelId);
        clearPendingEntryTimeout(entry);
        reject(error);
      });
  });
}

function resolveClientId(event, data) {
  if (event?.source && "id" in event.source && event.source.id) {
    return event.source.id;
  }
  if (data?.clientId) {
    return data.clientId;
  }
  return null;
}

function notifyClient(clientId, payload) {
  if (!clientId) return;
  clients.get(clientId).then((client) => {
    if (client) {
      client.postMessage({ ...payload, source: SW_CHANNEL });
    }
  });
}

async function handleSafezoneRequest(clientId, message) {
  const request = message?.request || {};
  const targetUrl = request.url;
  if (!targetUrl || typeof targetUrl !== "string") {
    throw new Error("safezone request requires a target url.");
  }

  const channelId = allocateSafezoneChannelId();
  const sanitizedHeaders = sanitizeHeaderBag(request.headers);
  const payload = {
    url: targetUrl,
    method: request.method || "GET",
    headers: sanitizedHeaders,
    renderHint: request.renderHint,
  };

  if (request.body !== undefined && request.body !== null) {
    payload.body = request.body;
    payload.bodyEncoding = request.bodyEncoding || "base64";
  }

  const entry = createPendingEntry({ clientId });
  entry.timeoutId = setTimeout(() => {
    safezonePendingRequests.delete(channelId);
    notifyClient(clientId, {
      type: "safezone-error",
      id: channelId,
      status: 504,
      message: "Safezone request timed out.",
    });
    sendSafezoneFrame({ ch: channelId, op: SAFEZONE_OP.CANCEL });
  }, SAFEZONE_REQUEST_TIMEOUT);
  safezonePendingRequests.set(channelId, entry);

  try {
    await ensureSafezoneConnection();
    sendSafezoneFrame({ ch: channelId, op: SAFEZONE_OP.OPEN, payload });
  } catch (error) {
    safezonePendingRequests.delete(channelId);
    clearPendingEntryTimeout(entry);
    throw error;
  }
}

function cancelSafezoneRequest(_clientId, message) {
  const requestId = Number(message?.id);
  if (!requestId) return;
  const entry = safezonePendingRequests.get(requestId);
  safezonePendingRequests.delete(requestId);
  clearPendingEntryTimeout(entry);
  sendSafezoneFrame({ ch: requestId, op: SAFEZONE_OP.CANCEL });
}

function replaySafezoneEventsToClient(clientId) {
  for (const event of safezoneReplayBuffer) {
    notifyClient(clientId, { type: "safezone-event", event });
  }
}

function sanitizeHeaderBag(headers) {
  if (!headers || typeof headers !== "object") {
    return {};
  }
  const sanitized = {};
  Object.entries(headers).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      sanitized[key] = value.map((entry) => String(entry));
    } else {
      sanitized[key] = String(value);
    }
  });
  return sanitized;
}

function recordSafezoneEvent(event) {
  safezoneReplayBuffer.push(event);
  if (safezoneReplayBuffer.length > SAFEZONE_MAX_REPLAY_BUFFER) {
    safezoneReplayBuffer.shift();
  }
}

function broadcastSafezoneState(state, info) {
  recordSafezoneEvent({ kind: "state", state, info, at: Date.now() });
  clients.matchAll({ includeUncontrolled: true, type: "window" }).then((windows) => {
    windows.forEach((client) => {
      client.postMessage({
        source: SW_CHANNEL,
        type: "safezone-state",
        state,
        info,
      });
    });
  });
}

function buildSafezoneUrl() {
  const protocol = self.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${self.location.host}${SAFEZONE_ENDPOINT}`;
}

function generateSafezoneRequestId(prefix = "client") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

function createPendingEntry(meta = {}) {
  return {
    startedAt: Date.now(),
    responseChunks: [],
    timeoutId: null,
    ...meta,
  };
}

function detachSafezoneSocket() {
  if (safezoneCleanup) {
    try {
      safezoneCleanup();
    } catch (error) {
      console.warn("[supersonic-sw] safezone cleanup failed", error);
    }
    safezoneCleanup = null;
  }
  safezoneSocket = null;
}

function attachSafezoneSocket(ws) {
  detachSafezoneSocket();
  safezoneSocket = ws;
  const onMessage = (event) => handleSafezoneSocketMessage(event);
  const onClose = (event) => handleSafezoneSocketClose(event);
  const onError = (event) => {
    console.warn("[supersonic-sw] safezone error", event?.message || event);
  };

  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", onClose);
  ws.addEventListener("error", onError);

  safezoneCleanup = () => {
    ws.removeEventListener("message", onMessage);
    ws.removeEventListener("close", onClose);
    ws.removeEventListener("error", onError);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  };
}

function handleSafezoneSocketMessage(event) {
  let payload;
  try {
    payload = parseSafezonePayload(event.data);
  } catch (error) {
    console.warn("[supersonic-sw] safezone payload parse failed", error);
    return;
  }

  if (!payload || typeof payload !== "object" || typeof payload.op !== "string") {
    return;
  }

  const channelId = Number(payload.ch);
  if (Number.isNaN(channelId)) {
    return;
  }

  switch (payload.op) {
    case SAFEZONE_OP.HEADERS:
      handleSafezoneHeaders(channelId, payload.payload);
      break;
    case SAFEZONE_OP.DATA:
      handleSafezoneData(channelId, payload.payload);
      break;
    case SAFEZONE_OP.END:
      finalizeSafezoneChannel(channelId);
      break;
    case SAFEZONE_OP.ERROR:
      handleSafezoneErrorFrame(channelId, payload.payload);
      break;
    case SAFEZONE_OP.PING:
      sendSafezoneFrame({ ch: channelId, op: SAFEZONE_OP.PONG, payload: payload.payload });
      break;
    default:
      break;
  }
}

function handleSafezoneSocketClose(event) {
  const reason = event?.reason || "safezone connection closed.";
  detachSafezoneSocket();
  safezoneConnectPromise = null;
  broadcastSafezoneState("disconnected", { reason });
  failAllPendingRequests(reason);
}

function handleSafezoneHeaders(channelId, payload = {}) {
  const entry = safezonePendingRequests.get(channelId);
  if (!entry) return;
  clearPendingEntryTimeout(entry);
  entry.responseMeta = {
    status: payload.status,
    headers: payload.headers,
    fromCache: Boolean(payload.fromCache),
    renderer: payload.renderer,
    requestId: payload.requestId,
  };
  entry.timeoutId = setTimeout(() => {
    safezonePendingRequests.delete(channelId);
    if (entry.reject) {
      entry.reject(buildSafezoneError({ message: "Safezone stalled.", status: 504 }));
    }
  }, SAFEZONE_REQUEST_TIMEOUT);

  if (entry.clientId) {
    notifyClient(entry.clientId, {
      type: "safezone-response",
      id: channelId,
      status: payload.status,
      headers: payload.headers,
      fromCache: Boolean(payload.fromCache),
      renderer: payload.renderer,
      requestId: payload.requestId,
    });
  }
}

function handleSafezoneData(channelId, payload = {}) {
  const entry = safezonePendingRequests.get(channelId);
  if (!entry) return;
  const chunk = payload.data || "";
  if (entry.clientId) {
    notifyClient(entry.clientId, {
      type: "safezone-body",
      id: channelId,
      data: chunk,
      final: false,
    });
  } else if (entry.resolve) {
    entry.responseChunks = entry.responseChunks || [];
    entry.responseChunks.push(chunk);
  }
}

function finalizeSafezoneChannel(channelId) {
  const entry = safezonePendingRequests.get(channelId);
  if (!entry) return;
  clearPendingEntryTimeout(entry);
  safezonePendingRequests.delete(channelId);
  if (entry.clientId) {
    notifyClient(entry.clientId, {
      type: "safezone-body",
      id: channelId,
      data: "",
      final: true,
    });
  } else if (entry.resolve) {
    const response = buildResponseFromEntry(entry);
    entry.resolve(response);
  }
}

function handleSafezoneErrorFrame(channelId, payload = {}) {
  const entry = safezonePendingRequests.get(channelId);
  if (entry) {
    clearPendingEntryTimeout(entry);
    safezonePendingRequests.delete(channelId);
    if (entry.clientId) {
      notifyClient(entry.clientId, {
        type: "safezone-error",
        id: channelId,
        status: payload.status,
        message: payload.message,
        details: payload.details,
      });
    }
    if (entry.reject) {
      entry.reject(buildSafezoneError(payload));
    }
  } else if (!channelId) {
    broadcastSafezoneState("error", { message: payload.message, details: payload.details });
  }
}

function parseSafezonePayload(data) {
  if (typeof data === "string") {
    return JSON.parse(data);
  }
  if (data instanceof ArrayBuffer) {
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(data));
  }
  return null;
}

function failAllPendingRequests(message, status = 503) {
  const entries = Array.from(safezonePendingRequests.entries());
  safezonePendingRequests.clear();
  entries.forEach(([id, meta]) => {
    clearPendingEntryTimeout(meta);
    if (meta.clientId) {
      notifyClient(meta.clientId, {
        type: "safezone-error",
        id,
        status,
        message,
      });
    }
    if (meta.reject) {
      meta.reject(new Error(message || "safezone disconnected."));
    }
  });
}

async function ensureSafezoneConnection() {
  if (safezoneSocket && safezoneSocket.readyState === WebSocket.OPEN) {
    return safezoneSocket;
  }
  if (safezoneConnectPromise) {
    return safezoneConnectPromise;
  }

  safezoneConnectPromise = new Promise((resolve, reject) => {
    const socket = new WebSocket(buildSafezoneUrl(), SAFEZONE_PROTOCOL);
    socket.binaryType = "arraybuffer";
    const timeoutId = setTimeout(() => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      safezoneConnectPromise = null;
      try {
        socket.close(1012, "connect-timeout");
      } catch {}
      reject(new Error("Safezone connection timed out."));
    }, SAFEZONE_CONNECT_TIMEOUT);

    const handleOpen = () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      clearTimeout(timeoutId);
      attachSafezoneSocket(socket);
      safezoneConnectPromise = null;
      broadcastSafezoneState("connected");
      resolve(socket);
    };

    const handleError = (event) => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      clearTimeout(timeoutId);
      safezoneConnectPromise = null;
      reject(event?.error || new Error("Failed to establish SuperSonic safezone."));
    };

    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
  });

  return safezoneConnectPromise;
}

function sendSafezoneFrame(frame) {
  if (safezoneSocket && safezoneSocket.readyState === WebSocket.OPEN) {
    safezoneSocket.send(JSON.stringify(frame));
    return;
  }
  ensureSafezoneConnection().then((socket) => socket.send(JSON.stringify(frame)));
}

function clearPendingEntryTimeout(entry) {
  if (entry?.timeoutId) {
    clearTimeout(entry.timeoutId);
    entry.timeoutId = null;
  }
}

function buildResponseFromEntry(entry) {
  const headers = new Headers();
  const headerList = entry.responseMeta?.headers || [];
  headerList.forEach(([key, value]) => headers.append(key, value));
  if (entry.responseMeta?.requestId) {
    headers.set(REQUEST_ID_HEADER, entry.responseMeta.requestId);
  }
  const status = entry.responseMeta?.status || 200;
  const bodyBuffer = mergeResponseChunks(entry.responseChunks || []);
  const body = bodyBuffer && bodyBuffer.length ? bodyBuffer : null;
  return new Response(body, {
    status,
    headers,
  });
}

function mergeResponseChunks(chunks) {
  if (!chunks || !chunks.length) {
    return new Uint8Array();
  }
  const decoded = chunks.map((chunk) => decodeBase64Chunk(chunk));
  const total = decoded.reduce((sum, buf) => sum + buf.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  decoded.forEach((buf) => {
    merged.set(buf, offset);
    offset += buf.length;
  });
  return merged;
}

function decodeBase64Chunk(chunk) {
  if (!chunk) return new Uint8Array();
  const binary = atob(chunk);
  const len = binary.length;
  const buffer = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer;
}

function buildSafezoneError(payload) {
  const message = payload?.message || "Safezone request failed.";
  const error = new Error(message);
  error.status = payload?.status;
  error.details = payload?.details;
  return error;
}






