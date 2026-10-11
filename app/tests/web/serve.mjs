/**
 * serve.mjs - a tiny local web server for the automatic website tests.
 *
 * It serves the built website (the "dist" folder made by
 * `npx expo export -p web`) at http://localhost:8099/devikins-legacy-hub/,
 * the same path it has on GitHub Pages. Started automatically by
 * playwright.config.js; you never need to run it by hand.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
const BASE = '/devikins-legacy-hub';
const PORT = Number(process.env.PORT || 8099);
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.svg': 'image/svg+xml',
};

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('No built website found in app/dist. Run "npm test" (it builds first) or "npx expo export -p web".');
  process.exit(1);
}

http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (!urlPath.startsWith(BASE)) {
      res.writeHead(302, { Location: BASE + '/' });
      return res.end();
    }
    let file = path.join(ROOT, urlPath.slice(BASE.length));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(ROOT, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  })
  .listen(PORT, () => console.log(`Test server: http://localhost:${PORT}${BASE}/`));
