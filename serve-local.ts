// Simple local dev server for siglum-engine
// Serves bundles, WASM, and proxies CTAN requests

const BUNDLES_DIR = './packages/bundles';
const DIST_DIR = './dist';

Bun.serve({
  port: 8787,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // /bundles/* - serve from packages/bundles
    if (path.startsWith('/bundles/')) {
      const file = path.slice(9); // remove '/bundles/'
      const filePath = `${BUNDLES_DIR}/${file}`;

      const bunFile = Bun.file(filePath);
      if (await bunFile.exists()) {
        const contentType = file.endsWith('.json') ? 'application/json'
          : file.endsWith('.gz') ? 'application/gzip'
          : 'application/octet-stream';

        return new Response(bunFile, {
          headers: { ...corsHeaders, 'Content-Type': contentType },
        });
      }
      return new Response('Not found: ' + filePath, { status: 404, headers: corsHeaders });
    }

    // /wasm/* - serve from root (busytex.wasm, busytex.js)
    if (path.startsWith('/wasm/')) {
      const file = path.slice(6);
      const filePath = `./${file}`;

      const bunFile = Bun.file(filePath);
      if (await bunFile.exists()) {
        const contentType = file.endsWith('.wasm') ? 'application/wasm'
          : file.endsWith('.js') ? 'application/javascript'
          : 'application/octet-stream';
        return new Response(bunFile, {
          headers: { ...corsHeaders, 'Content-Type': contentType },
        });
      }
      return new Response('Not found: ' + filePath, { status: 404, headers: corsHeaders });
    }

    // /api/fetch/* - proxy to CTAN (or use cached)
    if (path.startsWith('/api/fetch/')) {
      const pkg = path.slice(11);
      const ctanUrl = `https://siglum-api.vtp-ips.workers.dev/api/fetch/${pkg}`;

      console.log(`Proxying CTAN request: ${pkg}`);
      const response = await fetch(ctanUrl);
      const body = await response.text();

      return new Response(body, {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // /xzwasm.js - serve from dist
    if (path === '/xzwasm.js') {
      const bunFile = Bun.file(`${DIST_DIR}/xzwasm.js`);
      if (await bunFile.exists()) {
        return new Response(bunFile, {
          headers: { ...corsHeaders, 'Content-Type': 'application/javascript' },
        });
      }
    }

    // Health check
    if (path === '/' || path === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'siglum-local-dev',
        dirs: { bundles: BUNDLES_DIR, dist: DIST_DIR }
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
});

console.log('Local dev server: http://localhost:8787');
console.log('  /bundles/*  -> ./packages/bundles/');
console.log('  /wasm/*     -> ./dist/');
console.log('  /api/fetch/ -> CTAN proxy');
