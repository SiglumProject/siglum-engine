// CTAN package fetching module

import {
    getPackageMeta,
    savePackageMeta,
    readFromOPFS,
    writeToOPFS,
    CTAN_CACHE_VERSION
} from './storage.js';

export class CTANFetcher {
    constructor(options = {}) {
        this.proxyUrl = options.proxyUrl || 'http://localhost:8081';
        this.mountedFiles = new Set();
        this.fileCache = new Map(); // Memory cache for file contents
        this.fetchCount = 0;
        this.onLog = options.onLog || (() => {});
    }

    // Get all cached file contents (for passing to worker)
    // Only returns files that were loaded in this session (via fetchPackage)
    getCachedFiles() {
        return Object.fromEntries(this.fileCache);
    }

    async loadPackageFromCache(packageName) {
        try {
            const meta = await getPackageMeta(packageName);
            if (!meta) return null;

            // Check cache version
            if (meta.cacheVersion !== CTAN_CACHE_VERSION) return null;

            // Check if it's a "not found" marker
            if (meta.notFound) return { notFound: true };

            // Check memory cache first, then OPFS
            const files = new Map();
            if (meta.files && meta.files.length > 0) {
                const filesToLoad = [];
                for (const filePath of meta.files) {
                    if (this.fileCache.has(filePath)) {
                        files.set(filePath, this.fileCache.get(filePath));
                        this.mountedFiles.add(filePath);
                    } else {
                        filesToLoad.push(filePath);
                    }
                }

                // Load any missing files from OPFS
                if (filesToLoad.length > 0) {
                    const results = await Promise.all(
                        filesToLoad.map(async (filePath) => {
                            const content = await readFromOPFS(filePath);
                            return content ? [filePath, content] : null;
                        })
                    );
                    for (const result of results) {
                        if (result) {
                            files.set(result[0], result[1]);
                            this.mountedFiles.add(result[0]);
                            this.fileCache.set(result[0], result[1]); // Cache in memory
                        }
                    }
                }
            }

            return {
                files,
                dependencies: meta.dependencies || [],
            };
        } catch (e) {
            return null;
        }
    }

    async fetchPackage(packageName) {
        // Check cache first
        const cached = await this.loadPackageFromCache(packageName);
        if (cached) {
            if (cached.notFound) {
                this.onLog(`Package ${packageName} marked as not found in cache`);
                return null;
            }
            this.onLog(`Package ${packageName} loaded from cache`);
            return cached;
        }

        // Fetch from CTAN proxy
        this.onLog(`Fetching ${packageName} from CTAN...`);
        try {
            const response = await fetch(`${this.proxyUrl}/api/fetch/${packageName}`);
            if (!response.ok) {
                // Cache "not found" to avoid repeated lookups
                await savePackageMeta(packageName, {
                    notFound: true,
                    cacheVersion: CTAN_CACHE_VERSION,
                });
                return null;
            }

            const data = await response.json();
            if (data.error) {
                await savePackageMeta(packageName, {
                    notFound: true,
                    cacheVersion: CTAN_CACHE_VERSION,
                });
                return null;
            }

            // Process and cache files
            const files = new Map();
            for (const [path, info] of Object.entries(data.files)) {
                let content;
                if (info.encoding === 'base64') {
                    const binary = atob(info.content);
                    content = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) {
                        content[i] = binary.charCodeAt(i);
                    }
                } else if (typeof info.content === 'string') {
                    content = new TextEncoder().encode(info.content);
                } else {
                    content = new Uint8Array(info.content);
                }
                files.set(path, content);
                this.mountedFiles.add(path);
                this.fileCache.set(path, content); // Store in memory for fast access

                // Cache to OPFS
                await writeToOPFS(path, content);
            }

            // Cache metadata
            await savePackageMeta(packageName, {
                name: packageName,
                files: [...files.keys()],
                dependencies: data.dependencies || [],
                cacheVersion: CTAN_CACHE_VERSION,
            });

            this.fetchCount++;

            return {
                files,
                dependencies: data.dependencies || [],
            };
        } catch (e) {
            this.onLog(`CTAN fetch error: ${e.message}`);
            return null;
        }
    }

    async fetchWithDependencies(packageName, fetched = new Set()) {
        if (fetched.has(packageName)) return new Map();
        fetched.add(packageName);

        const result = await this.fetchPackage(packageName);
        if (!result) return new Map();

        const allFiles = new Map(result.files);

        // Fetch dependencies
        for (const dep of result.dependencies) {
            const depFiles = await this.fetchWithDependencies(dep, fetched);
            for (const [path, content] of depFiles) {
                allFiles.set(path, content);
            }
        }

        return allFiles;
    }

    getMountedFiles() {
        return [...this.mountedFiles];
    }

    getStats() {
        return {
            fetchCount: this.fetchCount,
            mountedFiles: this.mountedFiles.size,
        };
    }

    clearMountedFiles() {
        this.mountedFiles.clear();
    }
}

// Helper to extract package name from missing file
export function getPackageFromFile(filename) {
    // Check for EC/TC fonts (cm-super)
    if (/^(ec|tc)[a-z]{2}\d+$/.test(filename)) {
        return 'cm-super';
    }
    // Remove extension
    return filename.replace(/\.(sty|cls|def|clo|fd|cfg|tex)$/, '');
}

// Valid package name check
export function isValidPackageName(name) {
    if (!name || name.length < 2 || name.length > 50) return false;
    if (/[^a-zA-Z0-9_-]/.test(name)) return false;
    // Skip common false positives
    const skipList = ['document', 'texput', 'null', 'undefined', 'NaN'];
    if (skipList.includes(name)) return false;
    return true;
}
