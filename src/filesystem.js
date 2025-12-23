// Unified Virtual FileSystem for TeX compilation
// Single abstraction for mounting files from any source (bundles, CTAN, inline)
// Handles all post-processing: font maps, encoding files, ls-R generation

export class VirtualFileSystem {
    constructor(FS, options = {}) {
        this.FS = FS;
        this.MEMFS = FS.filesystems.MEMFS;
        this.onLog = options.onLog || (() => {});

        // Track state
        this.mountedFiles = new Set();
        this.mountedDirs = new Set();
        this.pendingFontMaps = new Set();
        this.bundleCache = new Map(); // bundleName -> ArrayBuffer

        // Lazy loading support
        this.lazyEnabled = options.lazyEnabled || false;
        this.lazyMarkerSymbol = '__siglum_lazy__';
    }

    // ============ Core Mount API ============

    /**
     * Mount a single file to the virtual filesystem
     * @param {string} path - Full path like /texlive/texmf-dist/tex/latex/foo/bar.sty
     * @param {Uint8Array|string} content - File content
     * @param {boolean} trackFontMaps - Whether to track font maps for processing
     */
    mount(path, content, trackFontMaps = true) {
        this._ensureDirectory(path);

        const data = typeof content === 'string'
            ? new TextEncoder().encode(content)
            : content;

        try {
            this.FS.writeFile(path, data);
            this.mountedFiles.add(path);
            if (trackFontMaps) this._trackFontFile(path);
        } catch (e) {
            this.onLog(`Failed to mount ${path}: ${e.message}`);
        }
    }

    /**
     * Mount a file lazily (content resolved on first read)
     * @param {string} path - Full path
     * @param {string} bundleName - Bundle containing the data
     * @param {number} start - Start offset in bundle
     * @param {number} end - End offset in bundle
     * @param {boolean} trackFontMaps - Whether to track font maps for processing
     */
    mountLazy(path, bundleName, start, end, trackFontMaps = true) {
        this._ensureDirectory(path);

        const dirPath = path.substring(0, path.lastIndexOf('/'));
        const fileName = path.substring(path.lastIndexOf('/') + 1);

        try {
            const parentNode = this.FS.lookupPath(dirPath).node;
            if (parentNode.contents?.[fileName]) return; // Already exists

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
     * Mount all files from a bundle
     * @param {string} bundleName - Bundle identifier
     * @param {ArrayBuffer} bundleData - Raw bundle data
     * @param {Object} manifest - File manifest {path: {bundle, start, end}}
     */
    mountBundle(bundleName, bundleData, manifest) {
        this.bundleCache.set(bundleName, bundleData);
        let mounted = 0;

        // Collect all files for this bundle
        const bundleFiles = [];
        for (const [path, info] of Object.entries(manifest)) {
            if (info.bundle === bundleName) {
                bundleFiles.push([path, info]);
            }
        }

        // Ensure all directories exist first
        const dirs = new Set();
        for (const [path] of bundleFiles) {
            const dir = path.substring(0, path.lastIndexOf('/'));
            if (dir) dirs.add(dir);
        }
        for (const dir of dirs) {
            this._ensureDirectoryPath(dir);
        }

        // Mount files (don't track font maps - bundles are already in base pdftex.map)
        for (const [path, info] of bundleFiles) {
            if (this.mountedFiles.has(path)) continue;

            if (this.lazyEnabled && !this._shouldEagerLoad(path)) {
                this.mountLazy(path, bundleName, info.start, info.end, false);
            } else {
                const content = new Uint8Array(bundleData.slice(info.start, info.end));
                this.mount(path, content, false);
            }
            mounted++;
        }

        this.onLog(`Mounted ${mounted} files from bundle ${bundleName}`);
        return mounted;
    }

    /**
     * Mount files from CTAN fetch response
     * @param {Map|Object} files - Map of path -> content
     */
    mountCtanFiles(files) {
        const filesMap = files instanceof Map ? files : new Map(Object.entries(files));
        let mounted = 0;

        for (const [path, content] of filesMap) {
            if (this.mountedFiles.has(path)) continue;

            const data = typeof content === 'string'
                ? (content.startsWith('base64:')
                    ? this._decodeBase64(content.slice(7))
                    : new TextEncoder().encode(content))
                : content;

            this.mount(path, data, true);  // Track font maps for CTAN packages
            mounted++;
        }

        this.onLog(`Mounted ${mounted} CTAN files`);
        return mounted;
    }

    // ============ Font Map Processing ============

    /**
     * Process all pending font maps - append to pdftex.map with path rewriting
     */
    processFontMaps() {
        if (this.pendingFontMaps.size === 0) return;

        const PDFTEX_MAP_PATH = '/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map';

        // Read existing pdftex.map
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

    /**
     * Rewrite font map file to use absolute paths
     */
    _rewriteMapPaths(mapContent, mapFilePath) {
        const lines = mapContent.split('\n');
        const mapDir = mapFilePath.substring(0, mapFilePath.lastIndexOf('/'));
        const packageMatch = mapFilePath.match(/\/([^\/]+)\/[^\/]+\.map$/);
        const packageName = packageMatch ? packageMatch[1] : '';

        const searchPaths = {
            pfb: [
                `/texlive/texmf-dist/fonts/type1/public/${packageName}`,
                '/texlive/texmf-dist/fonts/type1/public/cm-super',
                mapDir
            ],
            enc: [
                `/texlive/texmf-dist/fonts/enc/dvips/${packageName}`,
                '/texlive/texmf-dist/fonts/enc/dvips/cm-super',
                `/texlive/texmf-dist/fonts/type1/public/${packageName}`,
                mapDir
            ]
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

    // ============ ls-R Generation ============

    /**
     * Generate ls-R database for kpathsea
     */
    generateLsR(basePath = '/texlive/texmf-dist') {
        const dirContents = new Map();
        dirContents.set(basePath, { files: [], subdirs: [] });

        const getDir = (dirPath) => {
            if (!dirContents.has(dirPath)) {
                dirContents.set(dirPath, { files: [], subdirs: [] });
            }
            return dirContents.get(dirPath);
        };

        // Build directory tree from mounted files
        for (const path of this.mountedFiles) {
            if (!path.startsWith(basePath)) continue;

            const lastSlash = path.lastIndexOf('/');
            if (lastSlash < 0) continue;

            const dirPath = path.substring(0, lastSlash);
            const fileName = path.substring(lastSlash + 1);

            // Ensure directory chain exists
            let current = basePath;
            for (const part of dirPath.substring(basePath.length + 1).split('/').filter(p => p)) {
                const parent = getDir(current);
                current = `${current}/${part}`;
                if (!parent.subdirs.includes(part)) {
                    parent.subdirs.push(part);
                }
                getDir(current);
            }

            getDir(dirPath).files.push(fileName);
        }

        // Generate output
        const output = ['% ls-R -- filename database.', '% Created by Siglum VFS', ''];

        const outputDir = (dirPath) => {
            const contents = dirContents.get(dirPath);
            if (!contents) return;

            output.push(`${dirPath}:`);
            contents.files.sort().forEach(f => output.push(f));
            contents.subdirs.sort().forEach(d => output.push(d));
            output.push('');

            contents.subdirs.sort().forEach(subdir => {
                outputDir(`${dirPath}/${subdir}`);
            });
        };

        outputDir(basePath);

        const lsRContent = output.join('\n');
        this.FS.writeFile(`${basePath}/ls-R`, lsRContent);
        return lsRContent;
    }

    // ============ Finalization ============

    /**
     * Finalize the filesystem - call after all mounts are complete
     * Processes font maps, generates ls-R, etc.
     */
    finalize() {
        this.processFontMaps();
        this.generateLsR();
        this.onLog(`VFS finalized: ${this.mountedFiles.size} files`);
    }

    // ============ Lazy Loading Support ============

    _createLazyMarker(bundleName, start, end) {
        return {
            [this.lazyMarkerSymbol]: true,
            bundleName,
            start,
            end,
            length: end - start,
            byteLength: end - start
        };
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
     * Patch MEMFS to resolve lazy markers on read
     */
    patchForLazyLoading() {
        const vfs = this;

        const ensureResolved = (node) => {
            if (vfs.isLazyMarker(node.contents)) {
                const resolved = vfs.resolveLazy(node.contents);
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

    // ============ Internal Helpers ============

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

            try {
                this.FS.stat(current);
            } catch (e) {
                try {
                    this.FS.mkdir(current);
                } catch (e2) {}
            }
            this.mountedDirs.add(current);
        }
    }

    _shouldEagerLoad(path) {
        return path.endsWith('.fmt') ||
               path.endsWith('texmf.cnf') ||
               path.endsWith('.map');
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
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
}

// ============ Font Discovery Configuration ============

/**
 * Configure kpathsea environment for automatic font discovery
 * Call this before running pdfTeX
 */
export function configureTexEnvironment(ENV) {
    ENV['TEXMFCNF'] = '/texlive/texmf-dist/web2c';
    ENV['TEXMFROOT'] = '/texlive';
    ENV['TEXMFDIST'] = '/texlive/texmf-dist';
    ENV['TEXMFVAR'] = '/texlive/texmf-dist/texmf-var';
    ENV['TEXMFSYSVAR'] = '/texlive/texmf-dist/texmf-var';
    ENV['TEXMF'] = '/texlive/texmf-dist';

    // Input paths for TeX files
    ENV['TEXINPUTS'] = [
        '.',
        '/texlive/texmf-dist/tex/latex//',
        '/texlive/texmf-dist/tex/generic//',
        '/texlive/texmf-dist/tex//',
    ].join(':');

    // Font discovery paths - these are searched by kpathsea
    ENV['T1FONTS'] = [
        '.',
        '/texlive/texmf-dist/fonts/type1//',  // Search all Type1 subdirs
    ].join(':');

    ENV['ENCFONTS'] = [
        '.',
        '/texlive/texmf-dist/fonts/enc//',    // Search all encoding subdirs
    ].join(':');

    ENV['TFMFONTS'] = [
        '.',
        '/texlive/texmf-dist/fonts/tfm//',    // Search all TFM subdirs
    ].join(':');

    ENV['VFFONTS'] = [
        '.',
        '/texlive/texmf-dist/fonts/vf//',     // Search all VF subdirs
    ].join(':');

    // Map file paths
    ENV['TEXFONTMAPS'] = [
        '.',
        '/texlive/texmf-dist/fonts/map/dvips//',
        '/texlive/texmf-dist/fonts/map/pdftex//',
    ].join(':');
}
