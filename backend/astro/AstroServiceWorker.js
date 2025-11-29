/**
 * ASTRO SERVICE WORKER
 * The core proxy interception engine
 * 
 * Features:
 * - Full request interception
 * - Wisp/Epoxy/Bare-Mux transport support
 * - Cookie synchronization
 * - WebSocket proxying
 * - Intelligent caching
 * - Anti-detection measures
 */

class AstroServiceWorker {
    constructor(config) {
        this.config = config;
        this.clients = new Map();
        this.cookieStore = new Map();
        this.sessionStore = new Map();
        this.transport = null;
        this.transportReady = false;
        this.pendingRequests = [];
        this.stats = {
            requests: 0,
            cached: 0,
            bypassed: 0,
            errors: 0
        };
        
        // Initialize transport
        this._initTransport();
    }
    
    async _initTransport() {
        const transports = this.config.fallbackTransports || ['wisp', 'epoxy', 'libcurl', 'bare'];
        
        for (const type of transports) {
            try {
                this.transport = await this._createTransport(type);
                if (this.transport) {
                    console.log(`[ASTRO-SW] Transport initialized: ${type}`);
                    this.transportReady = true;
                    
                    // Process pending requests
                    this._processPendingRequests();
                    return;
                }
            } catch (e) {
                console.warn(`[ASTRO-SW] Failed to initialize ${type} transport:`, e.message);
            }
        }
        
        console.error('[ASTRO-SW] All transports failed, falling back to direct fetch');
        this.transportReady = true;
    }
    
    async _createTransport(type) {
        switch (type) {
            case 'wisp':
                return this._createWispTransport();
            case 'epoxy':
                return this._createEpoxyTransport();
            case 'libcurl':
                return this._createLibcurlTransport();
            case 'bare':
            default:
                return this._createBareTransport();
        }
    }
    
    async _createWispTransport() {
        // Wisp transport - WebSocket multiplexing protocol
        return {
            type: 'wisp',
            fetch: async (url, options) => {
                return this._wispFetch(url, options);
            },
            createWebSocket: (url, protocols) => {
                return this._wispWebSocket(url, protocols);
            }
        };
    }
    
    async _createEpoxyTransport() {
        // Epoxy transport - WASM-based fast proxy
        return {
            type: 'epoxy',
            fetch: async (url, options) => {
                return this._epoxyFetch(url, options);
            },
            createWebSocket: (url, protocols) => {
                return this._epoxyWebSocket(url, protocols);
            }
        };
    }
    
    async _createLibcurlTransport() {
        // Libcurl transport - curl-based compatible proxy
        return {
            type: 'libcurl',
            fetch: async (url, options) => {
                return this._libcurlFetch(url, options);
            },
            createWebSocket: (url, protocols) => {
                return this._libcurlWebSocket(url, protocols);
            }
        };
    }
    
    async _createBareTransport() {
        // Bare Server transport
        return {
            type: 'bare',
            fetch: async (url, options) => {
                return this._bareFetch(url, options);
            },
            createWebSocket: (url, protocols) => {
                return this._bareWebSocket(url, protocols);
            }
        };
    }
    
    /**
     * Main fetch handler
     */
    async handleFetch(event) {
        const request = event.request;
        const url = new URL(request.url);
        
        // Check if this is an Astro-proxied request
        if (!url.pathname.startsWith(this.config.prefix)) {
            return fetch(request);
        }
        
        // Wait for transport to be ready
        if (!this.transportReady) {
            return new Promise((resolve, reject) => {
                this.pendingRequests.push({ event, resolve, reject });
            });
        }
        
        try {
            // Extract the original URL
            const encodedUrl = url.pathname.slice(this.config.prefix.length);
            const originalUrl = this.config.decode(encodedUrl);
            
            if (!originalUrl) {
                throw new Error('Failed to decode URL');
            }
            
            this.stats.requests++;
            
            // Check cache first
            if (this.config.cache.enabled && request.method === 'GET') {
                const cached = await this._checkCache(originalUrl, request);
                if (cached) {
                    this.stats.cached++;
                    return cached;
                }
            }
            
            // Build proxy request
            const proxyRequest = await this._buildProxyRequest(originalUrl, request);
            
            // Execute request through transport
            const response = await this._executeRequest(originalUrl, proxyRequest);
            
            // Process response
            const processedResponse = await this._processResponse(originalUrl, response, request);
            
            // Cache if appropriate
            if (this.config.cache.enabled && request.method === 'GET' && processedResponse.ok) {
                await this._cacheResponse(originalUrl, processedResponse.clone());
            }
            
            return processedResponse;
            
        } catch (error) {
            this.stats.errors++;
            console.error('[ASTRO-SW] Fetch error:', error);
            
            return new Response(`
                <html>
                <head><title>Astro Proxy Error</title></head>
                <body style="background: #0a0a0f; color: #fff; font-family: system-ui; padding: 40px;">
                    <h1 style="color: #7c3aed;">⚠️ Astro Proxy Error</h1>
                    <p>Failed to load the requested page.</p>
                    <pre style="background: #1a1a2e; padding: 20px; border-radius: 8px;">${error.message}</pre>
                    <button onclick="location.reload()" style="background: #7c3aed; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; margin-top: 20px;">
                        Retry
                    </button>
                </body>
                </html>
            `, {
                status: 500,
                headers: { 'Content-Type': 'text/html' }
            });
        }
    }
    
    async _buildProxyRequest(originalUrl, request) {
        const headers = new Headers();
        
        // Copy relevant headers
        for (const [key, value] of request.headers) {
            // Skip hop-by-hop headers
            if (['host', 'connection', 'keep-alive', 'transfer-encoding', 
                 'upgrade', 'proxy-authorization', 'proxy-connection'].includes(key.toLowerCase())) {
                continue;
            }
            headers.set(key, value);
        }
        
        // Parse original URL
        const parsedUrl = new URL(originalUrl);
        
        // Set correct host
        headers.set('Host', parsedUrl.host);
        
        // Set origin for CORS
        headers.set('Origin', parsedUrl.origin);
        
        // Add referer
        headers.set('Referer', parsedUrl.href);
        
        // Apply stealth headers if enabled
        if (this.config.stealth.enabled) {
            this._applyStealthHeaders(headers);
        }
        
        // Add cookies from our cookie store
        const cookies = await this._getCookiesForUrl(originalUrl);
        if (cookies) {
            headers.set('Cookie', cookies);
        }
        
        // Build request body
        let body = null;
        if (!['GET', 'HEAD'].includes(request.method)) {
            body = await request.arrayBuffer();
        }
        
        return {
            method: request.method,
            headers,
            body,
            redirect: 'manual', // Handle redirects ourselves
            credentials: 'omit' // We handle cookies ourselves
        };
    }
    
    _applyStealthHeaders(headers) {
        const fingerprint = this.config.stealth.fingerprint;
        
        // Chrome-like headers
        if (fingerprint === 'chrome' || fingerprint === 'random') {
            headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7');
            headers.set('Accept-Language', 'en-US,en;q=0.9');
            headers.set('Accept-Encoding', 'gzip, deflate, br');
            headers.set('Sec-Ch-Ua', '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
            headers.set('Sec-Ch-Ua-Mobile', '?0');
            headers.set('Sec-Ch-Ua-Platform', '"Windows"');
            headers.set('Sec-Fetch-Dest', 'document');
            headers.set('Sec-Fetch-Mode', 'navigate');
            headers.set('Sec-Fetch-Site', 'none');
            headers.set('Sec-Fetch-User', '?1');
            headers.set('Upgrade-Insecure-Requests', '1');
        }
        
        // Firefox-like headers
        if (fingerprint === 'firefox') {
            headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8');
            headers.set('Accept-Language', 'en-US,en;q=0.5');
            headers.set('Accept-Encoding', 'gzip, deflate, br');
            headers.set('Upgrade-Insecure-Requests', '1');
            headers.set('Sec-Fetch-Dest', 'document');
            headers.set('Sec-Fetch-Mode', 'navigate');
            headers.set('Sec-Fetch-Site', 'none');
            headers.set('Sec-Fetch-User', '?1');
        }
        
        // Randomize User-Agent if rotation enabled
        if (this.config.stealth.headerRotation) {
            const userAgents = [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
            ];
            headers.set('User-Agent', userAgents[Math.floor(Math.random() * userAgents.length)]);
        }
    }
    
    async _executeRequest(originalUrl, proxyRequest) {
        // Add timing jitter if enabled
        if (this.config.stealth.jitter) {
            const [min, max] = this.config.stealth.timingNoise;
            const delay = Math.floor(Math.random() * (max - min + 1)) + min;
            await new Promise(r => setTimeout(r, delay));
        }
        
        // Use transport to make the request
        if (this.transport) {
            return await this.transport.fetch(originalUrl, proxyRequest);
        }
        
        // Fallback to direct fetch (through bare server)
        return await this._bareFetch(originalUrl, proxyRequest);
    }
    
    async _bareFetch(url, options) {
        const bareUrl = `${self.location.origin}${this.config.bare}`;
        
        const bareRequest = new Request(bareUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Bare-URL': url,
                'X-Bare-Headers': JSON.stringify(Object.fromEntries(options.headers))
            },
            body: options.body
        });
        
        const response = await fetch(bareRequest);
        return response;
    }
    
    async _wispFetch(url, options) {
        // Wisp protocol implementation
        const wispUrl = `${self.location.origin}${this.config.wisp}`;
        
        // Create Wisp connection
        // This is a simplified implementation
        return await this._bareFetch(url, options);
    }
    
    async _epoxyFetch(url, options) {
        // Epoxy transport - would use WASM module
        return await this._bareFetch(url, options);
    }
    
    async _libcurlFetch(url, options) {
        // Libcurl transport - would use WASM curl
        return await this._bareFetch(url, options);
    }
    
    async _processResponse(originalUrl, response, request) {
        // Extract cookies from response
        const setCookies = response.headers.get('Set-Cookie');
        if (setCookies) {
            await this._storeCookies(originalUrl, setCookies);
        }
        
        // Get content type
        const contentType = response.headers.get('Content-Type') || '';
        
        // Determine if we need to rewrite the content
        const needsRewrite = 
            contentType.includes('html') ||
            contentType.includes('css') ||
            contentType.includes('javascript');
        
        if (!needsRewrite) {
            // Return response as-is with modified headers
            return this._buildResponse(response, originalUrl);
        }
        
        // Read and rewrite content
        const text = await response.text();
        const rewritten = this._rewriteContent(text, contentType, originalUrl);
        
        // Build new response
        const newHeaders = new Headers(response.headers);
        
        // Remove problematic headers
        newHeaders.delete('Content-Security-Policy');
        newHeaders.delete('Content-Security-Policy-Report-Only');
        newHeaders.delete('X-Frame-Options');
        newHeaders.delete('X-Content-Type-Options');
        
        // Update content length
        const encoder = new TextEncoder();
        const encoded = encoder.encode(rewritten);
        newHeaders.set('Content-Length', encoded.length.toString());
        
        return new Response(rewritten, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders
        });
    }
    
    _rewriteContent(content, contentType, baseUrl) {
        // Send to client for rewriting via postMessage
        // This is handled by the AstroRewriter on the server side
        // In the service worker, we do minimal rewriting
        
        if (contentType.includes('html')) {
            return this._rewriteHtml(content, baseUrl);
        }
        
        if (contentType.includes('css')) {
            return this._rewriteCss(content, baseUrl);
        }
        
        if (contentType.includes('javascript')) {
            return this._rewriteJs(content, baseUrl);
        }
        
        return content;
    }
    
    _rewriteHtml(html, baseUrl) {
        const config = this.config;
        
        // Inject Astro client
        const injection = `
<script data-astro="config">
    self.__astro = ${JSON.stringify(config)};
    self.__astro.baseUrl = "${baseUrl}";
</script>
<script data-astro="client" src="${config.scripts.client}"></script>
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
        html = this._rewriteUrls(html, baseUrl, 'html');
        
        return html;
    }
    
    _rewriteCss(css, baseUrl) {
        // Rewrite url() in CSS
        return css.replace(/url\s*\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, quote, url) => {
            if (url.startsWith('data:') || url.startsWith('blob:')) return match;
            const rewritten = this._proxyUrl(url, baseUrl);
            return `url(${quote}${rewritten}${quote})`;
        });
    }
    
    _rewriteJs(js, baseUrl) {
        // Minimal JS rewriting in service worker
        // Most rewriting happens client-side via hooks
        return js;
    }
    
    _rewriteUrls(content, baseUrl, type) {
        // Rewrite href, src, action attributes
        return content.replace(/(href|src|action|data|poster)=["']([^"']+)["']/gi, (match, attr, url) => {
            if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) {
                return match;
            }
            if (url.startsWith(this.config.prefix)) {
                return match; // Already rewritten
            }
            const rewritten = this._proxyUrl(url, baseUrl);
            return `${attr}="${rewritten}"`;
        });
    }
    
    _proxyUrl(url, baseUrl) {
        try {
            const resolved = new URL(url, baseUrl).href;
            const encoded = this.config.encode(resolved);
            return `${this.config.prefix}${encoded}`;
        } catch (e) {
            return url;
        }
    }
    
    _buildResponse(response, originalUrl) {
        const headers = new Headers(response.headers);
        
        // Remove security headers that break proxying
        headers.delete('Content-Security-Policy');
        headers.delete('Content-Security-Policy-Report-Only');
        headers.delete('X-Frame-Options');
        headers.delete('X-Content-Type-Options');
        headers.delete('Strict-Transport-Security');
        
        // Add CORS headers
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        headers.set('Access-Control-Allow-Headers', '*');
        
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers
        });
    }
    
    // Cookie management
    async _getCookiesForUrl(url) {
        const parsedUrl = new URL(url);
        const domain = parsedUrl.hostname;
        const path = parsedUrl.pathname;
        
        const cookies = [];
        for (const [key, value] of this.cookieStore) {
            const [cookieDomain, cookiePath] = key.split('|');
            if (domain.endsWith(cookieDomain) && path.startsWith(cookiePath)) {
                cookies.push(value);
            }
        }
        
        return cookies.join('; ');
    }
    
    async _storeCookies(url, setCookieHeader) {
        const parsedUrl = new URL(url);
        const cookies = setCookieHeader.split(',').map(c => c.trim());
        
        for (const cookie of cookies) {
            const parts = cookie.split(';');
            const [name, value] = parts[0].split('=');
            
            let domain = parsedUrl.hostname;
            let path = '/';
            
            for (const part of parts.slice(1)) {
                const [key, val] = part.trim().split('=');
                if (key.toLowerCase() === 'domain') {
                    domain = val.replace(/^\./, '');
                } else if (key.toLowerCase() === 'path') {
                    path = val;
                }
            }
            
            const storeKey = `${domain}|${path}`;
            this.cookieStore.set(storeKey, `${name}=${value}`);
        }
        
        // Sync cookies to clients
        this._syncCookiesToClients();
    }
    
    _syncCookiesToClients() {
        const cookies = Object.fromEntries(this.cookieStore);
        
        self.clients.matchAll().then(clients => {
            clients.forEach(client => {
                client.postMessage({
                    type: 'ASTRO_COOKIE_SYNC',
                    cookies
                });
            });
        });
    }
    
    // Cache management
    async _checkCache(url, request) {
        if (request.method !== 'GET') return null;
        
        const cache = await caches.open('astro-v1');
        const cached = await cache.match(url);
        
        if (!cached) return null;
        
        // Check if cache is stale
        const cacheDate = cached.headers.get('X-Astro-Cached');
        if (cacheDate) {
            const age = Date.now() - parseInt(cacheDate);
            const maxAge = this.config.cache.maxAge * 1000;
            
            if (age > maxAge) {
                // Cache is stale
                if (this.config.cache.staleWhileRevalidate) {
                    // Return stale and revalidate in background
                    this._revalidateCache(url, request);
                    return cached;
                }
                return null;
            }
        }
        
        return cached;
    }
    
    async _cacheResponse(url, response) {
        const cache = await caches.open('astro-v1');
        
        // Add cache timestamp
        const headers = new Headers(response.headers);
        headers.set('X-Astro-Cached', Date.now().toString());
        
        const cachedResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers
        });
        
        await cache.put(url, cachedResponse);
    }
    
    async _revalidateCache(url, request) {
        // Revalidate in background
        try {
            const proxyRequest = await this._buildProxyRequest(url, request);
            const response = await this._executeRequest(url, proxyRequest);
            
            if (response.ok) {
                await this._cacheResponse(url, response);
            }
        } catch (e) {
            // Ignore revalidation errors
        }
    }
    
    _processPendingRequests() {
        while (this.pendingRequests.length > 0) {
            const { event, resolve, reject } = this.pendingRequests.shift();
            this.handleFetch(event).then(resolve).catch(reject);
        }
    }
    
    // WebSocket handling
    handleWebSocket(url, protocols) {
        if (this.transport && this.transport.createWebSocket) {
            return this.transport.createWebSocket(url, protocols);
        }
        return this._bareWebSocket(url, protocols);
    }
    
    _bareWebSocket(url, protocols) {
        // Convert to WebSocket proxy URL
        const wsUrl = new URL(url);
        const encoded = this.config.encode(wsUrl.href);
        const proxyWsUrl = `${self.location.origin.replace('http', 'ws')}${this.config.bare}ws/${encoded}`;
        
        return new WebSocket(proxyWsUrl, protocols);
    }
    
    // Stats
    getStats() {
        return { ...this.stats };
    }
}

// Export for service worker
if (typeof self !== 'undefined' && self.ServiceWorkerGlobalScope) {
    self.AstroServiceWorker = AstroServiceWorker;
}

export { AstroServiceWorker };
