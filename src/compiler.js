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

        this.bundleManager = new BundleManager({
            bundleBase: this.bundlesUrl,
            onLog: (msg) => this._log(msg),
        });

        this.ctanFetcher = new CTANFetcher({
            proxyUrl: this.ctanProxyUrl,
            onLog: (msg) => this._log(msg),
        });

        this.worker = null;
        this.workerReady = false;
        this.cachedWasmModule = null;
        this.pendingCompile = null;
        this.formatCache = new Map();

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

        // Load manifests
        await this.bundleManager.loadManifest();
        await this.bundleManager.loadBundleDeps();

        // Pre-compile WASM module
        this._log('Pre-compiling WASM module...');
        const response = await fetch(this.wasmUrl);
        const wasmBytes = await response.arrayBuffer();
        this.cachedWasmModule = await WebAssembly.compile(wasmBytes);

        // Initialize worker
        await this._initWorker();

        this._log('Compiler initialized');
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
                wasmModule: this.cachedWasmModule,
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

    async compile(source, options = {}) {
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

        // Load bundle data
        this.onProgress('loading', 'Loading bundles...');
        const bundleData = await this.bundleManager.loadBundles(bundles);

        // Get CTAN files from memory cache (populated by previous fetches)
        const ctanFiles = this.ctanFetcher.getCachedFiles();

        // Check for cached format
        let cachedFormat = null;
        const preamble = extractPreamble(source);
        const preambleHash = hashPreamble(preamble);
        const fmtMeta = await getFmtMeta(preambleHash + '_' + engine);
        if (fmtMeta) {
            const fmtData = await readFromOPFS(fmtMeta.fmtPath);
            if (fmtData) {
                cachedFormat = {
                    fmtName: preambleHash + '_' + engine,
                    fmtData: new Uint8Array(fmtData),
                };
                this._log('Using cached format');
            }
        }

        // Check for cached aux files
        const auxCache = await getAuxCache(preambleHash);

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

                        // Cache aux files
                        if (result.auxFilesToCache) {
                            await saveAuxCache(preambleHash, result.auxFilesToCache);
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
            });
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

        return new Promise((resolve, reject) => {
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
        });
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
}
