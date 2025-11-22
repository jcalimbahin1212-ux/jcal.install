
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
        this.thermalThrottle = false;
    }

    tick() {
        // Simulate load fluctuation
        this.load = this.load.map(l => Math.max(0, Math.min(100, l + (Math.random() * 10 - 5))));
        this.temperature = 40 + (this.getAverageLoad() * 0.5);
        
        // Thermal throttling simulation
        if (this.temperature > 90) {
            this.thermalThrottle = true;
            this.speedGhz = Math.max(0.8, this.speedGhz * 0.9);
        } else if (this.temperature < 60 && this.thermalThrottle) {
            this.thermalThrottle = false;
            this.speedGhz = 3.2; // Reset to base clock
        }
    }

    getAverageLoad() {
        return this.load.reduce((a, b) => a + b, 0) / this.cores;
    }
}

class VirtualRAM {
    constructor(sizeGb = 16) {
        this.total = sizeGb * 1024 * 1024 * 1024;
        this.used = 0;
        this.swapUsed = 0;
    }

    allocate(bytes) {
        if (this.used + bytes > this.total) {
            // Simulate swap usage
            this.swapUsed += bytes;
            return true; 
        }
        this.used += bytes;
        return true;
    }

    free(bytes) {
        if (this.swapUsed > 0) {
            this.swapUsed = Math.max(0, this.swapUsed - bytes);
        } else {
            this.used = Math.max(0, this.used - bytes);
        }
    }
}

class VirtualGPU {
    constructor(model) {
        this.model = model;
        this.vram = 8 * 1024; // MB
        this.utilization = 0;
        this.driverVersion = "536.23";
    }
}

// --- Network Stack Simulation ---

class VirtualNetworkInterface {
    constructor(config) {
        this.ip = config.ip;
        this.mac = config.mac;
        this.bandwidthMbps = config.bandwidthMbps || 100;
        this.latencyBaseMs = config.latencyBaseMs || 20;
        this.jitterMs = config.jitterMs || 5;
        this.packetLossRate = 0.001; // 0.1%
        this.bytesSent = 0;
        this.bytesReceived = 0;
        this.activeConnections = 0;
        this.dnsCache = new Map();
    }

    async resolveDns(hostname) {
        if (this.dnsCache.has(hostname)) {
            return this.dnsCache.get(hostname);
        }
        // Simulate DNS lookup time
        await new Promise(r => setTimeout(r, 10 + Math.random() * 40));
        const ip = `104.21.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
        this.dnsCache.set(hostname, ip);
        return ip;
    }

    async transmit(bytes) {
        this.bytesSent += bytes;
        const transmissionTime = (bytes * 8) / (this.bandwidthMbps * 1000000) * 1000;
        await new Promise(r => setTimeout(r, transmissionTime));
    }

    async receive(bytes) {
        this.bytesReceived += bytes;
        const transmissionTime = (bytes * 8) / (this.bandwidthMbps * 1000000) * 1000;
        await new Promise(r => setTimeout(r, transmissionTime));
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
        this.mkdir("/home/user/.cache");
        this.mkdir("/var");
        this.mkdir("/var/log");
        this.mkdir("/tmp");
        this.mkdir("/etc");
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

class FingerprintManager {
    constructor(platform) {
        this.platform = platform;
        this.canvasHash = randomUUID();
        this.audioHash = randomUUID();
        this.webglRenderer = this._getWebGLRenderer();
        this.screenResolution = this._getScreenResolution();
    }

    _getWebGLRenderer() {
        const renderers = [
            "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
            "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
            "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)"
        ];
        return renderers[Math.floor(Math.random() * renderers.length)];
    }

    _getScreenResolution() {
        const res = ["1920x1080", "2560x1440", "1366x768", "3840x2160"];
        return res[Math.floor(Math.random() * res.length)];
    }
}

class VirtualBrowserTab extends EventEmitter {
    constructor(id, userAgent, fingerprint) {
        super();
        this.id = id;
        this.userAgent = userAgent;
        this.fingerprint = fingerprint;
        this.url = "about:blank";
        this.title = "New Tab";
        this.history = [];
        this.cookies = new Map(); // Domain -> Cookie[]
        this.state = "idle"; // idle, loading, rendering
        this.domNodes = 0;
    }

    async navigate(url, networkStack, fileSystem) {
        this.state = "loading";
        this.emit("load-start", url);
        
        try {
            // DNS Lookup Simulation
            const hostname = new URL(url).hostname;
            await networkStack.resolveDns(hostname);

            // Connection Handshake Simulation
            await networkStack.transmit(500); // SYN
            await networkStack.receive(500);  // SYN-ACK
            await networkStack.transmit(500); // ACK

            const response = await networkStack.fetch(url, {
                headers: { 
                    "User-Agent": this.userAgent,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Sec-Ch-Ua-Platform": `"${this.fingerprint.platform}"`,
                    "Sec-Ch-Ua-Mobile": "?0",
                    "Upgrade-Insecure-Requests": "1"
                }
            });
            
            this.url = url;
            this.title = url; 
            this.history.push(url);
            this.state = "rendering";
            
            // Simulate rendering time based on content size
            const contentLength = Number(response.headers.get("content-length")) || 50000;
            const renderTime = Math.min(2000, contentLength / 100); // 1ms per 100 bytes
            await new Promise(r => setTimeout(r, renderTime));
            
            // Heuristic Analysis (Simulated DOM parsing)
            this.domNodes = Math.floor(contentLength / 200);
            
            // Cache resources to virtual disk
            fileSystem.writeFile(`/home/user/.cache/${encodeURIComponent(url)}.html`, "<html>...cached content...</html>");

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
        this.network = new VirtualNetworkInterface({
            ip: config.ip || this._randomizeIp(),
            mac: this._randomizeMac(),
            bandwidthMbps: config.bandwidthMbps || 100
        });
        // Monkey-patch fetch onto network interface for internal use
        this.network.fetch = this._internalFetch.bind(this);

        // User Space (Browser)
        this.fingerprint = new FingerprintManager(this.platform);
        this.browser = {
            name: "Chrome",
            version: "122.0.0.0",
            userAgent: this._generateUserAgent(this.platform),
            tabs: new Map(),
            activeTabId: null,
            extensions: ["uBlock Origin", "Tampermonkey", "React Developer Tools"],
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
        const tab = new VirtualBrowserTab(tabId, this.browser.userAgent, this.fingerprint);
        this.browser.tabs.set(tabId, tab);
        this.browser.activeTabId = tabId;
        return tab;
    }

    _simulateBackgroundActivity() {
        // Simulate OS tasks like indexing, updates, etc.
        const tasks = ["Windows Update", "Search Indexer", "Antivirus Scan", "Telemetry Upload"];
        const task = tasks[Math.floor(Math.random() * tasks.length)];
        this.cpu.load[0] += 20; // Spike CPU
        this.ram.allocate(1024 * 1024 * 50); // Allocate 50MB
        setTimeout(() => this.ram.free(1024 * 1024 * 50), 5000); // Free after 5s
    }

    /**
     * Public API to perform a fetch "as" this PC.
     * Uses the active browser tab metaphor.
     */
    async fetch(url, options = {}) {
        // Ensure we have a tab
        let tab = this.browser.tabs.get(this.browser.activeTabId);
        if (!tab) tab = this._openNewTab();

        // Execute request via Tab -> Network Stack
        const start = Date.now();
        try {
            const response = await tab.navigate(url, this.network, this.fs);

            // Update stats
            const duration = Date.now() - start;
            
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

    async _internalFetch(url, options) {
        // This is the actual fetch call to the outside world
        // In a real VM, this would be the network driver sending packets
        
        // Simulate packet loss
        if (Math.random() < this.network.packetLossRate) {
            await new Promise(r => setTimeout(r, 1000)); // Retry delay
        }

        const response = await fetch(url, {
            ...options,
            redirect: "manual"
        });
        
        // Track bandwidth
        const bodySize = Number(response.headers.get("content-length")) || 0;
        this.network.receive(bodySize);
        
        return response;
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
                temp: Math.round(this.cpu.temperature),
                throttled: this.cpu.thermalThrottle
            },
            ram: {
                total: this.ram.total,
                used: this.ram.used,
                swap: this.ram.swapUsed
            },
            network: {
                ip: this.network.ip,
                latency: this.network.latencyBaseMs,
                traffic: {
                    sent: this.network.bytesSent,
                    received: this.network.bytesReceived
                },
                activeConnections: this.network.activeConnections
            },
            browser: {
                tabs: this.browser.tabs.size,
                activeTab: this.browser.activeTabId,
                fingerprint: {
                    resolution: this.fingerprint.screenResolution,
                    renderer: this.fingerprint.webglRenderer
                }
            },
            processes: this.proc.processes.size
        };
    }
}
