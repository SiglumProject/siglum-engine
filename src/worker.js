// BusyTeX Compilation Worker
// This worker handles LaTeX compilation in a separate thread

const BUNDLE_BASE = 'packages/bundles';

// Worker state
let cachedWasmModule = null;
let busytexJsUrl = null;
let fileManifest = null;
let packageMap = null;
let bundleDeps = null;
let bundleRegistry = null;
let bundleCache = new Map();
let mountedBundles = new Set();
let dirNodeCache = new Map();
let ctanMountedFiles = new Set();
let lazyLoadCount = 0;

// Cached manifest index
let cachedBundleFilesMap = null;
let cachedManifestSize = 0;

// Pending CTAN fetch requests
const pendingCtanRequests = new Map();

function workerLog(msg) {
    self.postMessage({ type: 'log', message: msg });
}

function workerProgress(stage, detail) {
    self.postMessage({ type: 'progress', stage, detail });
}

// Request CTAN package from main thread
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

// Helper: ensure directory exists
function ensureDirectory(FS, dirPath) {
    const parts = dirPath.split('/').filter(p => p);
    let current = '';
    for (const part of parts) {
        current += '/' + part;
        try {
            FS.stat(current);
        } catch (e) {
            try {
                FS.mkdir(current);
            } catch (e2) {}
        }
    }
}

// Lazy content marker
const LAZY_MARKER_SYMBOL = '__siglum_lazy__';

function createLazyMarker(bundleName, start, end) {
    return {
        [LAZY_MARKER_SYMBOL]: true,
        bundleName,
        start,
        end,
        length: end - start,
        byteLength: end - start
    };
}

function isLazyMarker(obj) {
    return obj && typeof obj === 'object' && obj[LAZY_MARKER_SYMBOL] === true;
}

function resolveLazyContent(marker) {
    const bundleData = bundleCache.get(marker.bundleName);
    if (!bundleData) {
        workerLog('ERROR: Bundle not in cache: ' + marker.bundleName);
        return new Uint8Array(0);
    }
    lazyLoadCount++;
    if (lazyLoadCount <= 5) {
        workerLog('Lazy resolved #' + lazyLoadCount + ' from ' + marker.bundleName + ' (' + (marker.end - marker.start) + ' bytes)');
    }
    return new Uint8Array(bundleData.slice(marker.start, marker.end));
}

// Patch MEMFS for lazy loading
function patchMEMFSForLazyLoading(FS) {
    const MEMFS = FS.filesystems.MEMFS;
    if (!MEMFS || !MEMFS.stream_ops) {
        workerLog('WARNING: Cannot patch MEMFS');
        return false;
    }

    function ensureResolved(node) {
        if (isLazyMarker(node.contents)) {
            const resolved = resolveLazyContent(node.contents);
            node.contents = resolved;
            node.usedBytes = resolved.length;
        }
    }

    const originalRead = MEMFS.stream_ops.read;
    MEMFS.stream_ops.read = function(stream, buffer, offset, length, position) {
        ensureResolved(stream.node);
        return originalRead.call(this, stream, buffer, offset, length, position);
    };

    if (MEMFS.ops_table?.file?.stream?.read) {
        const originalTableRead = MEMFS.ops_table.file.stream.read;
        MEMFS.ops_table.file.stream.read = function(stream, buffer, offset, length, position) {
            ensureResolved(stream.node);
            return originalTableRead.call(this, stream, buffer, offset, length, position);
        };
    }

    if (MEMFS.stream_ops.mmap) {
        const originalMmap = MEMFS.stream_ops.mmap;
        MEMFS.stream_ops.mmap = function(stream, length, position, prot, flags) {
            ensureResolved(stream.node);
            return originalMmap.call(this, stream, length, position, prot, flags);
        };
    }

    workerLog('MEMFS patched for lazy loading');
    return true;
}

function shouldEagerLoad(path) {
    if (path.endsWith('.fmt')) return true;
    if (path.endsWith('texmf.cnf')) return true;
    if (path.endsWith('.map')) return true;
    return false;
}

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
    const beginDocMatch = source.match(/\\begin\{document\}/);

    let insertPos;
    if (documentclassMatch) {
        insertPos = documentclassMatch.index + documentclassMatch[0].length;
    } else if (beginDocMatch) {
        insertPos = beginDocMatch.index + beginDocMatch[0].length;
    } else {
        return source;
    }

    const preambleInsert = '\n% Font maps injected by Siglum\n' + mapCommands + '\n';
    workerLog('Injecting ' + newMaps.length + ' \\pdfmapfile commands');
    return source.slice(0, insertPos) + preambleInsert + source.slice(insertPos);
}

function generateLsR(FS, basePath) {
    const dirContents = new Map();
    const seenDirs = new Set();
    dirContents.set(basePath, { files: [], subdirs: [] });

    function getDir(dirPath) {
        if (!dirContents.has(dirPath)) {
            dirContents.set(dirPath, { files: [], subdirs: [] });
        }
        return dirContents.get(dirPath);
    }

    function ensureDirChain(dirPath) {
        if (seenDirs.has(dirPath) || dirPath.length <= basePath.length) return;
        seenDirs.add(dirPath);
        getDir(dirPath);
        const parentSlash = dirPath.lastIndexOf('/');
        if (parentSlash > basePath.length) {
            const parentDir = dirPath.substring(0, parentSlash);
            const subdir = dirPath.substring(parentSlash + 1);
            ensureDirChain(parentDir);
            getDir(parentDir).subdirs.push(subdir);
        } else if (parentSlash >= 0) {
            const subdir = dirPath.substring(parentSlash + 1);
            getDir(basePath).subdirs.push(subdir);
        }
    }

    for (const path of Object.keys(fileManifest)) {
        if (!path.startsWith(basePath)) continue;
        const lastSlash = path.lastIndexOf('/');
        if (lastSlash < 0) continue;
        const dirPath = path.substring(0, lastSlash);
        const fileName = path.substring(lastSlash + 1);
        if (!dirPath || !fileName) continue;
        ensureDirChain(dirPath);
        const dir = getDir(dirPath);
        if (dir?.files) dir.files.push(fileName);
    }

    for (const path of ctanMountedFiles) {
        if (!path.startsWith(basePath)) continue;
        const lastSlash = path.lastIndexOf('/');
        if (lastSlash < 0) continue;
        const dirPath = path.substring(0, lastSlash);
        const fileName = path.substring(lastSlash + 1);
        if (!dirPath || !fileName) continue;
        ensureDirChain(dirPath);
        const dir = getDir(dirPath);
        if (dir?.files) dir.files.push(fileName);
    }

    const output = ['% ls-R -- filename database.', '% Created by Siglum worker', ''];

    function outputDir(dirPath) {
        const contents = dirContents.get(dirPath);
        if (!contents) return;
        output.push(dirPath + ':');
        contents.files.sort();
        contents.subdirs.sort();
        for (const file of contents.files) output.push(file);
        for (const subdir of contents.subdirs) output.push(subdir);
        output.push('');
        for (const subdir of contents.subdirs) {
            outputDir(dirPath + '/' + subdir);
        }
    }

    outputDir(basePath);
    return output.join('\n');
}

function mountBundleLazy(FS, bundleName, bundleData, manifest, bundleFilesMap) {
    if (mountedBundles.has(bundleName)) return 0;
    bundleCache.set(bundleName, bundleData);
    const MEMFS = FS.filesystems.MEMFS;

    let bundleFiles;
    if (bundleFilesMap?.has(bundleName)) {
        bundleFiles = bundleFilesMap.get(bundleName);
    } else {
        bundleFiles = [];
        for (const [path, info] of Object.entries(manifest)) {
            if (info.bundle === bundleName) bundleFiles.push([path, info]);
        }
    }

    const directories = new Set();
    for (const [filePath] of bundleFiles) {
        const lastSlash = filePath.lastIndexOf('/');
        if (lastSlash > 0) directories.add(filePath.substring(0, lastSlash));
    }
    for (const dirPath of directories) ensureDirectory(FS, dirPath);

    const parentCache = new Map();
    for (const dirPath of directories) {
        try {
            parentCache.set(dirPath, FS.lookupPath(dirPath).node);
        } catch (e) {}
    }

    let mounted = 0;
    for (const [filePath, info] of bundleFiles) {
        const lastSlash = filePath.lastIndexOf('/');
        const dirPath = filePath.substring(0, lastSlash);
        const fileName = filePath.substring(lastSlash + 1);

        try {
            const parentNode = parentCache.get(dirPath);
            if (!parentNode) continue;
            if (parentNode.contents?.[fileName]) continue;

            if (shouldEagerLoad(filePath)) {
                const content = new Uint8Array(bundleData.slice(info.start, info.end));
                FS.writeFile(filePath, content);
            } else {
                const node = MEMFS.createNode(parentNode, fileName, 33206, 0);
                node.contents = createLazyMarker(bundleName, info.start, info.end);
                node.usedBytes = info.end - info.start;
            }
            mounted++;
        } catch (e) {}
    }

    mountedBundles.add(bundleName);
    return mounted;
}

function mountBundleEager(FS, bundleName, bundleData, manifest) {
    if (mountedBundles.has(bundleName)) return 0;
    let mounted = 0;

    for (const [filePath, info] of Object.entries(manifest)) {
        if (info.bundle !== bundleName) continue;
        const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
        ensureDirectory(FS, dirPath);
        try {
            try { FS.stat(filePath); continue; } catch (e) {}
            const content = new Uint8Array(bundleData.slice(info.start, info.end));
            FS.writeFile(filePath, content);
            mounted++;
        } catch (e) {}
    }

    mountedBundles.add(bundleName);
    return mounted;
}

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

function copyEncFilesToStandardLocation(FS, files) {
    const ENC_STANDARD_BASE = '/texlive/texmf-dist/fonts/enc/dvips';
    const encInType1 = Object.keys(files).filter(path =>
        path.endsWith('.enc') && path.includes('/fonts/type1/')
    );
    if (encInType1.length === 0) return;

    let copied = 0;
    for (const srcPath of encInType1) {
        try {
            const match = srcPath.match(/\/fonts\/type1\/public\/([^/]+)\//);
            if (!match) continue;
            const pkgName = match[1];
            const fileName = srcPath.split('/').pop();
            const destDir = ENC_STANDARD_BASE + '/' + pkgName;
            const destPath = destDir + '/' + fileName;
            ensureDirectory(FS, destDir);
            const content = FS.readFile(srcPath);
            FS.writeFile(destPath, content);
            ctanMountedFiles.add(destPath);
            copied++;
        } catch (e) {}
    }
    if (copied > 0) workerLog('Copied ' + copied + ' .enc files to standard location');
}

function rewriteMapWithAbsolutePaths(FS, mapContent, mapFilePath) {
    const lines = mapContent.split('\n');
    const rewrittenLines = [];
    const mapDir = mapFilePath.substring(0, mapFilePath.lastIndexOf('/'));
    const packageName = mapFilePath.includes('/cm-super') ? 'cm-super' :
                       (mapFilePath.match(/\/([^\/]+)\/[^\/]+\.map$/) || [])[1] || '';

    const searchPaths = {
        pfb: [
            '/texlive/texmf-dist/fonts/type1/public/' + packageName,
            '/texlive/texmf-dist/fonts/type1/public/cm-super',
            mapDir
        ],
        enc: [
            '/texlive/texmf-dist/fonts/enc/dvips/' + packageName,
            '/texlive/texmf-dist/fonts/enc/dvips/cm-super',
            '/texlive/texmf-dist/fonts/type1/public/' + packageName,
            mapDir
        ]
    };

    for (const line of lines) {
        if (line.trim().startsWith('%') || line.trim() === '') {
            rewrittenLines.push(line);
            continue;
        }

        let rewrittenLine = line;
        const fileRefPattern = /<<?([a-zA-Z0-9_-]+\.(pfb|enc))/g;
        let match;
        while ((match = fileRefPattern.exec(line)) !== null) {
            const fullMatch = match[0];
            const filename = match[1];
            const ext = match[2];
            const prefix = fullMatch.startsWith('<<') ? '<<' : '<';
            const paths = searchPaths[ext] || [];

            for (const searchDir of paths) {
                const candidatePath = searchDir + '/' + filename;
                try {
                    if (FS.analyzePath(candidatePath).exists) {
                        rewrittenLine = rewrittenLine.replace(fullMatch, prefix + candidatePath);
                        break;
                    }
                } catch (e) {}
            }
        }
        rewrittenLines.push(rewrittenLine);
    }

    return rewrittenLines.join('\n');
}

function appendFontMapsToUpdmap(FS, files) {
    const PDFTEX_MAP_PATH = '/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map';
    const mapFiles = Object.keys(files).filter(p => p.endsWith('.map') && !p.endsWith('pdftex.map'));
    if (mapFiles.length === 0) return;

    let existingMap = '';
    try {
        existingMap = new TextDecoder().decode(FS.readFile(PDFTEX_MAP_PATH));
    } catch (e) {
        ensureDirectory(FS, PDFTEX_MAP_PATH.substring(0, PDFTEX_MAP_PATH.lastIndexOf('/')));
    }

    let appended = 0;
    for (const mapPath of mapFiles) {
        try {
            const mapContent = new TextDecoder().decode(FS.readFile(mapPath));
            const rewrittenContent = rewriteMapWithAbsolutePaths(FS, mapContent, mapPath);
            existingMap += '\n% Added from ' + mapPath + '\n' + rewrittenContent + '\n';
            appended++;
        } catch (e) {}
    }

    if (appended > 0) {
        FS.writeFile(PDFTEX_MAP_PATH, existingMap);
        workerLog('Appended ' + appended + ' font map files to pdftex.map');
    }
}

async function initBusyTeX(wasmModule, jsUrl) {
    workerLog('Initializing WASM in worker...');
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
        print: (text) => workerLog('[TeX] ' + text),
        printErr: (text) => workerLog('[TeX ERR] ' + text),
        locateFile: (path) => path,
        preRun: [function() {
            moduleConfig.ENV = moduleConfig.ENV || {};
            moduleConfig.ENV['TEXMFCNF'] = '/texlive/texmf-dist/web2c';
            moduleConfig.ENV['TEXMFROOT'] = '/texlive';
            moduleConfig.ENV['TEXMFDIST'] = '/texlive/texmf-dist';
            moduleConfig.ENV['TEXMFVAR'] = '/texlive/texmf-dist/texmf-var';
            moduleConfig.ENV['TEXMFSYSVAR'] = '/texlive/texmf-dist/texmf-var';
            moduleConfig.ENV['TEXMF'] = '/texlive/texmf-dist';
            moduleConfig.ENV['TEXINPUTS'] = '.:/texlive/texmf-dist/tex/latex//:/texlive/texmf-dist/tex/xetex//:/texlive/texmf-dist/tex/generic//:/texlive/texmf-dist/tex//:';
            moduleConfig.ENV['T1FONTS'] = '.:/texlive/texmf-dist/fonts/type1/public/cm-super:/texlive/texmf-dist/fonts/type1//';
            moduleConfig.ENV['ENCFONTS'] = '.:/texlive/texmf-dist/fonts/enc/dvips/cm-super:/texlive/texmf-dist/fonts/type1/public/cm-super:/texlive/texmf-dist/fonts/enc//';
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

    workerLog('WASM initialized in ' + (performance.now() - startTime).toFixed(0) + 'ms');
    return Module;
}

async function handleCompile(request) {
    const { id, source, engine, options, bundleData, ctanFiles, cachedFormat, cachedAuxFiles } = request;

    workerLog('=== Worker Compilation Started ===');
    const totalStart = performance.now();

    mountedBundles.clear();
    dirNodeCache.clear();
    ctanMountedFiles.clear();
    lazyLoadCount = 0;

    if (!fileManifest) throw new Error('fileManifest not set');

    try {
        workerProgress('init', 'Initializing WASM...');
        let Module = await initBusyTeX(cachedWasmModule, busytexJsUrl);
        let FS = Module.FS;

        if (options.enableLazyFS) patchMEMFSForLazyLoading(FS);

        workerProgress('mount', 'Mounting bundles...');
        const bundleDataMap = bundleData instanceof Map ? bundleData : new Map(Object.entries(bundleData));

        const manifestSize = Object.keys(fileManifest).length;
        if (!cachedBundleFilesMap || cachedManifestSize !== manifestSize) {
            cachedBundleFilesMap = new Map();
            for (const [path, info] of Object.entries(fileManifest)) {
                if (!cachedBundleFilesMap.has(info.bundle)) cachedBundleFilesMap.set(info.bundle, []);
                cachedBundleFilesMap.get(info.bundle).push([path, info]);
            }
            cachedManifestSize = manifestSize;
        }

        const mountStart = performance.now();
        let totalMounted = 0;
        for (const [bundleName, data] of bundleDataMap) {
            if (options.enableLazyFS) {
                totalMounted += mountBundleLazy(FS, bundleName, data, fileManifest, cachedBundleFilesMap);
            } else {
                totalMounted += mountBundleEager(FS, bundleName, data, fileManifest);
            }
        }
        workerLog('Mounted ' + totalMounted + ' files in ' + (performance.now() - mountStart).toFixed(0) + 'ms');

        let ctanMounted = 0;
        const ctanFileObj = {};
        if (ctanFiles) {
            const ctanFilesMap = ctanFiles instanceof Map ? ctanFiles : new Map(Object.entries(ctanFiles));
            for (const [filePath, content] of ctanFilesMap) {
                if (fileManifest[filePath]) continue;
                const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
                ensureDirectory(FS, dirPath);
                try {
                    FS.writeFile(filePath, content);
                    ctanMountedFiles.add(filePath);
                    ctanFileObj[filePath] = true;
                    ctanMounted++;
                } catch (e) {}
            }
        }
        if (ctanMounted > 0) {
            workerLog('Mounted ' + ctanMounted + ' CTAN files');
            appendFontMapsToUpdmap(FS, ctanFileObj);
            copyEncFilesToStandardLocation(FS, ctanFileObj);
        }

        if (cachedAuxFiles && Object.keys(cachedAuxFiles).length > 0) {
            const restored = restoreAuxFiles(FS, cachedAuxFiles);
            if (restored > 0) workerLog('Restored ' + restored + ' aux files');
        }

        const lsRContent = generateLsR(FS, '/texlive/texmf-dist');
        FS.writeFile('/texlive/texmf-dist/ls-R', lsRContent);

        let fmtPath = engine === 'pdflatex'
            ? '/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt'
            : '/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex.fmt';

        let docSource = source;
        if (cachedFormat && engine === 'pdflatex') {
            FS.writeFile('/custom.fmt', cachedFormat.fmtData);
            fmtPath = '/custom.fmt';
            workerLog('Using custom format');
            const beginDocIdx = source.indexOf('\\begin{document}');
            if (beginDocIdx !== -1) docSource = source.substring(beginDocIdx);
        }

        if (engine === 'pdflatex') {
            if (!cachedFormat) docSource = injectMicrotypeWorkaround(docSource);
            const baseMaps = [
                '/texlive/texmf-dist/fonts/map/dvips/amsfonts/cm.map',
                '/texlive/texmf-dist/fonts/map/dvips/amsfonts/cmextra.map',
                '/texlive/texmf-dist/fonts/map/dvips/amsfonts/symbols.map',
            ];
            const existingMaps = baseMaps.filter(m => FS.analyzePath(m).exists);
            if (existingMaps.length > 0) {
                docSource = injectPdfMapFileCommands(docSource, existingMaps);
                const baseMapsObj = {};
                for (const m of existingMaps) baseMapsObj[m] = true;
                appendFontMapsToUpdmap(FS, baseMapsObj);
            }
        }

        FS.writeFile('/document.tex', docSource);
        workerProgress('compile', 'Running ' + engine + '...');

        let pdfData = null;
        let compileSuccess = false;
        let retryCount = 0;
        const maxRetries = 10;
        const ctanFetched = new Set();
        let lastExitCode = -1;
        const accumulatedCtanFiles = new Map();

        if (ctanFiles) {
            const ctanFilesMap = ctanFiles instanceof Map ? ctanFiles : new Map(Object.entries(ctanFiles));
            for (const [path, content] of ctanFilesMap) accumulatedCtanFiles.set(path, content);
        }

        while (!compileSuccess && retryCount < maxRetries) {
            if (retryCount > 0) {
                workerLog('Retry #' + retryCount + '...');
                Module = await initBusyTeX(cachedWasmModule, busytexJsUrl);
                FS = Module.FS;
                if (options.enableLazyFS) patchMEMFSForLazyLoading(FS);

                mountedBundles.clear();
                bundleCache.clear();
                for (const [bundleName, data] of bundleDataMap) {
                    if (options.enableLazyFS) {
                        mountBundleLazy(FS, bundleName, data, fileManifest, cachedBundleFilesMap);
                    } else {
                        mountBundleEager(FS, bundleName, data, fileManifest);
                    }
                }

                ctanMountedFiles.clear();
                const retryCtanObj = {};
                for (const [path, content] of accumulatedCtanFiles) {
                    if (fileManifest[path]) continue;
                    ensureDirectory(FS, path.substring(0, path.lastIndexOf('/')));
                    try {
                        FS.writeFile(path, content);
                        ctanMountedFiles.add(path);
                        retryCtanObj[path] = true;
                    } catch (e) {}
                }
                appendFontMapsToUpdmap(FS, retryCtanObj);
                copyEncFilesToStandardLocation(FS, retryCtanObj);

                if (cachedAuxFiles) restoreAuxFiles(FS, cachedAuxFiles);
                FS.writeFile('/texlive/texmf-dist/ls-R', generateLsR(FS, '/texlive/texmf-dist'));
                if (cachedFormat && fmtPath === '/custom.fmt') FS.writeFile('/custom.fmt', cachedFormat.fmtData);

                const mapFilesInObj = Object.keys(retryCtanObj).filter(p => p.endsWith('.map'));
                if (mapFilesInObj.length > 0 && engine === 'pdflatex') {
                    docSource = injectPdfMapFileCommands(docSource, mapFilesInObj);
                }
                FS.writeFile('/document.tex', docSource);
            }

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
                } catch (e) {}
            }

            if (!compileSuccess && options.enableCtan) {
                let logContent = '';
                try { logContent = new TextDecoder().decode(FS.readFile('/document.log')); } catch (e) {}
                const allOutput = logContent + ' ' + (result.stdout || '') + ' ' + (result.stderr || '');
                const missingFile = extractMissingFile(allOutput, ctanFetched);

                if (missingFile) {
                    const pkgName = getPackageFromFile(missingFile);
                    workerLog('Missing: ' + missingFile + ', fetching ' + pkgName + ' from CTAN...');
                    try {
                        const ctanData = await requestCtanFetch(pkgName);
                        if (ctanData.success) {
                            ctanFetched.add(pkgName);
                            const files = ctanData.files instanceof Map ? ctanData.files : new Map(Object.entries(ctanData.files));
                            for (const [path, content] of files) accumulatedCtanFiles.set(path, content);
                            retryCount++;
                            continue;
                        }
                    } catch (e) {
                        workerLog('CTAN fetch failed: ' + e.message);
                    }
                }
                break;
            } else if (!compileSuccess) {
                break;
            }
        }

        const auxFiles = compileSuccess ? collectAuxFiles(FS) : null;
        const totalTime = performance.now() - totalStart;
        workerLog('Total time: ' + totalTime.toFixed(0) + 'ms');

        const transferables = pdfData ? [pdfData.buffer] : [];
        self.postMessage({
            type: 'compile-response',
            id,
            success: compileSuccess,
            pdfData: pdfData ? pdfData.buffer : null,
            exitCode: lastExitCode,
            auxFilesToCache: auxFiles,
            stats: { compileTimeMs: totalTime, lazyLoadCount, bundlesUsed: [...bundleDataMap.keys()] }
        }, transferables);

    } catch (e) {
        workerLog('Error: ' + e.message);
        self.postMessage({ type: 'compile-response', id, success: false, exitCode: -1, error: e.message });
    }
}

async function handleFormatGenerate(request) {
    const { id, preambleContent, engine, manifest, packageMapData, bundleDepsData, bundleRegistryData, bundleData, ctanFiles } = request;

    workerLog('=== Format Generation Started ===');
    const startTime = performance.now();

    mountedBundles.clear();
    ctanMountedFiles.clear();
    fileManifest = manifest;
    packageMap = packageMapData;
    bundleDeps = bundleDepsData;
    bundleRegistry = new Set(bundleRegistryData);

    const bundleDataMap = bundleData instanceof Map ? bundleData : new Map(Object.entries(bundleData));
    const accumulatedCtanFiles = new Map();

    // Initialize with provided CTAN files
    if (ctanFiles) {
        const ctanFilesMap = ctanFiles instanceof Map ? ctanFiles : new Map(Object.entries(ctanFiles));
        for (const [path, content] of ctanFilesMap) accumulatedCtanFiles.set(path, content);
    }

    let retryCount = 0;
    const maxRetries = 10;
    const ctanFetched = new Set();

    while (retryCount < maxRetries) {
        try {
            const Module = await initBusyTeX(cachedWasmModule, busytexJsUrl);
            const FS = Module.FS;

            mountedBundles.clear();
            bundleCache.clear();

            for (const [bundleName, data] of bundleDataMap) {
                mountBundleEager(FS, bundleName, data, fileManifest);
            }

            // Mount accumulated CTAN files
            ctanMountedFiles.clear();
            for (const [filePath, content] of accumulatedCtanFiles) {
                if (fileManifest[filePath]) continue;
                ensureDirectory(FS, filePath.substring(0, filePath.lastIndexOf('/')));
                try {
                    FS.writeFile(filePath, content);
                    ctanMountedFiles.add(filePath);
                } catch (e) {}
            }

            FS.writeFile('/texlive/texmf-dist/ls-R', generateLsR(FS, '/texlive/texmf-dist'));
            FS.writeFile('/myformat.ini', preambleContent + '\n\\dump\n');

            const result = Module.callMainWithRedirects([
                'pdflatex', '-ini', '-jobname=myformat', '-interaction=nonstopmode',
                '&/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex', '/myformat.ini'
            ]);

            if (result.exit_code === 0) {
                const formatData = FS.readFile('/myformat.fmt');
                workerLog('Format generated: ' + (formatData.byteLength / 1024 / 1024).toFixed(1) + 'MB in ' + (performance.now() - startTime).toFixed(0) + 'ms');

                self.postMessage({
                    type: 'format-generate-response', id, success: true, formatData: formatData.buffer
                }, [formatData.buffer]);
                return;
            }

            // Format generation failed - check for missing packages
            let logContent = '';
            try { logContent = new TextDecoder().decode(FS.readFile('/myformat.log')); } catch (e) {}
            const allOutput = logContent + ' ' + (result.stdout || '') + ' ' + (result.stderr || '');
            const missingFile = extractMissingFile(allOutput, ctanFetched);

            if (missingFile) {
                const pkgName = getPackageFromFile(missingFile);
                workerLog('Format missing: ' + missingFile + ', fetching ' + pkgName + ' from CTAN...');
                try {
                    const ctanData = await requestCtanFetch(pkgName);
                    if (ctanData.success) {
                        ctanFetched.add(pkgName);
                        const files = ctanData.files instanceof Map ? ctanData.files : new Map(Object.entries(ctanData.files));
                        for (const [path, content] of files) accumulatedCtanFiles.set(path, content);
                        retryCount++;
                        workerLog('Retry format generation #' + retryCount + '...');
                        continue;
                    }
                } catch (e) {
                    workerLog('CTAN fetch failed: ' + e.message);
                }
            }

            // No missing file found or CTAN fetch failed
            throw new Error('Format generation failed with exit code ' + result.exit_code);

        } catch (e) {
            if (retryCount >= maxRetries - 1) {
                workerLog('Format generation error: ' + e.message);
                self.postMessage({ type: 'format-generate-response', id, success: false, error: e.message });
                return;
            }
            throw e;
        }
    }

    workerLog('Format generation failed after ' + maxRetries + ' retries');
    self.postMessage({ type: 'format-generate-response', id, success: false, error: 'Max retries exceeded' });
}

// Message handler
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
    }
};

self.onerror = function(e) {
    self.postMessage({ type: 'log', message: 'Worker error: ' + e.message });
};
