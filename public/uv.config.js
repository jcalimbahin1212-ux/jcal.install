/**
 * UV Configuration
 * 
 * This file configures the UV-style proxy system.
 * It matches the configuration used by Holy Unblocker and similar services.
 */

(function() {
    'use strict';
    
    // XOR codec - simple but effective obfuscation
    const xor = {
        encode: (str) => {
            const key = 2;
            return encodeURIComponent(
                str.split('').map((char) => 
                    String.fromCharCode(char.charCodeAt(0) ^ key)
                ).join('')
            );
        },
        decode: (str) => {
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
    
    // Base64 codec - standard encoding
    const base64 = {
        encode: (str) => {
            return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
                (match, p1) => String.fromCharCode('0x' + p1)
            ));
        },
        decode: (str) => {
            try {
                return decodeURIComponent(atob(str).split('').map((c) => {
                    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
                }).join(''));
            } catch {
                return str;
            }
        }
    };
    
    // Plain codec - no encoding (for debugging)
    const plain = {
        encode: (str) => encodeURIComponent(str),
        decode: (str) => decodeURIComponent(str)
    };
    
    // Shuffle codec - position-based scrambling
    const shuffle = {
        encode: (str) => {
            const shuffled = str.split('').map((char, i) => {
                return String.fromCharCode(char.charCodeAt(0) + (i % 5));
            }).join('');
            return encodeURIComponent(shuffled);
        },
        decode: (str) => {
            try {
                const decoded = decodeURIComponent(str);
                return decoded.split('').map((char, i) => {
                    return String.fromCharCode(char.charCodeAt(0) - (i % 5));
                }).join('');
            } catch {
                return str;
            }
        }
    };
    
    // Configuration object
    const __uv$config = {
        // Path prefix for proxied URLs
        prefix: '/uv/service/',
        
        // Bare server path
        bare: '/bare/',
        
        // Codec to use (xor is recommended for school bypass)
        encodeUrl: xor.encode,
        decodeUrl: xor.decode,
        
        // Service worker script location
        sw: '/uv-sw.js',
        
        // Handler script (injected into proxied pages)
        handler: '/uv-handler.js',
        
        // Bundle script
        bundle: '/uv-bundle.js',
        
        // Client script (for runtime hooks)
        client: '/uv-client.js',
        
        // Config script path
        config: '/uv.config.js',
        
        // Available codecs
        codecs: { xor, base64, plain, shuffle },
        
        // Helper functions
        rewriteUrl: function(url) {
            if (!url) return url;
            
            // Skip certain protocols
            if (url.startsWith('data:') || 
                url.startsWith('blob:') || 
                url.startsWith('javascript:') ||
                url.startsWith('#') ||
                url.startsWith('about:')) {
                return url;
            }
            
            // Already proxied?
            if (url.startsWith(location.origin + this.prefix)) {
                return url;
            }
            
            // Resolve relative URLs
            try {
                const absoluteUrl = new URL(url, this.meta?.url || location.href).href;
                const encoded = this.encodeUrl(absoluteUrl);
                return location.origin + this.prefix + encoded;
            } catch {
                return url;
            }
        },
        
        sourceUrl: function(url) {
            if (!url) return url;
            
            // Check if it's a proxied URL
            if (!url.startsWith(location.origin + this.prefix)) {
                return url;
            }
            
            const encoded = url.slice((location.origin + this.prefix).length);
            return this.decodeUrl(encoded);
        },
        
        // Meta information (set at runtime)
        meta: {
            url: null,
            base: null,
            origin: null
        }
    };
    
    // Expose globally
    if (typeof self !== 'undefined') {
        self.__uv$config = __uv$config;
    }
    if (typeof window !== 'undefined') {
        window.__uv$config = __uv$config;
    }
    if (typeof global !== 'undefined') {
        global.__uv$config = __uv$config;
    }
    
    // Export for modules
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = __uv$config;
    }
})();
