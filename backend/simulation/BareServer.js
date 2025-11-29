/**
 * BareServer.js
 * 
 * A complete implementation of a Bare Server protocol compatible with
 * Holy Unblocker / Ultraviolet style proxies.
 * 
 * The Bare protocol allows the service worker to make requests through this
 * server, completely bypassing any content filters because:
 * 1. All requests go through WebSocket or fetch to our server
 * 2. The actual target URL is encoded and sent as headers
 * 3. The response is streamed back to the client
 * 
 * This is the SAME technique used by Holy Unblocker, Metallic, Rammerhead, etc.
 */

import { Readable, PassThrough } from "stream";
import { randomUUID, createHash } from "crypto";
import { EventEmitter } from "events";
import http from "http";
import https from "https";

// Bare Protocol Version
const BARE_VERSION = "3.1.0";

// Headers that should never be forwarded
const FORBIDDEN_FORWARD_HEADERS = new Set([
    'host',
    'connection',
    'upgrade',
    'keep-alive',
    'transfer-encoding',
    'te',
    'trailer',
    'sec-websocket-key',
    'sec-websocket-extensions',
    'sec-websocket-accept',
    'sec-websocket-protocol',
    'sec-websocket-version',
    'proxy-connection',
    'proxy-authenticate',
    'proxy-authorization',
    'content-length' // We'll set this ourselves
]);

// Headers that reveal proxy usage
const STRIP_REQUEST_HEADERS = new Set([
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
    'via',
    'forwarded',
    'cf-connecting-ip',
    'cf-ray',
    'cf-ipcountry',
    'true-client-ip',
    'x-proxy-id',
    'x-correlation-id'
]);

/**
 * BareServer - Implements the Bare protocol for proxy requests
 */
export class BareServer extends EventEmitter {
    constructor(options = {}) {
        super();
        this.prefix = options.prefix || '/bare/';
        this.maintainer = options.maintainer || {
            email: 'support@example.com',
            website: 'https://example.com'
        };
        this.versions = ['v1', 'v2', 'v3'];
        this.maxHeaderSize = options.maxHeaderSize || 16384;
        
        // Connection pooling for better performance
        this.httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 256,
            maxFreeSockets: 64,
            timeout: 30000
        });
        this.httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 256,
            maxFreeSockets: 64,
            timeout: 30000,
            rejectUnauthorized: false // Allow self-signed certs
        });
        
        // Request metrics
        this.metrics = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            bytesTransferred: 0,
            activeConnections: 0,
            websocketConnections: 0
        };
        
        // User agent rotation for stealth
        this.userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
        ];
    }
    
    /**
     * Check if a request should be handled by Bare server
     */
    shouldRoute(req) {
        return req.url.startsWith(this.prefix);
    }
    
    /**
     * Route handler for Express
     */
    routeExpress(app) {
        // Bare server info endpoint
        app.get(this.prefix, (req, res) => this.handleInfo(req, res));
        app.get(`${this.prefix}v1/`, (req, res) => this.handleV1Info(req, res));
        app.get(`${this.prefix}v2/`, (req, res) => this.handleV2Info(req, res));
        app.get(`${this.prefix}v3/`, (req, res) => this.handleV3Info(req, res));
        
        // V3 request handler (most modern)
        app.all(`${this.prefix}v3/*`, (req, res) => this.handleV3Request(req, res));
        
        // V1/V2 fallback
        app.all(`${this.prefix}v1/*`, (req, res) => this.handleV1Request(req, res));
        app.all(`${this.prefix}v2/*`, (req, res) => this.handleV2Request(req, res));
        
        // Catch-all for bare protocol
        app.all(`${this.prefix}*`, (req, res) => this.handleV3Request(req, res));
    }
    
    /**
     * Handle bare server info request
     */
    handleInfo(req, res) {
        res.json({
            versions: this.versions,
            language: 'NodeJS',
            memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100,
            maintainer: this.maintainer,
            project: {
                name: 'StealthBare',
                description: 'A Bare server implementation for bypassing content filters',
                repository: 'https://github.com/example/stealthbare',
                version: BARE_VERSION
            },
            metrics: this.metrics
        });
    }
    
    handleV1Info(req, res) {
        res.json({ version: 'v1' });
    }
    
    handleV2Info(req, res) {
        res.json({ version: 'v2' });
    }
    
    handleV3Info(req, res) {
        res.json({ version: 'v3' });
    }
    
    /**
     * Handle V3 Bare request - Modern protocol
     * 
     * Headers:
     * - x-bare-url: Target URL
     * - x-bare-headers: JSON encoded headers to forward
     * - x-bare-forward-headers: Headers to forward from client
     */
    async handleV3Request(req, res) {
        this.metrics.totalRequests++;
        this.metrics.activeConnections++;
        
        try {
            // Parse Bare headers
            const bareUrl = req.headers['x-bare-url'];
            const bareHeadersRaw = req.headers['x-bare-headers'];
            const bareForwardHeaders = req.headers['x-bare-forward-headers'];
            
            if (!bareUrl) {
                // This might be a passthrough request, try to extract from path
                const pathUrl = this.extractUrlFromPath(req.url, this.prefix);
                if (pathUrl) {
                    return this.handlePassthroughRequest(req, res, pathUrl);
                }
                
                res.status(400).json({ 
                    code: 'MISSING_BARE_HEADER',
                    id: 'request.headers.x-bare-url',
                    message: 'Header x-bare-url is required'
                });
                return;
            }
            
            // Parse target URL
            let targetUrl;
            try {
                targetUrl = new URL(bareUrl);
            } catch (e) {
                res.status(400).json({
                    code: 'INVALID_BARE_URL',
                    id: 'request.headers.x-bare-url',
                    message: 'Invalid URL in x-bare-url header'
                });
                return;
            }
            
            // Build headers for outgoing request
            const outgoingHeaders = this.buildOutgoingHeaders(req, bareHeadersRaw, bareForwardHeaders);
            
            // Add host header
            outgoingHeaders['host'] = targetUrl.host;
            
            // Stealth user agent
            if (!outgoingHeaders['user-agent']) {
                outgoingHeaders['user-agent'] = this.getRandomUserAgent();
            }
            
            // Make the request
            const response = await this.makeRequest({
                method: req.method,
                url: targetUrl,
                headers: outgoingHeaders,
                body: req.method !== 'GET' && req.method !== 'HEAD' ? req : null
            });
            
            // Build response headers
            const responseHeaders = this.buildResponseHeaders(response);
            
            // Set Bare response headers
            res.set('x-bare-status', response.statusCode.toString());
            res.set('x-bare-status-text', response.statusMessage || '');
            res.set('x-bare-headers', JSON.stringify(responseHeaders));
            
            // Forward the response
            res.status(200);
            
            // Stream the response body
            if (response.body) {
                response.body.pipe(res);
                response.body.on('data', (chunk) => {
                    this.metrics.bytesTransferred += chunk.length;
                });
            } else {
                res.end();
            }
            
            this.metrics.successfulRequests++;
            
        } catch (error) {
            this.metrics.failedRequests++;
            console.error('[BareServer] Request failed:', error);
            
            res.status(500).json({
                code: 'BARE_REQUEST_FAILED',
                id: 'request',
                message: error.message
            });
        } finally {
            this.metrics.activeConnections--;
        }
    }
    
    /**
     * Handle V1/V2 requests (legacy compatibility)
     */
    async handleV1Request(req, res) {
        return this.handleV3Request(req, res);
    }
    
    async handleV2Request(req, res) {
        return this.handleV3Request(req, res);
    }
    
    /**
     * Handle passthrough request (URL encoded in path)
     */
    async handlePassthroughRequest(req, res, targetUrl) {
        this.metrics.totalRequests++;
        this.metrics.activeConnections++;
        
        try {
            const outgoingHeaders = {};
            
            // Copy safe headers
            for (const [key, value] of Object.entries(req.headers)) {
                const lowerKey = key.toLowerCase();
                if (!FORBIDDEN_FORWARD_HEADERS.has(lowerKey) && 
                    !STRIP_REQUEST_HEADERS.has(lowerKey) &&
                    !lowerKey.startsWith('x-bare-')) {
                    outgoingHeaders[key] = value;
                }
            }
            
            outgoingHeaders['host'] = targetUrl.host;
            outgoingHeaders['user-agent'] = this.getRandomUserAgent();
            
            const response = await this.makeRequest({
                method: req.method,
                url: targetUrl,
                headers: outgoingHeaders,
                body: req.method !== 'GET' && req.method !== 'HEAD' ? req : null
            });
            
            // Forward status and headers
            res.status(response.statusCode);
            
            const safeHeaders = this.buildResponseHeaders(response);
            for (const [key, value] of Object.entries(safeHeaders)) {
                try {
                    res.set(key, value);
                } catch (e) {
                    // Skip invalid headers
                }
            }
            
            // Stream response
            if (response.body) {
                response.body.pipe(res);
                response.body.on('data', (chunk) => {
                    this.metrics.bytesTransferred += chunk.length;
                });
            } else {
                res.end();
            }
            
            this.metrics.successfulRequests++;
            
        } catch (error) {
            this.metrics.failedRequests++;
            console.error('[BareServer] Passthrough request failed:', error);
            res.status(502).json({ error: error.message });
        } finally {
            this.metrics.activeConnections--;
        }
    }
    
    /**
     * Extract URL from request path
     */
    extractUrlFromPath(path, prefix) {
        const afterPrefix = path.slice(prefix.length);
        
        // Try to decode from various formats
        // Format 1: /bare/v3/https://example.com/path
        // Format 2: /bare/v3/aHR0cHM6Ly9leGFtcGxlLmNvbQ== (base64)
        // Format 3: /bare/v3/68747470733a2f2f6578616d706c652e636f6d (hex)
        
        // Remove version prefix
        let urlPart = afterPrefix.replace(/^v[1-3]\//, '');
        
        if (!urlPart) return null;
        
        // Try as plain URL
        try {
            if (urlPart.startsWith('http://') || urlPart.startsWith('https://')) {
                return new URL(urlPart);
            }
        } catch {}
        
        // Try base64 decode
        try {
            const decoded = Buffer.from(urlPart, 'base64url').toString('utf-8');
            if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
                return new URL(decoded);
            }
        } catch {}
        
        // Try hex decode
        try {
            const decoded = Buffer.from(urlPart, 'hex').toString('utf-8');
            if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
                return new URL(decoded);
            }
        } catch {}
        
        return null;
    }
    
    /**
     * Build outgoing headers from bare request
     */
    buildOutgoingHeaders(req, bareHeadersRaw, bareForwardHeaders) {
        const headers = {};
        
        // Parse x-bare-headers if provided
        if (bareHeadersRaw) {
            try {
                const parsedHeaders = JSON.parse(bareHeadersRaw);
                for (const [key, value] of Object.entries(parsedHeaders)) {
                    headers[key.toLowerCase()] = value;
                }
            } catch (e) {
                console.warn('[BareServer] Failed to parse x-bare-headers:', e.message);
            }
        }
        
        // Forward specified headers from client
        if (bareForwardHeaders) {
            try {
                const forwardList = JSON.parse(bareForwardHeaders);
                for (const headerName of forwardList) {
                    const value = req.headers[headerName.toLowerCase()];
                    if (value) {
                        headers[headerName.toLowerCase()] = value;
                    }
                }
            } catch (e) {
                // Fallback: treat as comma-separated list
                const forwardList = bareForwardHeaders.split(',').map(h => h.trim());
                for (const headerName of forwardList) {
                    const value = req.headers[headerName.toLowerCase()];
                    if (value) {
                        headers[headerName.toLowerCase()] = value;
                    }
                }
            }
        }
        
        // Strip any proxy-revealing headers
        for (const header of STRIP_REQUEST_HEADERS) {
            delete headers[header];
        }
        
        return headers;
    }
    
    /**
     * Build safe response headers
     */
    buildResponseHeaders(response) {
        const headers = {};
        
        for (const [key, value] of Object.entries(response.headers)) {
            const lowerKey = key.toLowerCase();
            
            // Skip forbidden headers
            if (FORBIDDEN_FORWARD_HEADERS.has(lowerKey)) {
                continue;
            }
            
            // Relax security headers
            if (lowerKey === 'content-security-policy' || 
                lowerKey === 'content-security-policy-report-only') {
                headers[key] = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;";
                continue;
            }
            
            if (lowerKey === 'x-frame-options') {
                continue; // Remove to allow embedding
            }
            
            if (lowerKey === 'x-content-type-options') {
                continue;
            }
            
            headers[key] = value;
        }
        
        // Add CORS headers
        headers['access-control-allow-origin'] = '*';
        headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS, HEAD';
        headers['access-control-allow-headers'] = '*';
        headers['access-control-expose-headers'] = '*';
        
        return headers;
    }
    
    /**
     * Make HTTP/HTTPS request to target
     */
    makeRequest({ method, url, headers, body }) {
        return new Promise((resolve, reject) => {
            const protocol = url.protocol === 'https:' ? https : http;
            const agent = url.protocol === 'https:' ? this.httpsAgent : this.httpAgent;
            
            const options = {
                method,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                headers,
                agent,
                timeout: 30000
            };
            
            const req = protocol.request(options, (res) => {
                resolve({
                    statusCode: res.statusCode,
                    statusMessage: res.statusMessage,
                    headers: res.headers,
                    body: res
                });
            });
            
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            
            if (body && typeof body.pipe === 'function') {
                body.pipe(req);
            } else if (body) {
                req.write(body);
                req.end();
            } else {
                req.end();
            }
        });
    }
    
    /**
     * Get random user agent
     */
    getRandomUserAgent() {
        return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
    }
    
    /**
     * Get metrics
     */
    getMetrics() {
        return { ...this.metrics };
    }
}

/**
 * BareWebSocket - WebSocket upgrade handler for Bare protocol
 */
export class BareWebSocket {
    constructor(wss, bareServer) {
        this.wss = wss;
        this.bareServer = bareServer;
        this.connections = new Map();
    }
    
    /**
     * Handle WebSocket upgrade for Bare protocol
     */
    handleUpgrade(req, socket, head) {
        // Check if this is a bare websocket request
        const bareUrl = req.headers['x-bare-url'];
        if (!bareUrl) {
            // Not a bare request, let it through
            return false;
        }
        
        try {
            const targetUrl = new URL(bareUrl);
            const wsProtocol = targetUrl.protocol === 'https:' ? 'wss:' : 'ws:';
            targetUrl.protocol = wsProtocol;
            
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.createProxyConnection(ws, targetUrl, req.headers);
            });
            
            return true;
        } catch (e) {
            console.error('[BareWebSocket] Upgrade failed:', e);
            socket.destroy();
            return false;
        }
    }
    
    /**
     * Create proxied WebSocket connection
     */
    createProxyConnection(clientWs, targetUrl, headers) {
        const WebSocket = require('ws');
        
        const wsHeaders = {};
        
        // Forward specified headers
        const bareHeaders = headers['x-bare-headers'];
        if (bareHeaders) {
            try {
                Object.assign(wsHeaders, JSON.parse(bareHeaders));
            } catch {}
        }
        
        wsHeaders['User-Agent'] = this.bareServer.getRandomUserAgent();
        wsHeaders['Origin'] = targetUrl.origin;
        
        const targetWs = new WebSocket(targetUrl.href, {
            headers: wsHeaders,
            rejectUnauthorized: false
        });
        
        const connectionId = randomUUID();
        this.connections.set(connectionId, { client: clientWs, target: targetWs });
        this.bareServer.metrics.websocketConnections++;
        
        // Proxy messages
        targetWs.on('open', () => {
            clientWs.send(JSON.stringify({ type: 'open' }));
        });
        
        targetWs.on('message', (data) => {
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(data);
            }
        });
        
        targetWs.on('close', (code, reason) => {
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.close(code, reason);
            }
            this.cleanup(connectionId);
        });
        
        targetWs.on('error', (err) => {
            console.error('[BareWebSocket] Target error:', err.message);
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.close(1011, 'Target connection error');
            }
            this.cleanup(connectionId);
        });
        
        clientWs.on('message', (data) => {
            if (targetWs.readyState === WebSocket.OPEN) {
                targetWs.send(data);
            }
        });
        
        clientWs.on('close', () => {
            if (targetWs.readyState === WebSocket.OPEN) {
                targetWs.close();
            }
            this.cleanup(connectionId);
        });
        
        clientWs.on('error', () => {
            if (targetWs.readyState === WebSocket.OPEN) {
                targetWs.close();
            }
            this.cleanup(connectionId);
        });
    }
    
    cleanup(connectionId) {
        this.connections.delete(connectionId);
        this.bareServer.metrics.websocketConnections--;
    }
}

export default BareServer;
