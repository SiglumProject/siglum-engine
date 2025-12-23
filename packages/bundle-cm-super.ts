#!/usr/bin/env bun
/**
 * Bundle cm-super fonts for R2 upload
 *
 * cm-super is too large (64MB+) to fetch at runtime in Cloudflare Workers.
 * This script downloads it, creates a bundle, and can upload to R2.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const CTAN_MIRROR = 'https://mirrors.ctan.org';
// Try TDS zip first, then fall back to regular zip
const CM_SUPER_URLS = [
  '/fonts/ps-type1/cm-super.tds.zip',
  '/install/fonts/cm-super.tds.zip',
  '/fonts/ps-type1/cm-super.zip',
];
const OUTPUT_DIR = './bundles';
const BUNDLE_NAME = 'cm-super';

interface BundleFile {
  path: string;
  name: string;
  start: number;
  end: number;
}

async function downloadAndExtract(): Promise<Map<string, Buffer>> {
  console.log('Downloading cm-super from CTAN...');

  let response: Response | null = null;
  let usedUrl = '';

  for (const urlPath of CM_SUPER_URLS) {
    const url = CTAN_MIRROR + urlPath;
    console.log(`Trying: ${url}`);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'busytex-bundler/1.0' },
      redirect: 'follow',
    });
    if (resp.ok) {
      response = resp;
      usedUrl = url;
      break;
    }
    console.log(`  ${resp.status} - trying next...`);
  }

  if (!response) {
    throw new Error('Failed to download cm-super from any URL');
  }

  console.log(`Downloaded from: ${usedUrl}`);
  const zipBuffer = await response.arrayBuffer();
  console.log(`Downloaded ${(zipBuffer.byteLength / 1024 / 1024).toFixed(1)} MB`);

  // Use Bun's native unzip (or fflate)
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(zipBuffer);

  const files = new Map<string, Buffer>();
  const entries = Object.entries(zip.files);

  // Filter for font files we need
  const fontExtensions = ['.pfb', '.tfm', '.vf', '.map', '.enc'];
  const texExtensions = ['.sty', '.fd', '.def'];

  for (const [filePath, file] of entries) {
    if (file.dir) continue;

    const ext = path.extname(filePath).toLowerCase();
    if (!fontExtensions.includes(ext) && !texExtensions.includes(ext)) continue;

    // Skip doc and source directories
    if (filePath.includes('/doc/') || filePath.includes('/source/')) continue;

    const content = await file.async('nodebuffer');

    // Convert cm-super source paths to TDS paths
    // cm-super/pfb/xxx.pfb -> fonts/type1/public/cm-super/xxx.pfb
    // cm-super/dvips/xxx.map -> fonts/map/dvips/cm-super/xxx.map
    // cm-super/dvips/xxx.enc -> fonts/enc/dvips/cm-super/xxx.enc
    // cm-super/dvipdfm/xxx.map -> fonts/map/dvipdfmx/cm-super/xxx.map (or skip)
    let targetPath = filePath;

    // Strip leading cm-super/ prefix
    if (targetPath.startsWith('cm-super/')) {
      targetPath = targetPath.substring('cm-super/'.length);
    }

    // Map to TDS structure
    if (targetPath.startsWith('pfb/')) {
      targetPath = 'fonts/type1/public/cm-super/' + targetPath.substring(4);
    } else if (targetPath.startsWith('dvips/') && ext === '.map') {
      targetPath = 'fonts/map/dvips/cm-super/' + targetPath.substring(6);
    } else if (targetPath.startsWith('dvips/') && ext === '.enc') {
      targetPath = 'fonts/enc/dvips/cm-super/' + targetPath.substring(6);
    } else if (targetPath.startsWith('dvipdfm/')) {
      // Skip dvipdfm maps - they're for dvipdfmx, not pdflatex
      continue;
    } else if (targetPath.startsWith('afm/')) {
      targetPath = 'fonts/afm/public/cm-super/' + targetPath.substring(4);
    } else if (targetPath.startsWith('type1/')) {
      targetPath = 'fonts/type1/public/cm-super/' + targetPath.substring(6);
    } else {
      // Keep other paths as-is under tex/latex/cm-super
      targetPath = 'tex/latex/cm-super/' + targetPath;
    }

    targetPath = '/texlive/texmf-dist/' + targetPath;
    targetPath = targetPath.replace(/\/+/g, '/');

    files.set(targetPath, content);
  }

  console.log(`Extracted ${files.size} font/style files`);
  return files;
}

async function createBundle(files: Map<string, Buffer>): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const chunks: Buffer[] = [];
  const bundleFiles: BundleFile[] = [];
  const fileManifest: Record<string, { bundle: string; start: number; end: number }> = {};
  let offset = 0;

  // Sort files for consistency
  const sortedPaths = [...files.keys()].sort();

  for (const filePath of sortedPaths) {
    const data = files.get(filePath)!;
    const dir = path.dirname(filePath);
    const name = path.basename(filePath);

    bundleFiles.push({
      path: dir,
      name: name,
      start: offset,
      end: offset + data.length,
    });

    fileManifest[filePath] = {
      bundle: BUNDLE_NAME,
      start: offset,
      end: offset + data.length,
    };

    chunks.push(data);
    offset += data.length;
  }

  const bundleData = Buffer.concat(chunks);
  const compressed = zlib.gzipSync(bundleData, { level: 9 });

  console.log(`Bundle size: ${(bundleData.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Compressed:  ${(compressed.length / 1024 / 1024).toFixed(2)} MB`);

  // Write bundle data
  fs.writeFileSync(path.join(OUTPUT_DIR, `${BUNDLE_NAME}.data.gz`), compressed);

  // Write metadata
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${BUNDLE_NAME}.meta.json`),
    JSON.stringify({
      name: BUNDLE_NAME,
      files: bundleFiles,
      totalSize: bundleData.length,
    }, null, 2)
  );

  // Update file-manifest.json
  const manifestPath = path.join(OUTPUT_DIR, 'file-manifest.json');
  let existingManifest: Record<string, any> = {};
  if (fs.existsSync(manifestPath)) {
    existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  }
  const mergedManifest = { ...existingManifest, ...fileManifest };
  fs.writeFileSync(manifestPath, JSON.stringify(mergedManifest));

  // Update package-map.json
  const mapPath = path.join(OUTPUT_DIR, 'package-map.json');
  let existingMap: Record<string, string> = {};
  if (fs.existsSync(mapPath)) {
    existingMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
  }
  existingMap['cm-super'] = BUNDLE_NAME;
  fs.writeFileSync(mapPath, JSON.stringify(existingMap, null, 2));

  // Update bundle-deps.json
  const depsPath = path.join(OUTPUT_DIR, 'bundle-deps.json');
  let deps: any = { engines: {}, bundles: {} };
  if (fs.existsSync(depsPath)) {
    deps = JSON.parse(fs.readFileSync(depsPath, 'utf-8'));
  }
  deps.bundles[BUNDLE_NAME] = { requires: [] };
  fs.writeFileSync(depsPath, JSON.stringify(deps, null, 2));

  console.log(`\nBundle created: ${OUTPUT_DIR}/${BUNDLE_NAME}.data.gz`);
  console.log(`Files in manifest: ${Object.keys(fileManifest).length}`);
}

async function uploadToR2(): Promise<void> {
  const dataPath = path.join(OUTPUT_DIR, `${BUNDLE_NAME}.data.gz`);
  const metaPath = path.join(OUTPUT_DIR, `${BUNDLE_NAME}.meta.json`);

  console.log('\nUploading to R2...');

  // Use wrangler to upload
  const { $ } = await import('bun');

  await $`bunx wrangler r2 object put siglum-bundles/${BUNDLE_NAME}.data.gz --file ${dataPath}`;
  await $`bunx wrangler r2 object put siglum-bundles/${BUNDLE_NAME}.meta.json --file ${metaPath}`;

  // Also upload updated manifests
  await $`bunx wrangler r2 object put siglum-bundles/file-manifest.json --file ${OUTPUT_DIR}/file-manifest.json`;
  await $`bunx wrangler r2 object put siglum-bundles/package-map.json --file ${OUTPUT_DIR}/package-map.json`;
  await $`bunx wrangler r2 object put siglum-bundles/bundle-deps.json --file ${OUTPUT_DIR}/bundle-deps.json`;

  console.log('Upload complete!');
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const shouldUpload = args.includes('--upload');

  const files = await downloadAndExtract();
  await createBundle(files);

  if (shouldUpload) {
    await uploadToR2();
  } else {
    console.log('\nTo upload to R2, run: bun run bundle-cm-super.ts --upload');
  }
}

main().catch(console.error);
