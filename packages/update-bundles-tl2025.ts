#!/usr/bin/env bun
/**
 * Update bundles with TL2025 content from texmfrepo archive
 *
 * This script:
 * 1. Extracts existing bundles
 * 2. Overlays TL2025 package content from texmfrepo/archive
 * 3. Repacks the bundles
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { execSync } from 'child_process';

const BUNDLES_DIR = './bundles';
const TEXMFREPO = '../busytex/source/texmfrepo/archive';

// Packages to update and which bundles they affect
const PACKAGE_UPDATES: Record<string, string[]> = {
    // Package name (without .rXXXX.tar.xz) -> bundles it affects
    'latex': ['core'],  // tex/latex/base/* goes to core bundle
    'l3kernel': ['l3'],
    'l3backend': ['l3'],
    'l3packages': ['l3'],
    'tools': ['core'],  // tex/latex/tools/*
    'amsmath': ['amsmath'],  // tex/latex/amsmath/*
    'amscls': ['amsmath'],   // tex/latex/amscls/*
    'amsfonts': ['amsmath'], // tex/latex/amsfonts/*
};

// Map package paths to bundle paths (prefix matching)
const PATH_MAPPINGS: Record<string, string> = {
    'tex/latex/base': '/texlive/texmf-dist/tex/latex/base',
    'tex/latex/tools': '/texlive/texmf-dist/tex/latex/tools',
    'tex/latex/l3kernel': '/texlive/texmf-dist/tex/latex/l3kernel',
    'tex/latex/l3backend': '/texlive/texmf-dist/tex/latex/l3backend',
    'tex/latex/l3packages': '/texlive/texmf-dist/tex/latex/l3packages',
    'makeindex/latex': '/texlive/texmf-dist/makeindex/latex',
};

interface FileEntry {
    path: string;
    name: string;
    start: number;
    end: number;
}

interface BundleMeta {
    name: string;
    files: FileEntry[];
    totalSize: number;
}

async function findPackageArchive(pkgName: string): Promise<string | null> {
    const files = fs.readdirSync(TEXMFREPO);
    // Find latest version (highest revision number)
    const matches = files.filter(f =>
        f.startsWith(`${pkgName}.r`) && f.endsWith('.tar.xz')
    ).sort().reverse();

    if (matches.length === 0) return null;
    return path.join(TEXMFREPO, matches[0]);
}

async function extractBundle(bundleName: string): Promise<Map<string, Buffer>> {
    const dataPath = path.join(BUNDLES_DIR, `${bundleName}.data.gz`);
    const metaPath = path.join(BUNDLES_DIR, `${bundleName}.meta.json`);

    if (!fs.existsSync(dataPath)) {
        throw new Error(`Bundle not found: ${bundleName}`);
    }

    const compressedData = fs.readFileSync(dataPath);
    const data = zlib.gunzipSync(compressedData);
    const meta: BundleMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    const files = new Map<string, Buffer>();
    for (const file of meta.files) {
        const fullPath = path.posix.join(file.path, file.name);
        const content = data.subarray(file.start, file.end);
        files.set(fullPath, Buffer.from(content));
    }

    console.log(`Extracted ${bundleName}: ${files.size} files`);
    return files;
}

async function extractPackage(archivePath: string): Promise<Map<string, Buffer>> {
    const tempDir = `/tmp/tl2025-pkg-${Date.now()}`;
    fs.mkdirSync(tempDir, { recursive: true });

    try {
        execSync(`tar -xf "${archivePath}" -C "${tempDir}"`, { stdio: 'pipe' });

        const files = new Map<string, Buffer>();

        function walkDir(dir: string, prefix: string = '') {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

                if (entry.isDirectory()) {
                    walkDir(fullPath, relativePath);
                } else if (entry.isFile()) {
                    files.set(relativePath, fs.readFileSync(fullPath));
                }
            }
        }

        walkDir(tempDir);
        return files;
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function repackBundle(bundleName: string, files: Map<string, Buffer>): Promise<void> {
    const entries: FileEntry[] = [];
    const chunks: Buffer[] = [];
    let offset = 0;

    // Sort files by path for consistency
    const sortedPaths = [...files.keys()].sort();

    for (const fullPath of sortedPaths) {
        const content = files.get(fullPath)!;
        const dir = path.posix.dirname(fullPath);
        const name = path.posix.basename(fullPath);

        entries.push({
            path: dir,
            name: name,
            start: offset,
            end: offset + content.length
        });

        chunks.push(content);
        offset += content.length;
    }

    const bundleData = Buffer.concat(chunks);
    const compressedData = zlib.gzipSync(bundleData, { level: 9 });

    const meta: BundleMeta = {
        name: bundleName,
        files: entries,
        totalSize: bundleData.length
    };

    const dataPath = path.join(BUNDLES_DIR, `${bundleName}.data.gz`);
    const metaPath = path.join(BUNDLES_DIR, `${bundleName}.meta.json`);

    fs.writeFileSync(dataPath, compressedData);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    console.log(`Repacked ${bundleName}: ${entries.length} files, ${(compressedData.length / 1024 / 1024).toFixed(2)}MB`);
}

async function updateBundle(bundleName: string, packageFiles: Map<string, Buffer>): Promise<number> {
    // Extract existing bundle
    const bundleFiles = await extractBundle(bundleName);

    let updatedCount = 0;

    // Update files from package
    for (const [pkgPath, content] of packageFiles) {
        // Try direct mapping: tex/... -> /texlive/texmf-dist/tex/...
        if (pkgPath.startsWith('tex/')) {
            const bundlePath = `/texlive/texmf-dist/${pkgPath}`;
            if (bundleFiles.has(bundlePath)) {
                const oldSize = bundleFiles.get(bundlePath)!.length;
                bundleFiles.set(bundlePath, content);
                console.log(`  Updated: ${bundlePath} (${oldSize} -> ${content.length})`);
                updatedCount++;
                continue;
            }
        }

        // Try other mappings
        for (const [srcPrefix, destPrefix] of Object.entries(PATH_MAPPINGS)) {
            if (pkgPath.startsWith(srcPrefix + '/')) {
                const relativePath = pkgPath.slice(srcPrefix.length + 1);
                const bundlePath = `${destPrefix}/${relativePath}`;

                if (bundleFiles.has(bundlePath)) {
                    const oldSize = bundleFiles.get(bundlePath)!.length;
                    bundleFiles.set(bundlePath, content);
                    console.log(`  Updated: ${bundlePath} (${oldSize} -> ${content.length})`);
                    updatedCount++;
                }
            }
        }
    }

    // Repack the bundle
    await repackBundle(bundleName, bundleFiles);

    return updatedCount;
}

async function main() {
    console.log('=== Updating bundles with TL2025 content ===\n');

    // Process each package
    for (const [pkgName, affectedBundles] of Object.entries(PACKAGE_UPDATES)) {
        const archivePath = await findPackageArchive(pkgName);
        if (!archivePath) {
            console.log(`Package not found: ${pkgName}, skipping`);
            continue;
        }

        console.log(`\nProcessing package: ${pkgName}`);
        console.log(`Archive: ${path.basename(archivePath)}`);

        const packageFiles = await extractPackage(archivePath);
        console.log(`Extracted ${packageFiles.size} files from package`);

        for (const bundleName of affectedBundles) {
            console.log(`\nUpdating bundle: ${bundleName}`);
            const count = await updateBundle(bundleName, packageFiles);
            console.log(`Updated ${count} files in ${bundleName}`);
        }
    }

    console.log('\n=== Done ===');
}

main().catch(console.error);
