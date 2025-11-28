/**
 * FilterBypass.js
 * 
 * A comprehensive filter bypass system that employs multiple evasion techniques
 * to circumvent web content filters commonly used in educational environments.
 * 
 * This module specifically targets:
 * - GoGuardian
 * - Securly
 * - Lightspeed Systems
 * - Cisco Umbrella
 * - Bark
 * - ContentKeeper
 * 
 * Techniques:
 * 1. Request Fragmentation
 * 2. Header Spoofing
 * 3. Content Rewriting
 * 4. SNI Manipulation (simulated)
 * 5. Timing Analysis Prevention
 * 6. Behavioral Mimicry
 */

import { randomBytes, createHash } from "crypto";

// --- Filter Detection ---
export class FilterDetector {
    constructor() {
        this.detectedFilters = new Set();
        this.signatures = {
            goguardian: {
                headers: ['x-goguardian', 'x-gg-session'],
                scripts: ['goguardian', 'gg-ext'],
                domains: ['goguardian.com', 'goguardianapp.com']
            },
            securly: {
                headers: ['x-securly'],
                scripts: ['securly'],
                domains: ['securly.com', 'securly.io']
            },
            lightspeed: {
                headers: ['x-lightspeed', 'x-ls-reqid'],
                scripts: ['lightspeed', 'relay.school'],
                domains: ['relay.school', 'lightspeedsystems.com']
            },
            umbrella: {
                headers: ['x-umbrella'],
                scripts: ['umbrella', 'opendns'],
                domains: ['opendns.com', 'umbrella.com']
            },
            bark: {
                headers: ['x-bark'],
                scripts: ['bark'],
                domains: ['bark.us']
            }
        };
    }
    
    /**
     * Analyzes request/response for filter signatures
     */
    detectFromHeaders(headers) {
        for (const [filterName, sigs] of Object.entries(this.signatures)) {
            for (const headerName of sigs.headers) {
                if (headers[headerName] || headers[headerName.toLowerCase()]) {
                    this.detectedFilters.add(filterName);
                }
            }
        }
        return this.detectedFilters;
    }
    
    /**
     * Analyzes HTML content for filter scripts
     */
    detectFromContent(html) {
        const lowerHtml = html.toLowerCase();
        
        for (const [filterName, sigs] of Object.entries(this.signatures)) {
            for (const script of sigs.scripts) {
                if (lowerHtml.includes(script)) {
                    this.detectedFilters.add(filterName);
                }
            }
        }
        return this.detectedFilters;
    }
    
    getDetectedFilters() {
        return Array.from(this.detectedFilters);
    }
}

// --- Advanced Content Rewriter ---
export class AdvancedContentRewriter {
    constructor() {
        // Homoglyph substitutions (looks identical but different unicode)
        this.homoglyphs = {
            'a': 'а', // Cyrillic
            'e': 'е',
            'o': 'о',
            'p': 'р',
            'c': 'с',
            'x': 'х',
            'y': 'у',
            'i': 'і', // Ukrainian
            'A': 'А',
            'B': 'В',
            'C': 'С',
            'E': 'Е',
            'H': 'Н',
            'K': 'К',
            'M': 'М',
            'O': 'О',
            'P': 'Р',
            'T': 'Т',
            'X': 'Х'
        };
        
        // Words that commonly trigger filters
        this.blockedWords = [
            'game', 'games', 'gaming', 'play', 'player', 'playing',
            'proxy', 'proxies', 'vpn', 'unblock', 'bypass', 'tunnel',
            'hack', 'cheat', 'exploit', 'crack', 'torrent',
            'anime', 'manga', 'stream', 'movie', 'video',
            'social', 'media', 'chat', 'message', 'dating',
            'gambling', 'casino', 'bet', 'poker'
        ];
    }
    
    /**
     * Applies homoglyph substitution to evade keyword filters
     */
    applyHomoglyphs(text, probability = 0.3) {
        let result = '';
        for (const char of text) {
            if (this.homoglyphs[char] && Math.random() < probability) {
                result += this.homoglyphs[char];
            } else {
                result += char;
            }
        }
        return result;
    }
    
    /**
     * Inserts zero-width characters to break up keywords
     */
    insertZeroWidth(text) {
        const zwChars = [
            '\u200B', // Zero-width space
            '\u200C', // Zero-width non-joiner
            '\u200D', // Zero-width joiner
            '\uFEFF'  // Zero-width no-break space
        ];
        
        let result = '';
        for (let i = 0; i < text.length; i++) {
            result += text[i];
            // Insert zero-width char every 2-4 characters
            if (i > 0 && i % (2 + Math.floor(Math.random() * 3)) === 0) {
                result += zwChars[Math.floor(Math.random() * zwChars.length)];
            }
        }
        return result;
    }
    
    /**
     * Rewrites blocked words with safe alternatives
     */
    rewriteBlockedWords(html) {
        let rewritten = html;
        
        for (const word of this.blockedWords) {
            const regex = new RegExp(`\\b${word}\\b`, 'gi');
            rewritten = rewritten.replace(regex, (match) => {
                // Use homoglyph version
                return this.applyHomoglyphs(match, 0.5);
            });
        }
        
        return rewritten;
    }
    
    /**
     * Removes filter-injected scripts
     */
    removeFilterScripts(html) {
        let cleaned = html;
        
        // Remove GoGuardian scripts
        cleaned = cleaned.replace(/<script[^>]*goguardian[^>]*>[\s\S]*?<\/script>/gi, '');
        cleaned = cleaned.replace(/<script[^>]*gg-ext[^>]*>[\s\S]*?<\/script>/gi, '');
        
        // Remove Securly scripts
        cleaned = cleaned.replace(/<script[^>]*securly[^>]*>[\s\S]*?<\/script>/gi, '');
        
        // Remove Lightspeed scripts
        cleaned = cleaned.replace(/<script[^>]*lightspeed[^>]*>[\s\S]*?<\/script>/gi, '');
        cleaned = cleaned.replace(/<script[^>]*relay\.school[^>]*>[\s\S]*?<\/script>/gi, '');
        
        // Remove any script with common filter keywords
        cleaned = cleaned.replace(/<script[^>]*(filter|monitor|track|block)[^>]*>[\s\S]*?<\/script>/gi, '');
        
        // Remove filter-related iframes
        cleaned = cleaned.replace(/<iframe[^>]*(goguardian|securly|lightspeed|umbrella|bark)[^>]*>[\s\S]*?<\/iframe>/gi, '');
        
        return cleaned;
    }
    
    /**
     * Injects anti-detection scripts
     */
    injectAntiDetection(html) {
        const antiDetectionScript = `
<script>
(function() {
    'use strict';
    
    // Prevent filter extensions from detecting page content
    const originalGetElementsByTagName = document.getElementsByTagName;
    document.getElementsByTagName = function(tagName) {
        const elements = originalGetElementsByTagName.call(document, tagName);
        if (tagName.toLowerCase() === 'script') {
            return Array.from(elements).filter(el => {
                const src = el.src || '';
                const content = el.textContent || '';
                return !src.includes('goguardian') && 
                       !src.includes('securly') && 
                       !src.includes('lightspeed') &&
                       !content.includes('goguardian') &&
                       !content.includes('securly');
            });
        }
        return elements;
    };
    
    // Override visibility API to always report visible
    Object.defineProperty(document, 'hidden', { value: false, writable: false });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false });
    
    // Disable filter-related event listeners
    const blockedEvents = ['blur', 'focus', 'visibilitychange'];
    const originalAddEventListener = window.addEventListener;
    window.addEventListener = function(type, listener, options) {
        if (blockedEvents.includes(type)) {
            return;
        }
        return originalAddEventListener.call(window, type, listener, options);
    };
    
    // Spoof window dimensions to avoid screen monitoring
    Object.defineProperty(window, 'innerWidth', { value: 1920, writable: false });
    Object.defineProperty(window, 'innerHeight', { value: 1080, writable: false });
    Object.defineProperty(window, 'outerWidth', { value: 1920, writable: false });
    Object.defineProperty(window, 'outerHeight', { value: 1080, writable: false });
    
    // Block screenshot APIs
    if (navigator.mediaDevices) {
        navigator.mediaDevices.getDisplayMedia = function() {
            return Promise.reject(new Error('Permission denied'));
        };
    }
    
    // Disable WebRTC to prevent IP leaks
    if (window.RTCPeerConnection) {
        window.RTCPeerConnection = function() {
            throw new Error('WebRTC disabled for privacy');
        };
    }
    
    console.log('[AstraCore] Anti-detection measures active');
})();
</script>`;
        
        // Inject after <head>
        return html.replace(/<head>/i, '<head>' + antiDetectionScript);
    }
    
    /**
     * Full content transformation pipeline
     */
    transform(html, options = {}) {
        let result = html;
        
        if (options.removeFilterScripts !== false) {
            result = this.removeFilterScripts(result);
        }
        
        if (options.rewriteBlockedWords !== false) {
            result = this.rewriteBlockedWords(result);
        }
        
        if (options.injectAntiDetection !== false) {
            result = this.injectAntiDetection(result);
        }
        
        return result;
    }
}

// --- Request Fragmenter ---
export class RequestFragmenter {
    /**
     * Splits a URL into multiple seemingly innocent requests
     */
    static fragmentUrl(url) {
        const urlObj = new URL(url);
        
        // Fragment into parts
        return {
            protocol: urlObj.protocol,
            host: urlObj.host,
            pathname: urlObj.pathname,
            search: urlObj.search,
            hash: urlObj.hash,
            // Encoded version for transmission
            encoded: Buffer.from(url).toString('base64url')
        };
    }
    
    /**
     * Reassembles URL from fragments
     */
    static reassembleUrl(fragments) {
        if (fragments.encoded) {
            return Buffer.from(fragments.encoded, 'base64url').toString('utf-8');
        }
        return `${fragments.protocol}//${fragments.host}${fragments.pathname}${fragments.search}${fragments.hash}`;
    }
}

// --- Behavioral Mimicry ---
export class BehavioralMimicry {
    constructor() {
        this.mouseMovements = [];
        this.scrollPatterns = [];
        this.keystrokeTimings = [];
    }
    
    /**
     * Generates human-like request patterns
     */
    generateHumanPattern() {
        // Typical human browsing: read time, scroll, click pattern
        const readTime = 2000 + Math.random() * 8000; // 2-10 seconds
        const scrollInterval = 500 + Math.random() * 2000;
        const clickDelay = 100 + Math.random() * 300;
        
        return {
            initialDelay: 50 + Math.random() * 150,
            readTime,
            scrollInterval,
            clickDelay,
            mouseJitter: Math.random() * 10
        };
    }
    
    /**
     * Adds human-like headers to request
     */
    humanizeHeaders(headers) {
        const humanized = { ...headers };
        
        // Add realistic timing headers
        humanized['X-Request-Start'] = Date.now().toString();
        
        // Add viewport hint
        humanized['Viewport-Width'] = '1920';
        humanized['DPR'] = '1';
        
        // Add device memory hint
        humanized['Device-Memory'] = '8';
        
        // Add connection hint
        humanized['Downlink'] = '10';
        humanized['ECT'] = '4g';
        humanized['RTT'] = '50';
        
        return humanized;
    }
}

// --- Main Filter Bypass Orchestrator ---
export class FilterBypass {
    constructor(config = {}) {
        this.config = {
            aggressiveMode: config.aggressiveMode ?? false,
            enableHomoglyphs: config.enableHomoglyphs ?? true,
            enableZeroWidth: config.enableZeroWidth ?? false,
            enableAntiDetection: config.enableAntiDetection ?? true,
            removeFilterScripts: config.removeFilterScripts ?? true,
            humanizeBehavior: config.humanizeBehavior ?? true,
            ...config
        };
        
        this.detector = new FilterDetector();
        this.rewriter = new AdvancedContentRewriter();
        this.mimicry = new BehavioralMimicry();
        
        this.stats = {
            requestsProcessed: 0,
            filtersDetected: [],
            transformationsApplied: 0
        };
    }
    
    /**
     * Processes a request through the bypass pipeline
     */
    async processRequest(url, headers = {}) {
        this.stats.requestsProcessed++;
        
        // Detect any filters in the request headers
        this.detector.detectFromHeaders(headers);
        
        // Build stealth headers
        let stealthHeaders = this._buildStealthHeaders(headers);
        
        // Apply behavioral mimicry
        if (this.config.humanizeBehavior) {
            stealthHeaders = this.mimicry.humanizeHeaders(stealthHeaders);
        }
        
        // Fragment URL if in aggressive mode
        let targetUrl = url;
        if (this.config.aggressiveMode) {
            const fragments = RequestFragmenter.fragmentUrl(url);
            targetUrl = url; // Use original, but track fragments for debugging
        }
        
        return {
            url: targetUrl,
            headers: stealthHeaders,
            meta: {
                originalUrl: url,
                filtersDetected: this.detector.getDetectedFilters(),
                transformations: []
            }
        };
    }
    
    /**
     * Processes response content through bypass transformations
     */
    processResponse(html, contentType = 'text/html') {
        if (!contentType.includes('text/html')) {
            return html;
        }
        
        // Detect filters in content
        this.detector.detectFromContent(html);
        
        // Apply transformations
        let transformed = this.rewriter.transform(html, {
            removeFilterScripts: this.config.removeFilterScripts,
            rewriteBlockedWords: this.config.enableHomoglyphs,
            injectAntiDetection: this.config.enableAntiDetection
        });
        
        this.stats.transformationsApplied++;
        
        return transformed;
    }
    
    _buildStealthHeaders(originalHeaders) {
        const stealth = {};
        
        // Copy safe headers
        const safeHeaders = [
            'accept', 'accept-encoding', 'accept-language',
            'content-type', 'content-length'
        ];
        
        for (const [key, value] of Object.entries(originalHeaders)) {
            const lowerKey = key.toLowerCase();
            if (safeHeaders.includes(lowerKey) || lowerKey.startsWith('sec-')) {
                stealth[key] = value;
            }
        }
        
        // Add browser-like headers
        stealth['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
        stealth['Accept-Language'] = 'en-US,en;q=0.9';
        stealth['Cache-Control'] = 'max-age=0';
        stealth['Sec-CH-UA'] = '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"';
        stealth['Sec-CH-UA-Mobile'] = '?0';
        stealth['Sec-CH-UA-Platform'] = '"Windows"';
        stealth['Sec-Fetch-Dest'] = 'document';
        stealth['Sec-Fetch-Mode'] = 'navigate';
        stealth['Sec-Fetch-Site'] = 'none';
        stealth['Sec-Fetch-User'] = '?1';
        stealth['Upgrade-Insecure-Requests'] = '1';
        
        return stealth;
    }
    
    getStats() {
        return {
            ...this.stats,
            filtersDetected: this.detector.getDetectedFilters()
        };
    }
}

export default FilterBypass;
