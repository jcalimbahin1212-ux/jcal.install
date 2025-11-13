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

app.all("/powerthrough", async (req, res) => {
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

  try {
    const upstream = await fetch(targetUrl.href, buildFetchOptions(req, targetUrl));
    const contentType = upstream.headers.get("content-type") || "";

    res.status(upstream.status);
    copyResponseHeaders(upstream.headers, res);

    if (contentType.includes("text/html")) {
      const html = await upstream.text();
      const rewritten = rewriteHtmlDocument(html, targetUrl);
      res.set("content-type", "text/html; charset=utf-8");
      res.set("x-frame-options", "ALLOWALL");
      return res.send(rewritten);
    }

    if (contentType.includes("text/css")) {
      const css = await upstream.text();
      const rewritten = rewriteCssUrls(css, targetUrl);
      res.set("content-type", contentType);
      return res.send(rewritten);
    }

    if (upstream.body) {
      return Readable.fromWeb(upstream.body).pipe(res);
    }

    return res.end();
  } catch (error) {
    console.error("[powerthrough] proxy error", error);
    if (!res.headersSent) {
      res.status(502).json({ error: "Failed to reach target upstream.", details: error.message });
    } else {
      res.end();
    }
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
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
