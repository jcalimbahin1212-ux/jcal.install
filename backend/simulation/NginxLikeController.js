
import { VirtualPC } from "./VirtualPC.js";
import { EventEmitter } from "events";

/**
 * NginxLikeController.js
 * 
 * A robust web server manager inspired by NGINX architecture.
 * It manages traffic routing, load balancing, and the lifecycle of "Virtual PC" workers.
 * 
 * Architecture:
 * - Master Process (Simulated): Manages configuration and workers.
 * - Workers (Virtual PCs): Handle the actual request processing.
 * - Upstreams: Groups of workers or external targets.
 * - Server Blocks: Virtual host configurations.
 */

export class NginxLikeController extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = {
            workerProcesses: config.workerProcesses || "auto",
            workerConnections: config.workerConnections || 1024,
            keepaliveTimeout: config.keepaliveTimeout || 65,
            ...config
        };

        this.workers = new Map(); // WorkerID -> VirtualPC
        this.upstreams = new Map(); // Name -> [WorkerIDs]
        this.serverBlocks = []; // List of server configurations
        this.requestQueue = [];
        
        this.status = "stopped";
        this.startTime = null;
        
        // Metrics
        this.metrics = {
            requestsTotal: 0,
            activeConnections: 0,
            bytesSent: 0,
            bytesReceived: 0
        };

        this._initialize();
    }

    _initialize() {
        console.log("[NginxController] Initializing server manager...");
        this._loadDefaultConfig();
        this._spawnWorkers();
        this._startHealthCheck();
        this.status = "ready";
    }

    _startHealthCheck() {
        setInterval(() => {
            this.workers.forEach((worker, id) => {
                const diag = worker.getDiagnostics();
                
                // Check for thermal throttling
                if (diag.cpu.throttled) {
                    console.warn(`[NginxController] Worker ${id} is thermal throttling. Cooling down...`);
                    // Temporarily remove from rotation or just log
                }

                // Check for "crash" (high load + high temp + errors)
                if (diag.cpu.temp > 95) {
                    console.error(`[NginxController] Worker ${id} OVERHEATED. Initiating emergency reboot.`);
                    this._rebootWorker(id);
                }
            });
        }, 5000);
    }

    _rebootWorker(id) {
        const oldWorker = this.workers.get(id);
        if (!oldWorker) return;

        console.log(`[NginxController] Rebooting worker ${id}...`);
        const newWorker = new VirtualPC({
            id: id,
            platform: oldWorker.platform,
            // Inherit some config but reset state
        });
        this.workers.set(id, newWorker);
        
        // Update upstreams
        this.upstreams.forEach(upstream => {
            const idx = upstream.workers.findIndex(w => w.id === id);
            if (idx !== -1) {
                upstream.workers[idx] = newWorker;
            }
        });
    }

    _loadDefaultConfig() {
        // Default "nginx.conf" simulation
        this.addServerBlock({
            listen: 80,
            serverName: "localhost",
            location: [
                { path: "/", proxyPass: "http://backend_cluster" },
                { path: "/static", root: "/var/www/html" }
            ]
        });

        this.addUpstream("backend_cluster", {
            strategy: "round-robin",
            servers: ["worker-1", "worker-2", "worker-3"]
        });
    }

    _spawnWorkers() {
        const count = this.config.workerProcesses === "auto" ? 4 : this.config.workerProcesses;
        console.log(`[NginxController] Spawning ${count} worker processes...`);
        
        for (let i = 0; i < count; i++) {
            const worker = new VirtualPC({
                id: `worker-${i + 1}`,
                platform: i % 2 === 0 ? "Linux" : "Windows" // Mix of platforms
            });
            this.workers.set(worker.id, worker);
        }
        
        // Register workers to the default upstream
        const defaultUpstream = this.upstreams.get("backend_cluster");
        if (defaultUpstream) {
            defaultUpstream.workers = Array.from(this.workers.values());
        }
    }

    /**
     * Main entry point for handling an incoming request (from Express).
     * Routes the request to the appropriate Virtual PC worker.
     * 
     * @param {object} req Express request object
     * @param {object} res Express response object
     * @param {function} next Express next function
     */
    async handleRequest(req, res, next) {
        this.metrics.requestsTotal++;
        this.metrics.activeConnections++;

        try {
            // 1. Match Server Block
            const serverBlock = this._matchServerBlock(req.hostname);
            if (!serverBlock) {
                // Fallback or 404
                return next(); 
            }

            // 2. Match Location
            const location = this._matchLocation(serverBlock, req.path);
            if (!location) {
                return next();
            }

            // 3. Process Request (Proxy Pass)
            if (location.proxyPass) {
                await this._proxyRequest(req, res, location);
            } else {
                // Static file serving would go here, but we defer to Express static for now
                next();
            }

        } catch (error) {
            console.error("[NginxController] Request processing failed:", error);
            if (!res.headersSent) {
                res.status(502).send("Bad Gateway - Simulation Error");
            }
        } finally {
            this.metrics.activeConnections--;
        }
    }

    _matchServerBlock(hostname) {
        // Simplified matching
        return this.serverBlocks.find(block => 
            block.serverName === hostname || block.serverName === "_"
        ) || this.serverBlocks[0];
    }

    _matchLocation(serverBlock, path) {
        // Longest prefix matching
        const locations = serverBlock.location || [];
        return locations
            .filter(loc => path.startsWith(loc.path))
            .sort((a, b) => b.path.length - a.path.length)[0];
    }

    async _proxyRequest(req, res, location) {
        // Determine upstream
        const upstreamName = location.proxyPass.replace("http://", "");
        const upstream = this.upstreams.get(upstreamName);

        if (!upstream) {
            throw new Error(`Upstream ${upstreamName} not found`);
        }

        // Load Balance
        const worker = this._loadBalance(upstream);
        if (!worker) {
            throw new Error("No healthy workers available");
        }

        // Execute request via Virtual PC
        // We need to construct the target URL. 
        // In a real proxy, we'd use the request URL.
        // Here, we assume the request URL is passed or we are proxying *to* the target.
        
        // If this is a "Coffee Shop" proxy request, the target is in the query or params.
        // We need to extract it.
        let targetUrl = req.query.url || req.params.encoded;
        
        // If no target found (e.g. direct access), we might just be simulating a hit to the worker itself
        if (!targetUrl) {
            // Just simulate a successful "internal" response
            res.setHeader("X-Powered-By", "NginxSimulation/1.0");
            res.setHeader("X-Worker-ID", worker.id);
            res.send(`Worker ${worker.id} is alive. Platform: ${worker.hardware.platform}`);
            return;
        }

        // If we have a target, fetch it via the worker
        try {
            // Decode if needed (simple check)
            if (!targetUrl.startsWith("http")) {
                // Assume it might be base64 or just needs protocol
                // For now, let's assume the caller handles decoding or it's a direct URL
            }

            const response = await worker.fetch(targetUrl, {
                method: req.method,
                headers: req.headers,
                body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined
            });

            // Stream response back
            res.status(response.status);
            
            // Copy headers
            for (const [key, value] of response.headers) {
                res.setHeader(key, value);
            }
            
            // Add simulation headers
            res.setHeader("X-Proxy-Worker", worker.id);
            res.setHeader("X-Simulation-Latency", `${worker.network.latencyBaseMs}ms`);

            // Pipe body
            if (response.body) {
                // Node-fetch body is a stream
                response.body.pipe(res);
            } else {
                res.end();
            }

        } catch (error) {
            throw error;
        }
    }

    _loadBalance(upstream) {
        // Smart Load Balancing: Least Connections / Lowest Load
        let bestWorker = null;
        let minScore = Infinity;

        for (const worker of upstream.workers) {
            const diag = worker.getDiagnostics();
            
            // Skip if throttled or overheated
            if (diag.cpu.throttled || diag.cpu.temp > 90) continue;

            // Score = Active Connections + (CPU Load / 10)
            const score = diag.network.activeConnections + (diag.cpu.load.reduce((a,b)=>a+b,0) / diag.cpu.cores / 10);
            
            if (score < minScore) {
                minScore = score;
                bestWorker = worker;
            }
        }

        // Fallback to Round Robin if all are busy/hot
        if (!bestWorker) {
            if (!upstream.cursor) upstream.cursor = 0;
            bestWorker = upstream.workers[upstream.cursor];
            upstream.cursor = (upstream.cursor + 1) % upstream.workers.length;
        }

        return bestWorker;
    }

    // --- Configuration Management ---

    addServerBlock(config) {
        this.serverBlocks.push(config);
    }

    addUpstream(name, config) {
        this.upstreams.set(name, {
            ...config,
            workers: [] // Will be populated
        });
    }

    /**
     * Dynamically scales the worker pool.
     */
    scaleWorkers(count) {
        const currentCount = this.workers.size;
        if (count > currentCount) {
            for (let i = currentCount; i < count; i++) {
                const worker = new VirtualPC({ id: `worker-${i + 1}` });
                this.workers.set(worker.id, worker);
            }
        } else if (count < currentCount) {
            // Scale down logic (remove idle workers)
            const toRemove = currentCount - count;
            const keys = Array.from(this.workers.keys()).slice(-toRemove);
            keys.forEach(k => this.workers.delete(k));
        }
        // Re-register to upstream
        const defaultUpstream = this.upstreams.get("backend_cluster");
        if (defaultUpstream) {
            defaultUpstream.workers = Array.from(this.workers.values());
        }
    }

    /**
     * Returns the status of the controller and all workers.
     */
    getStatus() {
        return {
            status: this.status,
            metrics: this.metrics,
            workers: Array.from(this.workers.values()).map(w => w.getDiagnostics()),
            upstreams: Array.from(this.upstreams.keys()),
            serverBlocks: this.serverBlocks.length
        };
    }

    /**
     * Retrieves logs from a specific worker's virtual filesystem.
     */
    getWorkerLogs(workerId) {
        const worker = this.workers.get(workerId);
        if (!worker) return null;
        return worker.fs.readFile("/var/log/browser_history.log");
    }
}
