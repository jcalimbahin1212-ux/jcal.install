(function() {
    console.log("[CoffeeShop] Interceptor active.");

    const PROXY_BASE = "/powerthrough";
    const CURRENT_URL = new URL(document.querySelector("meta[name='coffeeshop-target']")?.content || window.location.href);

    // --- Helper: Rewrite URL ---
    function rewriteUrl(url) {
        if (!url) return url;
        if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("#")) return url;
        
        try {
            const absolute = new URL(url, CURRENT_URL);
            // If it's already proxied, leave it
            if (absolute.origin === window.location.origin && absolute.pathname.startsWith(PROXY_BASE)) {
                return url;
            }
            
            // Construct proxy URL
            const proxied = new URL(PROXY_BASE, window.location.origin);
            proxied.searchParams.set("url", absolute.href);
            return proxied.href;
        } catch (e) {
            return url;
        }
    }

    // --- 1. Fetch Interceptor ---
    const originalFetch = window.fetch;
    window.fetch = async function(input, init) {
        let url = input;
        if (input instanceof Request) {
            url = input.url;
        }
        
        const newUrl = rewriteUrl(url);
        
        // If input was a Request object, we need to clone it with the new URL
        if (input instanceof Request) {
            // We can't easily clone a Request with a new URL, so we recreate it
            input = new Request(newUrl, input);
        } else {
            input = newUrl;
        }

        return originalFetch(input, init);
    };

    // --- 2. XHR Interceptor ---
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        const newUrl = rewriteUrl(url);
        return originalOpen.call(this, method, newUrl, ...args);
    };

    // --- 3. DOM Mutation Observer (Link Rewriter) ---
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1) { // ELEMENT_NODE
                    processNode(node);
                    // Also check children
                    node.querySelectorAll?.("*").forEach(processNode);
                }
            });
        });
    });

    function processNode(node) {
        if (node.tagName === "A" && node.href) {
            const original = node.getAttribute("href");
            if (original && !original.startsWith(PROXY_BASE) && !original.startsWith("#") && !original.startsWith("javascript:")) {
                node.setAttribute("href", rewriteUrl(original));
                node.setAttribute("target", "_self"); // Force stay in same tab to keep proxy context
            }
        }
        if (node.tagName === "IMG" && node.src) {
             const original = node.getAttribute("src");
             if (original && !original.startsWith(PROXY_BASE)) {
                 node.setAttribute("src", rewriteUrl(original));
             }
        }
        // Add more tags as needed (SCRIPT, LINK, IFRAME)
    }

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["href", "src"]
    });

    // Initial pass
    document.querySelectorAll("*").forEach(processNode);

    // --- 4. Form Submission Interceptor ---
    document.addEventListener("submit", (e) => {
        const form = e.target;
        const action = form.getAttribute("action") || "";
        const method = (form.getAttribute("method") || "GET").toUpperCase();
        
        e.preventDefault();

        const formData = new FormData(form);
        const targetUrl = new URL(action, CURRENT_URL);
        
        if (method === "GET") {
            // Append params to URL
            for (const [key, value] of formData.entries()) {
                targetUrl.searchParams.append(key, value);
            }
            window.location.href = rewriteUrl(targetUrl.href);
        } else {
            // POST via fetch and reload with result
            // This is tricky for a general proxy, but we can try
            // For now, let's just rewrite the action and submit
            const proxiedAction = rewriteUrl(targetUrl.href);
            // We can't easily change the action and submit because the browser will navigate
            // We need to construct a hidden form or use fetch
            
            // Simple fallback: just change action and submit
            // But we need to ensure the backend handles the POST body proxying
            form.setAttribute("action", proxiedAction);
            form.removeEventListener("submit", arguments.callee); // Remove handler to avoid loop
            form.submit();
        }
    });

})();
