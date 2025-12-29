// Main BusyTeXCompiler class - orchestrates compilation

import { BundleManager, detectEngine, extractPreamble, hashPreamble } from './bundles.js';
import { CTANFetcher, getPackageFromFile } from './ctan.js';
import {
    getAuxCache,
    saveAuxCache,
    getCachedPdf,
    saveCachedPdf,
    hashDocument,
    getFmtMeta,
    saveFmtMeta,
    readFromOPFS,
    writeToOPFS,
    clearCTANCache,
} from './storage.js';

export class BusyTeXCompiler {
    constructor(options = {}) {
        this.bundlesUrl = options.bundlesUrl || 'packages/bundles';
        this.wasmUrl = options.wasmUrl || 'busytex.wasm';
        this.workerUrl = options.workerUrl || null; // Will use embedded worker if not provided
        this.ctanProxyUrl = options.ctanProxyUrl || 'http://localhost:8081';
        this.xzwasmUrl = options.xzwasmUrl || './src/xzwasm.js';

        this.bundleManager = new BundleManager({
            bundleBase: this.bundlesUrl,
            onLog: (msg) => this._log(msg),
        });

        this.ctanFetcher = new CTANFetcher({
            proxyUrl: this.ctanProxyUrl,
            xzwasmUrl: this.xzwasmUrl,
            onLog: (msg) => this._log(msg),
        });

        this.worker = null;
        this.workerReady = false;
        this.pendingCompile = null;
        this.formatCache = new Map();
        this.formatGenerationPromise = null;

        this.onLog = options.onLog || (() => {});
        this.onProgress = options.onProgress || (() => {});

        // Options
        this.enableCtan = options.enableCtan !== false;
        this.enableLazyFS = options.enableLazyFS !== false;
        this.enableDocCache = options.enableDocCache !== false;
    }

    _log(msg) {
        this.onLog(msg);
    }

    async init() {
        this._log('Initializing BusyTeX compiler...');

        // Load manifests + WASM in parallel
        await Promise.all([
            this._loadManifests(),
            this._loadWasm(),
        ]);

        // Worker init (required) + bundle preload (optional, don't fail if it errors)
        await Promise.all([
            this._initWorker(),
            this.bundleManager.preloadEngine('pdflatex').catch(e => {
                this._log('Bundle preload failed (will load on demand): ' + e.message);
            }),
        ]);

        this._log('Compiler initialized');
    }

    async _loadManifests() {
        await this.bundleManager.loadManifest();
        await this.bundleManager.loadBundleDeps();
    }

    async _loadWasm() {
        this._log('Loading WASM...');
        const startTime = performance.now();

        try {
            const response = await fetch(this.wasmUrl);
            this.wasmModule = await WebAssembly.compileStreaming(response);
            this._log('WASM loaded in ' + (performance.now() - startTime).toFixed(0) + 'ms');
        } catch (e) {
            this._log('WASM load failed: ' + e.message);
            throw e;
        }
    }

    async _initWorker() {
        if (this.worker) return;

        // Get worker code - use external URL or read from src/worker.js
        let workerUrl = this.workerUrl;
        if (!workerUrl) {
            // Fetch worker.js and create blob URL
            const workerResponse = await fetch(new URL('./worker.js', import.meta.url));
            const workerCode = await workerResponse.text();
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            workerUrl = URL.createObjectURL(blob);
        }

        this.worker = new Worker(workerUrl);
        this.worker.onmessage = (e) => this._handleWorkerMessage(e);
        this.worker.onerror = (e) => this._handleWorkerError(e);

        // Get absolute URL for busytex.js - derive from wasmUrl
        const wasmUrlObj = new URL(this.wasmUrl, window.location.href);
        const busytexJsUrl = new URL('busytex.js', wasmUrlObj.href).href;

        // Send init message
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 30000);

            const originalHandler = this.worker.onmessage;
            this.worker.onmessage = (e) => {
                if (e.data.type === 'ready') {
                    clearTimeout(timeout);
                    this.workerReady = true;
                    this.worker.onmessage = originalHandler;
                    this._log('Worker ready');
                    resolve();
                } else {
                    originalHandler(e);
                }
            };

            this.worker.postMessage({
                type: 'init',
                wasmModule: this.wasmModule,
                busytexJsUrl,
                manifest: this.bundleManager.fileManifest,
                packageMapData: this.bundleManager.packageMap,
                bundleDepsData: this.bundleManager.bundleDeps,
                bundleRegistryData: this.bundleManager.bundleRegistry ? [...this.bundleManager.bundleRegistry] : [],
            });
        });
    }

    _handleWorkerMessage(e) {
        const msg = e.data;

        switch (msg.type) {
            case 'log':
                this._log(msg.message);
                break;

            case 'progress':
                this.onProgress(msg.stage, msg.detail);
                break;

            case 'compile-response':
                if (this.pendingCompile) {
                    this.pendingCompile.resolve(msg);
                    this.pendingCompile = null;
                }
                break;

            case 'format-generate-response':
                if (this.pendingFormat) {
                    this.pendingFormat.resolve(msg);
                    this.pendingFormat = null;
                }
                break;

            case 'ctan-fetch-request':
                this._handleCtanFetchRequest(msg);
                break;

            case 'bundle-fetch-request':
                this._handleBundleFetchRequest(msg);
                break;

            case 'file-range-fetch-request':
                this._handleFileRangeFetchRequest(msg).catch(e => {
                    console.error('[Compiler] file-range-fetch-request error:', e);
                    this._log('Error handling file range fetch: ' + e.message);
                });
                break;

            default:
                // Log unhandled message types for debugging
                if (msg.type && !['log', 'progress', 'compile-response', 'format-generate-response'].includes(msg.type)) {
                    console.log('[Compiler] Unhandled message type:', msg.type);
                }
        }
    }

    _handleWorkerError(e) {
        this._log('Worker error: ' + e.message);
        if (this.pendingCompile) {
            this.pendingCompile.reject(new Error('Worker error: ' + e.message));
            this.pendingCompile = null;
        }
        this.workerReady = false;
        this.worker = null;
    }

    async _handleCtanFetchRequest(msg) {
        const { requestId, packageName } = msg;

        try {
            this._log('Worker requested CTAN package: ' + packageName);
            // Only fetch this specific package, not dependencies
            // Dependencies are resolved by the worker's retry loop - if a dependency
            // is missing, the worker will request it specifically
            const result = await this.ctanFetcher.fetchPackage(packageName);

            if (!result) {
                this.worker.postMessage({
                    type: 'ctan-fetch-response',
                    requestId,
                    packageName,
                    success: false,
                    error: 'Package not found',
                });
                return;
            }

            this.worker.postMessage({
                type: 'ctan-fetch-response',
                requestId,
                packageName,
                success: true,
                files: Object.fromEntries(result.files),
                dependencies: result.dependencies || [],
            });
        } catch (e) {
            this._log('CTAN fetch error: ' + e.message);
            this.worker.postMessage({
                type: 'ctan-fetch-response',
                requestId,
                packageName,
                success: false,
                error: e.message,
            });
        }
    }

    async _handleBundleFetchRequest(msg) {
        const { requestId, bundleName } = msg;

        try {
            this._log('Worker requested bundle: ' + bundleName);

            // Load bundle data and metadata in parallel
            const [bundleData, metaResponse] = await Promise.all([
                this.bundleManager.loadBundle(bundleName),
                fetch(`${this.bundlesUrl}/${bundleName}.meta.json`).catch(() => null),
            ]);

            // Parse metadata if available
            let bundleMeta = null;
            if (metaResponse?.ok) {
                try {
                    bundleMeta = await metaResponse.json();
                } catch (e) {
                    this._log('Failed to parse bundle metadata: ' + e.message);
                }
            }

            // Copy bundleData before transfer so original stays valid in cache
            const bundleDataCopy = bundleData.slice(0);
            this.worker.postMessage({
                type: 'bundle-fetch-response',
                requestId,
                bundleName,
                success: true,
                bundleData: bundleDataCopy,
                bundleMeta,
            }, [bundleDataCopy]);
        } catch (e) {
            this._log('Bundle fetch error: ' + e.message);
            this.worker.postMessage({
                type: 'bundle-fetch-response',
                requestId,
                bundleName,
                success: false,
                error: e.message,
            });
        }
    }

    async _handleFileRangeFetchRequest(msg) {
        const { requestId, bundleName, start, end } = msg;

        try {
            this._log(`Worker requested file range: ${bundleName} [${start}:${end}]`);

            // Fetch using Range request to the uncompressed .raw file
            const url = `${this.bundlesUrl}/${bundleName}.raw`;
            const response = await fetch(url, {
                headers: {
                    'Range': `bytes=${start}-${end - 1}`,
                },
            });

            if (response.status !== 206 && response.status !== 200) {
                throw new Error(`Range request failed with status ${response.status}`);
            }

            const data = new Uint8Array(await response.arrayBuffer());
            this._log(`File range fetched: ${data.length} bytes`);

            this.worker.postMessage({
                type: 'file-range-fetch-response',
                requestId,
                bundleName,
                start,
                end,
                success: true,
                data,
            }, [data.buffer]);
        } catch (e) {
            this._log('File range fetch error: ' + e.message);
            this.worker.postMessage({
                type: 'file-range-fetch-response',
                requestId,
                bundleName,
                start,
                end,
                success: false,
                error: e.message,
            });
        }
    }

    async compile(source, options = {}) {
        // Wait for any pending format generation to complete before checking cache
        // This ensures the format is available in OPFS for the current compile
        if (this.formatGenerationPromise) {
            this._log('Waiting for format generation to complete...');
            await this.formatGenerationPromise.catch(() => {});
        }

        const engine = options.engine || detectEngine(source);
        const useCache = this.enableDocCache && options.useCache !== false;

        // Check document cache
        if (useCache) {
            const docHash = hashDocument(source);
            const cached = await getCachedPdf(docHash, engine);
            if (cached) {
                this._log('Using cached PDF');
                return {
                    success: true,
                    pdf: new Uint8Array(cached),
                    cached: true,
                };
            }
        }

        // Ensure worker is ready
        if (!this.workerReady) {
            await this._initWorker();
        }

        // Determine required bundles
        const { bundles } = this.bundleManager.checkPackages(source, engine);
        this._log('Required bundles: ' + bundles.join(', '));

        // Load bundle data and transfer to worker
        // Worker VFS resets each compile, so bundles must be sent every time
        // Use transfer (not clone) to avoid duplication - copies are made from cache
        this.onProgress('loading', 'Loading bundles...');
        const loadedBundles = await this.bundleManager.loadBundles(bundles);

        let bundleData = {};
        let transferList = [];
        let totalBytes = 0;

        for (const [name, data] of Object.entries(loadedBundles)) {
            if (data) {
                // Create copy for transfer (original stays in bundleManager cache)
                const copy = data.slice(0);
                bundleData[name] = copy;
                transferList.push(copy);
                totalBytes += copy.byteLength;
            }
        }
        this._log(`Transferring ${Object.keys(bundleData).length} bundles (${(totalBytes/1024/1024).toFixed(1)}MB)`);

        // Get CTAN files from memory cache (populated by previous fetches)
        const ctanFiles = this.ctanFetcher.getCachedFiles();

        // Merge in any additional files provided by the user
        const additionalFiles = options.additionalFiles || {};
        for (const [filename, content] of Object.entries(additionalFiles)) {
            // Convert string content to Uint8Array
            const data = typeof content === 'string'
                ? new TextEncoder().encode(content)
                : content;
            // Mount in current directory (will be found by TeX)
            ctanFiles['/' + filename] = data;
        }

        // Check for cached format
        let cachedFormat = null;
        const preamble = extractPreamble(source);
        const preambleHash = hashPreamble(preamble);
        const fmtMeta = await getFmtMeta(preambleHash + '_' + engine);
        if (fmtMeta) {
            const fmtData = await readFromOPFS(fmtMeta.fmtPath);
            // Ensure buffer isn't detached (byteLength > 0) and create a fresh copy with slice()
            if (fmtData && fmtData.buffer.byteLength > 0) {
                cachedFormat = {
                    fmtName: preambleHash + '_' + engine,
                    fmtData: fmtData.slice(),
                };
                this._log('Using cached format');
            }
        }

        // Check for cached aux files (include format state in key to avoid mismatch)
        const auxCacheKey = cachedFormat ? preambleHash + '_fmt' : preambleHash;
        const auxCache = await getAuxCache(auxCacheKey);

        // Send compile request
        this.onProgress('compiling', 'Compiling...');
        const compileId = crypto.randomUUID();

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingCompile) {
                    this.pendingCompile = null;
                    reject(new Error('Compilation timeout'));
                }
            }, 120000);

            this.pendingCompile = {
                resolve: async (result) => {
                    clearTimeout(timeout);

                    if (result.success) {
                        const pdfData = new Uint8Array(result.pdfData);

                        // Cache the PDF
                        if (useCache) {
                            const docHash = hashDocument(source);
                            await saveCachedPdf(docHash, engine, result.pdfData);
                        }

                        // Cache aux files (use same key that includes format state)
                        if (result.auxFilesToCache) {
                            await saveAuxCache(auxCacheKey, result.auxFilesToCache);
                        }

                        resolve({
                            success: true,
                            pdf: pdfData,
                            stats: result.stats,
                            log: result.log,
                        });
                    } else {
                        resolve({
                            success: false,
                            error: result.error,
                            exitCode: result.exitCode,
                            log: result.log,
                        });
                    }
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            };

            this.worker.postMessage({
                type: 'compile',
                id: compileId,
                source,
                engine,
                options: {
                    enableLazyFS: this.enableLazyFS,
                    enableCtan: this.enableCtan,
                },
                bundleData,
                ctanFiles,
                cachedFormat,
                cachedAuxFiles: auxCache?.files || null,
                deferredBundleNames: this.bundleManager.bundleDeps?.deferred || [],
            }, transferList);
        });
    }

    async generateFormat(source, options = {}) {
        const engine = options.engine || 'pdflatex';
        const preamble = extractPreamble(source);

        if (!preamble) {
            throw new Error('No preamble found in source');
        }

        // Check cache
        const preambleHash = hashPreamble(preamble);
        const fmtKey = preambleHash + '_' + engine;
        const fmtMeta = await getFmtMeta(fmtKey);
        if (fmtMeta) {
            const fmtData = await readFromOPFS(fmtMeta.fmtPath);
            if (fmtData) {
                this._log('Format already cached');
                return new Uint8Array(fmtData);
            }
        }

        // Ensure worker is ready
        if (!this.workerReady) {
            await this._initWorker();
        }

        // Determine required bundles
        const { bundles } = this.bundleManager.checkPackages(source, engine);
        const bundleData = await this.bundleManager.loadBundles(bundles);

        // Get CTAN files from memory cache
        const ctanFiles = this.ctanFetcher.getCachedFiles();

        this._log('Generating format file...');
        this.onProgress('format', 'Generating format...');

        // Track this promise so compile() can wait for it
        this.formatGenerationPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingFormat) {
                    this.pendingFormat = null;
                    reject(new Error('Format generation timeout'));
                }
            }, 300000); // 5 minute timeout

            this.pendingFormat = {
                resolve: async (result) => {
                    clearTimeout(timeout);

                    if (result.success) {
                        const fmtData = new Uint8Array(result.formatData);

                        // Cache to OPFS
                        const fmtPath = `fmt-cache/${fmtKey}.fmt`;
                        await writeToOPFS(fmtPath, fmtData);
                        await saveFmtMeta(fmtKey, { fmtPath });

                        this._log('Format generated and cached');
                        resolve(fmtData);
                    } else {
                        reject(new Error(result.error || 'Format generation failed'));
                    }
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            };

            this.worker.postMessage({
                type: 'generate-format',
                id: crypto.randomUUID(),
                preambleContent: preamble,
                engine,
                manifest: this.bundleManager.fileManifest,
                packageMapData: this.bundleManager.packageMap,
                bundleDepsData: this.bundleManager.bundleDeps,
                bundleRegistryData: [...this.bundleManager.bundleRegistry],
                bundleData,
                ctanFiles,
            });
        }).finally(() => {
            this.formatGenerationPromise = null;
        });

        return this.formatGenerationPromise;
    }

    async clearCache() {
        this._log('Clearing CTAN cache...');
        await clearCTANCache();
        this.ctanFetcher.clearMountedFiles();
        this._log('Cache cleared');
    }

    getStats() {
        return {
            bundles: this.bundleManager.getStats(),
            ctan: this.ctanFetcher.getStats(),
        };
    }

    terminate() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            this.workerReady = false;
        }
    }

    /**
     * Unload compiler to free memory. Clears RAM caches but keeps disk caches.
     * Call init() again to reinitialize.
     */
    unload() {
        this._log('Unloading compiler to free memory...');

        // Terminate worker (frees WASM module, heap, worker bundle cache)
        this.terminate();

        // Clear main thread caches
        this.bundleManager.clearCache();
        this.ctanFetcher.clearMountedFiles();

        // Clear format cache
        this.formatCache.clear();

        // Reset init state so next compile will reinitialize
        this.initPromise = null;

        this._log('Compiler unloaded');
    }

    /**
     * Check if compiler is currently loaded
     */
    isLoaded() {
        return this.worker !== null;
    }
}
