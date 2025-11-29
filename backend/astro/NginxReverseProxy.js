/**
 * NGINX-STYLE REVERSE PROXY
 * 
 * Implements a Node.js reverse proxy that mimics Nginx Proxy Manager's behavior.
 * Key features:
 * - Full header rewriting to match NPM's proxy_pass behavior
 * - WebSocket upgrade support (allow_websocket_upgrade)
 * - Request/Response header manipulation
 * - No trace of proxy in traffic (stealth mode)
 * - Block exploits patterns
 * - Caching support
 * 
 * Based on analysis of Nginx Proxy Manager's template system
 */

import http from 'http';
import https from 'https';
import tls from 'tls';
import { URL } from 'url';
import net from 'net';
import crypto from 'crypto';
import { EventEmitter } from 'events';

// Blocked exploit patterns (from NPM's block_exploits)
const EXPLOIT_PATTERNS = [
    /\.\.\/|\.\.%2f/i,
    /\<script\>/i,
    /\/etc\/passwd/i,
    /\/proc\/self/i,
    /php:\/\//i,
    /data:text\/html/i,
    /javascript:/i,
    /vbscript:/i,
    /onload\s*=/i,
    /onerror\s*=/i,
    /eval\s*\(/i,
    /document\.cookie/i,
];

// Headers that reveal proxy nature - must be removed
const PROXY_REVEAL_HEADERS = [
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-forwarded-host',
    'x-real-ip',
    'via',
    'forwarded',
    'x-proxy-id',
    'x-proxy-connection',
];

// Headers to copy from original request
const PASS_THROUGH_REQUEST_HEADERS = [
    'accept',
    'accept-language',
    'accept-encoding',
    'cache-control',
    'content-type',
    'content-length',
    'cookie',
    'if-modified-since',
    'if-none-match',
    'range',
    'referer',
    'origin',
];

// Headers to strip from response (security headers that might break proxy)
const STRIP_RESPONSE_HEADERS = [
    'content-security-policy',
    'content-security-policy-report-only',
    'x-frame-options',
    'x-content-type-options',
    'strict-transport-security',
    'x-xss-protection',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
    'cross-origin-resource-policy',
    'permissions-policy',
    'feature-policy',
];

class NginxReverseProxy extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            // Forward settings (like NPM's forward_scheme, forward_host, forward_port)
            forwardScheme: options.forwardScheme || 'https',
            forwardHost: null, // Dynamic per request
            forwardPort: null, // Dynamic per request
            
            // SSL settings
            sslForced: options.sslForced || false,
            http2Support: options.http2Support || false,
            hstsEnabled: options.hstsEnabled || false,
            hstsSubdomains: options.hstsSubdomains || false,
            
            // Features
            allowWebsocketUpgrade: options.allowWebsocketUpgrade !== false,
            cachingEnabled: options.cachingEnabled || false,
            blockExploits: options.blockExploits !== false,
            
            // Proxy settings
            preserveHost: options.preserveHost || false,
            timeout: options.timeout || 30000,
            
            // Stealth mode (our addition)
            stealthMode: options.stealthMode !== false,
            
            // User Agent spoofing
            userAgent: options.userAgent || this._getRandomUserAgent(),
            
            // Encoding settings
            prefix: options.prefix || '/astro/~/~/',
            encodeKey: options.encodeKey || 'NPMStealthProxy2024!@#$',
        };
        
        // Cache
        this.cache = new Map();
        this.maxCacheEntries = 1000;
        
        // Stats
        this.stats = {
            requests: 0,
            blocked: 0,
            cached: 0,
            errors: 0,
            websockets: 0,
        };
        
        // Connection pool (like nginx keepalive)
        this.agents = {
            http: new http.Agent({ 
                keepAlive: true, 
                maxSockets: 256,
                maxFreeSockets: 64,
                timeout: 60000 
            }),
            https: new https.Agent({ 
                keepAlive: true, 
                maxSockets: 256,
                maxFreeSockets: 64,
                timeout: 60000,
                rejectUnauthorized: false 
            })
        };
    }
    
    /**
     * Get a random realistic user agent
     */
    _getRandomUserAgent() {
        const agents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
        ];
        return agents[Math.floor(Math.random() * agents.length)];
    }
    
    /**
     * Encode URL for proxy (stealth encoding)
     */
    encode(url) {
        const key = this.config.encodeKey;
        let encoded = '';
        for (let i = 0; i < url.length; i++) {
            encoded += String.fromCharCode(url.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        return Buffer.from(encoded).toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '~');
    }
    
    /**
     * Decode URL from proxy format
     */
    decode(encoded) {
        try {
            const decoded = Buffer.from(
                encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/~/g, '='),
                'base64'
            ).toString();
            
            const key = this.config.encodeKey;
            let result = '';
            for (let i = 0; i < decoded.length; i++) {
                result += String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
            }
            return result;
        } catch (e) {
            return null;
        }
    }
    
    /**
     * Check if request contains exploit patterns
     */
    _checkExploits(url, headers) {
        if (!this.config.blockExploits) return false;
        
        for (const pattern of EXPLOIT_PATTERNS) {
            if (pattern.test(url)) return true;
            for (const value of Object.values(headers)) {
                if (typeof value === 'string' && pattern.test(value)) return true;
            }
        }
        return false;
    }
    
    /**
     * Build nginx-style proxy headers
     * Mimics NPM's proxy_set_header directives
     */
    _buildProxyHeaders(targetUrl, req) {
        const parsed = new URL(targetUrl);
        const headers = {};
        
        // Copy safe headers from original request
        for (const header of PASS_THROUGH_REQUEST_HEADERS) {
            if (req.headers[header]) {
                headers[header] = req.headers[header];
            }
        }
        
        // Host header - critical for proper proxying
        headers['host'] = parsed.host;
        
        // User-Agent - use spoofed one in stealth mode
        if (this.config.stealthMode) {
            headers['user-agent'] = this.config.userAgent;
        } else if (!headers['user-agent']) {
            headers['user-agent'] = this.config.userAgent;
        }
        
        // Accept headers
        if (!headers['accept']) {
            headers['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
        }
        if (!headers['accept-language']) {
            headers['accept-language'] = 'en-US,en;q=0.9';
        }
        
        // Don't accept compressed if we need to rewrite
        headers['accept-encoding'] = 'identity';
        
        // Connection headers
        headers['connection'] = 'keep-alive';
        
        // Security headers to make request look normal
        headers['sec-fetch-dest'] = 'document';
        headers['sec-fetch-mode'] = 'navigate';
        headers['sec-fetch-site'] = 'none';
        headers['sec-fetch-user'] = '?1';
        headers['upgrade-insecure-requests'] = '1';
        
        // Sec-CH-UA headers (Chrome client hints)
        headers['sec-ch-ua'] = '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"';
        headers['sec-ch-ua-mobile'] = '?0';
        headers['sec-ch-ua-platform'] = '"Windows"';
        
        // DNT (Do Not Track)
        headers['dnt'] = '1';
        
        // Fix Referer to target domain
        if (headers['referer']) {
            try {
                const refUrl = new URL(headers['referer']);
                // Only keep referer if it's from same domain
                if (refUrl.host !== parsed.host) {
                    delete headers['referer'];
                }
            } catch (e) {
                delete headers['referer'];
            }
        }
        
        // Fix Origin
        if (headers['origin']) {
            headers['origin'] = `${parsed.protocol}//${parsed.host}`;
        }
        
        return headers;
    }
    
    /**
     * Filter and modify response headers
     * Mimics NPM's response header manipulation
     */
    _processResponseHeaders(headers, targetUrl) {
        const result = {};
        
        for (const [key, value] of Object.entries(headers)) {
            const lowerKey = key.toLowerCase();
            
            // Skip headers that should be stripped
            if (STRIP_RESPONSE_HEADERS.includes(lowerKey)) {
                continue;
            }
            
            // Skip transfer/connection headers
            if (['transfer-encoding', 'connection', 'keep-alive'].includes(lowerKey)) {
                continue;
            }
            
            // Rewrite Location header for redirects
            if (lowerKey === 'location' && value) {
                const location = this._rewriteLocation(value, targetUrl);
                if (location) {
                    result[key] = location;
                }
                continue;
            }
            
            // Rewrite Set-Cookie domain/path
            if (lowerKey === 'set-cookie') {
                const cookies = Array.isArray(value) ? value : [value];
                result[key] = cookies.map(c => this._rewriteCookie(c, targetUrl));
                continue;
            }
            
            result[key] = value;
        }
        
        // Add CORS headers for cross-origin access
        result['access-control-allow-origin'] = '*';
        result['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS, HEAD';
        result['access-control-allow-headers'] = '*';
        result['access-control-expose-headers'] = '*';
        
        // Add timing allow for performance API
        result['timing-allow-origin'] = '*';
        
        return result;
    }
    
    /**
     * Rewrite Location header for redirects
     */
    _rewriteLocation(location, baseUrl) {
        try {
            const parsed = new URL(baseUrl);
            let absolute;
            
            if (location.startsWith('http')) {
                absolute = location;
            } else if (location.startsWith('//')) {
                absolute = parsed.protocol + location;
            } else if (location.startsWith('/')) {
                absolute = `${parsed.protocol}//${parsed.host}${location}`;
            } else {
                const base = baseUrl.replace(/\/[^\/]*$/, '/');
                absolute = base + location;
            }
            
            return this.config.prefix + this.encode(absolute);
        } catch (e) {
            return location;
        }
    }
    
    /**
     * Rewrite Set-Cookie header
     */
    _rewriteCookie(cookie, baseUrl) {
        // Remove domain restriction
        let modified = cookie.replace(/;\s*domain=[^;]+/gi, '');
        // Remove path restriction
        modified = modified.replace(/;\s*path=[^;]+/gi, '; path=/');
        // Remove secure flag if needed
        modified = modified.replace(/;\s*secure/gi, '');
        // Remove SameSite=Strict
        modified = modified.replace(/;\s*samesite=strict/gi, '; SameSite=Lax');
        return modified;
    }
    
    /**
     * Express middleware
     */
    middleware() {
        return async (req, res, next) => {
            const url = req.url;
            
            // Check if this is a proxy request
            if (!url.startsWith(this.config.prefix)) {
                return next();
            }
            
            // Handle CORS preflight
            if (req.method === 'OPTIONS') {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH');
                res.setHeader('Access-Control-Allow-Headers', '*');
                res.setHeader('Access-Control-Max-Age', '86400');
                res.statusCode = 204;
                return res.end();
            }
            
            await this.handleRequest(req, res);
        };
    }
    
    /**
     * Main request handler - mimics nginx proxy_pass
     */
    async handleRequest(req, res) {
        this.stats.requests++;
        
        // Extract encoded URL
        const encodedPath = req.url.slice(this.config.prefix.length).split('?')[0];
        const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        
        const targetUrl = this.decode(encodedPath);
        
        if (!targetUrl) {
            res.statusCode = 400;
            return res.end('Invalid proxy URL');
        }
        
        // Check for exploits
        if (this._checkExploits(targetUrl, req.headers)) {
            this.stats.blocked++;
            res.statusCode = 403;
            return res.end('Blocked by security policy');
        }
        
        try {
            const parsed = new URL(targetUrl + queryString);
            const isHttps = parsed.protocol === 'https:';
            const client = isHttps ? https : http;
            
            // Build proxy headers (nginx-style)
            const headers = this._buildProxyHeaders(targetUrl, req);
            
            // Request options
            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: req.method,
                headers: headers,
                agent: isHttps ? this.agents.https : this.agents.http,
                timeout: this.config.timeout,
            };
            
            // Make the proxy request
            const proxyReq = client.request(options, (proxyRes) => {
                this._handleProxyResponse(proxyRes, res, targetUrl, req);
            });
            
            proxyReq.on('error', (err) => {
                this.stats.errors++;
                console.error('[NPM-PROXY] Request error:', err.message);
                
                if (!res.headersSent) {
                    res.statusCode = 502;
                    res.setHeader('Content-Type', 'text/html');
                    res.end(this._errorPage('Bad Gateway', err.message));
                }
            });
            
            proxyReq.on('timeout', () => {
                proxyReq.destroy();
                this.stats.errors++;
                
                if (!res.headersSent) {
                    res.statusCode = 504;
                    res.setHeader('Content-Type', 'text/html');
                    res.end(this._errorPage('Gateway Timeout', 'The upstream server took too long to respond'));
                }
            });
            
            // Stream request body for POST/PUT
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                req.pipe(proxyReq);
            } else {
                proxyReq.end();
            }
            
        } catch (err) {
            this.stats.errors++;
            console.error('[NPM-PROXY] Handler error:', err);
            
            if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'text/html');
                res.end(this._errorPage('Internal Error', err.message));
            }
        }
    }
    
    /**
     * Handle proxy response
     */
    async _handleProxyResponse(proxyRes, res, targetUrl, req) {
        const contentType = proxyRes.headers['content-type'] || '';
        const needsRewrite = this._needsRewrite(contentType);
        
        // Process response headers
        const headers = this._processResponseHeaders(proxyRes.headers, targetUrl);
        
        // Set response headers
        for (const [key, value] of Object.entries(headers)) {
            if (value !== undefined && value !== null) {
                res.setHeader(key, value);
            }
        }
        
        res.statusCode = proxyRes.statusCode;
        
        // If content needs rewriting
        if (needsRewrite) {
            const chunks = [];
            
            proxyRes.on('data', chunk => chunks.push(chunk));
            proxyRes.on('end', () => {
                let body = Buffer.concat(chunks).toString('utf-8');
                
                // Rewrite content
                body = this._rewriteContent(body, contentType, targetUrl);
                
                res.setHeader('Content-Length', Buffer.byteLength(body));
                res.end(body);
            });
            
            proxyRes.on('error', (err) => {
                console.error('[NPM-PROXY] Response error:', err.message);
                if (!res.headersSent) {
                    res.statusCode = 502;
                    res.end('Proxy Error');
                }
            });
        } else {
            // Stream directly
            proxyRes.pipe(res);
        }
    }
    
    /**
     * Check if content needs URL rewriting
     */
    _needsRewrite(contentType) {
        return contentType.includes('text/html') ||
               contentType.includes('text/css') ||
               contentType.includes('application/javascript') ||
               contentType.includes('text/javascript') ||
               contentType.includes('application/x-javascript') ||
               contentType.includes('application/json');
    }
    
    /**
     * Rewrite content URLs
     */
    _rewriteContent(content, contentType, baseUrl) {
        const parsed = new URL(baseUrl);
        const baseOrigin = `${parsed.protocol}//${parsed.host}`;
        const prefix = this.config.prefix;
        const self = this;
        
        if (contentType.includes('html')) {
            // Rewrite absolute URLs
            content = content.replace(/(href|src|action|poster|data-src|srcset)\s*=\s*["']([^"']+)["']/gi, 
                (match, attr, url) => {
                    const rewritten = self._rewriteUrl(url, baseUrl);
                    return `${attr}="${rewritten}"`;
                });
            
            // Rewrite inline styles
            content = content.replace(/url\s*\(\s*["']?([^"'\)]+)["']?\s*\)/gi,
                (match, url) => {
                    const rewritten = self._rewriteUrl(url, baseUrl);
                    return `url("${rewritten}")`;
                });
            
            // Rewrite form actions
            content = content.replace(/(<form[^>]*action\s*=\s*["'])([^"']+)(["'][^>]*>)/gi,
                (match, pre, url, post) => {
                    const rewritten = self._rewriteUrl(url, baseUrl);
                    return pre + rewritten + post;
                });
            
            // Inject client script for dynamic URL handling
            const clientScript = `
<script>
(function() {
    const PROXY_PREFIX = '${prefix}';
    const PROXY_KEY = '${this.config.encodeKey}';
    
    function proxyEncode(str) {
        let encoded = '';
        for (let i = 0; i < str.length; i++) {
            encoded += String.fromCharCode(str.charCodeAt(i) ^ PROXY_KEY.charCodeAt(i % PROXY_KEY.length));
        }
        return btoa(encoded).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '~');
    }
    
    function proxyUrl(url) {
        if (url.startsWith(PROXY_PREFIX)) return url;
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return url;
        
        let absolute = url;
        if (url.startsWith('//')) {
            absolute = location.protocol + url;
        } else if (url.startsWith('/')) {
            absolute = '${baseOrigin}' + url;
        } else if (!url.startsWith('http')) {
            absolute = '${baseUrl.replace(/\/[^\/]*$/, '/')}' + url;
        }
        
        return PROXY_PREFIX + proxyEncode(absolute);
    }
    
    // Override fetch
    const origFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') {
            input = proxyUrl(input);
        } else if (input instanceof Request) {
            input = new Request(proxyUrl(input.url), input);
        }
        return origFetch.call(this, input, init);
    };
    
    // Override XHR
    const origXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        return origXHROpen.call(this, method, proxyUrl(url), ...args);
    };
    
    // Override location
    const origAssign = window.location.assign;
    window.location.assign = function(url) {
        return origAssign.call(this, proxyUrl(url));
    };
    
    // Override window.open
    const origOpen = window.open;
    window.open = function(url, ...args) {
        return origOpen.call(this, proxyUrl(url), ...args);
    };
    
    // Handle link clicks
    document.addEventListener('click', function(e) {
        const a = e.target.closest('a');
        if (a && a.href && !a.href.startsWith('javascript:') && !a.href.startsWith('#')) {
            if (!a.href.startsWith(location.origin + PROXY_PREFIX)) {
                e.preventDefault();
                window.location.href = proxyUrl(a.href);
            }
        }
    }, true);
    
    // Handle form submissions
    document.addEventListener('submit', function(e) {
        const form = e.target;
        if (form.action && !form.action.startsWith(location.origin + PROXY_PREFIX)) {
            form.action = proxyUrl(form.action);
        }
    }, true);
    
    console.log('[NPM-PROXY] Client hooks installed');
})();
</script>`;
            
            // Inject before </head> or at start of <body>
            if (content.includes('</head>')) {
                content = content.replace('</head>', clientScript + '</head>');
            } else if (content.includes('<body')) {
                content = content.replace(/<body([^>]*)>/i, '<body$1>' + clientScript);
            } else {
                content = clientScript + content;
            }
            
        } else if (contentType.includes('css')) {
            // Rewrite CSS url() references
            content = content.replace(/url\s*\(\s*["']?([^"'\)]+)["']?\s*\)/gi,
                (match, url) => {
                    const rewritten = self._rewriteUrl(url, baseUrl);
                    return `url("${rewritten}")`;
                });
            
            // Rewrite @import
            content = content.replace(/@import\s+["']([^"']+)["']/gi,
                (match, url) => {
                    const rewritten = self._rewriteUrl(url, baseUrl);
                    return `@import "${rewritten}"`;
                });
                
        } else if (contentType.includes('javascript')) {
            // Careful with JS - only rewrite obvious URL strings
            // This is minimal to avoid breaking code
        }
        
        return content;
    }
    
    /**
     * Rewrite a single URL
     */
    _rewriteUrl(url, baseUrl) {
        // Skip special URLs
        if (!url || 
            url.startsWith('data:') || 
            url.startsWith('blob:') || 
            url.startsWith('javascript:') ||
            url.startsWith('#') ||
            url.startsWith(this.config.prefix)) {
            return url;
        }
        
        try {
            let absolute;
            const parsed = new URL(baseUrl);
            
            if (url.startsWith('http://') || url.startsWith('https://')) {
                absolute = url;
            } else if (url.startsWith('//')) {
                absolute = parsed.protocol + url;
            } else if (url.startsWith('/')) {
                absolute = `${parsed.protocol}//${parsed.host}${url}`;
            } else {
                const base = baseUrl.replace(/\/[^\/]*$/, '/');
                absolute = base + url;
            }
            
            return this.config.prefix + this.encode(absolute);
        } catch (e) {
            return url;
        }
    }
    
    /**
     * Handle WebSocket upgrade (like NPM's allow_websocket_upgrade)
     */
    handleUpgrade(server) {
        server.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url, `http://${request.headers.host}`);
            
            if (!url.pathname.startsWith(this.config.prefix)) {
                return;
            }
            
            if (!this.config.allowWebsocketUpgrade) {
                socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
                return;
            }
            
            this._handleWebSocketUpgrade(request, socket, head);
        });
    }
    
    /**
     * WebSocket proxy
     */
    _handleWebSocketUpgrade(request, socket, head) {
        this.stats.websockets++;
        
        const encodedPath = request.url.slice(this.config.prefix.length).split('?')[0];
        const targetUrl = this.decode(encodedPath);
        
        if (!targetUrl) {
            socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            return;
        }
        
        try {
            const parsed = new URL(targetUrl);
            const isSecure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
            const wsProtocol = isSecure ? 'wss:' : 'ws:';
            const wsUrl = `${wsProtocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
            
            // Connect to target WebSocket
            const targetPort = parsed.port || (isSecure ? 443 : 80);
            
            const targetSocket = (isSecure ? tls : net).connect({
                host: parsed.hostname,
                port: targetPort,
                rejectUnauthorized: false,
            });
            
            // Forward WebSocket handshake
            const wsKey = request.headers['sec-websocket-key'];
            const wsVersion = request.headers['sec-websocket-version'];
            const wsProtocol2 = request.headers['sec-websocket-protocol'];
            
            let handshake = `GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\n`;
            handshake += `Host: ${parsed.host}\r\n`;
            handshake += `Upgrade: websocket\r\n`;
            handshake += `Connection: Upgrade\r\n`;
            handshake += `Sec-WebSocket-Key: ${wsKey}\r\n`;
            handshake += `Sec-WebSocket-Version: ${wsVersion}\r\n`;
            if (wsProtocol2) {
                handshake += `Sec-WebSocket-Protocol: ${wsProtocol2}\r\n`;
            }
            handshake += `Origin: ${parsed.protocol}//${parsed.host}\r\n`;
            handshake += `\r\n`;
            
            targetSocket.on('connect', () => {
                targetSocket.write(handshake);
            });
            
            // Bridge sockets
            let handshakeComplete = false;
            let buffer = Buffer.alloc(0);
            
            targetSocket.on('data', (data) => {
                if (!handshakeComplete) {
                    buffer = Buffer.concat([buffer, data]);
                    const idx = buffer.indexOf('\r\n\r\n');
                    if (idx !== -1) {
                        handshakeComplete = true;
                        socket.write(buffer.slice(0, idx + 4));
                        if (buffer.length > idx + 4) {
                            socket.write(buffer.slice(idx + 4));
                        }
                    }
                } else {
                    socket.write(data);
                }
            });
            
            socket.on('data', (data) => {
                if (handshakeComplete && !targetSocket.destroyed) {
                    targetSocket.write(data);
                }
            });
            
            const cleanup = () => {
                if (!socket.destroyed) socket.destroy();
                if (!targetSocket.destroyed) targetSocket.destroy();
            };
            
            socket.on('close', cleanup);
            socket.on('error', cleanup);
            targetSocket.on('close', cleanup);
            targetSocket.on('error', cleanup);
            
        } catch (err) {
            console.error('[NPM-PROXY] WebSocket error:', err.message);
            socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
    }
    
    /**
     * Generate error page
     */
    _errorPage(title, message) {
        return `<!DOCTYPE html>
<html>
<head>
    <title>${title}</title>
    <style>
        body {
            font-family: system-ui, sans-serif;
            background: #0a0a0f;
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
        }
        .error {
            text-align: center;
            padding: 40px;
        }
        h1 {
            font-size: 48px;
            margin: 0 0 10px 0;
            background: linear-gradient(135deg, #ef4444 0%, #f97316 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        p {
            color: #a0a0b0;
            max-width: 400px;
        }
        a {
            color: #7c3aed;
            text-decoration: none;
        }
    </style>
</head>
<body>
    <div class="error">
        <h1>${title}</h1>
        <p>${message}</p>
        <p><a href="javascript:history.back()">← Go Back</a></p>
    </div>
</body>
</html>`;
    }
    
    /**
     * Get stats
     */
    getStats() {
        return { ...this.stats };
    }
}

export { NginxReverseProxy };
export default NginxReverseProxy;
