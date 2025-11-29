/**
 * UV Handler - Client-side injection script
 * 
 * This script is injected into every proxied page to:
 * 1. Override browser APIs (fetch, XHR, WebSocket, etc.)
 * 2. Rewrite dynamically added URLs
 * 3. Spoof location and document properties
 * 4. Block detection attempts
 */

(function() {
    'use strict';
    
    // Prevent double-injection
    if (window.__uv$hooked) return;
    window.__uv$hooked = true;
    
    // Get configuration
    const config = window.__uv$config || {
        prefix: '/uv/service/',
        bare: '/bare/',
        encodeUrl: (str) => {
            const key = 2;
            return encodeURIComponent(
                str.split('').map((char) => 
                    String.fromCharCode(char.charCodeAt(0) ^ key)
                ).join('')
            );
        },
        decodeUrl: (str) => {
            const key = 2;
            try {
                const decoded = decodeURIComponent(str);
                return decoded.split('').map((char) => 
                    String.fromCharCode(char.charCodeAt(0) ^ key)
                ).join('');
            } catch {
                return str;
            }
        }
    };
    
    // Get the real URL from the page (set by server)
    const metaUrl = document.querySelector('meta[name="uv-url"]');
    const originalUrlStr = metaUrl ? metaUrl.content : config.sourceUrl(location.href);
    const __originalUrl = new URL(originalUrlStr || location.href);
    
    // Store native methods before overriding
    const nativeMethods = {
        fetch: window.fetch,
        XMLHttpRequest: window.XMLHttpRequest,
        WebSocket: window.WebSocket,
        Worker: window.Worker,
        SharedWorker: window.SharedWorker,
        EventSource: window.EventSource,
        open: window.open,
        postMessage: window.postMessage,
        addEventListener: window.addEventListener,
        removeEventListener: window.removeEventListener,
        
        // DOM methods
        createElement: document.createElement.bind(document),
        createElementNS: document.createElementNS.bind(document),
        setAttribute: Element.prototype.setAttribute,
        getAttribute: Element.prototype.getAttribute,
        appendChild: Node.prototype.appendChild,
        insertBefore: Node.prototype.insertBefore,
        
        // Object methods
        defineProperty: Object.defineProperty,
        getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
        
        // Function methods
        toString: Function.prototype.toString
    };
    
    /**
     * URL Rewriting Utilities
     */
    const urlRewriter = {
        needsProxy(url) {
            if (!url || typeof url !== 'string') return false;
            if (url.startsWith('data:')) return false;
            if (url.startsWith('blob:')) return false;
            if (url.startsWith('javascript:')) return false;
            if (url.startsWith('#')) return false;
            if (url.startsWith('about:')) return false;
            if (url.startsWith(location.origin + config.prefix)) return false;
            if (url.startsWith(location.origin + config.bare)) return false;
            return true;
        },
        
        rewriteUrl(url, base = __originalUrl.href) {
            if (!this.needsProxy(url)) return url;
            
            try {
                const resolved = new URL(url, base);
                const encoded = config.encodeUrl(resolved.href);
                return location.origin + config.prefix + encoded;
            } catch {
                return url;
            }
        },
        
        sourceUrl(url) {
            if (!url || !url.startsWith(location.origin + config.prefix)) {
                return url;
            }
            const encoded = url.slice((location.origin + config.prefix).length);
            return config.decodeUrl(encoded);
        }
    };
    
    /**
     * Override fetch API
     */
    window.fetch = function(input, init) {
        if (typeof input === 'string') {
            input = urlRewriter.rewriteUrl(input);
        } else if (input instanceof Request) {
            const newUrl = urlRewriter.rewriteUrl(input.url);
            if (newUrl !== input.url) {
                input = new Request(newUrl, input);
            }
        } else if (input instanceof URL) {
            input = urlRewriter.rewriteUrl(input.href);
        }
        
        return nativeMethods.fetch.call(window, input, init);
    };
    
    // Make it look native
    window.fetch.toString = () => 'function fetch() { [native code] }';
    
    /**
     * Override XMLHttpRequest
     */
    const OriginalXHR = nativeMethods.XMLHttpRequest;
    window.XMLHttpRequest = function() {
        const xhr = new OriginalXHR();
        const originalOpen = xhr.open;
        
        xhr.open = function(method, url, ...args) {
            url = urlRewriter.rewriteUrl(url);
            return originalOpen.call(this, method, url, ...args);
        };
        
        // Override responseURL getter
        nativeMethods.defineProperty(xhr, 'responseURL', {
            get: function() {
                const url = this._uvResponseURL || '';
                return urlRewriter.sourceUrl(url);
            },
            configurable: true
        });
        
        return xhr;
    };
    window.XMLHttpRequest.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest.toString = () => 'function XMLHttpRequest() { [native code] }';
    
    /**
     * Override WebSocket
     */
    if (nativeMethods.WebSocket) {
        window.WebSocket = function(url, protocols) {
            // WebSocket URLs need special handling through bare server
            const wsUrl = urlRewriter.rewriteUrl(url);
            console.log('[UV] WebSocket:', url, '->', wsUrl);
            return new nativeMethods.WebSocket(wsUrl, protocols);
        };
        window.WebSocket.prototype = nativeMethods.WebSocket.prototype;
        window.WebSocket.CONNECTING = 0;
        window.WebSocket.OPEN = 1;
        window.WebSocket.CLOSING = 2;
        window.WebSocket.CLOSED = 3;
        window.WebSocket.toString = () => 'function WebSocket() { [native code] }';
    }
    
    /**
     * Override Worker
     */
    if (nativeMethods.Worker) {
        window.Worker = function(url, options) {
            url = urlRewriter.rewriteUrl(url);
            return new nativeMethods.Worker(url, options);
        };
        window.Worker.prototype = nativeMethods.Worker.prototype;
        window.Worker.toString = () => 'function Worker() { [native code] }';
    }
    
    /**
     * Override window.open
     */
    window.open = function(url, target, features) {
        if (url) {
            url = urlRewriter.rewriteUrl(url);
        }
        return nativeMethods.open.call(window, url, target, features);
    };
    window.open.toString = () => 'function open() { [native code] }';
    
    /**
     * Override EventSource
     */
    if (nativeMethods.EventSource) {
        window.EventSource = function(url, eventSourceInitDict) {
            url = urlRewriter.rewriteUrl(url);
            return new nativeMethods.EventSource(url, eventSourceInitDict);
        };
        window.EventSource.prototype = nativeMethods.EventSource.prototype;
        window.EventSource.toString = () => 'function EventSource() { [native code] }';
    }
    
    /**
     * Override Element.setAttribute
     */
    const urlAttributes = new Set(['href', 'src', 'action', 'data', 'poster', 'srcset']);
    
    Element.prototype.setAttribute = function(name, value) {
        if (urlAttributes.has(name.toLowerCase()) && typeof value === 'string') {
            value = urlRewriter.rewriteUrl(value);
        }
        return nativeMethods.setAttribute.call(this, name, value);
    };
    
    /**
     * Override property setters for URL attributes
     */
    const urlProperties = {
        'HTMLAnchorElement': ['href'],
        'HTMLAreaElement': ['href'],
        'HTMLLinkElement': ['href'],
        'HTMLBaseElement': ['href'],
        'HTMLImageElement': ['src', 'srcset'],
        'HTMLScriptElement': ['src'],
        'HTMLIFrameElement': ['src'],
        'HTMLEmbedElement': ['src'],
        'HTMLSourceElement': ['src', 'srcset'],
        'HTMLTrackElement': ['src'],
        'HTMLMediaElement': ['src'],
        'HTMLVideoElement': ['src', 'poster'],
        'HTMLAudioElement': ['src'],
        'HTMLFormElement': ['action'],
        'HTMLInputElement': ['src', 'formAction'],
        'HTMLButtonElement': ['formAction'],
        'HTMLObjectElement': ['data']
    };
    
    for (const [elementName, props] of Object.entries(urlProperties)) {
        const ElementClass = window[elementName];
        if (!ElementClass) continue;
        
        for (const prop of props) {
            const descriptor = nativeMethods.getOwnPropertyDescriptor(ElementClass.prototype, prop);
            if (descriptor && descriptor.set) {
                const originalSetter = descriptor.set;
                const originalGetter = descriptor.get;
                
                nativeMethods.defineProperty(ElementClass.prototype, prop, {
                    get: function() {
                        const value = originalGetter ? originalGetter.call(this) : undefined;
                        return urlRewriter.sourceUrl(value);
                    },
                    set: function(value) {
                        if (typeof value === 'string') {
                            value = urlRewriter.rewriteUrl(value);
                        }
                        if (originalSetter) {
                            originalSetter.call(this, value);
                        }
                    },
                    configurable: true,
                    enumerable: true
                });
            }
        }
    }
    
    /**
     * Location Spoofing
     */
    const locationHandler = {
        get(target, prop, receiver) {
            switch (prop) {
                case 'href': return __originalUrl.href;
                case 'origin': return __originalUrl.origin;
                case 'protocol': return __originalUrl.protocol;
                case 'host': return __originalUrl.host;
                case 'hostname': return __originalUrl.hostname;
                case 'port': return __originalUrl.port;
                case 'pathname': return __originalUrl.pathname;
                case 'search': return __originalUrl.search;
                case 'hash': return __originalUrl.hash;
                case 'toString': return () => __originalUrl.href;
                case 'valueOf': return () => __originalUrl.href;
                case 'assign': 
                    return (url) => {
                        location.assign(urlRewriter.rewriteUrl(url));
                    };
                case 'replace':
                    return (url) => {
                        location.replace(urlRewriter.rewriteUrl(url));
                    };
                case 'reload':
                    return () => location.reload();
                default:
                    return typeof location[prop] === 'function' 
                        ? location[prop].bind(location)
                        : location[prop];
            }
        },
        set(target, prop, value) {
            if (prop === 'href') {
                location.href = urlRewriter.rewriteUrl(value);
                return true;
            }
            if (prop === 'hash') {
                location.hash = value;
                return true;
            }
            if (prop === 'search') {
                // Build new URL with search
                const newUrl = new URL(__originalUrl.href);
                newUrl.search = value;
                location.href = urlRewriter.rewriteUrl(newUrl.href);
                return true;
            }
            location[prop] = value;
            return true;
        }
    };
    
    const proxyLocation = new Proxy({}, locationHandler);
    
    // Try to replace document.location (may fail)
    try {
        nativeMethods.defineProperty(document, 'location', {
            get: () => proxyLocation,
            set: (value) => { location.href = urlRewriter.rewriteUrl(value); },
            configurable: false
        });
    } catch (e) {
        console.warn('[UV] Could not override document.location');
    }
    
    /**
     * Document Property Spoofing
     */
    const spoofedProps = {
        'domain': {
            get: () => __originalUrl.hostname,
            set: () => {} // Ignore
        },
        'URL': {
            get: () => __originalUrl.href
        },
        'documentURI': {
            get: () => __originalUrl.href
        },
        'referrer': {
            get: () => '' // Hide referrer
        },
        'cookie': {
            get: function() {
                // Scope cookies to original domain
                return document._uvCookies || '';
            },
            set: function(value) {
                document._uvCookies = value;
            }
        }
    };
    
    for (const [prop, handlers] of Object.entries(spoofedProps)) {
        try {
            nativeMethods.defineProperty(document, prop, {
                get: handlers.get,
                set: handlers.set,
                configurable: true
            });
        } catch {}
    }
    
    /**
     * Anti-Detection Measures
     */
    
    // Hide visibility changes
    try {
        nativeMethods.defineProperty(document, 'hidden', {
            get: () => false,
            configurable: true
        });
        nativeMethods.defineProperty(document, 'visibilityState', {
            get: () => 'visible',
            configurable: true
        });
    } catch {}
    
    // Block visibility change events
    const originalAddEventListener = nativeMethods.addEventListener;
    window.addEventListener = function(type, listener, options) {
        if (type === 'visibilitychange') {
            return; // Block
        }
        return originalAddEventListener.call(this, type, listener, options);
    };
    document.addEventListener = function(type, listener, options) {
        if (type === 'visibilitychange') {
            return; // Block
        }
        return originalAddEventListener.call(this, type, listener, options);
    };
    
    // Disable WebRTC (IP leak prevention)
    try {
        window.RTCPeerConnection = function() {
            throw new Error('WebRTC disabled for privacy');
        };
        window.RTCPeerConnection.toString = () => 'function RTCPeerConnection() { [native code] }';
    } catch {}
    
    try {
        window.webkitRTCPeerConnection = function() {
            throw new Error('WebRTC disabled for privacy');
        };
    } catch {}
    
    // Block navigator.sendBeacon to known tracking domains
    const originalSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function(url, data) {
        const urlObj = new URL(url, location.href);
        const blockedDomains = [
            'goguardian.com', 'securly.com', 'lightspeedsystems.com',
            'bark.us', 'google-analytics.com', 'doubleclick.net'
        ];
        
        if (blockedDomains.some(d => urlObj.hostname.includes(d))) {
            console.log('[UV] Blocked beacon to:', url);
            return true; // Pretend success
        }
        
        return originalSendBeacon.call(navigator, urlRewriter.rewriteUrl(url), data);
    };
    
    /**
     * History API Spoofing
     */
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    
    history.pushState = function(state, title, url) {
        if (url) {
            url = urlRewriter.rewriteUrl(url);
        }
        return originalPushState.call(this, state, title, url);
    };
    
    history.replaceState = function(state, title, url) {
        if (url) {
            url = urlRewriter.rewriteUrl(url);
        }
        return originalReplaceState.call(this, state, title, url);
    };
    
    /**
     * postMessage Origin Spoofing
     */
    window.postMessage = function(message, targetOrigin, transfer) {
        // Rewrite targetOrigin if needed
        if (targetOrigin && targetOrigin !== '*') {
            try {
                const targetUrl = new URL(targetOrigin);
                if (targetUrl.origin !== location.origin) {
                    // Allow cross-origin messaging through proxy
                    targetOrigin = '*';
                }
            } catch {}
        }
        return nativeMethods.postMessage.call(window, message, targetOrigin, transfer);
    };
    
    /**
     * Handle dynamically created elements
     */
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                
                // Rewrite URLs on new elements
                const rewriteElement = (el) => {
                    for (const attr of urlAttributes) {
                        const value = el.getAttribute(attr);
                        if (value && urlRewriter.needsProxy(value)) {
                            const rewritten = urlRewriter.rewriteUrl(value);
                            if (rewritten !== value) {
                                nativeMethods.setAttribute.call(el, attr, rewritten);
                            }
                        }
                    }
                };
                
                rewriteElement(node);
                
                // Also check children
                if (node.querySelectorAll) {
                    node.querySelectorAll('[href], [src], [action], [data], [poster], [srcset]')
                        .forEach(rewriteElement);
                }
            }
        }
    });
    
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
    
    /**
     * Console identification
     */
    console.log(
        '%c[UV Proxy]%c Hooks installed for %c' + __originalUrl.href,
        'background: #4CAF50; color: white; padding: 2px 6px; border-radius: 3px;',
        'color: inherit;',
        'color: #2196F3; font-weight: bold;'
    );
    
    // Expose for debugging
    window.__uv = {
        config,
        originalUrl: __originalUrl,
        rewriteUrl: urlRewriter.rewriteUrl.bind(urlRewriter),
        sourceUrl: urlRewriter.sourceUrl.bind(urlRewriter)
    };
    
})();
