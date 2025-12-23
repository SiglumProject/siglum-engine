#!/usr/bin/env node
// Combine multiple bundles into a single pdflatex-all bundle
// Usage: node combine-bundles.js

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const BUNDLES_DIR = path.join(__dirname, 'bundles');
const PDFLATEX_BUNDLES = [
    'core', 'fmt-pdflatex', 'l3', 'fonts-cm', 'fonts-misc',
    'fonts-lm-type1', 'dvips', 'extra'
];

async function combineBundles() {
    console.log('Combining pdflatex bundles...');

    const allFiles = [];
    const dataChunks = [];
    let currentOffset = 0;

    for (const bundleName of PDFLATEX_BUNDLES) {
        console.log(`  Processing: ${bundleName}`);

        // Read and decompress data
        const dataPath = path.join(BUNDLES_DIR, `${bundleName}.data.gz`);
        const metaPath = path.join(BUNDLES_DIR, `${bundleName}.meta.json`);

        const compressedData = fs.readFileSync(dataPath);
        const data = zlib.gunzipSync(compressedData);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

        // Adjust offsets and add files
        for (const file of meta.files) {
            allFiles.push({
                path: file.path,
                name: file.name,
                start: currentOffset + file.start,
                end: currentOffset + file.end,
                bundle: bundleName  // Track source bundle for debugging
            });
        }

        dataChunks.push(data);
        currentOffset += data.length;
    }

    // Combine all data
    const combinedData = Buffer.concat(dataChunks);
    console.log(`Combined data size: ${(combinedData.length / 1024 / 1024).toFixed(1)}MB`);

    // Write combined metadata
    const combinedMeta = {
        name: 'pdflatex-all',
        bundles: PDFLATEX_BUNDLES,
        files: allFiles
    };

    const metaOutPath = path.join(BUNDLES_DIR, 'pdflatex-all.meta.json');
    fs.writeFileSync(metaOutPath, JSON.stringify(combinedMeta, null, 2));
    console.log(`Wrote: ${metaOutPath}`);

    // Compress with gzip first (for comparison)
    const gzipData = zlib.gzipSync(combinedData, { level: 9 });
    const gzipPath = path.join(BUNDLES_DIR, 'pdflatex-all.data.gz');
    fs.writeFileSync(gzipPath, gzipData);
    console.log(`Gzip: ${(gzipData.length / 1024 / 1024).toFixed(1)}MB -> ${gzipPath}`);

    // Also write uncompressed for Brotli compression (use brotli CLI)
    const rawPath = path.join(BUNDLES_DIR, 'pdflatex-all.data');
    fs.writeFileSync(rawPath, combinedData);
    console.log(`Raw: ${(combinedData.length / 1024 / 1024).toFixed(1)}MB -> ${rawPath}`);
    console.log('Run: brotli -q 11 pdflatex-all.data  # to create .br version');

    // Stats
    console.log('\n--- Stats ---');
    console.log(`Files: ${allFiles.length}`);
    console.log(`Original bundles: ${PDFLATEX_BUNDLES.length}`);
    console.log(`Combined size (uncompressed): ${(combinedData.length / 1024 / 1024).toFixed(1)}MB`);
    console.log(`Combined size (gzip): ${(gzipData.length / 1024 / 1024).toFixed(1)}MB`);
}

combineBundles().catch(console.error);
