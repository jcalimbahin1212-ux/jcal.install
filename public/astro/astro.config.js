/**
 * ASTRO PROXY CONFIGURATION
 * Client-side configuration for Astro proxy
 */

const AstroConfig = {
    // URL prefixes
    prefix: '/astro/~/',
    bare: '/astro/bare/',
    wisp: '/astro/wisp/',
    cdn: '/astro/static/',
    
    // Encoding settings
    codec: 'quantum',
    encodeKey: 'AstroProxyQuantumKey2024!@#$',
    
    // Transport settings
    transport: 'auto', // 'wisp', 'epoxy', 'bare', 'auto'
    fallbackTransports: ['wisp', 'epoxy', 'bare'],
    
    // Stealth settings
    stealth: {
        enabled: true,
        fingerprint: 'chrome',
        jitter: true,
        timingNoise: [50, 200],
        headerRotation: true
    },
    
    // Anti-detection
    antiDetection: {
        goGuardianBypass: true,
        securlyBypass: true,
        lightspeedBypass: true,
        ibossBlocking: true,
        contentFilterEvasion: true
    },
    
    // Feature flags
    features: {
        serviceWorker: true,
        cookieSync: true,
        webSocketProxy: true,
        workerProxy: true,
        iframeProxy: true,
        shadowDOMSupport: true,
        webRTCProxy: true,
        webGLSpoof: true,
        canvasNoise: true,
        audioContextSpoof: true
    },
    
    // Caching
    cache: {
        enabled: true,
        strategy: 'intelligent',
        maxAge: 3600,
        staleWhileRevalidate: true
    },
    
    // Script locations
    scripts: {
        bundle: '/astro/astro.bundle.js',
        client: '/astro/astro.client.js',
        sw: '/astro/astro.sw.js',
        transport: '/astro/astro.transport.js',
        config: '/astro/astro.config.js'
    },
    
    // Encode URL
    encode: function(str) {
        if (!str) return str;
        let encoded = '';
        for (let i = 0; i < str.length; i++) {
            encoded += String.fromCharCode(str.charCodeAt(i) ^ this.encodeKey.charCodeAt(i % this.encodeKey.length));
        }
        return btoa(encoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '~');
    },
    
    // Decode URL
    decode: function(str) {
        if (!str) return str;
        let b64 = str.replace(/-/g, '+').replace(/_/g, '/').replace(/~/g, '=');
        let decoded = atob(b64);
        let original = '';
        for (let i = 0; i < decoded.length; i++) {
            original += String.fromCharCode(decoded.charCodeAt(i) ^ this.encodeKey.charCodeAt(i % this.encodeKey.length));
        }
        return original;
    },
    
    // Generate proxy URL
    proxyUrl: function(url) {
        return this.prefix + this.encode(url);
    },
    
    // Extract original URL
    extractUrl: function(proxyUrl) {
        if (!proxyUrl.startsWith(this.prefix)) return null;
        return this.decode(proxyUrl.slice(this.prefix.length));
    }
};

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstroConfig;
}

if (typeof window !== 'undefined') {
    window.AstroConfig = AstroConfig;
    window.__astro = AstroConfig;
}

if (typeof self !== 'undefined') {
    self.AstroConfig = AstroConfig;
    self.__astro = AstroConfig;
}
