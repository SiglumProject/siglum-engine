// Bundle loading and package resolution module

import { getBundleFromOPFS, saveBundleToOPFS } from './storage.js';

// Decompression using native CompressionStream
async function decompress(compressed, format = 'gzip') {
    // If format is 'none', return as-is (already decompressed by browser)
    if (format === 'none') {
        return compressed;
    }
    const ds = new DecompressionStream(format);
    const blob = new Blob([compressed]);
    const stream = blob.stream().pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
}

export class BundleManager {
    constructor(options = {}) {
        this.bundleBase = options.bundleBase || 'packages/bundles';
        this.bundleCache = new Map();
        this.fileManifest = null;
        this.packageMap = null;
        this.bundleDeps = null;
        this.packageDeps = null;
        this.bundleRegistry = null;
        this.bytesDownloaded = 0;
        this.cacheHitCount = 0;
        this.onLog = options.onLog || (() => {});
    }

    async loadManifest() {
        if (this.fileManifest) return this.fileManifest;

        // Cache-bust config files to ensure fresh data after deployments
        const cacheBuster = `?v=${Date.now()}`;
        const [manifestRes, registryRes, packageMapRes] = await Promise.all([
            fetch(`${this.bundleBase}/file-manifest.json${cacheBuster}`),
            fetch(`${this.bundleBase}/registry.json${cacheBuster}`),
            fetch(`${this.bundleBase}/package-map.json${cacheBuster}`),
        ]);

        this.fileManifest = await manifestRes.json();
        const registryData = await registryRes.json();
        // Registry contains objects with {name, files, size} - extract just names
        this.bundleRegistry = new Set(registryData.map(b => typeof b === 'string' ? b : b.name));
        this.packageMap = await packageMapRes.json();

        return this.fileManifest;
    }

    async loadBundleDeps() {
        if (this.bundleDeps) return this.bundleDeps;

        try {
            // Cache-bust config files to ensure fresh data after deployments
            const cacheBuster = `?v=${Date.now()}`;
            const [bundleDepsRes, packageDepsRes] = await Promise.all([
                fetch(`${this.bundleBase}/bundle-deps.json${cacheBuster}`),
                fetch(`${this.bundleBase}/package-deps.json${cacheBuster}`).catch(() => null),
            ]);
            this.bundleDeps = await bundleDepsRes.json();
            if (packageDepsRes) {
                this.packageDeps = await packageDepsRes.json();
            }
        } catch (e) {
            this.bundleDeps = {};
        }

        return this.bundleDeps;
    }

    bundleExists(bundleName) {
        return this.bundleRegistry?.has(bundleName) ?? false;
    }

    resolveBundles(packages, engine = 'xelatex') {
        const bundles = new Set();
        const resolved = new Set();

        // Add engine-required bundles from bundle-deps.json
        const engineDeps = this.bundleDeps?.engines?.[engine];
        if (engineDeps?.required) {
            for (const b of engineDeps.required) {
                if (this.bundleExists(b)) bundles.add(b);
            }
        }

        // Recursive function to add bundle and its dependencies
        const addBundle = (bundleName) => {
            if (resolved.has(bundleName)) return;
            resolved.add(bundleName);

            if (!this.bundleExists(bundleName)) return;
            bundles.add(bundleName);

            // Resolve bundle dependencies from bundleDeps.bundles
            const bundleInfo = this.bundleDeps?.bundles?.[bundleName];
            if (bundleInfo?.requires) {
                for (const dep of bundleInfo.requires) {
                    addBundle(dep);
                }
            }
        };

        const resolvePackage = (pkg) => {
            if (resolved.has('pkg:' + pkg)) return;
            resolved.add('pkg:' + pkg);

            // Find bundle for package
            const bundleName = this.packageMap?.[pkg];
            if (bundleName) {
                addBundle(bundleName);
            }

            // Resolve package-level dependencies
            const pkgDeps = this.packageDeps?.[pkg] || [];
            for (const dep of pkgDeps) {
                resolvePackage(dep);
            }
        };

        for (const pkg of packages) {
            resolvePackage(pkg);
        }

        // Filter to only existing bundles
        return [...bundles].filter(b => this.bundleExists(b));
    }

    checkPackages(source, engine = 'xelatex') {
        const packages = new Set();

        // Extract \usepackage commands
        const usePackageRegex = /\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
        let match;
        while ((match = usePackageRegex.exec(source)) !== null) {
            const pkgList = match[1].split(',').map(p => p.trim());
            for (const pkg of pkgList) packages.add(pkg);
        }

        // Extract \documentclass
        const docclassMatch = source.match(/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/);
        if (docclassMatch) {
            packages.add(docclassMatch[1]);
        }

        // Extract \RequirePackage
        const requireRegex = /\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
        while ((match = requireRegex.exec(source)) !== null) {
            const pkgList = match[1].split(',').map(p => p.trim());
            for (const pkg of pkgList) packages.add(pkg);
        }

        const bundles = this.resolveBundles([...packages], engine);
        return { packages: [...packages], bundles };
    }

    async loadBundle(bundleName) {
        // Check memory cache
        if (this.bundleCache.has(bundleName)) {
            return this.bundleCache.get(bundleName);
        }

        // Check OPFS cache
        const cached = await getBundleFromOPFS(bundleName);
        if (cached) {
            this.onLog(`  From OPFS: ${bundleName}`);
            this.bundleCache.set(bundleName, cached);
            this.cacheHitCount++;
            return cached;
        }

        // Fetch from server
        const url = `${this.bundleBase}/${bundleName}.data.gz`;
        this.onLog(`  Fetching: ${bundleName}`);

        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to load ${bundleName}: ${response.status}`);

        const compressed = await response.arrayBuffer();
        this.bytesDownloaded += compressed.byteLength;

        // Check if response was Brotli-compressed (browser already decompressed)
        const contentEncoding = response.headers.get('Content-Encoding');
        const format = contentEncoding === 'br' ? 'none' : 'gzip';
        const decompressed = await decompress(compressed, format);
        this.bundleCache.set(bundleName, decompressed);

        // Save to OPFS in background
        saveBundleToOPFS(bundleName, decompressed);

        return decompressed;
    }

    // Load combined pdflatex bundle (all required bundles in one file)
    async loadCombinedBundle(engine = 'pdflatex') {
        const combinedName = `${engine}-all`;

        // Check memory cache
        if (this.combinedBundleLoaded) {
            return true;
        }

        let combinedData;
        let combinedMeta;

        // Check OPFS cache for combined bundle
        const cached = await getBundleFromOPFS(combinedName);

        if (cached) {
            this.onLog(`  From OPFS: ${combinedName}`);
            combinedData = cached;
            this.cacheHitCount++;
            // Still need metadata
            const metaResponse = await fetch(`${this.bundleBase}/${combinedName}.meta.json`);
            if (!metaResponse.ok) return false;
            combinedMeta = await metaResponse.json();
        } else {
            // Fetch combined bundle (server may return Brotli-compressed with Content-Encoding)
            this.onLog(`  Fetching: ${combinedName} (combined bundle)`);

            const [dataResponse, metaResponse] = await Promise.all([
                fetch(`${this.bundleBase}/${combinedName}.data.gz`),
                fetch(`${this.bundleBase}/${combinedName}.meta.json`),
            ]);

            if (!dataResponse.ok || !metaResponse.ok) {
                this.onLog(`  Combined bundle not available, falling back to individual bundles`);
                return false;
            }

            // Check if server sent Brotli (browser auto-decompresses via Content-Encoding)
            const contentEncoding = dataResponse.headers.get('Content-Encoding');
            const rawData = await dataResponse.arrayBuffer();
            this.bytesDownloaded += rawData.byteLength;

            // If Content-Encoding was set, browser already decompressed
            // Otherwise we need to decompress gzip ourselves
            if (contentEncoding === 'br') {
                combinedData = rawData; // Already decompressed by browser
            } else {
                combinedData = await decompress(rawData, 'gzip');
            }
            combinedMeta = await metaResponse.json();

            // Save decompressed to OPFS
            saveBundleToOPFS(combinedName, combinedData);
        }

        // Store the combined data under each constituent bundle name
        for (const bundleName of combinedMeta.bundles) {
            this.bundleCache.set(bundleName, combinedData);
        }

        // Store metadata for file extraction
        this.combinedMeta = combinedMeta;
        this.combinedBundleLoaded = true;

        this.onLog(`  Loaded combined bundle: ${combinedMeta.bundles.length} bundles, ${combinedMeta.files.length} files`);
        return true;
    }

    async loadBundles(bundleNames) {
        // If combined bundle is loaded, all data is already cached
        if (this.combinedBundleLoaded) {
            const bundleData = {};
            for (const name of bundleNames) {
                bundleData[name] = this.bundleCache.get(name);
            }
            return bundleData;
        }

        const bundleData = {};
        await Promise.all(bundleNames.map(async (name) => {
            try {
                bundleData[name] = await this.loadBundle(name);
            } catch (e) {
                this.onLog(`Failed to load bundle ${name}: ${e.message}`);
            }
        }));
        return bundleData;
    }

    getStats() {
        return {
            bytesDownloaded: this.bytesDownloaded,
            cacheHits: this.cacheHitCount,
            bundlesCached: this.bundleCache.size,
        };
    }

    // Preload all required bundles for an engine (call during init)
    async preloadEngine(engine = 'pdflatex') {
        await this.loadBundleDeps();
        const engineDeps = this.bundleDeps?.engines?.[engine];
        if (!engineDeps?.required) return;

        this.onLog(`Preloading ${engine} bundles...`);

        // Load individual bundles in parallel (HTTP/2 multiplexing)
        // Combined bundle disabled due to Content-Encoding browser issues
        await this.loadBundles(engineDeps.required);
        this.onLog(`Preload complete: ${engineDeps.required.length} bundles`);
    }
}

// Engine detection
export function detectEngine(source) {
    // XeLaTeX indicators
    if (source.includes('\\usepackage{fontspec}') ||
        source.includes('\\usepackage{unicode-math}') ||
        source.includes('\\setmainfont') ||
        source.includes('\\setsansfont') ||
        source.includes('\\setmonofont')) {
        return 'xelatex';
    }

    // pdfLaTeX is default
    return 'pdflatex';
}

// Preamble extraction for format generation
export function extractPreamble(source) {
    const beginDocIdx = source.indexOf('\\begin{document}');
    if (beginDocIdx === -1) return '';
    return source.substring(0, beginDocIdx);
}

export function hashPreamble(preamble) {
    let hash = 5381;
    for (let i = 0; i < preamble.length; i++) {
        hash = ((hash << 5) + hash) + preamble.charCodeAt(i);
        hash = hash & hash;
    }
    return hash.toString(16);
}
