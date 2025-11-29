/**
 * ASTRO SERVER
 * Complete server-side proxy implementation
 * 
 * Integrates:
 * - NGINX-style reverse proxy (NPM)
 * - Bare Server protocol
 * - Wisp WebSocket multiplexing
 * - Request rewriting
 * - Stealth evasion
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { AstroConfig } from './AstroConfig.js';
import { AstroRewriter } from './AstroRewriter.js';
import { NginxReverseProxy } from './NginxReverseProxy.js';
import net from 'net';
import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class AstroServer {
    constructor(options = {}) {
        this.config = new AstroConfig(options);
        this.rewriter = new AstroRewriter(this.config);
        
        // NGINX-style reverse proxy (primary proxy handler)
        this.npmProxy = new NginxReverseProxy({
            prefix: '/astro/~/~/',  // NPM-style prefix
            encodeKey: 'NPMStealthProxy2024!@#$',
            stealthMode: true,
            allowWebsocketUpgrade: true,
            blockExploits: true,
            cachingEnabled: false,
        });
        
        // Wisp connections
        this.wispConnections = new Map();
        
        // Stats
        this.stats = {
            requests: 0,
            cached: 0,
            errors: 0,
            bytesTransferred: 0
        };
        
        // Cache
        this.cache = new Map();
        this.maxCacheSize = 100;
    }
    
    /**
     * Express middleware for Astro routes
     */
    middleware() {
        return async (req, res, next) => {
            const url = req.url;
            
            // NPM-style proxy (primary - stealth mode)
            if (url.startsWith('/astro/~/~/')) {
                return this.npmProxy.handleRequest(req, res);
            }
            
            // Static assets
            if (url.startsWith(this.config.cdn)) {
                return this._serveStatic(req, res, url);
            }
            
            // Bare server
            if (url.startsWith(this.config.bare)) {
                return this._handleBare(req, res, url);
            }
            
            // Proxied requests (legacy prefix)
            if (url.startsWith(this.config.prefix)) {
                return this._handleProxy(req, res, url);
            }
            
            next();
        };
    }
    
    /**
     * WebSocket upgrade handler for Wisp and NPM
     */
    handleUpgrade(server) {
        // Also register NPM proxy WebSocket handler
        this.npmProxy.handleUpgrade(server);
        
        server.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url, `http://${request.headers.host}`);
            
            // NPM-style proxy WebSocket (already handled by npmProxy.handleUpgrade)
            if (url.pathname.startsWith('/astro/~/~/')) {
                return; // Handled by npmProxy
            }
            
            // Wisp protocol
            if (url.pathname.startsWith(this.config.wisp)) {
                return this._handleWispUpgrade(request, socket, head);
            }
            
            // Bare WebSocket
            if (url.pathname.startsWith(this.config.bare + 'ws/')) {
                return this._handleBareWebSocket(request, socket, head);
            }
        });
    }
    
    /**
     * Serve static Astro assets
     */
    async _serveStatic(req, res, url) {
        const path = require('path');
        const fs = require('fs').promises;
        
        const relativePath = url.slice(this.config.cdn.length);
        const filePath = path.join(__dirname, '../../public/astro', relativePath);
        
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const ext = path.extname(filePath);
            
            const contentTypes = {
                '.js': 'application/javascript',
                '.css': 'text/css',
                '.html': 'text/html',
                '.json': 'application/json'
            };
            
            res.setHeader('Content-Type', contentTypes[ext] || 'text/plain');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.end(content);
            
        } catch (error) {
            res.statusCode = 404;
            res.end('Not found');
        }
    }
    
    /**
     * Handle Bare Server requests
     */
    async _handleBare(req, res, url) {
        // CORS preflight
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');
            res.setHeader('Access-Control-Max-Age', '86400');
            res.statusCode = 204;
            return res.end();
        }
        
        const targetUrl = req.headers['x-bare-url'];
        const method = req.headers['x-bare-method'] || req.method;
        let headers = {};
        
        try {
            headers = JSON.parse(req.headers['x-bare-headers'] || '{}');
        } catch (e) {}
        
        if (!targetUrl) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: 'Missing X-Bare-URL header' }));
        }
        
        this.stats.requests++;
        
        try {
            const response = await this._proxyRequest(targetUrl, method, headers, req);
            
            // Add CORS headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Expose-Headers', '*');
            
            // Copy response headers
            for (const [key, value] of Object.entries(response.headers)) {
                if (!['transfer-encoding', 'connection', 'keep-alive'].includes(key.toLowerCase())) {
                    res.setHeader(key, value);
                }
            }
            
            res.statusCode = response.statusCode;
            
            // Stream response body
            response.pipe(res);
            
        } catch (error) {
            this.stats.errors++;
            console.error('[ASTRO] Bare request error:', error.message);
            
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ 
                error: 'Proxy error', 
                message: error.message 
            }));
        }
    }
    
    /**
     * Handle proxied page requests
     */
    async _handleProxy(req, res, url) {
        const encodedUrl = url.slice(this.config.prefix.length).split('?')[0];
        const originalUrl = this.config.decode(encodedUrl);
        
        if (!originalUrl) {
            res.statusCode = 400;
            return res.end('Invalid proxy URL');
        }
        
        this.stats.requests++;
        
        try {
            // Check cache
            if (req.method === 'GET' && this.cache.has(originalUrl)) {
                const cached = this.cache.get(originalUrl);
                if (Date.now() - cached.timestamp < this.config.cache.maxAge * 1000) {
                    this.stats.cached++;
                    res.setHeader('Content-Type', cached.contentType);
                    res.setHeader('X-Astro-Cached', 'true');
                    return res.end(cached.content);
                }
            }
            
            const response = await this._proxyRequest(originalUrl, req.method, {}, req);
            
            // Collect response body
            const chunks = [];
            for await (const chunk of response) {
                chunks.push(chunk);
            }
            let body = Buffer.concat(chunks);
            
            // Get content type
            const contentType = response.headers['content-type'] || '';
            
            // Rewrite content if needed
            if (contentType.includes('html') || contentType.includes('css') || contentType.includes('javascript')) {
                const text = body.toString('utf-8');
                const rewritten = this.rewriter.rewrite(text, contentType, originalUrl);
                body = Buffer.from(rewritten, 'utf-8');
            }
            
            // Remove security headers
            const headersToRemove = [
                'content-security-policy',
                'content-security-policy-report-only',
                'x-frame-options',
                'x-content-type-options',
                'strict-transport-security'
            ];
            
            // Set response headers
            for (const [key, value] of Object.entries(response.headers)) {
                if (!headersToRemove.includes(key.toLowerCase()) && 
                    !['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
                    res.setHeader(key, value);
                }
            }
            
            // Add CORS
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Length', body.length);
            
            res.statusCode = response.statusCode;
            res.end(body);
            
            // Cache if appropriate
            if (req.method === 'GET' && response.statusCode === 200) {
                this._addToCache(originalUrl, body.toString('utf-8'), contentType);
            }
            
        } catch (error) {
            this.stats.errors++;
            console.error('[ASTRO] Proxy error:', error.message);
            
            res.statusCode = 502;
            res.setHeader('Content-Type', 'text/html');
            res.end(this._errorPage(error.message));
        }
    }
    
    /**
     * Make actual HTTP request
     */
    _proxyRequest(url, method, headers, req) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const isHttps = parsedUrl.protocol === 'https:';
            const client = isHttps ? https : http;
            
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (isHttps ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: method,
                headers: {
                    ...headers,
                    'Host': parsedUrl.host,
                    'User-Agent': headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': headers['accept'] || '*/*',
                    'Accept-Encoding': 'identity', // Don't accept compressed for rewriting
                },
                rejectUnauthorized: false, // Accept self-signed certs
                timeout: 30000
            };
            
            const proxyReq = client.request(options, (proxyRes) => {
                resolve(proxyRes);
            });
            
            proxyReq.on('error', reject);
            proxyReq.on('timeout', () => {
                proxyReq.destroy();
                reject(new Error('Request timeout'));
            });
            
            // Pipe request body
            if (method !== 'GET' && method !== 'HEAD') {
                req.pipe(proxyReq);
            } else {
                proxyReq.end();
            }
        });
    }
    
    /**
     * Handle Wisp WebSocket upgrade
     */
    _handleWispUpgrade(request, socket, head) {
        // WebSocket handshake
        const key = request.headers['sec-websocket-key'];
        const hash = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        
        const responseHeaders = [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${hash}`,
            ''
        ].join('\r\n') + '\r\n';
        
        socket.write(responseHeaders);
        
        // Create Wisp handler
        const wispHandler = new WispHandler(socket, this.config);
        const connectionId = crypto.randomBytes(16).toString('hex');
        this.wispConnections.set(connectionId, wispHandler);
        
        socket.on('close', () => {
            wispHandler.cleanup();
            this.wispConnections.delete(connectionId);
        });
        
        socket.on('error', (err) => {
            console.error('[ASTRO-WISP] Socket error:', err.message);
            wispHandler.cleanup();
            this.wispConnections.delete(connectionId);
        });
    }
    
    /**
     * Handle Bare WebSocket upgrade
     */
    _handleBareWebSocket(request, socket, head) {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const encodedTarget = url.pathname.split('/').pop();
        const targetUrl = Buffer.from(encodedTarget, 'base64').toString('utf-8');
        
        const parsedTarget = new URL(targetUrl);
        const isSecure = parsedTarget.protocol === 'wss:';
        
        // Connect to target WebSocket
        const targetPort = parsedTarget.port || (isSecure ? 443 : 80);
        
        const targetSocket = net.connect({
            host: parsedTarget.hostname,
            port: parseInt(targetPort)
        }, () => {
            // WebSocket handshake to client
            const key = request.headers['sec-websocket-key'];
            const hash = crypto
                .createHash('sha1')
                .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
                .digest('base64');
            
            socket.write([
                'HTTP/1.1 101 Switching Protocols',
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Accept: ${hash}`,
                ''
            ].join('\r\n') + '\r\n');
            
            // Pipe data between sockets
            socket.pipe(targetSocket);
            targetSocket.pipe(socket);
        });
        
        targetSocket.on('error', (err) => {
            console.error('[ASTRO] WebSocket proxy error:', err.message);
            socket.destroy();
        });
        
        socket.on('error', () => {
            targetSocket.destroy();
        });
    }
    
    _addToCache(url, content, contentType) {
        // LRU cache
        if (this.cache.size >= this.maxCacheSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        
        this.cache.set(url, {
            content,
            contentType,
            timestamp: Date.now()
        });
    }
    
    _errorPage(message) {
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
        .logo { font-size: 64px; margin-bottom: 20px; }
        h1 { color: #7c3aed; margin: 0 0 20px 0; }
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
        button:hover { background: #6d28d9; }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">🚀</div>
        <h1>Astro Proxy Error</h1>
        <p>Failed to load the requested page.</p>
        <div class="error">${message}</div>
        <button onclick="location.reload()">Retry</button>
        <button onclick="history.back()" style="background: transparent; border: 1px solid #7c3aed;">Go Back</button>
    </div>
</body>
</html>
        `;
    }
    
    getStats() {
        return { ...this.stats };
    }
    
    clearCache() {
        this.cache.clear();
    }
}

/**
 * WISP HANDLER
 * Handles individual Wisp WebSocket connections
 */
class WispHandler {
    constructor(socket, config) {
        this.socket = socket;
        this.config = config;
        this.streams = new Map();
        this.buffer = Buffer.alloc(0);
        
        // Wisp protocol constants
        this.PACKET_TYPES = {
            CONNECT: 0x01,
            DATA: 0x02,
            CONTINUE: 0x03,
            CLOSE: 0x04
        };
        
        this.STREAM_TYPES = {
            TCP: 0x01,
            UDP: 0x02
        };
        
        this.CLOSE_REASONS = {
            UNKNOWN: 0x01,
            VOLUNTARY: 0x02,
            NETWORK: 0x03,
            SERVER_REFUSED: 0x41,
            SERVER_UNREACHABLE: 0x42,
            TIMEOUT: 0x47,
            BLOCKED: 0x49
        };
        
        socket.on('data', (data) => this._handleData(data));
    }
    
    _handleData(data) {
        // WebSocket frame decoding (simplified)
        this.buffer = Buffer.concat([this.buffer, data]);
        
        while (this.buffer.length >= 2) {
            const firstByte = this.buffer[0];
            const secondByte = this.buffer[1];
            const masked = (secondByte & 0x80) !== 0;
            let payloadLength = secondByte & 0x7f;
            let offset = 2;
            
            if (payloadLength === 126) {
                if (this.buffer.length < 4) return;
                payloadLength = this.buffer.readUInt16BE(2);
                offset = 4;
            } else if (payloadLength === 127) {
                if (this.buffer.length < 10) return;
                payloadLength = Number(this.buffer.readBigUInt64BE(2));
                offset = 10;
            }
            
            let maskingKey = null;
            if (masked) {
                if (this.buffer.length < offset + 4) return;
                maskingKey = this.buffer.slice(offset, offset + 4);
                offset += 4;
            }
            
            if (this.buffer.length < offset + payloadLength) return;
            
            let payload = this.buffer.slice(offset, offset + payloadLength);
            
            if (masked) {
                for (let i = 0; i < payload.length; i++) {
                    payload[i] ^= maskingKey[i % 4];
                }
            }
            
            this.buffer = this.buffer.slice(offset + payloadLength);
            
            // Handle Wisp packet
            this._handleWispPacket(payload);
        }
    }
    
    _handleWispPacket(data) {
        if (data.length < 5) return;
        
        const type = data[0];
        const streamId = data.readUInt32LE(1);
        const payload = data.slice(5);
        
        switch (type) {
            case this.PACKET_TYPES.CONNECT:
                this._handleConnect(streamId, payload);
                break;
            case this.PACKET_TYPES.DATA:
                this._handleStreamData(streamId, payload);
                break;
            case this.PACKET_TYPES.CLOSE:
                this._handleClose(streamId, payload);
                break;
        }
    }
    
    _handleConnect(streamId, payload) {
        if (payload.length < 3) return;
        
        const streamType = payload[0];
        const port = payload.readUInt16LE(1);
        const hostname = payload.slice(3).toString('utf-8');
        
        console.log(`[ASTRO-WISP] Connect stream ${streamId} to ${hostname}:${port}`);
        
        // Create TCP connection
        const socket = net.connect({
            host: hostname,
            port: port
        }, () => {
            console.log(`[ASTRO-WISP] Stream ${streamId} connected`);
            
            // Send CONTINUE to indicate connection success
            this._sendContinue(streamId, 65535);
        });
        
        socket.on('data', (data) => {
            this._sendData(streamId, data);
        });
        
        socket.on('close', () => {
            this._sendClose(streamId, this.CLOSE_REASONS.VOLUNTARY);
            this.streams.delete(streamId);
        });
        
        socket.on('error', (err) => {
            console.error(`[ASTRO-WISP] Stream ${streamId} error:`, err.message);
            this._sendClose(streamId, this.CLOSE_REASONS.NETWORK);
            this.streams.delete(streamId);
        });
        
        this.streams.set(streamId, socket);
    }
    
    _handleStreamData(streamId, data) {
        const socket = this.streams.get(streamId);
        if (socket && !socket.destroyed) {
            socket.write(data);
        }
    }
    
    _handleClose(streamId, payload) {
        const socket = this.streams.get(streamId);
        if (socket) {
            socket.destroy();
            this.streams.delete(streamId);
        }
    }
    
    _sendData(streamId, data) {
        const packet = Buffer.alloc(5 + data.length);
        packet[0] = this.PACKET_TYPES.DATA;
        packet.writeUInt32LE(streamId, 1);
        data.copy(packet, 5);
        
        this._sendFrame(packet);
    }
    
    _sendContinue(streamId, bufferRemaining) {
        const packet = Buffer.alloc(9);
        packet[0] = this.PACKET_TYPES.CONTINUE;
        packet.writeUInt32LE(streamId, 1);
        packet.writeUInt32LE(bufferRemaining, 5);
        
        this._sendFrame(packet);
    }
    
    _sendClose(streamId, reason) {
        const packet = Buffer.alloc(6);
        packet[0] = this.PACKET_TYPES.CLOSE;
        packet.writeUInt32LE(streamId, 1);
        packet[5] = reason;
        
        this._sendFrame(packet);
    }
    
    _sendFrame(data) {
        // WebSocket frame encoding
        const length = data.length;
        let header;
        
        if (length < 126) {
            header = Buffer.alloc(2);
            header[0] = 0x82; // Binary frame, FIN set
            header[1] = length;
        } else if (length < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x82;
            header[1] = 126;
            header.writeUInt16BE(length, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x82;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(length), 2);
        }
        
        try {
            this.socket.write(Buffer.concat([header, data]));
        } catch (e) {
            // Socket closed
        }
    }
    
    cleanup() {
        for (const [id, socket] of this.streams) {
            socket.destroy();
        }
        this.streams.clear();
    }
}

export { AstroServer, AstroConfig, AstroRewriter };
