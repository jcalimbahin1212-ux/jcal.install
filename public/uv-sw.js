/**
 * UV-Style Service Worker
 * 
 * This service worker intercepts ALL requests from the proxied page
 * and routes them through our bare server. This is how Holy Unblocker
 * and similar services work.
 * 
 * Key concepts:
 * 1. All URLs are encoded (base64, xor, etc.) to hide the real destination
 * 2. Requests go to /bare/ which proxies them through our server
 * 3. Responses are rewritten to update all links to go through the proxy
 */

const SW_VERSION = '1.0.0';

// Configuration - this should match server-side config
const config = {
    prefix: '/uv/service/',
    bare: '/bare/',
    encodeUrl: (url) => {
        // XOR encoding with key
        const key = 2;
        return btoa(
            url.split('').map((char, i) => 
                String.fromCharCode(char.charCodeAt(0) ^ key)
            ).join('')
        );
    },
    decodeUrl: (encoded) => {
        const key = 2;
        try {
            const decoded = atob(encoded);
            return decoded.split('').map((char, i) => 
                String.fromCharCode(char.charCodeAt(0) ^ key)
            ).join('');
        } catch {
            return encoded;
        }
    }
};

// URL rewriting utilities
const urlUtils = {
    /**
     * Check if URL needs to be proxied
     */
    needsProxy(url) {
        if (!url) return false;
        if (url.startsWith('data:')) return false;
        if (url.startsWith('blob:')) return false;
        if (url.startsWith('javascript:')) return false;
        if (url.startsWith('#')) return false;
        if (url.startsWith(self.location.origin + config.prefix)) return false;
        if (url.startsWith(self.location.origin + config.bare)) return false;
        return true;
    },
    
    /**
     * Build proxied URL
     */
    buildProxyUrl(targetUrl, baseUrl) {
        try {
            const resolved = new URL(targetUrl, baseUrl);
            const encoded = config.encodeUrl(resolved.href);
            return self.location.origin + config.prefix + encoded;
        } catch {
            return targetUrl;
        }
    },
    
    /**
     * Extract original URL from proxied URL
     */
    getOriginalUrl(proxyUrl) {
        if (!proxyUrl.startsWith(self.location.origin + config.prefix)) {
            return proxyUrl;
        }
        const encoded = proxyUrl.slice((self.location.origin + config.prefix).length);
        return config.decodeUrl(encoded);
    }
};

// Response rewriter
const rewriter = {
    /**
     * Rewrite HTML content
     */
    rewriteHtml(html, baseUrl) {
        // Inject our client script at the start
        const clientScript = `
<script>
(function() {
    'use strict';
    
    // Store original URL for reference
    const __originalUrl = new URL('${baseUrl}');
    const __proxyPrefix = '${config.prefix}';
    
    // Encode URL function
    function encodeProxyUrl(url) {
        if (!url) return url;
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#')) {
            return url;
        }
        try {
            const resolved = new URL(url, __originalUrl);
            const key = 2;
            const encoded = btoa(
                resolved.href.split('').map((char, i) => 
                    String.fromCharCode(char.charCodeAt(0) ^ key)
                ).join('')
            );
            return location.origin + __proxyPrefix + encoded;
        } catch {
            return url;
        }
    }
    
    // Override fetch
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') {
            input = encodeProxyUrl(input);
        } else if (input instanceof Request) {
            input = new Request(encodeProxyUrl(input.url), input);
        }
        return originalFetch.call(this, input, init);
    };
    
    // Override XMLHttpRequest
    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        url = encodeProxyUrl(url);
        return originalXHROpen.call(this, method, url, ...args);
    };
    
    // Override window.open
    const originalWindowOpen = window.open;
    window.open = function(url, ...args) {
        url = encodeProxyUrl(url);
        return originalWindowOpen.call(this, url, ...args);
    };
    
    // Override location
    const locationProxy = new Proxy({}, {
        get(target, prop) {
            if (prop === 'href') return __originalUrl.href;
            if (prop === 'origin') return __originalUrl.origin;
            if (prop === 'host') return __originalUrl.host;
            if (prop === 'hostname') return __originalUrl.hostname;
            if (prop === 'pathname') return __originalUrl.pathname;
            if (prop === 'protocol') return __originalUrl.protocol;
            if (prop === 'port') return __originalUrl.port;
            if (prop === 'search') return __originalUrl.search;
            if (prop === 'hash') return __originalUrl.hash;
            if (prop === 'assign') return (url) => window.location.assign(encodeProxyUrl(url));
            if (prop === 'replace') return (url) => window.location.replace(encodeProxyUrl(url));
            if (prop === 'reload') return () => window.location.reload();
            if (prop === 'toString') return () => __originalUrl.href;
            return window.location[prop];
        },
        set(target, prop, value) {
            if (prop === 'href') {
                window.location.href = encodeProxyUrl(value);
                return true;
            }
            window.location[prop] = value;
            return true;
        }
    });
    
    // Try to override document.location (may fail due to security)
    try {
        Object.defineProperty(document, 'location', {
            get: () => locationProxy,
            configurable: true
        });
    } catch {}
    
    // Override document.domain
    try {
        Object.defineProperty(document, 'domain', {
            get: () => __originalUrl.hostname,
            set: () => {},
            configurable: true
        });
    } catch {}
    
    // Override document.URL
    try {
        Object.defineProperty(document, 'URL', {
            get: () => __originalUrl.href,
            configurable: true
        });
    } catch {}
    
    // Override document.referrer
    try {
        Object.defineProperty(document, 'referrer', {
            get: () => '',
            configurable: true
        });
    } catch {}
    
    // Block visibility events (anti-detection)
    Object.defineProperty(document, 'hidden', { get: () => false });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
    
    // Disable WebRTC (prevents IP leak)
    if (window.RTCPeerConnection) {
        window.RTCPeerConnection = function() {
            throw new Error('WebRTC disabled');
        };
    }
    
    console.log('[Proxy] Client hooks installed for', __originalUrl.href);
})();
</script>`;
        
        // Inject at start of head or body
        if (html.includes('<head>')) {
            html = html.replace('<head>', '<head>' + clientScript);
        } else if (html.includes('<HEAD>')) {
            html = html.replace('<HEAD>', '<HEAD>' + clientScript);
        } else if (html.includes('<body>')) {
            html = html.replace('<body>', '<body>' + clientScript);
        } else if (html.includes('<html>')) {
            html = html.replace('<html>', '<html>' + clientScript);
        }
        
        // Rewrite common URL attributes
        const urlAttrs = [
            'href', 'src', 'action', 'data-src', 'data-href',
            'poster', 'srcset', 'data'
        ];
        
        for (const attr of urlAttrs) {
            // Match attribute values
            const regex = new RegExp(`(${attr}\\s*=\\s*["'])([^"']+)(["'])`, 'gi');
            html = html.replace(regex, (match, prefix, url, suffix) => {
                if (url.startsWith('data:') || url.startsWith('#') || 
                    url.startsWith('javascript:') || url.startsWith('blob:')) {
                    return match;
                }
                const proxiedUrl = urlUtils.buildProxyUrl(url, baseUrl);
                return prefix + proxiedUrl + suffix;
            });
        }
        
        // Rewrite inline CSS url()
        html = html.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, url) => {
            if (url.startsWith('data:') || url.startsWith('#')) {
                return match;
            }
            const proxiedUrl = urlUtils.buildProxyUrl(url, baseUrl);
            return `url('${proxiedUrl}')`;
        });
        
        return html;
    },
    
    /**
     * Rewrite CSS content
     */
    rewriteCss(css, baseUrl) {
        // Rewrite url() references
        return css.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, url) => {
            if (url.startsWith('data:') || url.startsWith('#')) {
                return match;
            }
            const proxiedUrl = urlUtils.buildProxyUrl(url, baseUrl);
            return `url('${proxiedUrl}')`;
        });
    },
    
    /**
     * Rewrite JavaScript content
     */
    rewriteJs(js, baseUrl) {
        // This is complex and error-prone, so we rely on runtime hooks instead
        // Just wrap in a scope that provides our overrides
        return js;
    }
};

// Service Worker event handlers
self.addEventListener('install', (event) => {
    console.log('[UV-SW] Installing version', SW_VERSION);
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[UV-SW] Activating');
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Only handle requests to our service prefix
    if (!url.pathname.startsWith(config.prefix)) {
        return; // Let the request pass through normally
    }
    
    event.respondWith(handleFetch(event.request));
});

async function handleFetch(request) {
    const url = new URL(request.url);
    const encodedPath = url.pathname.slice(config.prefix.length);
    
    if (!encodedPath) {
        return new Response('Invalid proxy request', { status: 400 });
    }
    
    // Decode the original URL
    let targetUrl;
    try {
        targetUrl = config.decodeUrl(encodedPath);
        new URL(targetUrl); // Validate
    } catch {
        return new Response('Invalid encoded URL', { status: 400 });
    }
    
    console.log('[UV-SW] Proxying:', targetUrl);
    
    try {
        // Build headers for bare server request
        const bareHeaders = {};
        
        // Copy safe headers from original request
        for (const [key, value] of request.headers.entries()) {
            const lowerKey = key.toLowerCase();
            if (!lowerKey.startsWith('x-bare-') && 
                lowerKey !== 'host' && 
                lowerKey !== 'origin') {
                bareHeaders[key] = value;
            }
        }
        
        // Make request through bare server
        const bareUrl = self.location.origin + config.bare + 'v3/';
        const response = await fetch(bareUrl, {
            method: request.method,
            headers: {
                'x-bare-url': targetUrl,
                'x-bare-headers': JSON.stringify(bareHeaders),
                'Content-Type': request.headers.get('content-type') || 'text/plain'
            },
            body: request.method !== 'GET' && request.method !== 'HEAD' 
                ? await request.blob() 
                : undefined
        });
        
        // Get bare response metadata
        const bareStatus = parseInt(response.headers.get('x-bare-status') || '200');
        const bareStatusText = response.headers.get('x-bare-status-text') || '';
        
        let bareResponseHeaders = {};
        try {
            bareResponseHeaders = JSON.parse(response.headers.get('x-bare-headers') || '{}');
        } catch {}
        
        // Get content type
        const contentType = bareResponseHeaders['content-type'] || 
                           response.headers.get('content-type') || '';
        
        // Get response body
        let body = await response.arrayBuffer();
        
        // Rewrite content based on type
        if (contentType.includes('text/html')) {
            const text = new TextDecoder().decode(body);
            const rewritten = rewriter.rewriteHtml(text, targetUrl);
            body = new TextEncoder().encode(rewritten);
        } else if (contentType.includes('text/css')) {
            const text = new TextDecoder().decode(body);
            const rewritten = rewriter.rewriteCss(text, targetUrl);
            body = new TextEncoder().encode(rewritten);
        }
        
        // Build response headers
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(bareResponseHeaders)) {
            try {
                // Skip problematic headers
                if (key.toLowerCase() === 'content-encoding') continue;
                if (key.toLowerCase() === 'content-length') continue;
                if (key.toLowerCase() === 'transfer-encoding') continue;
                responseHeaders.set(key, value);
            } catch {}
        }
        
        // Always allow everything
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('X-Frame-Options', 'ALLOWALL');
        
        return new Response(body, {
            status: bareStatus,
            statusText: bareStatusText,
            headers: responseHeaders
        });
        
    } catch (error) {
        console.error('[UV-SW] Fetch error:', error);
        return new Response(`Proxy error: ${error.message}`, {
            status: 500,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}

// Message handler for communication with client
self.addEventListener('message', (event) => {
    if (event.data.type === 'ping') {
        event.ports[0].postMessage({ type: 'pong', version: SW_VERSION });
    }
});

console.log('[UV-SW] Loaded version', SW_VERSION);
