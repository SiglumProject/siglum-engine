# Upgrading TeX Live Version

This document describes how to upgrade siglum-engine from one TeX Live version to another (e.g., TL2024 to TL2025).

## Overview

A TeX Live upgrade involves updating three components:

1. **WASM binaries** - The pdfTeX/XeTeX/LuaTeX engines compiled to WebAssembly
2. **LaTeX macro packages** - The `.sty`, `.cls`, and other macro files in bundles
3. **Format files** - Pre-compiled `.fmt` files that must match the engine version

## Prerequisites

- Podman or Docker (for building WASM binaries)
- Bun (for running update scripts)
- ~10GB disk space for the TeX Live ISO

## Step 1: Update Makefile URLs

Edit `busytex/Makefile` to point to the new TeX Live version:

```makefile
# Update these URLs (around lines 5-11)
URL_texlive_full_iso = https://mirror.ctan.org/systems/texlive/Images/texlive2025.iso
URL_texlive = https://github.com/TeX-Live/texlive-source/archive/refs/heads/tags/texlive-2025.0.tar.gz
```

For TL2026, change `2025` to `2026` in both URLs.

## Step 2: Download TeX Live ISO

The ISO contains all package archives needed to update bundles:

```bash
cd busytex
mkdir -p source/texmfrepo
curl -L --progress-bar https://mirror.ctan.org/systems/texlive/Images/texlive2025.iso | bsdtar -xf - -C source/texmfrepo
```

This downloads ~6GB and extracts package archives to `source/texmfrepo/archive/`.

## Step 3: Rebuild WASM Binaries (if needed)

If the TeX engine version changed, rebuild the WASM binaries:

```bash
cd busytex
./build-wasm.sh wasm-pdftex   # For pdfTeX
./build-wasm.sh wasm-xetex    # For XeTeX
./build-wasm.sh wasm-luatex   # For LuaTeX
```

This requires Podman/Docker and takes significant time.

## Step 4: Update Bundles with New Package Content

Edit `packages/update-bundles-tl2025.ts` to include the packages you want to update:

```typescript
const PACKAGE_UPDATES: Record<string, string[]> = {
    'latex': ['core'],      // tex/latex/base/*
    'l3kernel': ['l3'],
    'l3backend': ['l3'],
    'l3packages': ['l3'],
    'tools': ['core'],      // tex/latex/tools/*
    'amsmath': ['amsmath'],
    'amscls': ['amsmath'],
    'amsfonts': ['amsmath'],
};
```

Run the update script:

```bash
cd packages
bun run update-bundles-tl2025.ts
```

This extracts packages from the ISO archives and overlays them onto existing bundles.

## Step 5: Update file-manifest.json

After repacking bundles, the byte offsets change. Update `file-manifest.json`:

```bash
cd packages/bundles

# For each updated bundle, sync entries from meta.json to file-manifest.json
node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync("file-manifest.json", "utf8"));
const coreMeta = JSON.parse(fs.readFileSync("core.meta.json", "utf8"));
const l3Meta = JSON.parse(fs.readFileSync("l3.meta.json", "utf8"));
const amsmathMeta = JSON.parse(fs.readFileSync("amsmath.meta.json", "utf8"));

// Remove old entries for these bundles
for (const key of Object.keys(manifest)) {
  if (["core", "l3", "amsmath"].includes(manifest[key].bundle)) {
    delete manifest[key];
  }
}

// Add new entries from meta.json files
for (const meta of [coreMeta, l3Meta, amsmathMeta]) {
  for (const file of meta.files) {
    const key = file.path + "/" + file.name;
    manifest[key] = {
      bundle: meta.name,
      start: file.start,
      end: file.end
    };
  }
}

fs.writeFileSync("file-manifest.json", JSON.stringify(manifest, null, 2));
'
```

## Step 6: Regenerate Format Files

Format files must be regenerated to match the new engine and macro versions.

### Generate pdflatex format:

```bash
cd busytex
node generate-formats.cjs pdflatex
```

### Package the format bundle:

```bash
# The script outputs a double-gzipped file, so decompress twice
gunzip -c pdflatex.fmt > pdflatex.fmt.raw
gunzip -c pdflatex.fmt.raw > pdflatex.fmt.uncompressed

# Get the uncompressed size
SIZE=$(wc -c < pdflatex.fmt.uncompressed)
echo "Uncompressed size: $SIZE"

# Create the bundle
gzip -9 -c pdflatex.fmt.uncompressed > ../packages/bundles/fmt-pdflatex.data.gz

# Update meta.json with correct size
cat > ../packages/bundles/fmt-pdflatex.meta.json << EOF
{
  "name": "fmt-pdflatex",
  "files": [
    {
      "path": "/texlive/texmf-dist/texmf-var/web2c/pdftex",
      "name": "pdflatex.fmt",
      "start": 0,
      "end": $SIZE
    }
  ],
  "totalSize": $SIZE
}
EOF

# Cleanup
rm pdflatex.fmt pdflatex.fmt.raw pdflatex.fmt.uncompressed
```

### Update file-manifest.json for format:

```bash
cd packages/bundles
node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync("file-manifest.json", "utf8"));
const meta = JSON.parse(fs.readFileSync("fmt-pdflatex.meta.json", "utf8"));
const file = meta.files[0];
manifest[file.path + "/" + file.name] = {
  bundle: "fmt-pdflatex",
  start: file.start,
  end: file.end
};
fs.writeFileSync("file-manifest.json", JSON.stringify(manifest, null, 2));
'
```

### Repeat for XeTeX/LuaTeX:

```bash
# For xelatex
node generate-formats.cjs xelatex
# Then package similarly, updating fmt-xelatex.data.gz and fmt-xelatex.meta.json

# For lualatex
node generate-formats.cjs lualatex
# Then package similarly, updating fmt-lualatex.data.gz and fmt-lualatex.meta.json
```

## Step 7: Test Locally

Start the local dev server:

```bash
cd /path/to/siglum-engine
bun run serve-local.ts
```

Then:

1. Clear browser storage (OPFS + IndexedDB)
2. Open siglum-ui pointing to localhost:8787
3. Compile a test document
4. Verify the log shows the new version:
   ```
   pdfTeX, Version 3.141592653-2.6-1.40.27 (TeX Live 2025)
   LaTeX2e <2024-11-01> patch level 2
   L3 programming layer <2025-01-18>
   ```

## Verification Checklist

- [ ] LaTeX date shows new version (e.g., `2024-11-01` for TL2025)
- [ ] L3 date shows new version (e.g., `2025-01-18` for TL2025)
- [ ] pdfTeX version matches (e.g., `1.40.27` for TL2025)
- [ ] Documents compile without "strings are different" format errors
- [ ] amsmath and other common packages work without errors

## Troubleshooting

### "Could not undump X bytes from format file"

The format file size in `file-manifest.json` doesn't match the actual file size. Update the `end` value to match the uncompressed format size.

### "primitive \leqno no longer primitive"

Package version mismatch - the amsmath bundle needs to be updated to match the new LaTeX version.

### "article.cls not found" / "Mounted 0 files from bundle core"

The `file-manifest.json` entries for the bundle were removed but not re-added. Re-run the manifest update script.

### Format file has wrong checksum

The format was generated with a different engine version. Regenerate the format file using `generate-formats.cjs`.

## Files Modified During Upgrade

- `busytex/Makefile` - TeX Live URLs
- `packages/update-bundles-tl2025.ts` - Package update script
- `packages/bundles/core.data.gz` + `.meta.json`
- `packages/bundles/l3.data.gz` + `.meta.json`
- `packages/bundles/amsmath.data.gz` + `.meta.json`
- `packages/bundles/fmt-pdflatex.data.gz` + `.meta.json`
- `packages/bundles/fmt-xelatex.data.gz` + `.meta.json`
- `packages/bundles/fmt-lualatex.data.gz` + `.meta.json`
- `packages/bundles/file-manifest.json`

## Notes

- The format files are engine-specific. A pdfTeX format won't work with XeTeX.
- Format files embed the engine version checksum and will fail if mismatched.
- The `file-manifest.json` entries override `meta.json` entries - both must be updated.
- Bundle updates only affect files that exist in both the package and the bundle.
- New files in packages are NOT automatically added to bundles.
