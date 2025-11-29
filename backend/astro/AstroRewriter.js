/**
 * ASTRO REWRITER
 * High-performance HTML/CSS/JavaScript rewriter
 * 
 * Inspired by Scramjet's WASM approach but optimized for pure JS performance
 * with intelligent caching and minimal overhead
 */

import url from 'url';

class AstroRewriter {
    constructor(config) {
        this.config = config;
        this.urlCache = new Map();
        this.maxCacheSize = 10000;
        
        // HTML attribute map for URL rewriting
        this.urlAttributes = {
            'a': ['href'],
            'link': ['href'],
            'script': ['src'],
            'img': ['src', 'srcset'],
            'video': ['src', 'poster'],
            'audio': ['src'],
            'source': ['src', 'srcset'],
            'iframe': ['src'],
            'embed': ['src'],
            'object': ['data'],
            'form': ['action'],
            'input': ['src', 'formaction'],
            'button': ['formaction'],
            'area': ['href'],
            'base': ['href'],
            'track': ['src'],
            'use': ['href', 'xlink:href'],
            'image': ['href', 'xlink:href'],
            'meta': ['content'], // Only for refresh redirects
        };
        
        // Event handlers that may contain JS
        this.jsAttributes = [
            'onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onmouseover',
            'onmousemove', 'onmouseout', 'onkeydown', 'onkeypress', 'onkeyup',
            'onload', 'onunload', 'onfocus', 'onblur', 'onchange', 'onsubmit',
            'onreset', 'onselect', 'onerror', 'onabort', 'onscroll', 'onresize',
            'oncontextmenu', 'oninput', 'oninvalid', 'onsearch', 'ondrag',
            'ondragend', 'ondragenter', 'ondragleave', 'ondragover', 'ondragstart',
            'ondrop', 'onwheel', 'oncopy', 'oncut', 'onpaste', 'onbeforeprint',
            'onafterprint', 'onhashchange', 'onmessage', 'ononline', 'onoffline',
            'onpagehide', 'onpageshow', 'onpopstate', 'onstorage', 'ontouchstart',
            'ontouchmove', 'ontouchend', 'ontouchcancel', 'onanimationstart',
            'onanimationend', 'onanimationiteration', 'ontransitionend'
        ];
        
        // CSS properties that contain URLs
        this.cssUrlProperties = [
            'background', 'background-image', 'border-image', 'border-image-source',
            'list-style', 'list-style-image', 'content', 'cursor', 'mask',
            'mask-image', 'src', 'filter', '-webkit-mask-image'
        ];
    }
    
    /**
     * Main rewrite entry point
     */
    rewrite(content, contentType, baseUrl) {
        const type = this._parseContentType(contentType);
        
        switch (type) {
            case 'html':
                return this.rewriteHtml(content, baseUrl);
            case 'css':
                return this.rewriteCss(content, baseUrl);
            case 'javascript':
                return this.rewriteJs(content, baseUrl);
            case 'manifest':
                return this.rewriteManifest(content, baseUrl);
            case 'json':
                return this.rewriteJson(content, baseUrl);
            default:
                return content;
        }
    }
    
    _parseContentType(contentType) {
        if (!contentType) return 'unknown';
        const ct = contentType.toLowerCase();
        if (ct.includes('html')) return 'html';
        if (ct.includes('css')) return 'css';
        if (ct.includes('javascript') || ct.includes('ecmascript')) return 'javascript';
        if (ct.includes('manifest+json')) return 'manifest';
        if (ct.includes('json')) return 'json';
        return 'unknown';
    }
    
    /**
     * Rewrite URLs with caching
     */
    rewriteUrl(urlStr, baseUrl, type = 'generic') {
        if (!urlStr || typeof urlStr !== 'string') return urlStr;
        
        // Handle special protocols
        const trimmed = urlStr.trim();
        if (this._isSpecialProtocol(trimmed)) {
            if (trimmed.startsWith('javascript:')) {
                return 'javascript:' + this.rewriteJs(trimmed.slice(11), baseUrl);
            }
            return trimmed;
        }
        
        // Check cache
        const cacheKey = `${baseUrl}|${urlStr}`;
        if (this.urlCache.has(cacheKey)) {
            return this.urlCache.get(cacheKey);
        }
        
        try {
            // Resolve URL
            const resolved = new URL(urlStr, baseUrl).href;
            const rewritten = this.config.proxyUrl(resolved);
            
            // Cache result
            this._addToCache(cacheKey, rewritten);
            
            return rewritten;
        } catch (e) {
            return urlStr;
        }
    }
    
    _isSpecialProtocol(url) {
        const special = ['data:', 'blob:', 'javascript:', 'about:', 'mailto:', 'tel:', 'sms:', 'file:'];
        return special.some(p => url.startsWith(p));
    }
    
    _addToCache(key, value) {
        // LRU cache implementation
        if (this.urlCache.size >= this.maxCacheSize) {
            const firstKey = this.urlCache.keys().next().value;
            this.urlCache.delete(firstKey);
        }
        this.urlCache.set(key, value);
    }
    
    /**
     * HTML Rewriting - comprehensive DOM manipulation
     */
    rewriteHtml(html, baseUrl) {
        if (!html || typeof html !== 'string') return html;
        
        // Fast path: simple replacements for performance
        if (html.length < 1000 && !html.includes('<script') && !html.includes('<style')) {
            return this._fastHtmlRewrite(html, baseUrl);
        }
        
        // Full DOM parsing for complex documents
        return this._fullHtmlRewrite(html, baseUrl);
    }
    
    _fastHtmlRewrite(html, baseUrl) {
        // Quick regex-based rewriting for simple documents
        let result = html;
        
        // Rewrite href attributes
        result = result.replace(/\bhref\s*=\s*["']([^"']+)["']/gi, (match, url) => {
            return `href="${this.rewriteUrl(url, baseUrl)}"`;
        });
        
        // Rewrite src attributes
        result = result.replace(/\bsrc\s*=\s*["']([^"']+)["']/gi, (match, url) => {
            return `src="${this.rewriteUrl(url, baseUrl)}"`;
        });
        
        // Rewrite action attributes
        result = result.replace(/\baction\s*=\s*["']([^"']+)["']/gi, (match, url) => {
            return `action="${this.rewriteUrl(url, baseUrl)}"`;
        });
        
        return result;
    }
    
    _fullHtmlRewrite(html, baseUrl) {
        // Create a result string with injected scripts
        let result = html;
        
        // Inject Astro client at the beginning of <head>
        const headInject = this._generateHeadInjection(baseUrl);
        
        // Find head position
        const headMatch = result.match(/<head[^>]*>/i);
        if (headMatch) {
            const insertPos = headMatch.index + headMatch[0].length;
            result = result.slice(0, insertPos) + headInject + result.slice(insertPos);
        } else {
            // No head, inject at beginning of html
            const htmlMatch = result.match(/<html[^>]*>/i);
            if (htmlMatch) {
                const insertPos = htmlMatch.index + htmlMatch[0].length;
                result = result.slice(0, insertPos) + '<head>' + headInject + '</head>' + result.slice(insertPos);
            } else {
                result = headInject + result;
            }
        }
        
        // Rewrite all URLs in attributes
        result = this._rewriteHtmlUrls(result, baseUrl);
        
        // Rewrite inline scripts
        result = this._rewriteInlineScripts(result, baseUrl);
        
        // Rewrite inline styles
        result = this._rewriteInlineStyles(result, baseUrl);
        
        // Rewrite meta refresh
        result = this._rewriteMetaRefresh(result, baseUrl);
        
        // Rewrite srcset attributes
        result = this._rewriteSrcset(result, baseUrl);
        
        // Add anti-detection scripts
        if (this.config.antiDetection.contentFilterEvasion) {
            result = this._injectAntiDetection(result);
        }
        
        return result;
    }
    
    _generateHeadInjection(baseUrl) {
        const config = this.config.toClientConfig();
        
        return `
<!-- ASTRO PROXY INJECTION -->
<script data-astro="config">
    window.__astro = ${JSON.stringify(config)};
    window.__astro.baseUrl = "${baseUrl}";
    window.__astro.origin = "${new URL(baseUrl).origin}";
</script>
<script data-astro="client" src="${this.config.scripts.client}"></script>
<script data-astro="hooks">
    // Initialize Astro hooks before any other scripts run
    if (window.$astro) {
        window.$astro.init();
    }
</script>
<!-- END ASTRO INJECTION -->
`;
    }
    
    _rewriteHtmlUrls(html, baseUrl) {
        let result = html;
        
        // Pattern for various URL-containing attributes
        const urlPattern = /\b(href|src|action|data|poster|formaction|cite|profile|codebase|classid|usemap|longdesc|archive)\s*=\s*["']([^"']+)["']/gi;
        
        result = result.replace(urlPattern, (match, attr, url) => {
            // Skip already rewritten URLs
            if (url.includes(this.config.prefix)) return match;
            // Skip data URIs and other special protocols
            if (this._isSpecialProtocol(url.trim())) return match;
            
            const rewritten = this.rewriteUrl(url, baseUrl);
            return `${attr}="${rewritten}"`;
        });
        
        return result;
    }
    
    _rewriteInlineScripts(html, baseUrl) {
        // Match script tags and rewrite their content
        return html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, content) => {
            // Skip external scripts (they have src)
            if (/\bsrc\s*=/i.test(attrs)) {
                return match;
            }
            
            // Skip already processed
            if (/data-astro/.test(attrs)) {
                return match;
            }
            
            // Rewrite script content
            const rewritten = this.rewriteJs(content, baseUrl);
            return `<script${attrs}>${rewritten}</script>`;
        });
    }
    
    _rewriteInlineStyles(html, baseUrl) {
        // Rewrite style tags
        let result = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, content) => {
            const rewritten = this.rewriteCss(content, baseUrl);
            return `<style${attrs}>${rewritten}</style>`;
        });
        
        // Rewrite style attributes
        result = result.replace(/\bstyle\s*=\s*["']([^"']+)["']/gi, (match, content) => {
            const rewritten = this.rewriteInlineCss(content, baseUrl);
            return `style="${rewritten}"`;
        });
        
        return result;
    }
    
    _rewriteMetaRefresh(html, baseUrl) {
        return html.replace(/<meta([^>]*)(http-equiv\s*=\s*["']?refresh["']?)([^>]*)>/gi, (match, before, equiv, after) => {
            // Find content attribute
            const contentMatch = (before + after).match(/content\s*=\s*["']?([^"'>]+)["']?/i);
            if (!contentMatch) return match;
            
            const content = contentMatch[1];
            const urlMatch = content.match(/url\s*=\s*(.+)/i);
            if (!urlMatch) return match;
            
            const refreshUrl = urlMatch[1].trim().replace(/['"]/g, '');
            const rewritten = this.rewriteUrl(refreshUrl, baseUrl);
            const newContent = content.replace(urlMatch[1], rewritten);
            
            return match.replace(contentMatch[1], newContent);
        });
    }
    
    _rewriteSrcset(html, baseUrl) {
        return html.replace(/\bsrcset\s*=\s*["']([^"']+)["']/gi, (match, srcset) => {
            const rewritten = srcset.split(',').map(entry => {
                const parts = entry.trim().split(/\s+/);
                if (parts.length > 0) {
                    parts[0] = this.rewriteUrl(parts[0], baseUrl);
                }
                return parts.join(' ');
            }).join(', ');
            
            return `srcset="${rewritten}"`;
        });
    }
    
    _injectAntiDetection(html) {
        const antiDetectionScript = `
<script data-astro="antidetect">
(function() {
    // Remove known filter extensions
    const blockedScripts = [
        'goguardian', 'securly', 'lightspeed', 'iboss', 
        'contentkeeper', 'blocksi', 'smoothwall', 'zscaler',
        'forcepointwebsense', 'cisco-umbrella', 'fortiguard'
    ];
    
    // Override createElement to block filter scripts
    const _createElement = document.createElement.bind(document);
    document.createElement = function(tag) {
        const el = _createElement(tag);
        if (tag.toLowerCase() === 'script') {
            const origSetAttribute = el.setAttribute.bind(el);
            el.setAttribute = function(name, value) {
                if (name === 'src' && blockedScripts.some(b => value.toLowerCase().includes(b))) {
                    console.log('[ASTRO] Blocked filter script:', value);
                    return;
                }
                return origSetAttribute(name, value);
            };
        }
        return el;
    };
    
    // Block filter websocket connections
    const _WebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
        if (blockedScripts.some(b => url.toLowerCase().includes(b))) {
            console.log('[ASTRO] Blocked filter websocket:', url);
            // Return a fake websocket that does nothing
            return {
                send: () => {},
                close: () => {},
                addEventListener: () => {},
                removeEventListener: () => {},
                readyState: 3
            };
        }
        return new _WebSocket(url, protocols);
    };
    
    // Spoof navigator properties
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    
    // Remove any existing filter elements
    setTimeout(() => {
        document.querySelectorAll('[id*="guardian"], [id*="securly"], [class*="guardian"], [class*="securly"]').forEach(el => {
            el.remove();
        });
    }, 100);
})();
</script>`;
        
        // Inject before closing </body>
        if (html.includes('</body>')) {
            return html.replace('</body>', antiDetectionScript + '</body>');
        }
        return html + antiDetectionScript;
    }
    
    /**
     * CSS Rewriting
     */
    rewriteCss(css, baseUrl) {
        if (!css || typeof css !== 'string') return css;
        
        let result = css;
        
        // Rewrite url() functions
        result = result.replace(/url\s*\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, quote, url) => {
            if (this._isSpecialProtocol(url.trim())) return match;
            const rewritten = this.rewriteUrl(url.trim(), baseUrl);
            return `url(${quote}${rewritten}${quote})`;
        });
        
        // Rewrite @import statements
        result = result.replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, url) => {
            const rewritten = this.rewriteUrl(url, baseUrl);
            return `@import ${quote}${rewritten}${quote}`;
        });
        
        result = result.replace(/@import\s+url\s*\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, quote, url) => {
            const rewritten = this.rewriteUrl(url.trim(), baseUrl);
            return `@import url(${quote}${rewritten}${quote})`;
        });
        
        // Rewrite @font-face src
        result = result.replace(/@font-face\s*\{([^}]+)\}/gi, (match, content) => {
            const rewrittenContent = content.replace(/url\s*\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (m, q, u) => {
                if (this._isSpecialProtocol(u.trim())) return m;
                return `url(${q}${this.rewriteUrl(u.trim(), baseUrl)}${q})`;
            });
            return `@font-face {${rewrittenContent}}`;
        });
        
        return result;
    }
    
    rewriteInlineCss(css, baseUrl) {
        return this.rewriteCss(css, baseUrl);
    }
    
    /**
     * JavaScript Rewriting - Most complex and critical
     */
    rewriteJs(js, baseUrl) {
        if (!js || typeof js !== 'string') return js;
        
        let result = js;
        
        // Wrap in Astro context for URL interception
        const wrapper = this._generateJsWrapper(baseUrl);
        
        // Rewrite specific patterns
        result = this._rewriteLocationAccess(result);
        result = this._rewriteDocumentWrites(result);
        result = this._rewriteFetchCalls(result, baseUrl);
        result = this._rewriteXhrCalls(result, baseUrl);
        result = this._rewriteWebSocketCalls(result, baseUrl);
        result = this._rewriteWorkerCalls(result, baseUrl);
        result = this._rewriteImportCalls(result, baseUrl);
        result = this._rewriteUrlConstructors(result, baseUrl);
        
        // Add wrapper for location/document interception
        if (result.includes('location') || result.includes('document')) {
            result = wrapper.before + result + wrapper.after;
        }
        
        return result;
    }
    
    _generateJsWrapper(baseUrl) {
        return {
            before: `(function(__astro_base__){
    var __astro_location__ = window.$astro ? window.$astro.location : window.location;
    var __astro_document__ = window.$astro ? window.$astro.document : window.document;
    var __astro_window__ = window.$astro ? window.$astro.window : window;
`,
            after: `
})(${JSON.stringify(baseUrl)});`
        };
    }
    
    _rewriteLocationAccess(js) {
        // Be careful not to break valid code patterns
        let result = js;
        
        // Replace location.href assignments
        result = result.replace(/\blocation\s*\.\s*href\s*=/g, '__astro_location__.href=');
        
        // Replace location.assign/replace calls
        result = result.replace(/\blocation\s*\.\s*assign\s*\(/g, '__astro_location__.assign(');
        result = result.replace(/\blocation\s*\.\s*replace\s*\(/g, '__astro_location__.replace(');
        
        // Replace window.location accesses
        result = result.replace(/\bwindow\s*\.\s*location\b/g, '__astro_window__.location');
        
        // Replace document.location accesses
        result = result.replace(/\bdocument\s*\.\s*location\b/g, '__astro_document__.location');
        
        return result;
    }
    
    _rewriteDocumentWrites(js) {
        let result = js;
        
        // Rewrite document.write/writeln to go through proxy
        result = result.replace(/\bdocument\s*\.\s*write\s*\(/g, '__astro_document__.write(');
        result = result.replace(/\bdocument\s*\.\s*writeln\s*\(/g, '__astro_document__.writeln(');
        
        // Rewrite innerHTML/outerHTML setters (these are tricky)
        // We'll handle these in the client-side hooks instead
        
        return result;
    }
    
    _rewriteFetchCalls(js, baseUrl) {
        // Rewrite fetch calls to use proxy
        return js.replace(/\bfetch\s*\(\s*(['"`])([^'"`]+)\1/g, (match, quote, url) => {
            if (this._isSpecialProtocol(url)) return match;
            const rewritten = this.rewriteUrl(url, baseUrl);
            return `fetch(${quote}${rewritten}${quote}`;
        });
    }
    
    _rewriteXhrCalls(js, baseUrl) {
        // Rewrite XMLHttpRequest.open calls
        return js.replace(/\.open\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*(['"`])([^'"`]+)\3/g, (match, q1, method, q2, url) => {
            if (this._isSpecialProtocol(url)) return match;
            const rewritten = this.rewriteUrl(url, baseUrl);
            return `.open(${q1}${method}${q1}, ${q2}${rewritten}${q2}`;
        });
    }
    
    _rewriteWebSocketCalls(js, baseUrl) {
        // Rewrite WebSocket constructor calls
        return js.replace(/new\s+WebSocket\s*\(\s*(['"`])([^'"`]+)\1/g, (match, quote, url) => {
            // Convert to WSS proxy URL
            const wsUrl = url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
            const rewritten = this.rewriteUrl(wsUrl, baseUrl);
            // Convert back to WS
            const wsRewritten = rewritten.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
            return `new WebSocket(${quote}${wsRewritten}${quote}`;
        });
    }
    
    _rewriteWorkerCalls(js, baseUrl) {
        let result = js;
        
        // Rewrite Worker constructor
        result = result.replace(/new\s+Worker\s*\(\s*(['"`])([^'"`]+)\1/g, (match, quote, url) => {
            const rewritten = this.rewriteUrl(url, baseUrl);
            return `new Worker(${quote}${rewritten}${quote}`;
        });
        
        // Rewrite SharedWorker constructor
        result = result.replace(/new\s+SharedWorker\s*\(\s*(['"`])([^'"`]+)\1/g, (match, quote, url) => {
            const rewritten = this.rewriteUrl(url, baseUrl);
            return `new SharedWorker(${quote}${rewritten}${quote}`;
        });
        
        return result;
    }
    
    _rewriteImportCalls(js, baseUrl) {
        let result = js;
        
        // Rewrite dynamic imports
        result = result.replace(/\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g, (match, quote, url) => {
            if (this._isSpecialProtocol(url)) return match;
            const rewritten = this.rewriteUrl(url, baseUrl);
            return `import(${quote}${rewritten}${quote})`;
        });
        
        return result;
    }
    
    _rewriteUrlConstructors(js, baseUrl) {
        // This is tricky - we need to handle URL constructor carefully
        // We'll inject a proxy at runtime instead
        return js;
    }
    
    /**
     * Manifest Rewriting (PWA manifests)
     */
    rewriteManifest(manifest, baseUrl) {
        try {
            const data = JSON.parse(manifest);
            
            // Rewrite start_url
            if (data.start_url) {
                data.start_url = this.rewriteUrl(data.start_url, baseUrl);
            }
            
            // Rewrite scope
            if (data.scope) {
                data.scope = this.rewriteUrl(data.scope, baseUrl);
            }
            
            // Rewrite icons
            if (data.icons) {
                data.icons = data.icons.map(icon => ({
                    ...icon,
                    src: this.rewriteUrl(icon.src, baseUrl)
                }));
            }
            
            // Rewrite screenshots
            if (data.screenshots) {
                data.screenshots = data.screenshots.map(ss => ({
                    ...ss,
                    src: this.rewriteUrl(ss.src, baseUrl)
                }));
            }
            
            return JSON.stringify(data);
        } catch (e) {
            return manifest;
        }
    }
    
    /**
     * JSON Rewriting (API responses, etc.)
     */
    rewriteJson(json, baseUrl) {
        // For most JSON, we don't need to rewrite
        // But we can optionally rewrite URL fields
        return json;
    }
    
    /**
     * Unrewrite URL (convert proxy URL back to original)
     */
    unrewriteUrl(proxyUrl) {
        return this.config.extractUrl(proxyUrl);
    }
    
    /**
     * Clear cache
     */
    clearCache() {
        this.urlCache.clear();
    }
}

export { AstroRewriter };
