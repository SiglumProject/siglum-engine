// CTAN package fetching module

import {
    getPackageMeta,
    savePackageMeta,
    readFromOPFS,
    writeToOPFS,
    CTAN_CACHE_VERSION
} from './storage.js';

// Lazy load xzwasm when needed (UMD module loaded via script tag)
let XzReadableStream = null;
let xzwasmUrl = './src/xzwasm.js'; // Default, can be overridden

function setXzwasmUrl(url) {
    xzwasmUrl = url;
}

async function loadXzwasm() {
    if (XzReadableStream) return XzReadableStream;

    // Load UMD module via script tag
    return new Promise((resolve, reject) => {
        if (self.xzwasm) {
            XzReadableStream = self.xzwasm.XzReadableStream;
            resolve(XzReadableStream);
            return;
        }
        const script = document.createElement('script');
        script.src = xzwasmUrl;
        script.onload = () => {
            XzReadableStream = self.xzwasm.XzReadableStream;
            resolve(XzReadableStream);
        };
        script.onerror = () => reject(new Error('Failed to load xzwasm from ' + xzwasmUrl));
        document.head.appendChild(script);
    });
}

// Parse TAR archive into Map<path, Uint8Array>
function parseTar(tarData) {
    const files = new Map();
    let offset = 0;
    const decoder = new TextDecoder();

    while (offset < tarData.length - 512) {
        // Check for zero block (end of archive)
        let isZero = true;
        for (let i = 0; i < 512; i++) {
            if (tarData[offset + i] !== 0) { isZero = false; break; }
        }
        if (isZero) break;

        // Parse header - name is at bytes 0-99
        const nameBytes = tarData.subarray(offset, offset + 100);
        let nameEnd = nameBytes.indexOf(0);
        if (nameEnd === -1) nameEnd = 100;
        const name = decoder.decode(nameBytes.subarray(0, nameEnd));

        // Size is at bytes 124-135 (12 bytes, octal, null/space terminated)
        const sizeBytes = tarData.subarray(offset + 124, offset + 136);
        let sizeEnd = 0;
        for (let i = 0; i < 12; i++) {
            if (sizeBytes[i] === 0 || sizeBytes[i] === 32) break;
            sizeEnd = i + 1;
        }
        const sizeStr = decoder.decode(sizeBytes.subarray(0, sizeEnd));
        const size = parseInt(sizeStr, 8) || 0;

        // TypeFlag is at byte 156
        const typeFlag = tarData[offset + 156];

        // Prefix is at bytes 345-499 (USTAR format)
        const prefixBytes = tarData.subarray(offset + 345, offset + 500);
        let prefixEnd = prefixBytes.indexOf(0);
        if (prefixEnd === -1) prefixEnd = 155;
        const prefix = decoder.decode(prefixBytes.subarray(0, prefixEnd));

        const fullPath = prefix ? prefix + '/' + name : name;

        offset += 512; // Move past header

        // Only process regular files (typeFlag 0 or '0' which is ASCII 48)
        if ((typeFlag === 0 || typeFlag === 48) && size > 0 && name) {
            files.set(fullPath, new Uint8Array(tarData.buffer, tarData.byteOffset + offset, size));
        }

        // Move to next 512-byte boundary
        offset += Math.ceil(size / 512) * 512;
    }

    return files;
}

// Note: We now use TexLive 2023 for ALL packages for version compatibility
// (CTAN has latest versions that may require newer LaTeX than our 2022-11-01)

// Dynamic package name cache (populated by CTAN API lookups)
const packageNameCache = new Map();

export class CTANFetcher {
    constructor(options = {}) {
        this.proxyUrl = options.proxyUrl || 'http://localhost:8081';
        this.mountedFiles = new Set();
        this.fileCache = new Map(); // Memory cache for file contents
        this.fetchCount = 0;
        this.onLog = options.onLog || (() => {});

        // Set xzwasm URL if provided
        if (options.xzwasmUrl) {
            setXzwasmUrl(options.xzwasmUrl);
        }
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

        // Try TexLive first for version compatibility with our LaTeX 2022-11-01
        // (CTAN has latest versions that may require newer LaTeX)
        return this.fetchTexLivePackage(packageName);
    }

    // Look up real TexLive archive name via CTAN API
    async lookupTexLivePackageName(packageName) {
        // Check memory cache first
        if (packageNameCache.has(packageName)) {
            return packageNameCache.get(packageName);
        }

        try {
            // Query CTAN API for package info
            const response = await fetch(`${this.proxyUrl}/api/ctan-pkg/${packageName}`);
            if (!response.ok) return packageName;

            const data = await response.json();
            // If package is contained in another, use that
            const realName = data.contained_in || data.name || packageName;
            packageNameCache.set(packageName, realName);
            return realName;
        } catch (e) {
            return packageName;
        }
    }

    // Fetch from TexLive 2023 archive (for packages with version compatibility issues)
    async fetchTexLivePackage(packageName) {
        // Check cache first (same cache as CTAN)
        const cached = await this.loadPackageFromCache(packageName);
        if (cached) {
            if (cached.notFound) {
                this.onLog(`Package ${packageName} marked as not found in cache`);
                return null;
            }
            this.onLog(`Package ${packageName} loaded from cache (TexLive)`);
            return cached;
        }

        // Try direct name first
        this.onLog(`Fetching ${packageName} from TexLive 2023...`);
        let texlivePkg = packageName;

        try {
            let response = await fetch(`${this.proxyUrl}/api/texlive/${texlivePkg}`);

            // If not found, look up real package name via CTAN API
            if (!response.ok) {
                this.onLog(`Direct fetch failed, looking up package container...`);
                const realName = await this.lookupTexLivePackageName(packageName);
                if (realName !== packageName) {
                    this.onLog(`${packageName} is in ${realName}, fetching...`);
                    texlivePkg = realName;
                    response = await fetch(`${this.proxyUrl}/api/texlive/${texlivePkg}`);
                }
            }
            if (!response.ok) {
                this.onLog(`TexLive package ${packageName} not found, trying CTAN...`);
                // Fall back to CTAN for packages not in TexLive 2023
                return this.fetchCtanPackage(packageName);
            }

            // Get XZ-compressed TAR
            const xzData = await response.arrayBuffer();
            this.onLog(`Downloaded ${(xzData.byteLength / 1024).toFixed(1)} KB, decompressing...`);

            // Load xzwasm and decompress XZ using streaming
            const XzStream = await loadXzwasm();
            const xzStream = new XzStream(new Response(xzData).body);
            const reader = xzStream.getReader();
            const chunks = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                // Must copy chunk - xzwasm may reuse its internal buffer
                chunks.push(new Uint8Array(value));
            }

            // Concatenate chunks
            const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
            this.onLog(`Decompressed ${chunks.length} chunks, total ${totalLen} bytes`);
            const tarData = new Uint8Array(totalLen);
            let pos = 0;
            for (const chunk of chunks) {
                tarData.set(chunk, pos);
                pos += chunk.length;
            }

            // Debug: log first 100 bytes as hex
            const hex = Array.from(tarData.subarray(0, 100))
                .map(b => b.toString(16).padStart(2, '0')).join(' ');
            this.onLog(`First 100 bytes: ${hex}`);

            // Parse TAR
            const tarFiles = parseTar(tarData);
            this.onLog(`Extracted ${tarFiles.size} files from TAR (keys: ${[...tarFiles.keys()].slice(0,3).join(', ')}...)`);

            // Process files (similar to CTAN fetch)
            const texExtensions = ['.sty', '.cls', '.def', '.cfg', '.tex', '.fd', '.clo', '.ltx'];
            const fontExtensions = ['.pfb', '.pfm', '.afm', '.tfm', '.vf', '.map', '.enc'];
            const files = new Map();

            for (const [tarPath, content] of tarFiles) {
                // Skip docs and source
                if (tarPath.includes('/doc/') || tarPath.startsWith('doc/')) continue;
                if (tarPath.includes('/source/') || tarPath.startsWith('source/')) continue;

                const ext = tarPath.substring(tarPath.lastIndexOf('.')).toLowerCase();
                const fileName = tarPath.split('/').pop();

                if (texExtensions.includes(ext) || fontExtensions.includes(ext)) {
                    // Map to texlive path structure
                    let targetPath;
                    if (tarPath.includes('/texmf-dist/')) {
                        const idx = tarPath.indexOf('/texmf-dist/');
                        targetPath = '/texlive' + tarPath.substring(idx);
                    } else if (tarPath.includes('/tex/')) {
                        const idx = tarPath.indexOf('/tex/');
                        targetPath = '/texlive/texmf-dist' + tarPath.substring(idx);
                    } else if (tarPath.includes('/fonts/')) {
                        const idx = tarPath.indexOf('/fonts/');
                        targetPath = '/texlive/texmf-dist' + tarPath.substring(idx);
                    } else {
                        targetPath = `/texlive/texmf-dist/tex/latex/${packageName}/${fileName}`;
                    }

                    files.set(targetPath, new Uint8Array(content));
                    this.mountedFiles.add(targetPath);
                    this.fileCache.set(targetPath, new Uint8Array(content));
                    await writeToOPFS(targetPath, content);
                }
            }

            this.onLog(`Processed ${files.size} TeX/font files from ${packageName}`);

            if (files.size === 0) {
                this.onLog(`No TeX files found in ${packageName}, marking as not found`);
                await savePackageMeta(packageName, {
                    notFound: true,
                    cacheVersion: CTAN_CACHE_VERSION,
                });
                return null;
            }

            // Cache metadata
            await savePackageMeta(packageName, {
                name: packageName,
                files: [...files.keys()],
                dependencies: [],
                cacheVersion: CTAN_CACHE_VERSION,
                source: 'texlive-2023',
            });

            this.fetchCount++;
            return { files, dependencies: [] };
        } catch (e) {
            this.onLog(`TexLive fetch error: ${e.message}, trying CTAN...`);
            return this.fetchCtanPackage(packageName);
        }
    }

    // Fetch from CTAN proxy (fallback when TexLive doesn't have the package)
    async fetchCtanPackage(packageName) {
        this.onLog(`Fetching ${packageName} from CTAN...`);
        try {
            const response = await fetch(`${this.proxyUrl}/api/fetch/${packageName}`);
            if (!response.ok) {
                this.onLog(`CTAN package ${packageName} not found (${response.status})`);
                await savePackageMeta(packageName, {
                    notFound: true,
                    cacheVersion: CTAN_CACHE_VERSION,
                });
                return null;
            }

            const data = await response.json();
            if (data.error) {
                this.onLog(`CTAN fetch failed: ${data.error}`);
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
                this.fileCache.set(path, content);
                await writeToOPFS(path, content);
            }

            // Cache metadata
            await savePackageMeta(packageName, {
                name: packageName,
                files: [...files.keys()],
                dependencies: data.dependencies || [],
                cacheVersion: CTAN_CACHE_VERSION,
                source: 'ctan',
            });

            this.fetchCount++;
            return {
                files,
                dependencies: data.dependencies || [],
            };
        } catch (e) {
            this.onLog(`CTAN fetch error: ${e.message}`);
            await savePackageMeta(packageName, {
                notFound: true,
                cacheVersion: CTAN_CACHE_VERSION,
            });
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
