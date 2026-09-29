// Local, read-only static server for the Hiyori v2 workbench.
//   node tools/serve.mjs [--port=5178]   ->  http://127.0.0.1:5178/
// Serves ONLY: this work folder's demo/src/rig/build/out-review (/work/), the
// original Hiyori moc3 + two textures (/hiyori/, read-only) and the vendored
// Cubism Core (/vendor/). Loopback only, no network calls, no writes.
// Malformed URLs get 400 and the server keeps running.
import http from 'node:http';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {workRoot, projectRoot, hiyoriDir, corePath} from '../src/cubism-core-node.mjs';

export const TYPES = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.moc3': 'application/octet-stream', '.css': 'text/css; charset=utf-8'};
// Work-folder subtrees the browser may read. source/ (cmo3/can3) and
// reference/ (private masters) are never served.
const WORK_ALLOW = ['demo/', 'src/', 'rig/', 'build/', 'out/review/'];
const HIYORI_ALLOW = /^(hiyori_pro_t11\.moc3|hiyori_pro_t11\.2048\/texture_0[01]\.png)$/;

// Pure: request URL -> {status, file?, location?}. Never throws.
export function resolveRequest(rawUrl) {
  let clean;
  try {
    clean = decodeURIComponent(String(rawUrl ?? '').split('?')[0].split('#')[0]);
  } catch {
    return {status: 400};
  }
  if (!clean.startsWith('/') || clean.includes('\0') || clean.includes('\\') || clean.split('/').includes('..')) return {status: 404};
  if (clean === '/' || clean === '/index.html') return {status: 302, location: '/work/demo/index.html'};
  if (clean === '/vendor/live2dcubismcore.js') return {status: 200, file: corePath};
  if (clean.startsWith('/hiyori/')) {
    const rel = clean.slice('/hiyori/'.length);
    return HIYORI_ALLOW.test(rel) ? {status: 200, file: path.join(hiyoriDir, rel)} : {status: 404};
  }
  if (clean.startsWith('/work/')) {
    const rel = clean.slice('/work/'.length);
    if (!WORK_ALLOW.some(prefix => rel.startsWith(prefix))) return {status: 404};
    const file = path.resolve(workRoot, rel);
    return file.startsWith(workRoot + path.sep) ? {status: 200, file} : {status: 404};
  }
  return {status: 404};
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      const target = resolveRequest(req.url);
      if (target.status === 302) { res.writeHead(302, {location: target.location}).end(); return; }
      if (target.status !== 200) { res.writeHead(target.status, {'content-type': 'text/plain'}).end(target.status === 400 ? 'bad request' : 'not found'); return; }
      const info = await stat(target.file).catch(() => null);
      if (!info?.isFile()) { res.writeHead(404, {'content-type': 'text/plain'}).end('not found'); return; }
      res.writeHead(200, {'content-type': TYPES[path.extname(target.file)] || 'application/octet-stream', 'content-length': info.size,
        'cache-control': 'no-cache', 'x-content-type-options': 'nosniff'});
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(target.file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(500, {'content-type': 'text/plain'});
      res.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number((process.argv.find(a => a.startsWith('--port=')) || '--port=5178').slice(7));
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Hiyori v2 workbench (PROTOTYPE): http://127.0.0.1:${port}/`);
    console.log(`project root: ${projectRoot}`);
  });
}
