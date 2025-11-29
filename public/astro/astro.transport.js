/**
 * ASTRO WISP TRANSPORT
 * WebSocket multiplexing protocol for efficient proxying
 * 
 * Wisp allows multiple streams over a single WebSocket connection,
 * reducing connection overhead and evading some network filters.
 */

class WispTransport {
    constructor(wispUrl, config = {}) {
        this.wispUrl = wispUrl;
        this.config = config;
        this.socket = null;
        this.streams = new Map();
        this.nextStreamId = 1;
        this.connected = false;
        this.connecting = false;
        this.messageQueue = [];
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        
        // Wisp protocol constants
        this.WISP_VERSION = 1;
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
    }
    
    async connect() {
        if (this.connected) return;
        if (this.connecting) {
            return new Promise((resolve) => {
                const check = setInterval(() => {
                    if (this.connected) {
                        clearInterval(check);
                        resolve();
                    }
                }, 50);
            });
        }
        
        this.connecting = true;
        
        return new Promise((resolve, reject) => {
            try {
                this.socket = new WebSocket(this.wispUrl);
                this.socket.binaryType = 'arraybuffer';
                
                this.socket.onopen = () => {
                    console.log('[ASTRO-WISP] Connected');
                    this.connected = true;
                    this.connecting = false;
                    this.reconnectAttempts = 0;
                    
                    // Process queued messages
                    this._flushQueue();
                    
                    resolve();
                };
                
                this.socket.onmessage = (event) => {
                    this._handleMessage(event.data);
                };
                
                this.socket.onclose = (event) => {
                    console.log('[ASTRO-WISP] Disconnected:', event.code);
                    this.connected = false;
                    this.connecting = false;
                    
                    // Close all streams
                    for (const [id, stream] of this.streams) {
                        stream.onClose?.(this.CLOSE_REASONS.NETWORK);
                    }
                    this.streams.clear();
                    
                    // Attempt reconnect
                    this._attemptReconnect();
                };
                
                this.socket.onerror = (error) => {
                    console.error('[ASTRO-WISP] Error:', error);
                    this.connecting = false;
                    reject(error);
                };
                
            } catch (error) {
                this.connecting = false;
                reject(error);
            }
        });
    }
    
    _attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('[ASTRO-WISP] Max reconnect attempts reached');
            return;
        }
        
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        
        console.log(`[ASTRO-WISP] Reconnecting in ${delay}ms...`);
        
        setTimeout(() => {
            this.connect().catch(() => {});
        }, delay);
    }
    
    _flushQueue() {
        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            this.socket.send(message);
        }
    }
    
    _send(data) {
        if (this.connected && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(data);
        } else {
            this.messageQueue.push(data);
        }
    }
    
    _handleMessage(data) {
        const buffer = new Uint8Array(data);
        
        if (buffer.length < 5) {
            console.warn('[ASTRO-WISP] Invalid packet: too short');
            return;
        }
        
        // Parse packet header
        const type = buffer[0];
        const streamId = new DataView(buffer.buffer).getUint32(1, true);
        const payload = buffer.slice(5);
        
        const stream = this.streams.get(streamId);
        
        switch (type) {
            case this.PACKET_TYPES.DATA:
                if (stream) {
                    stream.onData?.(payload);
                }
                break;
                
            case this.PACKET_TYPES.CONTINUE:
                if (stream) {
                    // Flow control: server ready for more data
                    const bufferRemaining = new DataView(payload.buffer).getUint32(0, true);
                    stream.onContinue?.(bufferRemaining);
                }
                break;
                
            case this.PACKET_TYPES.CLOSE:
                if (stream) {
                    const reason = payload[0] || this.CLOSE_REASONS.UNKNOWN;
                    stream.onClose?.(reason);
                    this.streams.delete(streamId);
                }
                break;
        }
    }
    
    /**
     * Create a new stream to a target host
     */
    async createStream(hostname, port, streamType = 'tcp') {
        await this.connect();
        
        const streamId = this.nextStreamId++;
        
        return new Promise((resolve, reject) => {
            // Create stream object
            const stream = {
                id: streamId,
                hostname,
                port,
                type: streamType,
                open: false,
                buffer: [],
                onData: null,
                onClose: null,
                onContinue: null,
                
                // Stream methods
                write: (data) => this._streamWrite(streamId, data),
                close: () => this._streamClose(streamId)
            };
            
            this.streams.set(streamId, stream);
            
            // Build CONNECT packet
            const hostnameBytes = new TextEncoder().encode(hostname);
            const packet = new Uint8Array(5 + 1 + 2 + hostnameBytes.length);
            const view = new DataView(packet.buffer);
            
            // Header
            packet[0] = this.PACKET_TYPES.CONNECT;
            view.setUint32(1, streamId, true);
            
            // Payload: type (1) + port (2) + hostname
            packet[5] = streamType === 'udp' ? this.STREAM_TYPES.UDP : this.STREAM_TYPES.TCP;
            view.setUint16(6, port, true);
            packet.set(hostnameBytes, 8);
            
            this._send(packet);
            
            // Mark stream as open (assume success for now)
            // In production, wait for server confirmation
            stream.open = true;
            resolve(stream);
        });
    }
    
    _streamWrite(streamId, data) {
        const stream = this.streams.get(streamId);
        if (!stream || !stream.open) return;
        
        const payload = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
        const packet = new Uint8Array(5 + payload.length);
        
        packet[0] = this.PACKET_TYPES.DATA;
        new DataView(packet.buffer).setUint32(1, streamId, true);
        packet.set(payload, 5);
        
        this._send(packet);
    }
    
    _streamClose(streamId) {
        const stream = this.streams.get(streamId);
        if (!stream) return;
        
        const packet = new Uint8Array(6);
        packet[0] = this.PACKET_TYPES.CLOSE;
        new DataView(packet.buffer).setUint32(1, streamId, true);
        packet[5] = this.CLOSE_REASONS.VOLUNTARY;
        
        this._send(packet);
        
        stream.open = false;
        this.streams.delete(streamId);
    }
    
    /**
     * High-level fetch through Wisp
     */
    async fetch(url, options = {}) {
        const parsedUrl = new URL(url);
        const port = parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80);
        
        // Create stream
        const stream = await this.createStream(parsedUrl.hostname, parseInt(port));
        
        return new Promise((resolve, reject) => {
            const responseData = [];
            let headersParsed = false;
            let responseHeaders = {};
            let statusCode = 200;
            let statusText = 'OK';
            
            stream.onData = (data) => {
                if (!headersParsed) {
                    // Parse HTTP response headers
                    const text = new TextDecoder().decode(data);
                    const headerEnd = text.indexOf('\r\n\r\n');
                    
                    if (headerEnd !== -1) {
                        const headerText = text.slice(0, headerEnd);
                        const bodyText = text.slice(headerEnd + 4);
                        
                        // Parse status line
                        const lines = headerText.split('\r\n');
                        const statusLine = lines[0].match(/HTTP\/\d\.\d (\d+) (.+)/);
                        if (statusLine) {
                            statusCode = parseInt(statusLine[1]);
                            statusText = statusLine[2];
                        }
                        
                        // Parse headers
                        for (let i = 1; i < lines.length; i++) {
                            const [name, ...value] = lines[i].split(': ');
                            if (name) {
                                responseHeaders[name.toLowerCase()] = value.join(': ');
                            }
                        }
                        
                        headersParsed = true;
                        if (bodyText) {
                            responseData.push(new TextEncoder().encode(bodyText));
                        }
                    } else {
                        responseData.push(data);
                    }
                } else {
                    responseData.push(data);
                }
            };
            
            stream.onClose = (reason) => {
                if (reason === this.CLOSE_REASONS.VOLUNTARY || headersParsed) {
                    // Build response
                    const body = new Blob(responseData);
                    const headers = new Headers(responseHeaders);
                    
                    resolve(new Response(body, {
                        status: statusCode,
                        statusText,
                        headers
                    }));
                } else {
                    reject(new Error(`Stream closed: ${reason}`));
                }
            };
            
            // Build HTTP request
            const method = options.method || 'GET';
            const path = parsedUrl.pathname + parsedUrl.search;
            const headers = options.headers || {};
            
            let request = `${method} ${path} HTTP/1.1\r\n`;
            request += `Host: ${parsedUrl.host}\r\n`;
            request += `Connection: close\r\n`;
            
            for (const [name, value] of Object.entries(headers)) {
                request += `${name}: ${value}\r\n`;
            }
            
            request += '\r\n';
            
            if (options.body) {
                request += options.body;
            }
            
            stream.write(request);
        });
    }
    
    /**
     * Create a proxied WebSocket through Wisp
     */
    createWebSocket(url, protocols) {
        const parsedUrl = new URL(url);
        const port = parsedUrl.port || (parsedUrl.protocol === 'wss:' ? 443 : 80);
        
        // Create a fake WebSocket that uses Wisp stream
        const fakeWs = {
            readyState: WebSocket.CONNECTING,
            protocol: '',
            extensions: '',
            bufferedAmount: 0,
            binaryType: 'arraybuffer',
            url: url,
            onopen: null,
            onclose: null,
            onmessage: null,
            onerror: null,
            
            send: (data) => {},
            close: () => {}
        };
        
        // Create stream and set up handlers
        this.createStream(parsedUrl.hostname, parseInt(port)).then(stream => {
            fakeWs.readyState = WebSocket.OPEN;
            
            fakeWs.send = (data) => {
                stream.write(data);
            };
            
            fakeWs.close = () => {
                stream.close();
                fakeWs.readyState = WebSocket.CLOSED;
                fakeWs.onclose?.({ code: 1000, reason: '' });
            };
            
            stream.onData = (data) => {
                fakeWs.onmessage?.({ data: data.buffer });
            };
            
            stream.onClose = (reason) => {
                fakeWs.readyState = WebSocket.CLOSED;
                fakeWs.onclose?.({ code: 1006, reason: `Wisp: ${reason}` });
            };
            
            fakeWs.onopen?.({});
            
        }).catch(error => {
            fakeWs.readyState = WebSocket.CLOSED;
            fakeWs.onerror?.(error);
        });
        
        return fakeWs;
    }
    
    disconnect() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.connected = false;
        this.streams.clear();
    }
}

/**
 * ASTRO EPOXY TRANSPORT
 * High-performance WASM-based proxy (fallback implementation)
 */
class EpoxyTransport {
    constructor(bareUrl, config = {}) {
        this.bareUrl = bareUrl;
        this.config = config;
    }
    
    async fetch(url, options = {}) {
        // Epoxy would use WASM, but we fall back to bare server
        return this._bareFetch(url, options);
    }
    
    async _bareFetch(url, options) {
        const headers = options.headers || {};
        
        const bareResponse = await fetch(this.bareUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Bare-URL': url,
                'X-Bare-Method': options.method || 'GET',
                'X-Bare-Headers': JSON.stringify(headers)
            },
            body: options.body
        });
        
        return bareResponse;
    }
    
    createWebSocket(url, protocols) {
        // Fall back to bare WebSocket
        const encodedUrl = btoa(url);
        const wsUrl = `${this.bareUrl.replace('http', 'ws')}ws/${encodedUrl}`;
        return new WebSocket(wsUrl, protocols);
    }
}

/**
 * ASTRO TRANSPORT MANAGER
 * Manages multiple transport types with automatic fallback
 */
class AstroTransportManager {
    constructor(config) {
        this.config = config;
        this.transports = new Map();
        this.activeTransport = null;
        this.fallbackOrder = ['wisp', 'epoxy', 'bare'];
    }
    
    async initialize() {
        const wispUrl = `${location.origin.replace('http', 'ws')}${this.config.wisp}`;
        const bareUrl = `${location.origin}${this.config.bare}`;
        
        // Try transports in order
        for (const type of this.fallbackOrder) {
            try {
                const transport = await this._createTransport(type, wispUrl, bareUrl);
                if (transport) {
                    this.transports.set(type, transport);
                    if (!this.activeTransport) {
                        this.activeTransport = transport;
                        console.log(`[ASTRO] Active transport: ${type}`);
                    }
                }
            } catch (error) {
                console.warn(`[ASTRO] Failed to initialize ${type} transport:`, error);
            }
        }
        
        if (!this.activeTransport) {
            throw new Error('No transport available');
        }
    }
    
    async _createTransport(type, wispUrl, bareUrl) {
        switch (type) {
            case 'wisp':
                const wisp = new WispTransport(wispUrl, this.config);
                await wisp.connect();
                return wisp;
            case 'epoxy':
                return new EpoxyTransport(bareUrl, this.config);
            case 'bare':
                return new EpoxyTransport(bareUrl, this.config); // Same impl for now
            default:
                return null;
        }
    }
    
    async fetch(url, options) {
        try {
            return await this.activeTransport.fetch(url, options);
        } catch (error) {
            // Try fallback transports
            for (const [type, transport] of this.transports) {
                if (transport !== this.activeTransport) {
                    try {
                        const response = await transport.fetch(url, options);
                        this.activeTransport = transport;
                        console.log(`[ASTRO] Switched to ${type} transport`);
                        return response;
                    } catch (e) {
                        continue;
                    }
                }
            }
            throw error;
        }
    }
    
    createWebSocket(url, protocols) {
        return this.activeTransport.createWebSocket(url, protocols);
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { WispTransport, EpoxyTransport, AstroTransportManager };
}

if (typeof window !== 'undefined') {
    window.WispTransport = WispTransport;
    window.EpoxyTransport = EpoxyTransport;
    window.AstroTransportManager = AstroTransportManager;
}
