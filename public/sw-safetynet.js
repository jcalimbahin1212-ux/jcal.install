const SHELL_CACHE = "safetynet-shell-v1";
const SHELL_ASSETS = ["/", "/index.html", "/style.css", "/app.js", "/assets/logo.svg"];

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
            if (key !== SHELL_CACHE) {
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
  return fetch(proxyUrl.toString(), { credentials: "same-origin" });
}
