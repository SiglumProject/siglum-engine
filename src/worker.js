// BusyTeX Compilation Worker
// Uses VirtualFileSystem for unified file mounting

// ============ Virtual FileSystem (inlined for worker compatibility) ============

class VirtualFileSystem {
    constructor(FS, options = {}) {
        this.FS = FS;
        this.MEMFS = FS.filesystems.MEMFS;
        this.onLog = options.onLog || (() => {});
        this.mountedFiles = new Set();
        this.mountedDirs = new Set();
        this.pendingFontMaps = new Set();
        this.bundleCache = new Map();
        this.lazyEnabled = options.lazyEnabled || false;
        this.lazyMarkerSymbol = '__siglum_lazy__';
        this.deferredMarkerSymbol = '__siglum_deferred__';

        // Deferred bundle loading - for font bundles loaded on demand
        this.deferredBundles = new Map();  // bundleName -> {manifest entries}
        this.onBundleNeeded = options.onBundleNeeded || null;  // async callback

        // External cache for Range-fetched files (persists across VFS instances)
        this.fetchedFiles = options.fetchedFilesCache || new Map();
    }

    mount(path, content, trackFontMaps = true) {
        this._ensureDirectory(path);
        const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        try {
            this.FS.writeFile(path, data);
            this.mountedFiles.add(path);
            if (trackFontMaps) this._trackFontFile(path);
        } catch (e) {
            this.onLog(`Failed to mount ${path}: ${e.message}`);
        }
    }

    mountLazy(path, bundleName, start, end, trackFontMaps = true) {
        this._ensureDirectory(path);
        const dirPath = path.substring(0, path.lastIndexOf('/'));
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        try {
            const parentNode = this.FS.lookupPath(dirPath).node;
            if (parentNode.contents?.[fileName]) return;
            const node = this.MEMFS.createNode(parentNode, fileName, 33206, 0);
            node.contents = this._createLazyMarker(bundleName, start, end);
            node.usedBytes = end - start;
            this.mountedFiles.add(path);
            if (trackFontMaps) this._trackFontFile(path);
        } catch (e) {
            this.onLog(`Failed to mount lazy ${path}: ${e.message}`);
        }
    }

    /**
     * Register a bundle as deferred - files are marked but not loaded
     * When a deferred file is accessed, it triggers a bundle fetch request
     */
    mountDeferredBundle(bundleName, manifest, bundleMeta = null) {
        const bundleFiles = this._getBundleFiles(bundleName, manifest, bundleMeta);
        if (bundleFiles.length === 0) return 0;

        // Store manifest info for later loading
        this.deferredBundles.set(bundleName, { files: bundleFiles, manifest, meta: bundleMeta });

        // Create directory structure
        const dirs = new Set();
        for (const [path] of bundleFiles) {
            const dir = path.substring(0, path.lastIndexOf('/'));
            if (dir) dirs.add(dir);
        }
        for (const dir of dirs) this._ensureDirectoryPath(dir);

        // Mount files as deferred markers
        let mounted = 0;
        for (const [path, info] of bundleFiles) {
            if (this.mountedFiles.has(path)) continue;
            this._mountDeferredFile(path, bundleName, info.start, info.end);
            mounted++;
        }
        this.onLog(`Registered ${mounted} deferred files from bundle ${bundleName}`);
        return mounted;
    }

    _mountDeferredFile(path, bundleName, start, end) {
        this._ensureDirectory(path);
        const dirPath = path.substring(0, path.lastIndexOf('/'));
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        try {
            const parentNode = this.FS.lookupPath(dirPath).node;
            if (parentNode.contents?.[fileName]) return;
            const node = this.MEMFS.createNode(parentNode, fileName, 33206, 0);
            node.contents = this._createDeferredMarker(bundleName, start, end);
            node.usedBytes = end - start;
            this.mountedFiles.add(path);
        } catch (e) {
            this.onLog(`Failed to mount deferred ${path}: ${e.message}`);
        }
    }

    _createDeferredMarker(bundleName, start, end) {
        return { [this.deferredMarkerSymbol]: true, bundleName, start, end, length: end - start, byteLength: end - start };
    }

    isDeferredMarker(obj) {
        return obj && typeof obj === 'object' && obj[this.deferredMarkerSymbol] === true;
    }

    _getBundleFiles(bundleName, manifest, bundleMeta) {
        const bundleFiles = [];

        // Check if bundle files are in the global manifest
        for (const [path, info] of Object.entries(manifest)) {
            if (info.bundle === bundleName) bundleFiles.push([path, info]);
        }

        // If no files found in manifest, use bundle-specific metadata
        if (bundleFiles.length === 0 && bundleMeta?.files) {
            for (const fileInfo of bundleMeta.files) {
                const fullPath = `${fileInfo.path}/${fileInfo.name}`;
                bundleFiles.push([fullPath, { start: fileInfo.start, end: fileInfo.end }]);
            }
        }

        return bundleFiles;
    }

    mountBundle(bundleName, bundleData, manifest, bundleMeta = null) {
        this.bundleCache.set(bundleName, bundleData);
        let mounted = 0;
        const bundleFiles = this._getBundleFiles(bundleName, manifest, bundleMeta);

        const dirs = new Set();
        for (const [path] of bundleFiles) {
            const dir = path.substring(0, path.lastIndexOf('/'));
            if (dir) dirs.add(dir);
        }
        for (const dir of dirs) this._ensureDirectoryPath(dir);

        // Track font files for later pdftex.map rewriting
        const isFontBundle = bundleName === 'cm-super' || bundleName.startsWith('fonts-');

        for (const [path, info] of bundleFiles) {
            if (this.mountedFiles.has(path)) continue;
            if (this.lazyEnabled && !this._shouldEagerLoad(path)) {
                this.mountLazy(path, bundleName, info.start, info.end, false);
            } else {
                const content = new Uint8Array(bundleData.slice(info.start, info.end));
                this.mount(path, content, false);
            }
            mounted++;

            // Track font files for pdftex.map rewriting
            if (isFontBundle && (path.endsWith('.pfb') || path.endsWith('.enc'))) {
                const filename = path.substring(path.lastIndexOf('/') + 1);
                this.fontFileLocations = this.fontFileLocations || new Map();
                this.fontFileLocations.set(filename, path);
            }
        }
        this.onLog(`Mounted ${mounted} files from bundle ${bundleName}`);
        return mounted;
    }

    mountCtanFiles(files) {
        const filesMap = files instanceof Map ? files : new Map(Object.entries(files));
        let mounted = 0;
        for (const [path, content] of filesMap) {
            if (this.mountedFiles.has(path)) continue;
            const data = typeof content === 'string'
                ? (content.startsWith('base64:') ? this._decodeBase64(content.slice(7)) : new TextEncoder().encode(content))
                : content;
            this.mount(path, data, true);  // Track font maps for CTAN packages
            mounted++;
        }
        this.onLog(`Mounted ${mounted} CTAN files`);
        return mounted;
    }

    processFontMaps() {
        if (this.pendingFontMaps.size === 0) return;
        const PDFTEX_MAP_PATH = '/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map';
        let existingMap = '';
        try {
            existingMap = new TextDecoder().decode(this.FS.readFile(PDFTEX_MAP_PATH));
        } catch (e) {
            this._ensureDirectoryPath(PDFTEX_MAP_PATH.substring(0, PDFTEX_MAP_PATH.lastIndexOf('/')));
        }
        let appended = 0;
        for (const mapPath of this.pendingFontMaps) {
            try {
                const mapContent = new TextDecoder().decode(this.FS.readFile(mapPath));
                const rewrittenContent = this._rewriteMapPaths(mapContent, mapPath);
                existingMap += `\n% Added from ${mapPath}\n${rewrittenContent}\n`;
                appended++;
            } catch (e) {
                this.onLog(`Failed to process font map ${mapPath}: ${e.message}`);
            }
        }
        if (appended > 0) {
            this.FS.writeFile(PDFTEX_MAP_PATH, existingMap);
            this.onLog(`Processed ${appended} font maps`);
        }
        this.pendingFontMaps.clear();
    }

    _rewriteMapPaths(mapContent, mapFilePath) {
        const lines = mapContent.split('\n');
        const mapDir = mapFilePath.substring(0, mapFilePath.lastIndexOf('/'));
        const packageMatch = mapFilePath.match(/\/([^\/]+)\/[^\/]+\.map$/);
        const packageName = packageMatch ? packageMatch[1] : '';
        const searchPaths = {
            pfb: [`/texlive/texmf-dist/fonts/type1/public/${packageName}`, '/texlive/texmf-dist/fonts/type1/public/cm-super', mapDir],
            enc: [`/texlive/texmf-dist/fonts/enc/dvips/${packageName}`, '/texlive/texmf-dist/fonts/enc/dvips/cm-super', `/texlive/texmf-dist/fonts/type1/public/${packageName}`, mapDir]
        };
        return lines.map(line => {
            if (line.trim().startsWith('%') || line.trim() === '') return line;
            let rewritten = line;
            const fileRefPattern = /<<?([a-zA-Z0-9_-]+\.(pfb|enc))/g;
            let match;
            while ((match = fileRefPattern.exec(line)) !== null) {
                const [fullMatch, filename, ext] = match;
                const prefix = fullMatch.startsWith('<<') ? '<<' : '<';
                const paths = searchPaths[ext] || [];
                for (const searchDir of paths) {
                    const candidatePath = `${searchDir}/${filename}`;
                    try {
                        if (this.FS.analyzePath(candidatePath).exists) {
                            rewritten = rewritten.replace(fullMatch, `${prefix}${candidatePath}`);
                            break;
                        }
                    } catch (e) {}
                }
            }
            return rewritten;
        }).join('\n');
    }

    generateLsR(basePath = '/texlive/texmf-dist') {
        const dirContents = new Map();
        dirContents.set(basePath, { files: [], subdirs: [] });
        const getDir = (dirPath) => {
            if (!dirContents.has(dirPath)) dirContents.set(dirPath, { files: [], subdirs: [] });
            return dirContents.get(dirPath);
        };
        for (const path of this.mountedFiles) {
            if (!path.startsWith(basePath)) continue;
            const lastSlash = path.lastIndexOf('/');
            if (lastSlash < 0) continue;
            const dirPath = path.substring(0, lastSlash);
            const fileName = path.substring(lastSlash + 1);
            let current = basePath;
            for (const part of dirPath.substring(basePath.length + 1).split('/').filter(p => p)) {
                const parent = getDir(current);
                current = `${current}/${part}`;
                if (!parent.subdirs.includes(part)) parent.subdirs.push(part);
                getDir(current);
            }
            getDir(dirPath).files.push(fileName);
        }
        const output = ['% ls-R -- filename database.', '% Created by Siglum VFS', ''];
        const outputDir = (dirPath) => {
            const contents = dirContents.get(dirPath);
            if (!contents) return;
            output.push(`${dirPath}:`);
            contents.files.sort().forEach(f => output.push(f));
            contents.subdirs.sort().forEach(d => output.push(d));
            output.push('');
            contents.subdirs.sort().forEach(subdir => outputDir(`${dirPath}/${subdir}`));
        };
        outputDir(basePath);
        const lsRContent = output.join('\n');
        this.FS.writeFile(`${basePath}/ls-R`, lsRContent);
        return lsRContent;
    }

    finalize() {
        this.processFontMaps();
        this.rewritePdftexMapPaths();
        this.generateLsR();
        this.onLog(`VFS finalized: ${this.mountedFiles.size} files`);
    }

    rewritePdftexMapPaths() {
        // Rewrite pdftex.map to use absolute paths for font files
        // This ensures pdfTeX can find fonts without relying on kpathsea search
        if (!this.fontFileLocations || this.fontFileLocations.size === 0) return;

        const PDFTEX_MAP_PATH = '/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map';
        try {
            const mapContent = new TextDecoder().decode(this.FS.readFile(PDFTEX_MAP_PATH));
            const lines = mapContent.split('\n');
            let modifiedCount = 0;

            const rewrittenLines = lines.map(line => {
                if (line.trim().startsWith('%') || line.trim() === '') return line;

                let rewritten = line;
                // Match font file references: <filename.pfb or <<filename.pfb or <filename.enc
                const fileRefPattern = /<<?([a-zA-Z0-9_-]+\.(pfb|enc))/g;
                let match;
                while ((match = fileRefPattern.exec(line)) !== null) {
                    const [fullMatch, filename] = match;
                    const absolutePath = this.fontFileLocations.get(filename);
                    if (absolutePath) {
                        const prefix = fullMatch.startsWith('<<') ? '<<' : '<';
                        rewritten = rewritten.replace(fullMatch, `${prefix}${absolutePath}`);
                        modifiedCount++;
                    }
                }
                return rewritten;
            });

            if (modifiedCount > 0) {
                const newMapContent = rewrittenLines.join('\n');
                this.FS.writeFile(PDFTEX_MAP_PATH, newMapContent);
                this.onLog(`Rewrote pdftex.map: ${modifiedCount} font paths resolved`);
            }
        } catch (e) {
            // pdftex.map might not exist yet, that's OK
        }
    }

    _createLazyMarker(bundleName, start, end) {
        return { [this.lazyMarkerSymbol]: true, bundleName, start, end, length: end - start, byteLength: end - start };
    }

    isLazyMarker(obj) {
        return obj && typeof obj === 'object' && obj[this.lazyMarkerSymbol] === true;
    }

    resolveLazy(marker) {
        const bundleData = this.bundleCache.get(marker.bundleName);
        if (!bundleData) {
            this.onLog(`ERROR: Bundle not in cache: ${marker.bundleName}`);
            return new Uint8Array(0);
        }
        return new Uint8Array(bundleData.slice(marker.start, marker.end));
    }

    /**
     * Resolve a deferred marker - returns data if bundle loaded, tracks request if not
     * For per-file loading: tracks individual files to fetch via Range requests
     */
    resolveDeferred(marker) {
        const bundleData = this.bundleCache.get(marker.bundleName);
        if (bundleData) {
            // Bundle is now loaded - return the actual data
            this.onLog(`Deferred resolve: ${marker.bundleName} [${marker.start}:${marker.end}] - loaded`);
            return new Uint8Array(bundleData.slice(marker.start, marker.end));
        }

        // Check if file was already fetched individually via Range request
        const fileKey = `${marker.bundleName}:${marker.start}:${marker.end}`;
        this.onLog(`Deferred resolve: checking cache for ${fileKey} (cache size: ${this.fetchedFiles.size})`);
        if (this.fetchedFiles.has(fileKey)) {
            const data = this.fetchedFiles.get(fileKey);
            this.onLog(`Deferred resolve: CACHE HIT ${fileKey} (${data.length} bytes)`);
            return data;
        }
        this.onLog(`Deferred resolve: CACHE MISS ${fileKey}`);

        // Track individual file request for Range-based fetching (avoid duplicates)
        this.pendingDeferredFiles = this.pendingDeferredFiles || [];
        const alreadyPending = this.pendingDeferredFiles.some(
            f => f.bundleName === marker.bundleName && f.start === marker.start && f.end === marker.end
        );
        if (!alreadyPending) {
            this.pendingDeferredFiles.push({
                bundleName: marker.bundleName,
                start: marker.start,
                end: marker.end,
            });
        }
        this.onLog(`Deferred resolve: file [${marker.start}:${marker.end}] - requesting Range fetch`);

        // Return empty data - this will cause TeX to fail with a file not found error
        // The retry loop will detect this and fetch individual files via Range requests
        return new Uint8Array(0);
    }

    /**
     * Store fetched file data for later resolution
     */
    storeFetchedFile(bundleName, start, end, data) {
        const key = `${bundleName}:${start}:${end}`;
        this.fetchedFiles.set(key, data);
        this.onLog(`Stored file in cache: ${key} (${data.length} bytes, cache size: ${this.fetchedFiles.size})`);
    }

    /**
     * Get list of individual files that need to be fetched via Range requests
     */
    getPendingDeferredFiles() {
        const pending = this.pendingDeferredFiles || [];
        this.pendingDeferredFiles = [];
        return pending;
    }

    /**
     * Get list of deferred bundles (legacy fallback - not used with per-file loading)
     */
    getPendingDeferredBundles() {
        const pending = this.pendingDeferredBundles ? [...this.pendingDeferredBundles] : [];
        if (this.pendingDeferredBundles) this.pendingDeferredBundles.clear();
        return pending;
    }

    /**
     * Upgrade deferred markers to lazy markers when bundle is loaded
     * Call this after a deferred bundle's data is added to bundleCache
     */
    activateDeferredBundle(bundleName) {
        if (!this.bundleCache.has(bundleName)) {
            this.onLog(`Cannot activate deferred bundle ${bundleName}: not in cache`);
            return 0;
        }

        const bundleInfo = this.deferredBundles.get(bundleName);
        if (!bundleInfo) return 0;

        let activated = 0;
        for (const [path] of bundleInfo.files) {
            try {
                const node = this.FS.lookupPath(path).node;
                if (this.isDeferredMarker(node.contents)) {
                    // Convert deferred marker to lazy marker (same structure, different symbol)
                    const marker = node.contents;
                    node.contents = this._createLazyMarker(marker.bundleName, marker.start, marker.end);
                    activated++;
                }
            } catch (e) {}
        }

        this.deferredBundles.delete(bundleName);
        this.onLog(`Activated ${activated} files from deferred bundle ${bundleName}`);
        return activated;
    }

    patchForLazyLoading() {
        const vfs = this;
        const ensureResolved = (node) => {
            // Fast path: if already a Uint8Array, no resolution needed
            const contents = node.contents;
            if (contents instanceof Uint8Array) return;

            if (vfs.isLazyMarker(contents)) {
                const resolved = vfs.resolveLazy(contents);
                node.contents = resolved;
                node.usedBytes = resolved.length;
            } else if (vfs.isDeferredMarker(contents)) {
                const resolved = vfs.resolveDeferred(contents);
                // Always replace marker with resolved data (even if empty)
                // This is required because MEMFS.read expects node.contents to be a Uint8Array
                // The bundle tracking happens inside resolveDeferred() before returning empty
                node.contents = resolved;
                node.usedBytes = resolved.length;
            }
        };
        const originalRead = this.MEMFS.stream_ops.read;
        this.MEMFS.stream_ops.read = function(stream, buffer, offset, length, position) {
            ensureResolved(stream.node);
            return originalRead.call(this, stream, buffer, offset, length, position);
        };
        if (this.MEMFS.ops_table?.file?.stream?.read) {
            const originalTableRead = this.MEMFS.ops_table.file.stream.read;
            this.MEMFS.ops_table.file.stream.read = function(stream, buffer, offset, length, position) {
                ensureResolved(stream.node);
                return originalTableRead.call(this, stream, buffer, offset, length, position);
            };
        }
        if (this.MEMFS.stream_ops.mmap) {
            const originalMmap = this.MEMFS.stream_ops.mmap;
            this.MEMFS.stream_ops.mmap = function(stream, length, position, prot, flags) {
                ensureResolved(stream.node);
                return originalMmap.call(this, stream, length, position, prot, flags);
            };
        }
        this.lazyEnabled = true;
        this.onLog('VFS: Lazy loading enabled');
    }

    _ensureDirectory(filePath) {
        const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
        this._ensureDirectoryPath(dirPath);
    }

    _ensureDirectoryPath(dirPath) {
        if (this.mountedDirs.has(dirPath)) return;
        const parts = dirPath.split('/').filter(p => p);
        let current = '';
        for (const part of parts) {
            current += '/' + part;
            if (this.mountedDirs.has(current)) continue;
            try { this.FS.stat(current); } catch (e) { try { this.FS.mkdir(current); } catch (e2) {} }
            this.mountedDirs.add(current);
        }
    }

    _shouldEagerLoad(path) {
        // Eager load critical files that kpathsea needs to find
        return path.endsWith('.fmt') ||
               path.endsWith('texmf.cnf') ||
               path.endsWith('.map') ||
               path.endsWith('.pfb') ||  // Type1 fonts - needed by pdfTeX
               path.endsWith('.enc');    // Encoding files - needed by pdfTeX
    }

    _trackFontFile(path) {
        // Track font maps for later processing (append to pdftex.map)
        // Only called for CTAN packages - bundles pass trackFontMaps=false
        if (path.endsWith('.map') && !path.endsWith('pdftex.map')) {
            this.pendingFontMaps.add(path);
        }
    }

    _decodeBase64(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
}

function configureTexEnvironment(ENV) {
    ENV['TEXMFCNF'] = '/texlive/texmf-dist/web2c';
    ENV['TEXMFROOT'] = '/texlive';
    ENV['TEXMFDIST'] = '/texlive/texmf-dist';
    ENV['TEXMFVAR'] = '/texlive/texmf-dist/texmf-var';
    ENV['TEXMFSYSVAR'] = '/texlive/texmf-dist/texmf-var';
    ENV['TEXMFSYSCONFIG'] = '/texlive/texmf-dist';
    ENV['TEXMFLOCAL'] = '/texlive/texmf-dist';
    ENV['TEXMFHOME'] = '/texlive/texmf-dist';
    ENV['TEXMFCONFIG'] = '/texlive/texmf-dist';
    ENV['TEXMFAUXTREES'] = '';
    ENV['TEXMF'] = '/texlive/texmf-dist';
    ENV['TEXMFDOTDIR'] = '.';
    ENV['TEXINPUTS'] = '.:/texlive/texmf-dist/tex/latex//:/texlive/texmf-dist/tex/generic//:/texlive/texmf-dist/tex//:';
    ENV['T1FONTS'] = '.:/texlive/texmf-dist/fonts/type1//';
    ENV['ENCFONTS'] = '.:/texlive/texmf-dist/fonts/enc//';
    ENV['TFMFONTS'] = '.:/texlive/texmf-dist/fonts/tfm//';
    ENV['VFFONTS'] = '.:/texlive/texmf-dist/fonts/vf//';
    ENV['TEXFONTMAPS'] = '.:/texlive/texmf-dist/fonts/map/dvips//:/texlive/texmf-dist/fonts/map/pdftex//:/texlive/texmf-dist/texmf-var/fonts/map//';
    ENV['TEXPSHEADERS'] = '.:/texlive/texmf-dist/dvips//:/texlive/texmf-dist/fonts/enc//:/texlive/texmf-dist/fonts/type1//:/texlive/texmf-dist/fonts/type42//';
}

// ============ Worker Code ============

const BUNDLE_BASE = 'packages/bundles';

// Worker state
let cachedWasmModule = null;
let busytexJsUrl = null;
let fileManifest = null;
let packageMap = null;
let bundleDeps = null;
let bundleRegistry = null;

// Global Module instance - reused across compilations to avoid memory leaks
// Each initBusyTeX call creates a 512MB WASM heap; we want only ONE
let globalModule = null;
let globalModulePromise = null;

// Pending requests
const pendingCtanRequests = new Map();
const pendingBundleRequests = new Map();
const pendingFileRangeRequests = new Map();
const globalFetchedFilesCache = new Map();  // Persist Range-fetched files across compiles

// Operation queue to serialize compile and format-generate operations
// (async onmessage doesn't block new messages from being processed concurrently)
let operationQueue = Promise.resolve();

function workerLog(msg) {
    self.postMessage({ type: 'log', message: msg });
}

function workerProgress(stage, detail) {
    self.postMessage({ type: 'progress', stage, detail });
}

// ============ External Fetch Requests ============

function requestCtanFetch(packageName) {
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        pendingCtanRequests.set(requestId, { resolve, reject });

        self.postMessage({
            type: 'ctan-fetch-request',
            requestId,
            packageName,
        });

        setTimeout(() => {
            if (pendingCtanRequests.has(requestId)) {
                pendingCtanRequests.delete(requestId);
                reject(new Error('CTAN fetch timeout'));
            }
        }, 60000);
    });
}

function requestBundleFetch(bundleName) {
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        pendingBundleRequests.set(requestId, { resolve, reject });

        self.postMessage({
            type: 'bundle-fetch-request',
            requestId,
            bundleName,
        });

        setTimeout(() => {
            if (pendingBundleRequests.has(requestId)) {
                pendingBundleRequests.delete(requestId);
                reject(new Error('Bundle fetch timeout'));
            }
        }, 60000);
    });
}

function requestFileRangeFetch(bundleName, start, end) {
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        pendingFileRangeRequests.set(requestId, { resolve, reject });

        self.postMessage({
            type: 'file-range-fetch-request',
            requestId,
            bundleName,
            start,
            end,
        });

        setTimeout(() => {
            if (pendingFileRangeRequests.has(requestId)) {
                pendingFileRangeRequests.delete(requestId);
                reject(new Error('File range fetch timeout'));
            }
        }, 30000);
    });
}

// ============ Source Processing ============

function injectMicrotypeWorkaround(source) {
    if (!source.includes('microtype')) return source;
    const documentclassMatch = source.match(/\\documentclass/);
    if (!documentclassMatch) return source;
    const insertPos = documentclassMatch.index;
    const workaround = '% Siglum: Disable microtype font expansion\n\\PassOptionsToPackage{expansion=false}{microtype}\n';
    workerLog('Injecting microtype expansion=false workaround');
    return source.slice(0, insertPos) + workaround + source.slice(insertPos);
}

function injectPdfMapFileCommands(source, mapFilePaths) {
    if (mapFilePaths.length === 0) return source;
    const newMaps = mapFilePaths.filter(p => !source.includes(p));
    if (newMaps.length === 0) return source;

    const mapCommands = newMaps.map(p => '\\pdfmapfile{+' + p + '}').join('\n');
    const documentclassMatch = source.match(/\\documentclass(\[[^\]]*\])?\{[^}]+\}/);

    if (documentclassMatch) {
        const insertPos = documentclassMatch.index + documentclassMatch[0].length;
        const preambleInsert = '\n% Font maps injected by Siglum\n' + mapCommands + '\n';
        workerLog('Injecting ' + newMaps.length + ' \\pdfmapfile commands');
        return source.slice(0, insertPos) + preambleInsert + source.slice(insertPos);
    }
    return source;
}

// ============ Missing File Detection ============

function extractMissingFile(logContent, alreadyFetched) {
    const patterns = [
        /! LaTeX Error: File `([^']+)' not found/g,
        /! I can't find file `([^']+)'/g,
        /LaTeX Warning:.*File `([^']+)' not found/g,
        /Package .* Error:.*`([^']+)' not found/g,
        /! Font [^=]+=([a-z0-9]+) at .* not loadable: Metric \(TFM\) file/g,
        /!pdfTeX error:.*\(file ([a-z0-9]+)\): Font .* not found/g,
        /! Font ([a-z]+[0-9]+) at [0-9]+ not found/g,
    ];
    const fetchedSet = alreadyFetched || new Set();

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(logContent)) !== null) {
            const missingFile = match[1];
            const pkgName = getPackageFromFile(missingFile);
            if (!fetchedSet.has(pkgName)) return missingFile;
        }
    }
    return null;
}

function getFontPackage(fontName) {
    if (/^(ec|tc)[a-z]{2}\d+$/.test(fontName)) return 'cm-super';
    return null;
}

function getPackageFromFile(filename) {
    const fontPkg = getFontPackage(filename);
    if (fontPkg) return fontPkg;
    return filename.replace(/\.(sty|cls|def|clo|fd|cfg|tex)$/, '');
}

// ============ Aux File Handling ============

function collectAuxFiles(FS) {
    const auxExtensions = ['.aux', '.toc', '.lof', '.lot', '.out', '.nav', '.snm', '.bbl', '.blg'];
    const files = {};
    for (const ext of auxExtensions) {
        const path = '/document' + ext;
        try {
            files[ext] = FS.readFile(path, { encoding: 'utf8' });
        } catch (e) {}
    }
    return files;
}

function restoreAuxFiles(FS, auxFiles) {
    let restored = 0;
    for (const [ext, content] of Object.entries(auxFiles)) {
        try {
            FS.writeFile('/document' + ext, content);
            restored++;
        } catch (e) {}
    }
    return restored;
}

// ============ WASM Initialization ============

async function initBusyTeX(wasmModule, jsUrl) {
    workerLog('Initializing WASM...');
    const startTime = performance.now();
    importScripts(jsUrl);

    const moduleConfig = {
        thisProgram: '/bin/busytex',
        noInitialRun: true,
        noExitRuntime: true,
        instantiateWasm: (imports, successCallback) => {
            WebAssembly.instantiate(wasmModule, imports).then(instance => {
                successCallback(instance);
            });
            return {};
        },
        print: (text) => {
            // Suppress noisy font map warnings
            if (text.includes('ambiguous entry') ||
                text.includes('duplicates ignored') ||
                text.includes('will be treated as font file not present') ||
                text.includes('font file present but not included') ||
                text.includes('invalid entry for') ||
                text.includes('SlantFont/ExtendFont')) return;
            workerLog('[TeX] ' + text);
        },
        printErr: (text) => {
            // Suppress font generation attempts (not supported in WASM)
            if (text.includes('mktexpk') || text.includes('kpathsea: fork')) return;
            workerLog('[TeX ERR] ' + text);
        },
        locateFile: (path) => path,
        preRun: [function() {
            moduleConfig.ENV = moduleConfig.ENV || {};
            configureTexEnvironment(moduleConfig.ENV);
        }],
    };

    const Module = await busytex(moduleConfig);
    const FS = Module.FS;
    try { FS.mkdir('/bin'); } catch (e) {}
    try { FS.writeFile('/bin/busytex', ''); } catch (e) {}

    Module.setPrefix = function(prefix) {
        Module.thisProgram = '/bin/' + prefix;
    };

    Module.callMainWithRedirects = function(args = [], print = false) {
        Module.do_print = print;
        Module.output_stdout = '';
        Module.output_stderr = '';
        if (args.length > 0) Module.setPrefix(args[0]);
        const exit_code = Module.callMain(args);
        Module._flush_streams();
        return { exit_code, stdout: Module.output_stdout, stderr: Module.output_stderr };
    };

    workerLog('WASM ready in ' + (performance.now() - startTime).toFixed(0) + 'ms');
    return Module;
}

/**
 * Create a fresh Module instance for each operation
 *
 * Note: We previously tried reusing a globalModule to avoid memory leaks,
 * but pdfTeX has internal C globals (glyph_unicode_tree, etc.) that don't
 * reset between invocations, causing assertion failures in format generation.
 * Until we can properly reset pdfTeX state, each operation needs a fresh Module.
 */
async function getOrCreateModule() {
    // Always create fresh Module - pdfTeX internal state doesn't reset properly
    return await initBusyTeX(cachedWasmModule, busytexJsUrl);
}

/**
 * Reset the filesystem for a fresh compilation
 * Removes all files except core TeX directories
 */
function resetFS(FS) {
    // Remove /texlive entirely and recreate structure
    try {
        // Remove dynamically created directories
        const dirsToClean = ['/texlive', '/document.pdf', '/document.log', '/document.aux'];
        for (const path of dirsToClean) {
            try {
                const stat = FS.stat(path);
                if (FS.isDir(stat.mode)) {
                    // Recursively remove directory
                    const removeDir = (dirPath) => {
                        try {
                            const contents = FS.readdir(dirPath);
                            for (const name of contents) {
                                if (name === '.' || name === '..') continue;
                                const fullPath = dirPath + '/' + name;
                                const s = FS.stat(fullPath);
                                if (FS.isDir(s.mode)) {
                                    removeDir(fullPath);
                                } else {
                                    FS.unlink(fullPath);
                                }
                            }
                            FS.rmdir(dirPath);
                        } catch (e) {}
                    };
                    removeDir(path);
                } else {
                    FS.unlink(path);
                }
            } catch (e) {}
        }
    } catch (e) {
        workerLog('FS reset warning: ' + e.message);
    }
}

// ============ Compilation ============

async function handleCompile(request) {
    const { id, source, engine, options, bundleData, ctanFiles, cachedFormat, cachedAuxFiles, deferredBundleNames } = request;

    workerLog('=== Compilation Started ===');
    const totalStart = performance.now();

    // Fallback to bundleDeps.deferred if not passed in message (for older compilers)
    const effectiveDeferredBundles = deferredBundleNames || bundleDeps?.deferred || [];
    workerLog(`deferredBundleNames: ${JSON.stringify(effectiveDeferredBundles)}`);

    if (!fileManifest) throw new Error('fileManifest not set');

    // Track accumulated resources across retries
    const bundleDataMap = bundleData instanceof Map ? bundleData : new Map(Object.entries(bundleData));
    const bundleMetaMap = new Map(); // Store bundle metadata for dynamically loaded bundles
    const accumulatedCtanFiles = new Map();

    // Bundles to load on-demand (e.g., font bundles like cm-super)
    const deferredBundles = new Set(effectiveDeferredBundles);

    if (ctanFiles) {
        const ctanFilesMap = ctanFiles instanceof Map ? ctanFiles : new Map(Object.entries(ctanFiles));
        for (const [path, content] of ctanFilesMap) accumulatedCtanFiles.set(path, content);
    }

    let pdfData = null;
    let compileSuccess = false;
    let retryCount = 0;
    const maxRetries = 10;
    const fetchedPackages = new Set();
    // Use global cache for Range-fetched files (persists across compiles)
    let lastExitCode = -1;
    let Module = null;
    let FS = null;

    while (!compileSuccess && retryCount < maxRetries) {
        if (retryCount > 0) {
            workerLog(`Retry #${retryCount}...`);
        }

        try {
            // Get or create global WASM instance (reused to avoid memory leaks)
            Module = await getOrCreateModule();
            FS = Module.FS;

            // Reset filesystem for clean compilation
            resetFS(FS);

            // Create VFS with unified mount handling
            const vfs = new VirtualFileSystem(FS, {
                onLog: workerLog,
                lazyEnabled: options.enableLazyFS,
                fetchedFilesCache: globalFetchedFilesCache  // Persist across compiles
            });

            // Only patch for lazy loading once (on first use)
            if (options.enableLazyFS && !Module._lazyPatchApplied) {
                vfs.patchForLazyLoading();
                Module._lazyPatchApplied = true;
            }

            // Mount all bundles (regular and deferred)
            workerProgress('mount', 'Mounting files...');
            for (const [bundleName, data] of bundleDataMap) {
                const meta = bundleMetaMap.get(bundleName) || null;
                vfs.mountBundle(bundleName, data, fileManifest, meta);
            }

            // Mount deferred bundles (file markers without data - loaded on demand)
            for (const bundleName of deferredBundles) {
                if (!bundleDataMap.has(bundleName)) {
                    const count = vfs.mountDeferredBundle(bundleName, fileManifest, null);
                    workerLog(`Deferred bundle ${bundleName}: mounted ${count} file markers`);
                }
            }

            // Mount CTAN files
            if (accumulatedCtanFiles.size > 0) {
                vfs.mountCtanFiles(accumulatedCtanFiles);
            }

            // Restore aux files
            if (cachedAuxFiles && Object.keys(cachedAuxFiles).length > 0) {
                const restored = restoreAuxFiles(FS, cachedAuxFiles);
                if (restored > 0) workerLog(`Restored ${restored} aux files`);
            }

            // Finalize VFS - processes font maps, generates ls-R
            vfs.finalize();

            // Prepare document source
            let docSource = source;
            let fmtPath = engine === 'pdflatex'
                ? '/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt'
                : '/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex.fmt';

            if (cachedFormat && engine === 'pdflatex' && cachedFormat.fmtData) {
                // Verify buffer isn't detached before using
                if (cachedFormat.fmtData.buffer && cachedFormat.fmtData.buffer.byteLength > 0) {
                    FS.writeFile('/custom.fmt', cachedFormat.fmtData);
                    fmtPath = '/custom.fmt';
                    workerLog('Using custom format');
                    const beginDocIdx = source.indexOf('\\begin{document}');
                    if (beginDocIdx !== -1) docSource = source.substring(beginDocIdx);
                } else {
                    workerLog('Custom format buffer is detached, using default format');
                }
            }

            if (engine === 'pdflatex' && !cachedFormat) {
                docSource = injectMicrotypeWorkaround(docSource);
            }

            // Font maps are now handled by VFS.processFontMaps() - no need to inject \pdfmapfile commands

            FS.writeFile('/document.tex', docSource);

            // Run compilation
            workerProgress('compile', `Running ${engine}...`);
            let result;

            if (engine === 'pdflatex') {
                result = Module.callMainWithRedirects([
                    'pdflatex', '--no-shell-escape', '--interaction=nonstopmode',
                    '--halt-on-error', '--fmt=' + fmtPath, '/document.tex'
                ]);
            } else {
                result = Module.callMainWithRedirects([
                    'xelatex', '--no-shell-escape', '--interaction=nonstopmode',
                    '--halt-on-error', '--no-pdf',
                    '--fmt=/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex.fmt',
                    '/document.tex'
                ]);
                if (result.exit_code === 0) {
                    result = Module.callMainWithRedirects([
                        'xdvipdfmx', '-o', '/document.pdf', '/document.xdv'
                    ]);
                }
            }

            lastExitCode = result.exit_code;

            if (result.exit_code === 0) {
                try {
                    pdfData = FS.readFile('/document.pdf');
                    compileSuccess = true;
                    workerLog('Compilation successful!');
                } catch (e) {
                    workerLog('Failed to read PDF: ' + e.message);
                }
            }

            // Handle missing files and deferred bundles
            if (!compileSuccess) {
                // First, check for individual file Range requests (more efficient than full bundle)
                const pendingFiles = vfs.getPendingDeferredFiles();
                if (pendingFiles.length > 0) {
                    workerLog(`Fetching ${pendingFiles.length} individual files via Range requests...`);
                    let fetchedAny = false;
                    for (const fileReq of pendingFiles) {
                        try {
                            const fileResult = await requestFileRangeFetch(fileReq.bundleName, fileReq.start, fileReq.end);
                            if (fileResult.success) {
                                vfs.storeFetchedFile(fileReq.bundleName, fileReq.start, fileReq.end, fileResult.data);
                                fetchedAny = true;
                                workerLog(`Loaded file bytes [${fileReq.start}:${fileReq.end}] (${fileResult.data.length} bytes)`);
                            }
                        } catch (e) {
                            workerLog(`Failed to fetch file range: ${e.message}`);
                        }
                    }
                    if (fetchedAny) {
                        retryCount++;
                        continue;
                    }
                }

                // Fallback: check if any deferred bundles were accessed but not loaded
                const pendingDeferred = vfs.getPendingDeferredBundles();
                workerLog(`Checking pending deferred bundles: ${pendingDeferred.length > 0 ? pendingDeferred.join(', ') : 'none'}`);
                if (pendingDeferred.length > 0) {
                    workerLog(`Deferred bundles needed: ${pendingDeferred.join(', ')}`);
                    let fetchedAny = false;
                    for (const bundleName of pendingDeferred) {
                        if (bundleDataMap.has(bundleName)) continue;
                        try {
                            const bundleResult = await requestBundleFetch(bundleName);
                            if (bundleResult.success) {
                                bundleDataMap.set(bundleName, bundleResult.bundleData);
                                if (bundleResult.bundleMeta) {
                                    bundleMetaMap.set(bundleName, bundleResult.bundleMeta);
                                }
                                // Remove from deferred set since it's now loaded
                                deferredBundles.delete(bundleName);
                                fetchedAny = true;
                                workerLog(`Loaded deferred bundle: ${bundleName}`);
                            }
                        } catch (e) {
                            workerLog(`Failed to load deferred bundle ${bundleName}: ${e.message}`);
                        }
                    }
                    if (fetchedAny) {
                        retryCount++;
                        continue;
                    }
                }

                // Then check for missing files via log parsing (CTAN fallback)
                if (options.enableCtan) {
                    let logContent = '';
                    try { logContent = new TextDecoder().decode(FS.readFile('/document.log')); } catch (e) {}
                    const allOutput = logContent + ' ' + (result.stdout || '') + ' ' + (result.stderr || '');
                    const missingFile = extractMissingFile(allOutput, fetchedPackages);

                    if (missingFile) {
                        const pkgName = getPackageFromFile(missingFile);

                        // Try bundle first (compressed, fast)
                        const bundleName = packageMap?.[pkgName];
                        if (bundleName && !bundleDataMap.has(bundleName)) {
                            workerLog(`Missing: ${missingFile}, loading bundle ${bundleName}...`);
                            try {
                                const bundleResult = await requestBundleFetch(bundleName);
                                if (bundleResult.success) {
                                    fetchedPackages.add(pkgName);
                                    bundleDataMap.set(bundleName, bundleResult.bundleData);
                                    if (bundleResult.bundleMeta) {
                                        bundleMetaMap.set(bundleName, bundleResult.bundleMeta);
                                    }
                                    retryCount++;
                                    continue;
                                }
                            } catch (e) {
                                workerLog(`Bundle fetch failed: ${e.message}, trying CTAN...`);
                            }
                        }

                        // Fall back to CTAN
                        workerLog(`Missing: ${missingFile}, fetching ${pkgName} from CTAN...`);
                        try {
                            const ctanData = await requestCtanFetch(pkgName);
                            if (ctanData.success) {
                                fetchedPackages.add(pkgName);
                                const files = ctanData.files instanceof Map ? ctanData.files : new Map(Object.entries(ctanData.files));
                                for (const [path, content] of files) {
                                    accumulatedCtanFiles.set(path, content);
                                }
                                retryCount++;
                                continue;
                            }
                        } catch (e) {
                            workerLog(`CTAN fetch failed: ${e.message}`);
                        }
                    }
                }
            }

            // No more retries possible
            if (!compileSuccess) break;

        } catch (e) {
            workerLog(`Error: ${e.message}`);
            break;
        }
    }

    const auxFiles = compileSuccess ? collectAuxFiles(FS) : null;
    const totalTime = performance.now() - totalStart;
    workerLog(`Total time: ${totalTime.toFixed(0)}ms`);

    const transferables = pdfData ? [pdfData.buffer] : [];
    self.postMessage({
        type: 'compile-response',
        id,
        success: compileSuccess,
        pdfData: pdfData ? pdfData.buffer : null,
        exitCode: lastExitCode,
        auxFilesToCache: auxFiles,
        stats: { compileTimeMs: totalTime, bundlesUsed: [...bundleDataMap.keys()] }
    }, transferables);
}

// ============ Format Generation ============

async function handleFormatGenerate(request) {
    const { id, preambleContent, engine, manifest, packageMapData, bundleDepsData, bundleRegistryData, bundleData, ctanFiles } = request;

    workerLog('=== Format Generation Started ===');
    const startTime = performance.now();

    fileManifest = manifest;
    packageMap = packageMapData;
    bundleDeps = bundleDepsData;
    bundleRegistry = new Set(bundleRegistryData);

    const bundleDataMap = bundleData instanceof Map ? bundleData : new Map(Object.entries(bundleData));
    const bundleMetaMap = new Map(); // Store bundle metadata for dynamically loaded bundles
    const accumulatedCtanFiles = new Map();

    if (ctanFiles) {
        const ctanFilesMap = ctanFiles instanceof Map ? ctanFiles : new Map(Object.entries(ctanFiles));
        for (const [path, content] of ctanFilesMap) accumulatedCtanFiles.set(path, content);
    }

    let retryCount = 0;
    const maxRetries = 10;
    const fetchedPackages = new Set();

    while (retryCount < maxRetries) {
        try {
            // Get or create global WASM instance (reused to avoid memory leaks)
            const Module = await getOrCreateModule();
            const FS = Module.FS;

            // Reset filesystem for clean format generation
            resetFS(FS);

            const vfs = new VirtualFileSystem(FS, { onLog: workerLog });

            for (const [bundleName, data] of bundleDataMap) {
                const meta = bundleMetaMap.get(bundleName) || null;
                vfs.mountBundle(bundleName, data, fileManifest, meta);
            }

            if (accumulatedCtanFiles.size > 0) {
                vfs.mountCtanFiles(accumulatedCtanFiles);
            }

            vfs.finalize();

            FS.writeFile('/myformat.ini', preambleContent + '\n\\dump\n');

            const result = Module.callMainWithRedirects([
                'pdflatex', '-ini', '-jobname=myformat', '-interaction=nonstopmode',
                '&/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex', '/myformat.ini'
            ]);

            if (result.exit_code === 0) {
                const formatData = FS.readFile('/myformat.fmt');
                workerLog(`Format generated: ${(formatData.byteLength / 1024 / 1024).toFixed(1)}MB in ${(performance.now() - startTime).toFixed(0)}ms`);

                self.postMessage({
                    type: 'format-generate-response', id, success: true, formatData: formatData.buffer
                }, [formatData.buffer]);
                return;
            }

            // Check for missing packages
            let logContent = '';
            try { logContent = new TextDecoder().decode(FS.readFile('/myformat.log')); } catch (e) {}
            const allOutput = logContent + ' ' + (result.stdout || '') + ' ' + (result.stderr || '');
            const missingFile = extractMissingFile(allOutput, fetchedPackages);

            if (missingFile) {
                const pkgName = getPackageFromFile(missingFile);

                // Try bundle first
                const bundleName = packageMap?.[pkgName];
                if (bundleName && !bundleDataMap.has(bundleName)) {
                    workerLog(`Format missing: ${missingFile}, loading bundle ${bundleName}...`);
                    try {
                        const bundleResult = await requestBundleFetch(bundleName);
                        if (bundleResult.success) {
                            fetchedPackages.add(pkgName);
                            bundleDataMap.set(bundleName, bundleResult.bundleData);
                            if (bundleResult.bundleMeta) {
                                bundleMetaMap.set(bundleName, bundleResult.bundleMeta);
                            }
                            retryCount++;
                            continue;
                        }
                    } catch (e) {
                        workerLog(`Bundle fetch failed: ${e.message}, trying CTAN...`);
                    }
                }

                // Fall back to CTAN
                workerLog(`Format missing: ${missingFile}, fetching ${pkgName} from CTAN...`);
                try {
                    const ctanData = await requestCtanFetch(pkgName);
                    if (ctanData.success) {
                        fetchedPackages.add(pkgName);
                        const files = ctanData.files instanceof Map ? ctanData.files : new Map(Object.entries(ctanData.files));
                        for (const [path, content] of files) accumulatedCtanFiles.set(path, content);
                        retryCount++;
                        continue;
                    }
                } catch (e) {
                    workerLog(`CTAN fetch failed: ${e.message}`);
                }
            }

            throw new Error(`Format generation failed with exit code ${result.exit_code}`);

        } catch (e) {
            if (retryCount >= maxRetries - 1) {
                workerLog(`Format generation error: ${e.message}`);
                self.postMessage({ type: 'format-generate-response', id, success: false, error: e.message });
                return;
            }
            retryCount++;
        }
    }

    workerLog(`Format generation failed after ${maxRetries} retries`);
    self.postMessage({ type: 'format-generate-response', id, success: false, error: 'Max retries exceeded' });
}

// ============ Message Handler ============

self.onmessage = async function(e) {
    const msg = e.data;

    switch (msg.type) {
        case 'init':
            // Compile WASM directly in worker to avoid 30MB duplication via postMessage
            busytexJsUrl = msg.busytexJsUrl;
            if (msg.manifest) {
                fileManifest = msg.manifest;
                packageMap = msg.packageMapData;
                bundleDeps = msg.bundleDepsData;
                bundleRegistry = new Set(msg.bundleRegistryData || []);
            }

            cachedWasmModule = msg.wasmModule;
            self.postMessage({ type: 'ready' });
            break;

        case 'compile':
            // Queue compile operations to prevent concurrent execution
            operationQueue = operationQueue.then(() => handleCompile(msg)).catch(e => {
                workerLog(`Compile queue error: ${e.message}`);
            });
            break;

        case 'generate-format':
            // Queue format operations to prevent concurrent execution
            operationQueue = operationQueue.then(() => handleFormatGenerate(msg)).catch(e => {
                workerLog(`Format queue error: ${e.message}`);
            });
            break;

        case 'ctan-fetch-response':
            const pending = pendingCtanRequests.get(msg.requestId);
            if (pending) {
                pendingCtanRequests.delete(msg.requestId);
                if (msg.success) pending.resolve(msg);
                else pending.reject(new Error(msg.error || 'CTAN fetch failed'));
            }
            break;

        case 'bundle-fetch-response':
            const pendingBundle = pendingBundleRequests.get(msg.requestId);
            if (pendingBundle) {
                pendingBundleRequests.delete(msg.requestId);
                if (msg.success) pendingBundle.resolve(msg);
                else pendingBundle.reject(new Error(msg.error || 'Bundle fetch failed'));
            }
            break;

        case 'file-range-fetch-response':
            const pendingFileRange = pendingFileRangeRequests.get(msg.requestId);
            if (pendingFileRange) {
                pendingFileRangeRequests.delete(msg.requestId);
                if (msg.success) pendingFileRange.resolve(msg);
                else pendingFileRange.reject(new Error(msg.error || 'File range fetch failed'));
            }
            break;
    }
};

self.onerror = function(e) {
    self.postMessage({ type: 'log', message: 'Worker error: ' + e.message });
};
