# busytex-lazy

A lazy-loading infrastructure layer for [BusyTeX](https://github.com/busytex/busytex), enabling browser-based LaTeX compilation without downloading the entire TeX Live distribution upfront.

## The Problem

TeX Live is massive. A minimal pdflatex installation is 100MB+, and supporting common packages pushes it to 500MB+. Loading this upfront makes browser-based LaTeX impractical for most use cases.

## The Solution

**busytex-lazy** splits TeX Live into small bundles (~1-10MB each) that are loaded on-demand during compilation:

1. **Initial load**: Only core bundles (~15MB compressed) for basic documents
2. **On-demand loading**: Additional packages fetched as the document requires them
3. **CTAN fallback**: Missing packages automatically downloaded from CTAN mirrors
4. **Persistent caching**: OPFS/IndexedDB storage eliminates repeat downloads

## Installation

### ES Modules (Browser)

busytex-lazy is designed for direct browser usage with ES modules - no bundler required:

```html
<script type="module">
import { BusyTeXCompiler } from './src/index.js';

const compiler = new BusyTeXCompiler({
    bundlesUrl: 'packages/bundles',
    wasmUrl: 'busytex.wasm',
    ctanProxyUrl: 'http://localhost:8081',
    onLog: (msg) => console.log(msg),
    onProgress: (stage, detail) => console.log(`${stage}: ${detail}`),
});

await compiler.init();

const result = await compiler.compile(`
\\documentclass{article}
\\begin{document}
Hello, World!
\\end{document}
`);

if (result.success) {
    const blob = new Blob([result.pdf], { type: 'application/pdf' });
    window.open(URL.createObjectURL(blob));
}
</script>
```

### Available Exports

```javascript
// Main compiler class
import { BusyTeXCompiler } from './src/index.js';

// Bundle management
import { BundleManager, detectEngine, extractPreamble, hashPreamble } from './src/index.js';

// CTAN package fetching
import { CTANFetcher, getPackageFromFile, isValidPackageName } from './src/index.js';

// Storage utilities
import { clearCTANCache, hashDocument, getCachedPdf, saveCachedPdf, listAllCachedPackages } from './src/index.js';
```

### Compiler Options

```javascript
const compiler = new BusyTeXCompiler({
    bundlesUrl: 'packages/bundles',  // Path to bundle files
    wasmUrl: 'busytex.wasm',         // Path to BusyTeX WASM
    workerUrl: null,                 // Custom worker URL (uses embedded if null)
    ctanProxyUrl: 'http://localhost:8081',  // CTAN proxy server
    enableCtan: true,                // Enable CTAN fallback for missing packages
    enableLazyFS: true,              // Enable lazy file loading
    enableDocCache: true,            // Cache compiled PDFs
    onLog: (msg) => {},              // Log callback
    onProgress: (stage, detail) => {},  // Progress callback
});
```

### Compilation Options

```javascript
const result = await compiler.compile(source, {
    engine: 'pdflatex',  // 'pdflatex' | 'xelatex' | 'lualatex' (auto-detected if not specified)
    useCache: true,      // Use cached PDF if available
});

// Result object
{
    success: boolean,
    pdf: Uint8Array,     // PDF data (if successful)
    cached: boolean,     // Whether result came from cache
    error: string,       // Error message (if failed)
    log: string,         // LaTeX log output
    stats: object,       // Compilation statistics
}
```

## Prerequisites

This project uses [BusyTeX](https://github.com/busytex/busytex) as a git submodule. After cloning, you need to build or download the WASM files:

```bash
# Clone with submodules
git clone --recurse-submodules <repo-url>

# Build BusyTeX (requires emscripten)
cd busytex
make wasm
cp build/wasm/busytex.js build/wasm/busytex.wasm ..
cd ..
```

Or download pre-built binaries from the [BusyTeX releases](https://github.com/busytex/busytex/releases).

## Quick Start

```bash
# Start a local server
python3 -m http.server 8080

# (Optional) Start CTAN proxy for package fallback
cd packages && bun run ctan-proxy.ts

# Open in browser
open http://localhost:8080/split-bundle-lazy.html
```

The demo page includes a full-featured editor with:
- Engine selection (pdflatex, xelatex, lualatex)
- Custom format generation (pre-compile preambles for faster subsequent compiles)
- PDF preview
- Automatic CTAN package fetching

## Bundle System

Bundles are pre-packaged collections of TeX files:

| Bundle | Contents | Size (gzip) |
|--------|----------|-------------|
| `core` | LaTeX kernel, base classes | ~2MB |
| `fmt-pdflatex` | pdflatex format file | ~3MB |
| `l3` | LaTeX3 packages (expl3, xparse) | ~2MB |
| `fonts-cm` | Computer Modern fonts | ~1MB |
| `amsmath` | AMS math packages | ~500KB |
| `graphics` | graphicx, color, etc. | ~300KB |
| `tikz` | TikZ/PGF graphics | ~5MB |
| ... | 30+ more bundles | varies |

### Bundle Structure

```
packages/bundles/
├── core.data.gz          # Compressed file contents
├── core.meta.json        # File paths, offsets, sizes
├── amsmath.data.gz
├── amsmath.meta.json
├── registry.json         # Available bundles
├── package-map.json      # Package name -> bundle mapping
├── file-manifest.json    # File path -> bundle mapping
└── bundle-deps.json      # Bundle dependency graph
```

## CTAN Fallback

When a package isn't in any bundle, busytex-lazy fetches it from CTAN:

1. Compilation fails with "file not found"
2. System extracts package name from the missing file path
3. CTAN API queried for package metadata
4. Package files downloaded and mounted
5. Compilation retried automatically

This provides access to all 6000+ CTAN packages without bundling them.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Main Thread   │     │  Compile Worker │
├─────────────────┤     ├─────────────────┤
│ - UI updates    │────▶│ - WASM runtime  │
│ - OPFS caching  │     │ - Bundle mount  │
│ - Bundle fetch  │◀────│ - Compilation   │
│ - PDF render    │     │ - Font handling │
└─────────────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│  Storage Layer  │
├─────────────────┤
│ - OPFS (fast)   │
│ - IndexedDB     │
│ - Fetch cache   │
└─────────────────┘
```

## Engine Support

| Engine | Status | Notes |
|--------|--------|-------|
| pdflatex | Working | Primary focus |
| xelatex | Working | Requires OTF font bundles |
| lualatex | Partial | Large format files |

## Known Limitations

- **kpathsea quirks**: Font path resolution in WASM requires absolute paths; font maps are rewritten automatically
- **Large documents**: Memory pressure with 100+ page documents
- **Some packages**: Packages requiring shell escape or external tools won't work
- **Font subsetting**: Not supported; full fonts embedded in PDFs

## Performance

Typical first-compile times (cold cache):

| Document Type | Time | Data Downloaded |
|--------------|------|-----------------|
| Hello World | ~2s | ~15MB |
| Article with math | ~4s | ~20MB |
| Beamer presentation | ~8s | ~35MB |
| Full memoir book | ~15s | ~50MB |

Subsequent compiles with warm cache: 1-3s regardless of complexity.

## Project Structure

```
.
├── src/                    # ES module source files
│   ├── index.js            # Main entry point (exports all public APIs)
│   ├── compiler.js         # BusyTeXCompiler class
│   ├── bundles.js          # BundleManager, engine detection, preamble handling
│   ├── ctan.js             # CTANFetcher for missing package resolution
│   ├── storage.js          # OPFS/IndexedDB caching layer
│   └── worker.js           # Web Worker for off-main-thread compilation
├── busytex/                # BusyTeX submodule (build to get .js/.wasm)
├── busytex.js              # BusyTeX WASM JavaScript (built from submodule)
├── busytex.wasm            # BusyTeX WebAssembly binary (built from submodule)
├── split-bundle-lazy.html  # Demo application
├── README.md
└── packages/
    ├── bundles/            # Pre-built TeX bundles
    │   ├── *.data.gz       # Compressed bundle data
    │   ├── *.meta.json     # Bundle metadata
    │   ├── registry.json   # Bundle registry
    │   ├── package-map.json
    │   ├── file-manifest.json
    │   └── bundle-deps.json
    └── ctan-proxy.ts       # Development CTAN proxy server
```

### Module Overview

| Module | Description |
|--------|-------------|
| `compiler.js` | Main orchestrator - initializes worker, handles compile requests, manages caching |
| `bundles.js` | Loads bundle manifests, resolves package dependencies, detects required engine |
| `ctan.js` | Fetches missing packages from CTAN, caches to OPFS |
| `storage.js` | OPFS and IndexedDB operations for persistent caching |
| `worker.js` | Runs in Web Worker - mounts bundles, executes WASM, returns PDF |

## Development

### Running Locally

```bash
# Start file server
python3 -m http.server 8080

# (Optional) Start CTAN proxy for package fallback
cd packages && bun run ctan-proxy.ts

# Open demo in browser
open http://localhost:8080/split-bundle-lazy.html  # Standalone demo
open http://localhost:8080/demo.html               # ES modules demo
```

### Using in Your Project

Copy the `src/` directory and `packages/bundles/` to your project, then import:

```javascript
import { BusyTeXCompiler } from './src/index.js';
```

Requirements:
- Serve with `Content-Type: application/javascript` for `.js` files
- CORS headers if loading bundles from a different origin
- CTAN proxy running for dynamic package resolution (optional)

### Modifying Bundles

After modifying bundle files, regenerate the indices:

```bash
cd packages/bundles
python3 sync-package-map.py
```

## Credits

This project builds on:

- **[BusyTeX](https://github.com/busytex/busytex)** - The WASM port of TeX Live that makes browser-based LaTeX possible
- **[TeX Live](https://tug.org/texlive/)** - The underlying TeX distribution
- **[CTAN](https://ctan.org/)** - Package repository and API

## License

MIT License - see LICENSE file.

The bundled TeX Live components retain their original licenses (primarily LPPL for LaTeX packages).
