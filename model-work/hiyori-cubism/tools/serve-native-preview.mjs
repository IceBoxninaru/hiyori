// Local, read-only before/after native export preview server (127.0.0.1 only).
//   node model-work/hiyori-cubism/tools/serve-native-preview.mjs --before <a.model3.json> --after <b.model3.json>
//        --poses <poses.json> --port <n> --core <core.js> --pixi <pixi.js> --live2d-display <cubism4.js>
//        [--pixi-unsafe-eval <pixi-unsafe-eval.js>] [--camera <camera.json>]
// Serves exact diagnostic files, three (optionally four) vendor files, a sanitized config and only
// the declared Moc/Textures of each model3 through opaque aliases. No writes.
import http from 'node:http';
import {createReadStream, promises as fsp} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {declaredReferences, resolveReferences, parsePoses, readBounded, safeLabel, AuditError} from '../src/export-audit.mjs';
import {parsePosesV2, sharedPosesAsModels, SLOT_NAMES, PreviewError} from '../preview/pose-core.mjs';

const PREVIEW_DIR = fileURLToPath(new URL('../preview/', import.meta.url));
export const PREVIEW_FILES = Object.freeze(['index.html', 'app.mjs', 'pose-core.mjs', 'load-guard.mjs', 'render-step.mjs', 'style.css']);
export const SLOTS = Object.freeze(['before', 'after']);
const VENDOR = Object.freeze({core: 'core.js', pixi: 'pixi.js', live2dDisplay: 'live2d-display.js'});
// Optional fourth vendor: the local @pixi/unsafe-eval helper, loaded after Pixi so no 'unsafe-eval' CSP is needed.
const OPTIONAL_VENDOR = Object.freeze({pixiUnsafeEval: 'pixi-unsafe-eval.js'});
const TYPES = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.moc3': 'application/octet-stream'};
const TEXTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
// No 'unsafe-eval': Pixi 6 relies on the optional local pixi-unsafe-eval helper instead.
// 'wasm-unsafe-eval' is required for Core to instantiate its WebAssembly.
export const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; "
  + "connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export class ServeError extends Error {
  constructor(code, detail = '') { super(detail ? `${code}: ${detail}` : code); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new ServeError(code, detail); };
const fromAudit = (e, slot) => e instanceof AuditError ? new ServeError(e.code, `${slot}${e.ref ? ` ${e.ref}` : ''}${e.detail ? `: ${e.detail}` : ''}`) : e;

async function realFile(file, code, label) {
  let real;
  try { real = await fsp.realpath(file); } catch { fail(code, label); }
  const info = await fsp.stat(real);
  if (!info.isFile()) fail(code, `${label} is not a regular file`);
  return real;
}

async function readJsonFile(file, limit, code, label) {
  const text = (await readBounded(file, limit, code, label)).toString('utf8');
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch { fail(code, `${label}: invalid JSON`); }
}

export function parseCamera(json) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(json) || json.version !== 1) fail('E_CAMERA', 'expected {"version":1,...}');
  for (const k of Object.keys(json)) if (!['version', 'zoom', 'centerX', 'centerY', 'crop'].includes(k)) fail('E_CAMERA', `unknown key ${safeLabel(k)}`);
  const num = (v, name, positive = false) => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || (positive && v <= 0)) fail('E_CAMERA', `${name} must be a finite${positive ? ' positive' : ''} number`);
    return v;
  };
  const out = {zoom: num(json.zoom, 'zoom', true) ?? 1, centerX: num(json.centerX, 'centerX') ?? 0.5, centerY: num(json.centerY, 'centerY') ?? 0.5, crop: null};
  if (json.crop !== undefined) {
    if (!isObj(json.crop)) fail('E_CAMERA', 'crop must be an object');
    for (const k of Object.keys(json.crop)) if (!['x', 'y', 'w', 'h'].includes(k)) fail('E_CAMERA', `unknown crop key ${safeLabel(k)}`);
    out.crop = {x: num(json.crop.x, 'crop.x'), y: num(json.crop.y, 'crop.y'), w: num(json.crop.w, 'crop.w', true), h: num(json.crop.h, 'crop.h', true)};
    if (Object.values(out.crop).some(v => v === undefined)) fail('E_CAMERA', 'crop needs x, y, w, h');
  }
  return out;
}

// Resolves everything once. Returns {routes: Map(url -> {file, real, base, type}), config}.
// Every failure is a ServeError with a stable code and no absolute path.
export async function preparePreview({before, after, poses, core, pixi, live2dDisplay, pixiUnsafeEval = null, camera = null}) {
  const routes = new Map();
  for (const name of PREVIEW_FILES) {
    const file = path.join(PREVIEW_DIR, name);
    const real = await realFile(file, 'E_PREVIEW_MISSING', name);
    routes.set(name === 'index.html' ? '/' : `/app/${name}`, {file, real, base: null, type: TYPES[path.extname(name)]});
  }
  for (const [key, alias] of Object.entries(VENDOR)) {
    const given = {core, pixi, live2dDisplay}[key];
    if (typeof given !== 'string' || !given) fail('E_VENDOR_MISSING', key);
    const real = await realFile(given, 'E_VENDOR_MISSING', key);
    if (path.extname(real).toLowerCase() !== '.js') fail('E_VENDOR_TYPE', `${key} must be a .js file`);
    routes.set(`/vendor/${alias}`, {file: real, real, base: null, type: TYPES['.js']});
  }
  if (pixiUnsafeEval) {
    const real = await realFile(pixiUnsafeEval, 'E_VENDOR_MISSING', 'pixiUnsafeEval');
    if (path.extname(real).toLowerCase() !== '.js') fail('E_VENDOR_TYPE', 'pixiUnsafeEval must be a .js file');
    routes.set(`/vendor/${OPTIONAL_VENDOR.pixiUnsafeEval}`, {file: real, real, base: null, type: TYPES['.js']});
  }
  const models = [];
  for (const [slot, modelPath] of [['before', before], ['after', after]]) {
    if (typeof modelPath !== 'string' || !modelPath) fail('E_MODEL_MISSING', slot);
    const modelReal = await realFile(modelPath, 'E_MODEL_MISSING', slot);
    const modelDir = path.dirname(modelReal);
    let refs;
    try {
      const model3 = await readJsonFile(modelReal, 1 << 20, 'E_MODEL_JSON', slot);
      refs = declaredReferences(model3).filter(r => r.kind === 'moc' || r.kind === 'texture');
    } catch (e) { throw fromAudit(e, slot); }
    const {resolved, errors} = await resolveReferences(modelDir, refs);
    if (errors.length) fail(errors[0].code, `${slot} ${errors[0].ref}${errors[0].detail ? `: ${errors[0].detail}` : ''}`);
    const entry = {slot, label: `${slot}: ${safeLabel(path.basename(modelReal))}`, moc: null, textures: []};
    resolved.forEach((r, i) => {
      const ext = path.extname(r.ref).toLowerCase();
      if (r.kind === 'moc' && ext !== '.moc3') fail('E_REF_TYPE', `${slot} moc must be .moc3`);
      if (r.kind === 'texture' && !TEXTURE_EXT.has(ext)) fail('E_REF_TYPE', `${slot} texture[${i - 1}] must be png/jpg/webp`);
      const url = `/m/${slot}/r/${i}${ext}`;
      routes.set(url, {file: r.file, real: r.file, base: modelDir, type: TYPES[ext]});
      if (r.kind === 'moc') entry.moc = url; else entry.textures.push(url);
    });
    models.push(entry);
  }
  // v1: the audit's shared-pose format (same values for both models).
  // v2: preview-only explicit per-model poses (see preview/pose-core.mjs).
  let parsedPoses, posesVersion;
  let posesJson;
  try { posesJson = await readJsonFile(poses ?? '', 256 << 10, 'E_POSES_READ', 'poses'); } catch (e) { throw fromAudit(e, 'poses'); }
  if (posesJson?.version === 2) {
    try { parsedPoses = parsePosesV2(posesJson); } catch (e) { throw e instanceof PreviewError ? new ServeError(e.code, e.detail) : e; }
    posesVersion = 2;
  } else {
    let shared;
    try { shared = parsePoses(posesJson); } catch (e) { throw fromAudit(e, 'poses'); }
    // parsePoses accepts any key; /config.json must never echo a path- or URL-looking
    // ID. Legal SDK parameter IDs (letters, digits, _ . -) pass unchanged.
    for (const pose of shared) {
      for (const id of Object.keys(pose.parameters)) if (safeLabel(id) !== id) fail('E_POSE_PARAM_ID', `pose ${pose.name}: malformed parameter id (value redacted)`);
    }
    parsedPoses = sharedPosesAsModels(shared);
    posesVersion = 1;
  }
  const defaultPose = {name: 'default', version: posesVersion, models: Object.fromEntries(SLOT_NAMES.map(slot => [slot, {parameters: {}}]))};
  let cameraConfig = null;
  if (camera) { try { cameraConfig = parseCamera(await readJsonFile(camera, 64 << 10, 'E_CAMERA', 'camera')); } catch (e) { throw fromAudit(e, 'camera'); } }
  const config = {version: 1, mode: 'raw-core', pixiUnsafeEval: !!pixiUnsafeEval, models, posesVersion, poses: [defaultPose, ...parsedPoses], camera: cameraConfig,
    note: 'Raw Core mode: SDK Pose, physics, motion, expressions, blink, breath and gaze are disabled. Both A and B arm parts may be visible.'};
  const body = Buffer.from(JSON.stringify(config));
  routes.set('/config.json', {body, type: TYPES['.json']});
  return {routes, config};
}

// Pure: request URL -> route or {status}. Never throws.
export function resolveRequest(routes, rawUrl) {
  const raw = String(rawUrl ?? '');
  if (!raw.startsWith('/') || raw.startsWith('//')) return {status: 400};
  let clean;
  try { clean = decodeURIComponent(raw.split('?')[0].split('#')[0]); } catch { return {status: 400}; }
  if (clean.includes('\0') || clean.includes('\\') || clean.split('/').includes('..') || clean.includes('//')) return {status: 404};
  const route = routes.get(clean);
  return route ? {status: 200, route} : {status: 404};
}

async function stillSafe(route) {
  if (route.body) return true;
  try {
    const real = await fsp.realpath(route.file);
    if (real !== route.real) return false;
    if (route.base && !real.startsWith(route.base + path.sep)) return false;
    return (await fsp.stat(real)).isFile();
  } catch { return false; }
}

export function createPreviewServer(prepared) {
  const server = http.createServer(async (req, res) => {
    const plain = (status, text) => { res.writeHead(status, {'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store'}).end(text); };
    try {
      const port = server.address()?.port;
      if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { plain(421, 'misdirected request'); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('allow', 'GET, HEAD'); plain(405, 'method not allowed'); return; }
      const target = resolveRequest(prepared.routes, req.url);
      if (target.status !== 200) { plain(target.status, target.status === 400 ? 'bad request' : 'not found'); return; }
      const {route} = target;
      if (!(await stillSafe(route))) { plain(404, 'not found'); return; }
      const headers = {'content-type': route.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP,
        'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin'};
      if (route.body) { res.writeHead(200, {...headers, 'content-length': route.body.length}); res.end(req.method === 'HEAD' ? undefined : route.body); return; }
      const info = await fsp.stat(route.real);
      res.writeHead(200, {...headers, 'content-length': info.size});
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(route.real);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) plain(500, 'internal error'); else res.destroy();
    }
  });
  return server;
}

export function parseArgs(argv) {
  const takes = {'--before': 'before', '--after': 'after', '--poses': 'poses', '--port': 'port', '--core': 'core', '--pixi': 'pixi', '--live2d-display': 'live2dDisplay', '--pixi-unsafe-eval': 'pixiUnsafeEval', '--camera': 'camera'};
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return {help: true};
    const eq = arg.indexOf('=');
    const [flag, inline] = eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    const key = takes[flag];
    if (!key) return {error: /^--?[a-z][a-z0-9-]{0,40}$/.test(flag) ? `unknown option ${flag}` : 'unknown argument (value redacted)'};
    const value = inline ?? argv[++i];
    if (!value) return {error: `${flag} needs a value`};
    opts[key] = value;
  }
  for (const required of ['before', 'after', 'poses', 'port', 'core', 'pixi', 'live2dDisplay']) if (!opts[required]) return {error: `missing --${required === 'live2dDisplay' ? 'live2d-display' : required}`};
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return {error: '--port must be an integer 1-65535'};
  return {...opts, port};
}

const HELP = `Native export pose comparison preview (local, read-only, 127.0.0.1 only)

  node model-work/hiyori-cubism/tools/serve-native-preview.mjs --before <before.model3.json> --after <after.model3.json>
       --poses <poses.json> --port <1-65535> --core <live2dcubismcore.js> --pixi <pixi v6 UMD>
       --live2d-display <pixi-live2d-display cubism4 UMD> [--pixi-unsafe-eval <local pixi-unsafe-eval helper>]
       [--camera <camera.json>]

The CSP has no 'unsafe-eval'. Pixi 6 needs the local pixi-unsafe-eval helper; without it Pixi
shader setup is expected to fail and the page reports the error.

Raw Core mode only: SDK Pose, physics, motion, expressions, blink, breath and gaze are disabled,
so both A and B arm parts may be visible. Pixel differences do not judge anatomy, and never
override an export-audit incompatibility.
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return 0; }
  if (opts.error) { process.stderr.write(`E_USAGE: ${opts.error}\n(see --help)\n`); return 64; }
  let prepared;
  try { prepared = await preparePreview(opts); } catch (e) {
    process.stderr.write(e instanceof ServeError ? `${e.code}${e.detail ? `: ${e.detail}` : ''}\n` : 'E_INTERNAL\n');
    return 2;
  }
  const server = createPreviewServer(prepared);
  return new Promise(resolve => {
    server.once('error', e => { process.stderr.write(e?.code === 'EADDRINUSE' ? `E_PORT_BUSY: ${opts.port}\n` : 'E_LISTEN\n'); resolve(2); });
    server.listen(opts.port, '127.0.0.1', () => {
      process.stdout.write(`Native preview (raw-core, read-only): http://127.0.0.1:${opts.port}/\n`);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { if (code !== undefined) process.exitCode = code; }, () => { process.stderr.write('E_INTERNAL\n'); process.exitCode = 2; });
}
