// Bundle loading and package resolution module

import { getBundleFromOPFS, saveBundleToOPFS } from './storage.js';

// Decompression using native CompressionStream
async function decompress(compressed) {
    const ds = new DecompressionStream('gzip');
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

        const [manifestRes, registryRes, packageMapRes] = await Promise.all([
            fetch(`${this.bundleBase}/file-manifest.json`),
            fetch(`${this.bundleBase}/registry.json`),
            fetch(`${this.bundleBase}/package-map.json`),
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
            const [bundleDepsRes, packageDepsRes] = await Promise.all([
                fetch(`${this.bundleBase}/bundle-deps.json`),
                fetch(`${this.bundleBase}/package-deps.json`).catch(() => null),
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

        const decompressed = await decompress(compressed);
        this.bundleCache.set(bundleName, decompressed);

        // Save to OPFS in background
        saveBundleToOPFS(bundleName, decompressed);

        return decompressed;
    }

    async loadBundles(bundleNames) {
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
