import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

class SmartCache {
    constructor(cacheDir, maxSizeBytes = 50 * 1024 * 1024) { // 50MB default
        this.cacheDir = cacheDir;
        this.maxSizeBytes = maxSizeBytes;
        this.currentSizeBytes = 0;
        this.index = new Map(); // url -> { filename, size, lastAccess, hits, contentType }
        
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        } else {
            this._rebuildIndex();
        }
    }

    _rebuildIndex() {
        // In a real scenario, we'd persist the index to disk.
        // For now, we'll just clear the directory on startup to be safe/simple
        // or scan files. Let's just clear for this simulation to avoid stale state.
        const files = fs.readdirSync(this.cacheDir);
        for (const file of files) {
            fs.unlinkSync(path.join(this.cacheDir, file));
        }
        this.currentSizeBytes = 0;
    }

    _getHash(url) {
        return crypto.createHash('md5').update(url).digest('hex');
    }

    async get(url) {
        if (!this.index.has(url)) return null;

        const entry = this.index.get(url);
        entry.lastAccess = Date.now();
        entry.hits++;
        
        const filePath = path.join(this.cacheDir, entry.filename);
        if (fs.existsSync(filePath)) {
            return {
                content: fs.readFileSync(filePath),
                contentType: entry.contentType,
                headers: entry.headers,
                status: entry.status
            };
        } else {
            this.index.delete(url);
            this.currentSizeBytes -= entry.size;
            return null;
        }
    }

    async set(url, content, contentType, headers = {}, status = 200) {
        const size = content.length;
        if (size > this.maxSizeBytes * 0.2) return; // Don't cache huge individual files

        // Eviction policy: LRU + LFU hybrid (simplified)
        while (this.currentSizeBytes + size > this.maxSizeBytes) {
            this._evictOne();
        }

        const hash = this._getHash(url);
        const filename = `${hash}.cache`;
        const filePath = path.join(this.cacheDir, filename);

        fs.writeFileSync(filePath, content);
        
        this.index.set(url, {
            filename,
            size,
            lastAccess: Date.now(),
            hits: 1,
            contentType,
            headers,
            status
        });
        this.currentSizeBytes += size;
    }

    _evictOne() {
        if (this.index.size === 0) return;

        // Find entry with lowest score. Score = hits / (age in seconds + 1)
        // Actually, let's just do simple LRU for robustness
        let oldestUrl = null;
        let oldestTime = Infinity;

        for (const [url, entry] of this.index.entries()) {
            if (entry.lastAccess < oldestTime) {
                oldestTime = entry.lastAccess;
                oldestUrl = url;
            }
        }

        if (oldestUrl) {
            const entry = this.index.get(oldestUrl);
            const filePath = path.join(this.cacheDir, entry.filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            this.currentSizeBytes -= entry.size;
            this.index.delete(oldestUrl);
        }
    }

    getStats() {
        return {
            entries: this.index.size,
            size: this.currentSizeBytes,
            maxSize: this.maxSizeBytes,
            utilization: (this.currentSizeBytes / this.maxSizeBytes * 100).toFixed(1) + '%'
        };
    }
}

export default SmartCache;