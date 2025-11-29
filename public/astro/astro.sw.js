/**
 * ASTRO SERVICE WORKER (Client-side)
 * Minimal service worker that intercepts requests and proxies them
 */

const ASTRO_VERSION = '1.0.0';
const CACHE_NAME = `astro-v${ASTRO_VERSION}`;

// Config will be injected
let config = null;

self.addEventListener('install', (event) => {
    console.log('[ASTRO-SW] Installing v' + ASTRO_VERSION);
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[ASTRO-SW] Activating');
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            // Clean old caches
            caches.keys().then(keys => {
                return Promise.all(
                    keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
                );
            })
        ])
    );
});

self.addEventListener('message', (event) => {
    const { type, data } = event.data;
    
    switch (type) {
        case 'ASTRO_CONFIG':
            config = data;
            console.log('[ASTRO-SW] Config received:', config);
            break;
        case 'ASTRO_SET_COOKIE':
            // Store cookie for the proxied origin
            break;
    }
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Skip if no config
    if (!config) {
        return;
    }
    
    // Check if this is a proxied request
    if (!url.pathname.startsWith(config.prefix)) {
        return;
    }
    
    event.respondWith(handleProxiedRequest(event.request));
});

async function handleProxiedRequest(request) {
    const url = new URL(request.url);
    
    try {
        // Extract original URL
        const encodedUrl = url.pathname.slice(config.prefix.length);
        const originalUrl = decode(encodedUrl);
        
        if (!originalUrl) {
            throw new Error('Failed to decode URL');
        }
        
        // Check cache first
        if (request.method === 'GET') {
            const cached = await caches.match(request);
            if (cached) {
                return cached;
            }
        }
        
        // Make request through bare server
        const response = await fetchThroughBare(originalUrl, request);
        
        // Process and cache response
        const processed = await processResponse(response, originalUrl);
        
        if (request.method === 'GET' && processed.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, processed.clone());
        }
        
        return processed;
        
    } catch (error) {
        console.error('[ASTRO-SW] Error:', error);
        return new Response(errorPage(error.message), {
            status: 500,
            headers: { 'Content-Type': 'text/html' }
        });
    }
}

async function fetchThroughBare(url, request) {
    const bareUrl = `${self.location.origin}${config.bare}`;
    
    // Build headers
    const headers = {};
    for (const [key, value] of request.headers) {
        if (!['host', 'origin', 'referer'].includes(key.toLowerCase())) {
            headers[key] = value;
        }
    }
    
    // Set proper headers for the target
    const parsedUrl = new URL(url);
    headers['Host'] = parsedUrl.host;
    headers['Origin'] = parsedUrl.origin;
    headers['Referer'] = url;
    
    // Get body for non-GET requests
    let body = null;
    if (!['GET', 'HEAD'].includes(request.method)) {
        body = await request.arrayBuffer();
    }
    
    // Make bare request
    const bareResponse = await fetch(bareUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Bare-URL': url,
            'X-Bare-Method': request.method,
            'X-Bare-Headers': JSON.stringify(headers)
        },
        body: body ? new Blob([body]) : null
    });
    
    return bareResponse;
}

async function processResponse(response, originalUrl) {
    const contentType = response.headers.get('Content-Type') || '';
    
    // Only rewrite HTML, CSS, and JS
    if (!contentType.includes('html') && 
        !contentType.includes('css') && 
        !contentType.includes('javascript')) {
        return response;
    }
    
    // Read content
    let content = await response.text();
    
    // Rewrite based on content type
    if (contentType.includes('html')) {
        content = rewriteHtml(content, originalUrl);
    } else if (contentType.includes('css')) {
        content = rewriteCss(content, originalUrl);
    } else if (contentType.includes('javascript')) {
        content = rewriteJs(content, originalUrl);
    }
    
    // Build new headers
    const headers = new Headers();
    for (const [key, value] of response.headers) {
        // Skip security headers
        if (['content-security-policy', 'x-frame-options', 'x-content-type-options'].includes(key.toLowerCase())) {
            continue;
        }
        headers.set(key, value);
    }
    
    // Add CORS headers
    headers.set('Access-Control-Allow-Origin', '*');
    
    return new Response(content, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

function rewriteHtml(html, baseUrl) {
    // Inject Astro client
    const injection = `
<script data-astro="config">
    self.__astro = ${JSON.stringify(config)};
    self.__astro.baseUrl = "${baseUrl}";
</script>
<script data-astro="client" src="${config.scripts?.client || '/astro/astro.client.js'}"></script>
`;
    
    // Insert after <head>
    if (html.includes('<head>')) {
        html = html.replace('<head>', '<head>' + injection);
    } else if (html.includes('<head ')) {
        html = html.replace(/<head[^>]*>/, match => match + injection);
    } else {
        html = injection + html;
    }
    
    // Rewrite URLs
    html = html.replace(/(href|src|action|data|poster)=["']([^"']+)["']/gi, (match, attr, url) => {
        if (isSpecialUrl(url)) return match;
        if (url.startsWith(config.prefix)) return match;
        return `${attr}="${proxyUrl(url, baseUrl)}"`;
    });
    
    return html;
}

function rewriteCss(css, baseUrl) {
    return css.replace(/url\s*\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, quote, url) => {
        if (isSpecialUrl(url)) return match;
        return `url(${quote}${proxyUrl(url, baseUrl)}${quote})`;
    });
}

function rewriteJs(js, baseUrl) {
    // Minimal JS rewriting - most is done client-side
    return js;
}

function proxyUrl(url, baseUrl) {
    try {
        const resolved = new URL(url, baseUrl).href;
        const encoded = encode(resolved);
        return `${config.prefix}${encoded}`;
    } catch (e) {
        return url;
    }
}

function isSpecialUrl(url) {
    return ['data:', 'blob:', 'javascript:', 'about:', 'mailto:'].some(p => url.startsWith(p));
}

// Encoding/Decoding
function encode(str) {
    const codec = config?.codec || 'quantum';
    const key = config?.encodeKey || '';
    
    switch (codec) {
        case 'quantum':
            return quantumEncode(str, key);
        case 'xor':
            return xorEncode(str, key);
        case 'base64':
            return btoa(str);
        default:
            return str;
    }
}

function decode(str) {
    const codec = config?.codec || 'quantum';
    const key = config?.encodeKey || '';
    
    switch (codec) {
        case 'quantum':
            return quantumDecode(str, key);
        case 'xor':
            return xorDecode(str, key);
        case 'base64':
            return atob(str);
        default:
            return str;
    }
}

function quantumEncode(str, key) {
    let encoded = '';
    for (let i = 0; i < str.length; i++) {
        encoded += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return btoa(encoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '~');
}

function quantumDecode(str, key) {
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/').replace(/~/g, '=');
    let decoded = atob(b64);
    let original = '';
    for (let i = 0; i < decoded.length; i++) {
        original += String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return original;
}

function xorEncode(str, key) {
    let encoded = '';
    for (let i = 0; i < str.length; i++) {
        encoded += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return btoa(encoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function xorDecode(str, key) {
    while (str.length % 4) str += '=';
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    let decoded = atob(str);
    let original = '';
    for (let i = 0; i < decoded.length; i++) {
        original += String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return original;
}

function errorPage(message) {
    return `
<!DOCTYPE html>
<html>
<head>
    <title>Astro Error</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
            color: white;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
        }
        .container {
            text-align: center;
            padding: 40px;
            max-width: 500px;
        }
        .logo {
            font-size: 64px;
            margin-bottom: 20px;
        }
        h1 {
            color: #7c3aed;
            margin: 0 0 20px 0;
        }
        .error {
            background: rgba(124, 58, 237, 0.2);
            border: 1px solid #7c3aed;
            padding: 20px;
            border-radius: 8px;
            font-family: monospace;
            word-break: break-all;
        }
        button {
            background: #7c3aed;
            color: white;
            border: none;
            padding: 12px 32px;
            font-size: 16px;
            border-radius: 8px;
            cursor: pointer;
            margin-top: 24px;
        }
        button:hover {
            background: #6d28d9;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">🚀</div>
        <h1>Astro Proxy Error</h1>
        <p>Something went wrong while loading this page.</p>
        <div class="error">${message}</div>
        <button onclick="location.reload()">Retry</button>
    </div>
</body>
</html>
    `;
}
