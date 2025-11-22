
import { randomUUID } from "crypto";
import { EventEmitter } from "events";

/**
 * VirtualPC.js
 * 
 * A comprehensive simulation of a personal computer environment.
 * This class simulates hardware, operating system kernel, file system,
 * network stack, and a user-space browser application.
 * 
 * Designed to provide a highly realistic and persistent context for
 * web scraping, proxying, and automation tasks.
 */

// --- Hardware Simulation ---

class VirtualCPU {
    constructor(cores = 4, speedGhz = 3.2) {
        this.cores = cores;
        this.speedGhz = speedGhz;
        this.load = new Array(cores).fill(0);
        this.temperature = 45; // Celsius
    }

    tick() {
        // Simulate load fluctuation
        this.load = this.load.map(l => Math.max(0, Math.min(100, l + (Math.random() * 10 - 5))));
        this.temperature = 40 + (this.getAverageLoad() * 0.5);
    }

    getAverageLoad() {
        return this.load.reduce((a, b) => a + b, 0) / this.cores;
    }
}

class VirtualRAM {
    constructor(sizeGb = 16) {
        this.total = sizeGb * 1024 * 1024 * 1024;
        this.used = 0;
    }

    allocate(bytes) {
        if (this.used + bytes > this.total) return false;
        this.used += bytes;
        return true;
    }

    free(bytes) {
        this.used = Math.max(0, this.used - bytes);
    }
}

class VirtualGPU {
    constructor(model) {
        this.model = model;
        this.vram = 8 * 1024; // MB
        this.utilization = 0;
    }
}

// --- OS Simulation ---

class VirtualFileSystem {
    constructor() {
        this.root = {
            type: "dir",
            name: "/",
            children: new Map()
        };
        this._initStandardDirs();
    }

    _initStandardDirs() {
        this.mkdir("/home");
        this.mkdir("/home/user");
        this.mkdir("/home/user/Downloads");
        this.mkdir("/home/user/Documents");
        this.mkdir("/var");
        this.mkdir("/var/log");
        this.mkdir("/tmp");
    }

    mkdir(path) {
        const parts = path.split("/").filter(Boolean);
        let current = this.root;
        for (const part of parts) {
            if (!current.children.has(part)) {
                current.children.set(part, {
                    type: "dir",
                    name: part,
                    children: new Map(),
                    created: Date.now()
                });
            }
            current = current.children.get(part);
        }
    }

    writeFile(path, content) {
        const parts = path.split("/").filter(Boolean);
        const fileName = parts.pop();
        let current = this.root;
        for (const part of parts) {
            if (!current.children.has(part)) this.mkdir(part); // Auto-create dirs
            current = current.children.get(part);
        }
        current.children.set(fileName, {
            type: "file",
            name: fileName,
            content: content,
            size: content.length,
            created: Date.now()
        });
    }

    readFile(path) {
        const parts = path.split("/").filter(Boolean);
        let current = this.root;
        for (const part of parts) {
            if (!current.children.has(part)) return null;
            current = current.children.get(part);
        }
        return current.type === "file" ? current.content : null;
    }
}

class ProcessManager {
    constructor() {
        this.processes = new Map();
        this.nextPid = 1000;
    }

    spawn(name, type = "user") {
        const pid = this.nextPid++;
        const proc = {
            pid,
            name,
            type,
            status: "running",
            cpuUsage: 0,
            memoryUsage: 0,
            started: Date.now()
        };
        this.processes.set(pid, proc);
        return pid;
    }

    kill(pid) {
        this.processes.delete(pid);
    }

    tick() {
        for (const proc of this.processes.values()) {
            // Simulate dynamic resource usage
            proc.cpuUsage = Math.random() * 5;
            proc.memoryUsage = Math.floor(Math.random() * 100 * 1024 * 1024);
        }
    }
}

// --- Browser Simulation ---

class VirtualBrowserTab extends EventEmitter {
    constructor(id, userAgent) {
        super();
        this.id = id;
        this.userAgent = userAgent;
        this.url = "about:blank";
        this.title = "New Tab";
        this.history = [];
        this.cookies = new Map(); // Domain -> Cookie[]
        this.state = "idle"; // idle, loading, rendering
    }

    async navigate(url, networkStack) {
        this.state = "loading";
        this.emit("load-start", url);
        
        try {
            const response = await networkStack.fetch(url, {
                headers: { "User-Agent": this.userAgent }
            });
            
            this.url = url;
            this.title = url; // Simplified
            this.history.push(url);
            this.state = "rendering";
            
            // Simulate rendering time
            await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
            
            this.state = "idle";
            this.emit("load-finish", url);
            return response;
        } catch (error) {
            this.state = "error";
            this.emit("load-error", error);
            throw error;
        }
    }
}

// --- Main VirtualPC Class ---

export class VirtualPC extends EventEmitter {
    constructor(config = {}) {
        super();
        this.id = config.id || randomUUID();
        this.ownerId = config.ownerId || null;
        this.createdAt = Date.now();
        
        // Hardware
        this.cpu = new VirtualCPU(config.cpuCores, config.cpuSpeed);
        this.ram = new VirtualRAM(config.memoryGb);
        this.gpu = new VirtualGPU(config.gpuRenderer || "Generic Virtual GPU");
        this.platform = config.platform || this._randomizePlatform();

        // OS
        this.fs = new VirtualFileSystem();
        this.proc = new ProcessManager();
        this.kernel = {
            version: "5.15.0-generic",
            uptime: 0
        };

        // Network
        this.network = {
            ip: config.ip || this._randomizeIp(),
            mac: this._randomizeMac(),
            latencyBaseMs: Math.floor(Math.random() * 40) + 10,
            jitterMs: Math.floor(Math.random() * 5),
            bytesSent: 0,
            bytesReceived: 0
        };

        // User Space (Browser)
        this.browser = {
            name: "Chrome",
            version: "122.0.0.0",
            userAgent: this._generateUserAgent(this.platform),
            tabs: new Map(),
            activeTabId: null,
            extensions: ["uBlock Origin", "Tampermonkey"],
            bookmarks: []
        };

        // Start System
        this._startSystemLoop();
        this._launchBrowser();
    }

    _startSystemLoop() {
        this.systemInterval = setInterval(() => {
            this.kernel.uptime++;
            this.cpu.tick();
            this.proc.tick();
            
            // Random background activity
            if (Math.random() < 0.05) {
                this._simulateBackgroundActivity();
            }
        }, 1000);
    }

    _launchBrowser() {
        const pid = this.proc.spawn("chrome.exe", "user");
        this.browser.pid = pid;
        this._openNewTab();
    }

    _openNewTab() {
        const tabId = randomUUID();
        const tab = new VirtualBrowserTab(tabId, this.browser.userAgent);
        this.browser.tabs.set(tabId, tab);
        this.browser.activeTabId = tabId;
        return tab;
    }

    _simulateBackgroundActivity() {
        // Simulate OS tasks like indexing, updates, etc.
        const tasks = ["Windows Update", "Search Indexer", "Antivirus Scan", "Telemetry Upload"];
        const task = tasks[Math.floor(Math.random() * tasks.length)];
        // console.log(`[VirtualPC ${this.id}] Background task: ${task}`);
        this.cpu.load[0] += 20; // Spike CPU
    }

    /**
     * Public API to perform a fetch "as" this PC.
     * Uses the active browser tab metaphor.
     */
    async fetch(url, options = {}) {
        // Ensure we have a tab
        let tab = this.browser.tabs.get(this.browser.activeTabId);
        if (!tab) tab = this._openNewTab();

        // Simulate network conditions
        await this._simulateNetworkDelay();

        // Execute request
        const start = Date.now();
        try {
            // We use the tab to navigate, but we return the raw response for the proxy
            // In a full simulation, the tab would render and we'd return the screenshot/DOM.
            // Here we are a proxy, so we return the stream.
            
            // Merge headers
            const headers = new Headers(options.headers);
            headers.set("User-Agent", this.browser.userAgent);
            headers.set("X-Forwarded-For", this.network.ip); // Simulate proxy chain if needed, or hide it
            
            // Add realistic headers based on platform
            this._enrichHeaders(headers);

            const response = await fetch(url, {
                ...options,
                headers,
                redirect: "manual"
            });

            // Update stats
            const duration = Date.now() - start;
            this.network.bytesSent += (options.body ? options.body.length : 0) || 0;
            this.network.bytesReceived += Number(response.headers.get("content-length")) || 0;

            // Log to filesystem
            this.fs.writeFile(
                `/var/log/browser_history.log`, 
                `[${new Date().toISOString()}] ${options.method || "GET"} ${url} - ${response.status} (${duration}ms)\n`
            );

            return response;

        } catch (error) {
            throw error;
        }
    }

    _enrichHeaders(headers) {
        headers.set("Sec-Ch-Ua-Platform", `"${this.platform}"`);
        headers.set("Sec-Ch-Ua-Mobile", "?0");
        headers.set("Accept-Language", "en-US,en;q=0.9");
        if (!headers.has("Accept")) {
            headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
        }
    }

    async _simulateNetworkDelay() {
        const delay = this.network.latencyBaseMs + (Math.random() * this.network.jitterMs);
        await new Promise(r => setTimeout(r, delay));
    }

    // --- Randomization ---

    _randomizePlatform() {
        const p = ["Windows", "macOS", "Linux"];
        return p[Math.floor(Math.random() * p.length)];
    }

    _randomizeIp() {
        return `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    }

    _randomizeMac() {
        return "XX:XX:XX:XX:XX:XX".replace(/X/g, () => "0123456789ABCDEF".charAt(Math.floor(Math.random() * 16)));
    }

    _generateUserAgent(platform) {
        const v = "122.0.0.0";
        if (platform === "Windows") return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
        if (platform === "macOS") return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
        return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
    }

    // --- Diagnostics ---

    getDiagnostics() {
        return {
            id: this.id,
            platform: this.platform,
            uptime: this.kernel.uptime,
            cpu: {
                cores: this.cpu.cores,
                load: this.cpu.load.map(l => Math.round(l)),
                temp: Math.round(this.cpu.temperature)
            },
            ram: {
                total: this.ram.total,
                used: this.ram.used
            },
            network: {
                ip: this.network.ip,
                latency: this.network.latencyBaseMs,
                traffic: {
                    sent: this.network.bytesSent,
                    received: this.network.bytesReceived
                }
            },
            browser: {
                tabs: this.browser.tabs.size,
                activeTab: this.browser.activeTabId
            },
            processes: this.proc.processes.size
        };
    }
}
