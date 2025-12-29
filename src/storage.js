// Storage module for OPFS and IndexedDB caching

// Safari detection - Safari has issues with ArrayBuffer detachment and WebAssembly.Module serialization
const isSafari = typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

const IDB_NAME = 'siglum-ctan-cache';
const IDB_STORE = 'packages';
const CTAN_CACHE_VERSION = 7;
const BUNDLE_CACHE_VERSION = 4;

let idbCache = null;
let opfsRoot = null;

// IndexedDB operations
export async function openIDBCache() {
    if (idbCache) return idbCache;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_NAME, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            idbCache = request.result;
            resolve(idbCache);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'name' });
            }
        };
    });
}

export async function getPackageMeta(packageName) {
    try {
        const db = await openIDBCache();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const request = store.get(packageName);
            request.onerror = () => resolve(null);
            request.onsuccess = () => resolve(request.result);
        });
    } catch (e) {
        return null;
    }
}

export async function savePackageMeta(packageName, meta) {
    try {
        const db = await openIDBCache();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const request = store.put({ name: packageName, ...meta, timestamp: Date.now() });
            request.onerror = () => resolve(false);
            request.onsuccess = () => resolve(true);
        });
    } catch (e) {
        return false;
    }
}

// List all cached CTAN packages and their file paths
export async function listAllCachedPackages() {
    try {
        const db = await openIDBCache();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const request = store.getAll();
            request.onerror = () => resolve([]);
            request.onsuccess = () => resolve(request.result || []);
        });
    } catch (e) {
        return [];
    }
}

// OPFS operations
let opfsInitAttempted = false;
let opfsDisabled = false; // Set to true after persistent failures to avoid spam

export async function getOPFSRoot() {
    if (opfsRoot) return opfsRoot;
    if (opfsDisabled) return null; // Don't retry after persistent failure

    // Safari workaround: request persistent storage first to initialize storage subsystem
    if (!opfsInitAttempted && navigator.storage?.persist) {
        opfsInitAttempted = true;
        try {
            await navigator.storage.persist();
        } catch (e) {
            // Ignore - just a workaround attempt
        }
    }

    // Safari can have transient OPFS failures - retry a few times
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            opfsRoot = await navigator.storage.getDirectory();
            return opfsRoot;
        } catch (e) {
            if (attempt === maxRetries) {
                // Only log once, then disable OPFS for this session
                console.warn('OPFS not available, disabling for this session:', e.message || e);
                opfsDisabled = true;
                return null;
            }
            // Wait briefly before retry (Safari transient errors often resolve quickly)
            await new Promise(r => setTimeout(r, 100 * attempt));
        }
    }
    return null;
}

export async function readFromOPFS(filePath) {
    try {
        const root = await getOPFSRoot();
        if (!root) return null;

        const parts = filePath.split('/').filter(p => p);
        let current = root;

        for (let i = 0; i < parts.length - 1; i++) {
            current = await current.getDirectoryHandle(parts[i]);
        }

        const fileName = parts[parts.length - 1];
        const fileHandle = await current.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        // Create a TRUE copy to avoid Safari ArrayBuffer detachment issues
        // new Uint8Array(buffer) creates a VIEW, not a copy - the buffer can be detached
        const copy = new Uint8Array(buffer.byteLength);
        copy.set(new Uint8Array(buffer));
        return copy;
    } catch (e) {
        return null;
    }
}

export async function writeToOPFS(filePath, content) {
    try {
        const root = await getOPFSRoot();
        if (!root) return false;

        const parts = filePath.split('/').filter(p => p);
        let current = root;

        for (let i = 0; i < parts.length - 1; i++) {
            current = await current.getDirectoryHandle(parts[i], { create: true });
        }

        const fileName = parts[parts.length - 1];
        const fileHandle = await current.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        return true;
    } catch (e) {
        return false;
    }
}

// Bundle cache operations
let bundleCacheVersionChecked = false;

export async function checkBundleCacheVersion() {
    if (bundleCacheVersionChecked) return;
    bundleCacheVersionChecked = true;

    try {
        const root = await getOPFSRoot();
        if (!root) return;

        const versionHandle = await root.getFileHandle('bundle-cache-version', { create: true });
        const file = await versionHandle.getFile();
        const text = await file.text();
        const version = parseInt(text) || 0;

        if (version < BUNDLE_CACHE_VERSION) {
            console.log('Bundle cache version mismatch, clearing cache...');
            await clearBundleCache();
            const writable = await versionHandle.createWritable();
            await writable.write(String(BUNDLE_CACHE_VERSION));
            await writable.close();
        }
    } catch (e) {
        // First run, create version file
        try {
            const root = await getOPFSRoot();
            if (root) {
                const versionHandle = await root.getFileHandle('bundle-cache-version', { create: true });
                const writable = await versionHandle.createWritable();
                await writable.write(String(BUNDLE_CACHE_VERSION));
                await writable.close();
            }
        } catch (e2) {}
    }
}

export async function clearBundleCache() {
    try {
        const root = await getOPFSRoot();
        if (!root) return;
        await root.removeEntry('bundles', { recursive: true });
    } catch (e) {}
}

export async function getBundleFromOPFS(bundleName) {
    await checkBundleCacheVersion();
    try {
        const root = await getOPFSRoot();
        if (!root) return null;

        const bundlesDir = await root.getDirectoryHandle('bundles');
        const fileHandle = await bundlesDir.getFileHandle(bundleName + '.data');
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        // Create a TRUE copy to avoid Safari ArrayBuffer detachment issues
        const copy = new Uint8Array(buffer.byteLength);
        copy.set(new Uint8Array(buffer));
        return copy.buffer;
    } catch (e) {
        return null;
    }
}

export async function saveBundleToOPFS(bundleName, data) {
    try {
        const root = await getOPFSRoot();
        if (!root) return;

        const bundlesDir = await root.getDirectoryHandle('bundles', { create: true });
        const fileHandle = await bundlesDir.getFileHandle(bundleName + '.data', { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(data);
        await writable.close();
    } catch (e) {}
}

// Aux file cache
const AUX_CACHE_VERSION = 1;
const AUX_STORE = 'aux-cache';
let auxCacheDb = null;
const auxMemoryCache = new Map();

export async function openAuxCacheDb() {
    if (auxCacheDb) return auxCacheDb;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('siglum-aux-cache', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            auxCacheDb = request.result;
            resolve(auxCacheDb);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(AUX_STORE)) {
                db.createObjectStore(AUX_STORE, { keyPath: 'hash' });
            }
        };
    });
}

export async function getAuxCache(preambleHash) {
    if (auxMemoryCache.has(preambleHash)) {
        return auxMemoryCache.get(preambleHash);
    }
    try {
        const db = await openAuxCacheDb();
        return new Promise((resolve) => {
            const tx = db.transaction(AUX_STORE, 'readonly');
            const store = tx.objectStore(AUX_STORE);
            const request = store.get(preambleHash);
            request.onerror = () => resolve(null);
            request.onsuccess = () => {
                const result = request.result;
                if (result) auxMemoryCache.set(preambleHash, result);
                resolve(result);
            };
        });
    } catch (e) {
        return null;
    }
}

export async function saveAuxCache(preambleHash, auxFiles) {
    const entry = { hash: preambleHash, files: auxFiles, timestamp: Date.now() };
    auxMemoryCache.set(preambleHash, entry);
    try {
        const db = await openAuxCacheDb();
        const tx = db.transaction(AUX_STORE, 'readwrite');
        const store = tx.objectStore(AUX_STORE);
        store.put(entry);
    } catch (e) {}
}

// Document cache for compiled PDFs
const DOC_CACHE_VERSION = 1;
const DOC_STORE = 'doc-cache';
let docCacheDb = null;
const docMemoryCache = new Map();
const MAX_DOC_CACHE_SIZE = 10;

export async function openDocCacheDb() {
    if (docCacheDb) return docCacheDb;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('siglum-doc-cache', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            docCacheDb = request.result;
            resolve(docCacheDb);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(DOC_STORE)) {
                db.createObjectStore(DOC_STORE, { keyPath: 'key' });
            }
        };
    });
}

export function hashDocument(source) {
    let hash = 5381;
    for (let i = 0; i < source.length; i++) {
        hash = ((hash << 5) + hash) + source.charCodeAt(i);
        hash = hash & hash;
    }
    return hash.toString(16);
}

export async function getCachedPdf(docHash, engine) {
    const key = docHash + '_' + engine;
    if (docMemoryCache.has(key)) {
        return docMemoryCache.get(key);
    }
    try {
        const db = await openDocCacheDb();
        return new Promise((resolve) => {
            const tx = db.transaction(DOC_STORE, 'readonly');
            const store = tx.objectStore(DOC_STORE);
            const request = store.get(key);
            request.onerror = () => resolve(null);
            request.onsuccess = () => {
                const result = request.result;
                if (result) {
                    docMemoryCache.set(key, result.pdfData);
                }
                resolve(result?.pdfData || null);
            };
        });
    } catch (e) {
        return null;
    }
}

export async function saveCachedPdf(docHash, engine, pdfData) {
    const key = docHash + '_' + engine;
    docMemoryCache.set(key, pdfData);

    // Limit memory cache size
    if (docMemoryCache.size > MAX_DOC_CACHE_SIZE) {
        const firstKey = docMemoryCache.keys().next().value;
        docMemoryCache.delete(firstKey);
    }

    try {
        const db = await openDocCacheDb();
        const tx = db.transaction(DOC_STORE, 'readwrite');
        const store = tx.objectStore(DOC_STORE);
        store.put({ key, pdfData, timestamp: Date.now() });
    } catch (e) {}
}

// Format cache
const FMT_STORE = 'fmt-cache';
let fmtCacheDb = null;
const fmtMemoryCache = new Map();

export async function openFmtCacheDb() {
    if (fmtCacheDb) return fmtCacheDb;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('siglum-fmt-cache', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            fmtCacheDb = request.result;
            resolve(fmtCacheDb);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(FMT_STORE)) {
                db.createObjectStore(FMT_STORE, { keyPath: 'hash' });
            }
        };
    });
}

export async function getFmtMeta(preambleHash) {
    if (fmtMemoryCache.has(preambleHash)) {
        return fmtMemoryCache.get(preambleHash);
    }
    try {
        const db = await openFmtCacheDb();
        return new Promise((resolve) => {
            const tx = db.transaction(FMT_STORE, 'readonly');
            const store = tx.objectStore(FMT_STORE);
            const request = store.get(preambleHash);
            request.onerror = () => resolve(null);
            request.onsuccess = () => {
                const result = request.result;
                if (result) fmtMemoryCache.set(preambleHash, result);
                resolve(result);
            };
        });
    } catch (e) {
        return null;
    }
}

export async function saveFmtMeta(preambleHash, meta) {
    fmtMemoryCache.set(preambleHash, meta);
    try {
        const db = await openFmtCacheDb();
        const tx = db.transaction(FMT_STORE, 'readwrite');
        const store = tx.objectStore(FMT_STORE);
        store.put({ hash: preambleHash, ...meta, timestamp: Date.now() });
    } catch (e) {}
}

export async function loadFmtFromOPFS(fmtPath) {
    return await readFromOPFS(fmtPath);
}

export async function saveFmtToOPFS(fmtPath, fmtData) {
    return await writeToOPFS(fmtPath, fmtData);
}

// Clear all CTAN cache
export async function clearCTANCache() {
    try {
        const db = await openIDBCache();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        store.clear();
        await new Promise(r => tx.oncomplete = r);

        const root = await getOPFSRoot();
        if (root) {
            try {
                await root.removeEntry('ctan-packages', { recursive: true });
            } catch (e) {}
        }

        return true;
    } catch (e) {
        return false;
    }
}

// WASM cache - stores COMPILED WebAssembly.Module in IndexedDB for instant instantiation
const WASM_CACHE_VERSION = 2; // Bump to invalidate old byte caches
const WASM_DB_NAME = 'siglum-wasm-cache';
const WASM_STORE = 'modules';

let wasmCacheDb = null;

async function openWasmCacheDb() {
    if (wasmCacheDb) return wasmCacheDb;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(WASM_DB_NAME, WASM_CACHE_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            wasmCacheDb = request.result;
            resolve(wasmCacheDb);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            // Clear old stores on version upgrade
            for (const name of db.objectStoreNames) {
                db.deleteObjectStore(name);
            }
            db.createObjectStore(WASM_STORE, { keyPath: 'key' });
        };
    });
}

// Get cached compiled WebAssembly.Module from IndexedDB
export async function getCompiledWasmModule() {
    // Safari has bugs with WebAssembly.Module serialization in IndexedDB - skip cache entirely
    if (isSafari) {
        console.log('Safari detected - skipping WASM module cache (serialization bugs)');
        return null;
    }
    try {
        const db = await openWasmCacheDb();
        return new Promise((resolve) => {
            const tx = db.transaction(WASM_STORE, 'readonly');
            const store = tx.objectStore(WASM_STORE);
            const request = store.get('busytex');
            request.onerror = () => resolve(null);
            request.onsuccess = () => {
                const result = request.result;
                if (result?.module instanceof WebAssembly.Module) {
                    console.log('Loaded compiled WASM module from IndexedDB cache');
                    resolve(result.module);
                } else {
                    resolve(null);
                }
            };
        });
    } catch (e) {
        console.warn('Failed to get cached WASM module:', e);
        return null;
    }
}

// Save compiled WebAssembly.Module to IndexedDB
export async function saveCompiledWasmModule(module) {
    // Safari has bugs with WebAssembly.Module serialization - don't cache
    if (isSafari) {
        return false;
    }
    try {
        const db = await openWasmCacheDb();
        return new Promise((resolve) => {
            const tx = db.transaction(WASM_STORE, 'readwrite');
            const store = tx.objectStore(WASM_STORE);
            const request = store.put({ key: 'busytex', module, timestamp: Date.now() });
            request.onerror = () => {
                console.warn('Failed to cache compiled WASM module');
                resolve(false);
            };
            request.onsuccess = () => {
                console.log('Cached compiled WASM module to IndexedDB');
                resolve(true);
            };
        });
    } catch (e) {
        console.warn('Failed to save compiled WASM module:', e);
        return false;
    }
}

// Legacy OPFS functions - keep for backwards compatibility during transition
export async function getWasmFromOPFS() {
    // Try new IndexedDB cache first
    return null; // Disable legacy OPFS cache - use getCompiledWasmModule instead
}

export async function saveWasmToOPFS(wasmBytes) {
    // No longer used - we cache compiled modules instead of bytes
    return false;
}

export { CTAN_CACHE_VERSION, BUNDLE_CACHE_VERSION, WASM_CACHE_VERSION };
