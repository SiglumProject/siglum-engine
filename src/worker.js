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

    mountBundle(bundleName, bundleData, manifest, bundleMeta = null) {
        this.bundleCache.set(bundleName, bundleData);
        let mounted = 0;
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

// Pending requests
const pendingCtanRequests = new Map();
const pendingBundleRequests = new Map();

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

// ============ Compilation ============

async function handleCompile(request) {
    const { id, source, engine, options, bundleData, ctanFiles, cachedFormat, cachedAuxFiles } = request;

    workerLog('=== Compilation Started ===');
    const totalStart = performance.now();

    if (!fileManifest) throw new Error('fileManifest not set');

    // Track accumulated resources across retries
    const bundleDataMap = bundleData instanceof Map ? bundleData : new Map(Object.entries(bundleData));
    const bundleMetaMap = new Map(); // Store bundle metadata for dynamically loaded bundles
    const accumulatedCtanFiles = new Map();

    if (ctanFiles) {
        const ctanFilesMap = ctanFiles instanceof Map ? ctanFiles : new Map(Object.entries(ctanFiles));
        for (const [path, content] of ctanFilesMap) accumulatedCtanFiles.set(path, content);
    }

    let pdfData = null;
    let compileSuccess = false;
    let retryCount = 0;
    const maxRetries = 10;
    const fetchedPackages = new Set();
    let lastExitCode = -1;
    let Module = null;
    let FS = null;

    while (!compileSuccess && retryCount < maxRetries) {
        if (retryCount > 0) {
            workerLog(`Retry #${retryCount}...`);
        }

        try {
            // Initialize fresh WASM instance
            Module = await initBusyTeX(cachedWasmModule, busytexJsUrl);
            FS = Module.FS;

            // Create VFS with unified mount handling
            const vfs = new VirtualFileSystem(FS, {
                onLog: workerLog,
                lazyEnabled: options.enableLazyFS
            });

            if (options.enableLazyFS) {
                vfs.patchForLazyLoading();
            }

            // Mount all bundles
            workerProgress('mount', 'Mounting files...');
            for (const [bundleName, data] of bundleDataMap) {
                const meta = bundleMetaMap.get(bundleName) || null;
                vfs.mountBundle(bundleName, data, fileManifest, meta);
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

            if (cachedFormat && engine === 'pdflatex') {
                FS.writeFile('/custom.fmt', cachedFormat.fmtData);
                fmtPath = '/custom.fmt';
                workerLog('Using custom format');
                const beginDocIdx = source.indexOf('\\begin{document}');
                if (beginDocIdx !== -1) docSource = source.substring(beginDocIdx);
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

            // Handle missing files
            if (!compileSuccess && options.enableCtan) {
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
            const Module = await initBusyTeX(cachedWasmModule, busytexJsUrl);
            const FS = Module.FS;

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
            cachedWasmModule = msg.wasmModule;
            busytexJsUrl = msg.busytexJsUrl;
            if (msg.manifest) {
                fileManifest = msg.manifest;
                packageMap = msg.packageMapData;
                bundleDeps = msg.bundleDepsData;
                bundleRegistry = new Set(msg.bundleRegistryData || []);
            }
            self.postMessage({ type: 'ready' });
            break;

        case 'compile':
            await handleCompile(msg);
            break;

        case 'generate-format':
            await handleFormatGenerate(msg);
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
    }
};

self.onerror = function(e) {
    self.postMessage({ type: 'log', message: 'Worker error: ' + e.message });
};
