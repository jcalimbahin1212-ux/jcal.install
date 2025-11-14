const SHELL_VERSION = "v2";
const SHELL_CACHE = `safetynet-shell-${SHELL_VERSION}`;
const DATA_CACHE = `safetynet-data-${SHELL_VERSION}`;
const SHELL_ASSETS = ["/", "/index.html", "/style.css", "/app.js", "/assets/logo.svg", "/sw-safetynet.js"];
const CLIENT_CHANNEL = "safetynet-client";
const SW_CHANNEL = "safetynet-sw";
const TUNNEL_ENDPOINT = "/tunnel";
const TUNNEL_PROTOCOL = "safetynet.v1";
const TUNNEL_MAX_REPLAY_BUFFER = 32;
const ENABLE_TUNNEL_TRANSPORT = true;

let tunnelSocket = null;
let tunnelConnectPromise = null;
let tunnelCleanup = null;
const tunnelPendingRequests = new Map();
const tunnelReplayBuffer = [];

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
    event.respondWith(proxyThroughSafetyNet(url));
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
    case "tunnel-open":
      ensureTunnelConnection().catch((error) => {
        notifyClient(clientId, {
          type: "tunnel-error",
          message: error.message || "Failed to open SafetyNet tunnel.",
        });
      });
      break;
    case "tunnel-request":
      handleTunnelRequest(clientId, data).catch((error) => {
        notifyClient(clientId, {
          type: "tunnel-error",
          id: data?.id,
          message: error.message || "Unable to dispatch tunnel request.",
        });
      });
      break;
    case "tunnel-cancel":
      cancelTunnelRequest(clientId, data);
      break;
    case "tunnel-replay":
      replayTunnelEventsToClient(clientId);
      break;
    default:
      break;
  }
});

function shouldProxy(url) {
  return url.origin === self.location.origin && url.pathname.startsWith("/proxy/");
}

function shouldCache(request, url) {
  if (url.pathname.startsWith("/powerthrough")) return false;
  if (url.pathname.startsWith("/proxy/")) return false;
  if (url.pathname.startsWith("/sw-safetynet.js")) return false;
  if (request.destination === "document") return true;
  return ["style", "script", "image", ""].includes(request.destination);
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  cache.put(request, response.clone());
  return response;
}

function proxyThroughSafetyNet(url) {
  const encodedTarget = url.pathname.replace(/^\/proxy\//, "");
  const decodedTarget = decodeURIComponent(encodedTarget);
  const proxyUrl = new URL("/powerthrough", self.location.origin);
  proxyUrl.searchParams.set("url", decodedTarget);
  url.searchParams.forEach((value, key) => {
    if (key !== "url") {
      proxyUrl.searchParams.set(key, value);
    }
  });

  const renderHint = url.searchParams.get("render") || undefined;
  if (ENABLE_TUNNEL_TRANSPORT) {
    return performTunnelProxy(decodedTarget, renderHint).catch((error) => {
      sendTelemetry("tunnel-fetch-error", { target: decodedTarget, message: error.message });
      return fetch(proxyUrl.toString(), { credentials: "same-origin" }).catch((fetchError) => {
        sendTelemetry("proxy-fetch-error", { target: decodedTarget, message: fetchError.message });
        return new Response(JSON.stringify({ error: "Proxy request failed.", details: fetchError.message }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      });
    });
  }

  return fetch(proxyUrl.toString(), { credentials: "same-origin" }).catch((error) => {
    sendTelemetry("proxy-fetch-error", { target: decodedTarget, message: error.message });
    return new Response(JSON.stringify({ error: "Proxy request failed.", details: error.message }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
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

function performTunnelProxy(targetUrl, renderHint) {
  return new Promise((resolve, reject) => {
    const requestId = generateTunnelRequestId("sw");
    const entry = createPendingEntry({
      resolve,
      reject,
      expectBody: true,
      responseChunks: [],
    });
    tunnelPendingRequests.set(requestId, entry);

    ensureTunnelConnection()
      .then(() => {
        const envelope = {
          type: "request",
          id: requestId,
          url: targetUrl,
          method: "GET",
          headers: {},
        };
        if (renderHint) {
          envelope.renderHint = renderHint;
        }
        return sendTunnelEnvelope(envelope);
      })
      .catch((error) => {
        tunnelPendingRequests.delete(requestId);
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

async function handleTunnelRequest(clientId, message) {
  const request = message?.request || {};
  const requestId = request.id || message.id;
  const targetUrl = request.url;
  if (!requestId || typeof requestId !== "string") {
    throw new Error("Tunnel request id is required.");
  }
  if (!targetUrl || typeof targetUrl !== "string") {
    throw new Error("Tunnel request requires a target url.");
  }

  const sanitizedHeaders = sanitizeHeaderBag(request.headers);
  const envelope = {
    type: "request",
    id: requestId,
    url: targetUrl,
    method: request.method || "GET",
    headers: sanitizedHeaders,
    renderHint: request.renderHint,
  };

  if (request.body !== undefined && request.body !== null) {
    envelope.body = request.body;
    envelope.bodyEncoding = request.bodyEncoding || "base64";
  }

  const ws = await ensureTunnelConnection();
  tunnelPendingRequests.set(
    requestId,
    createPendingEntry({
      clientId,
    })
  );
  try {
    ws.send(JSON.stringify(envelope));
  } catch (error) {
    tunnelPendingRequests.delete(requestId);
    throw error;
  }
}

function cancelTunnelRequest(_clientId, message) {
  const requestId = message?.id;
  if (!requestId) return;
  tunnelPendingRequests.delete(requestId);
  sendTunnelEnvelope({ type: "cancel", id: requestId }).catch(() => {});
}

function replayTunnelEventsToClient(clientId) {
  for (const event of tunnelReplayBuffer) {
    notifyClient(clientId, { type: "tunnel-event", event });
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

function recordTunnelEvent(event) {
  tunnelReplayBuffer.push(event);
  if (tunnelReplayBuffer.length > TUNNEL_MAX_REPLAY_BUFFER) {
    tunnelReplayBuffer.shift();
  }
}

function broadcastTunnelState(state, info) {
  recordTunnelEvent({ kind: "state", state, info, at: Date.now() });
  clients.matchAll({ includeUncontrolled: true, type: "window" }).then((windows) => {
    windows.forEach((client) => {
      client.postMessage({
        source: SW_CHANNEL,
        type: "tunnel-state",
        state,
        info,
      });
    });
  });
}

function buildTunnelUrl() {
  const protocol = self.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${self.location.host}${TUNNEL_ENDPOINT}`;
}

function generateTunnelRequestId(prefix = "client") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

function createPendingEntry(meta = {}) {
  return {
    startedAt: Date.now(),
    responseChunks: [],
    ...meta,
  };
}

function detachTunnelSocket() {
  if (tunnelCleanup) {
    try {
      tunnelCleanup();
    } catch (error) {
      console.warn("[safetynet-sw] tunnel cleanup failed", error);
    }
    tunnelCleanup = null;
  }
  tunnelSocket = null;
}

function attachTunnelSocket(ws) {
  detachTunnelSocket();
  tunnelSocket = ws;
  const onMessage = (event) => handleTunnelSocketMessage(event);
  const onClose = (event) => handleTunnelSocketClose(event);
  const onError = (event) => {
    console.warn("[safetynet-sw] tunnel error", event?.message || event);
  };

  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", onClose);
  ws.addEventListener("error", onError);

  tunnelCleanup = () => {
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

function handleTunnelSocketMessage(event) {
  let payload;
  try {
    payload = parseTunnelPayload(event.data);
  } catch (error) {
    console.warn("[safetynet-sw] tunnel payload parse failed", error);
    return;
  }

  if (!payload || typeof payload !== "object") {
    return;
  }

  switch (payload.type) {
    case "response":
      handleTunnelResponse(payload);
      break;
    case "body":
      handleTunnelBody(payload);
      break;
    case "error":
      handleTunnelError(payload);
      break;
    default:
      break;
  }
}

function handleTunnelSocketClose(event) {
  const reason = event?.reason || "Tunnel connection closed.";
  detachTunnelSocket();
  tunnelConnectPromise = null;
  broadcastTunnelState("disconnected", { reason });
  failAllPendingRequests(reason);
}

function handleTunnelResponse(payload) {
  const entry = payload?.id ? tunnelPendingRequests.get(payload.id) : null;
  if (!entry) {
    return;
  }
  entry.responseMeta = {
    status: payload.status,
    headers: payload.headers,
    fromCache: Boolean(payload.fromCache),
    renderer: payload.renderer,
  };
  notifyClient(entry.clientId, {
    type: "tunnel-response",
    id: payload.id,
    status: payload.status,
    headers: payload.headers,
    fromCache: Boolean(payload.fromCache),
    renderer: payload.renderer,
  });
}

function handleTunnelBody(payload) {
  const entry = payload?.id ? tunnelPendingRequests.get(payload.id) : null;
  if (!entry) {
    return;
  }
  notifyClient(entry.clientId, {
    type: "tunnel-body",
    id: payload.id,
    data: payload.data,
    final: Boolean(payload.final),
  });

  if (entry.resolve) {
    if (payload.data) {
      entry.responseChunks = entry.responseChunks || [];
      entry.responseChunks.push(payload.data);
    }
    if (payload.final) {
      const response = buildResponseFromEntry(entry);
      tunnelPendingRequests.delete(payload.id);
      entry.resolve(response);
      return;
    }
  }

  if (payload.final) {
    tunnelPendingRequests.delete(payload.id);
  }
}

function handleTunnelError(payload) {
  const entry = payload?.id ? tunnelPendingRequests.get(payload.id) : null;
  if (entry) {
    tunnelPendingRequests.delete(payload.id);
    notifyClient(entry.clientId, {
      type: "tunnel-error",
      id: payload.id,
      status: payload.status,
      message: payload.message,
      details: payload.details,
    });
    if (entry.reject) {
      entry.reject(buildTunnelError(payload));
    }
  } else if (!payload.id) {
    broadcastTunnelState("error", { message: payload.message, details: payload.details });
  }
}

function parseTunnelPayload(data) {
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
  const entries = Array.from(tunnelPendingRequests.entries());
  tunnelPendingRequests.clear();
  entries.forEach(([id, meta]) => {
    notifyClient(meta.clientId, {
      type: "tunnel-error",
      id,
      status,
      message,
    });
    if (meta.reject) {
      meta.reject(new Error(message || "Tunnel disconnected."));
    }
  });
}

async function ensureTunnelConnection() {
  if (tunnelSocket && tunnelSocket.readyState === WebSocket.OPEN) {
    return tunnelSocket;
  }
  if (tunnelConnectPromise) {
    return tunnelConnectPromise;
  }

  tunnelConnectPromise = new Promise((resolve, reject) => {
    const socket = new WebSocket(buildTunnelUrl(), TUNNEL_PROTOCOL);
    socket.binaryType = "arraybuffer";

    const handleOpen = () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      attachTunnelSocket(socket);
      tunnelConnectPromise = null;
      broadcastTunnelState("connected");
      resolve(socket);
    };

    const handleError = (event) => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      tunnelConnectPromise = null;
      reject(event?.error || new Error("Failed to establish SafetyNet tunnel."));
    };

    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
  });

  return tunnelConnectPromise;
}

function sendTunnelEnvelope(envelope) {
  if (tunnelSocket && tunnelSocket.readyState === WebSocket.OPEN) {
    tunnelSocket.send(JSON.stringify(envelope));
    return Promise.resolve();
  }
  return ensureTunnelConnection().then((socket) => socket.send(JSON.stringify(envelope)));
}

function buildResponseFromEntry(entry) {
  const headers = new Headers();
  const headerList = entry.responseMeta?.headers || [];
  headerList.forEach(([key, value]) => headers.append(key, value));
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

function buildTunnelError(payload) {
  const message = payload?.message || "Tunnel request failed.";
  const error = new Error(message);
  error.status = payload?.status;
  error.details = payload?.details;
  return error;
}
