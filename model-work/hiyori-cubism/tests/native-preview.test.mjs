// Offline SYNTHETIC tests for the native preview. A fake Core, fake model files
// and fake vendor scripts stand in for real assets. Passing these tests is NOT
// evidence of real WebGL, Pixi, texture or Core rendering; that is checked locally.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {preparePreview, createPreviewServer, resolveRequest, parseArgs, parseCamera, PREVIEW_FILES} from '../tools/serve-native-preview.mjs';
import {readDeclaredState, validatePoseForModel, applyPose, installDeterministicUpdate, partOpacityDiff, topologyNotes, deriveCamera, cropToView} from '../preview/pose-core.mjs';
import {createLoadGuard} from '../preview/load-guard.mjs';
import {renderSlotOnce, disposeRecord, loadSlotsOwned, purgeTextureCache, generationUrl, FIXED_UPDATE_MS} from '../preview/render-step.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const linkDir = (target, at) => symlink(target, at, WIN ? 'junction' : 'dir');

// ---- fake Core (only the inspected surface) -------------------------------------------
function fakeCore(spec) {
  const stats = {models: 0, released: 0, mocsReleased: 0};
  class Moc { static fromArrayBuffer() { return spec.nullMoc ? null : new Moc(); } hasMocConsistency() { return spec.inconsistent ? 0 : 1; } _release() { stats.mocsReleased++; } }
  const newModel = () => {
    stats.models++;
    return {
      parameters: {ids: spec.params.map(p => p.id), minimumValues: spec.params.map(p => p.min), maximumValues: spec.params.map(p => p.max),
        defaultValues: spec.params.map(p => p.default), values: Float32Array.from(spec.params.map(p => p.initial ?? p.default))},
      parts: {ids: spec.parts.map(p => p.id), opacities: Float32Array.from(spec.parts.map(p => p.opacity))},
      drawables: {ids: spec.drawables ?? ['ArtMesh1']},
      canvasinfo: {CanvasWidth: 2976, CanvasHeight: 4175, PixelsPerUnit: 2976, CanvasOriginX: 1488, CanvasOriginY: 2087.5},
      updates: 0, update() { this.updates++; }, release() { stats.released++; },
    };
  };
  const core = {Version: {csmGetVersion: () => 0x05010000, csmGetLatestMocVersion: () => 5, csmGetMocVersion: (moc, bytes) => {
    if (!(moc instanceof Moc) || typeof bytes.byteLength !== 'number') throw new TypeError('bad args'); return spec.mocVersion ?? 5; }},
  Moc, Model: {fromMoc: () => spec.nullModel ? null : newModel()}};
  return {core, stats, newModel};
}
const SPEC = () => ({
  params: [{id: 'ParamAngleX', min: -30, max: 30, default: 0}, {id: 'ParamShoulder', min: 0, max: 1, default: 0}, {id: 'ParamBreath', min: 0, max: 1, default: 0.5, initial: 0.25}],
  parts: [{id: 'PartArmA', opacity: 1}, {id: 'PartArmB', opacity: 0.25}],
});
const MOC = new ArrayBuffer(8);

// ---- pose core ------------------------------------------------------------------------
test('declared state comes from a separate fresh Core model, uses declared defaults and releases it', () => {
  const {core, stats} = fakeCore(SPEC());
  const state = readDeclaredState(core, MOC);
  assert.deepEqual(state.parameters.map(q => [q.id, q.default]), [['ParamAngleX', 0], ['ParamShoulder', 0], ['ParamBreath', 0.5]]);
  assert.deepEqual(state.parts, [{id: 'PartArmA', initial: 1}, {id: 'PartArmB', initial: 0.25}], 'fresh part opacities, not assumed all-ones');
  assert.equal(state.mocVersion, 5); assert.equal(state.canvas.width, 2976);
  assert.equal(stats.released, 1); assert.equal(stats.mocsReleased, 1);
  for (const patch of [{mocVersion: 6}, {nullModel: true}, {inconsistent: true}, {nullMoc: true}]) {
    const f = fakeCore({...SPEC(), ...patch});
    assert.throws(() => readDeclaredState(f.core, MOC), e => /^E_/.test(e.code), JSON.stringify(patch));
  }
  const bad = SPEC(); bad.params[1].default = 2;
  assert.throws(() => readDeclaredState(fakeCore(bad).core, MOC), e => e.code === 'E_STRUCTURE');
});

test('pose validation: unknown IDs, non-finite and out-of-range values fail (never clamped)', () => {
  const state = readDeclaredState(fakeCore(SPEC()).core, MOC);
  assert.doesNotThrow(() => validatePoseForModel({name: 'shrug', parameters: {ParamShoulder: 1}}, state));
  assert.throws(() => validatePoseForModel({name: 'x', parameters: {ParamArmLRaise: 1}}, state), e => e.code === 'E_POSE_UNKNOWN_PARAM');
  assert.throws(() => validatePoseForModel({name: 'x', parameters: {ParamShoulder: 1.01}}, state), e => e.code === 'E_POSE_RANGE');
  assert.throws(() => validatePoseForModel({name: 'x', parameters: {ParamShoulder: NaN}}, state), e => e.code === 'E_POSE_VALUE');
  assert.throws(() => validatePoseForModel({name: 'x', parameters: {'/Users/example-private/p': 1}}, state), e => e.code === 'E_POSE_UNKNOWN_PARAM' && !e.message.includes('example-private'));
});

test('applyPose resets every parameter and part to declared defaults first: order and history independent', () => {
  const f = fakeCore(SPEC());
  const state = readDeclaredState(f.core, MOC);
  const shrug = {name: 'shrug', parameters: {ParamShoulder: 1}}, head = {name: 'head', parameters: {ParamAngleX: 15}};
  const snapshot = m => [Array.from(m.parameters.values), Array.from(m.parts.opacities)];
  const alone = f.newModel(); applyPose(alone, state, shrug);
  const after = f.newModel(); applyPose(after, state, head); after.parts.opacities[0] = 0; after.parameters.values[2] = 0.9; applyPose(after, state, shrug);
  assert.deepEqual(snapshot(after), snapshot(alone));
  assert.deepEqual(snapshot(alone), [[0, 1, 0.5], [1, 0.25]], 'declared defaults (breath 0.5, not the instance initial 0.25)');
  assert.deepEqual(applyPose(alone, state, {name: 'default', parameters: {}}), {});
  assert.deepEqual(snapshot(alone)[0], [0, 0, 0.5]);
  const other = f.newModel(); other.parameters.ids = ['X', 'Y', 'Z'];
  assert.throws(() => applyPose(other, state, shrug), e => e.code === 'E_STATE_MISMATCH');
});

test('deterministic update replaces the wrapper update: reset, apply, Core update; reports read-back values', () => {
  const f = fakeCore(SPEC());
  const state = readDeclaredState(f.core, MOC), raw = f.newModel();
  let wrapperRan = false, pose = {name: 'shrug', parameters: {ParamShoulder: 1}}, applied = null;
  const internal = {coreModel: {update() { raw.update(); }}, update() { wrapperRan = true; }};
  installDeterministicUpdate(internal, raw, state, () => pose, a => { applied = a; });
  raw.parameters.values[0] = 12; raw.parts.opacities[1] = 1; // e.g. a motion or SDK Pose wrote here
  internal.update(16, 1000);
  assert.equal(wrapperRan, false); assert.equal(raw.updates, 1);
  assert.deepEqual(applied, {ParamShoulder: 1});
  assert.deepEqual(Array.from(raw.parameters.values), [0, 1, 0.5]);
  assert.deepEqual(partOpacityDiff(raw, state), []);
  pose = {name: 'default', parameters: {}}; internal.update();
  assert.deepEqual(Array.from(raw.parameters.values), [0, 0, 0.5]);
});

test('camera is derived once from the before canvas; crop maps identically; topology differences are notes', () => {
  const state = readDeclaredState(fakeCore(SPEC()).core, MOC);
  const cam = deriveCamera(state.canvas, {width: 560, height: 784});
  assert.ok(Object.isFrozen(cam));
  assert.ok(Math.abs(cam.scale - Math.min(560 / 2976, 784 / 4175)) < 1e-12);
  const r = cropToView(cam, {x: 0.25, y: 0.18, w: 0.3, h: 0.22});
  assert.ok(r.w > 0 && r.h > 0);
  assert.throws(() => deriveCamera(state.canvas, {width: 560, height: 784}, {zoom: 0}), e => e.code === 'E_CAMERA');
  const other = {...state, drawableIds: ['ArtMesh1', 'ArtMeshNew'], canvas: {...state.canvas, width: 3000}};
  const notes = topologyNotes(state, other);
  assert.equal(notes.length, 2);
  assert.deepEqual(topologyNotes(state, state), []);
});

test('load guard: a stale asynchronous load is destroyed on arrival, the latest is kept', async () => {
  const guard = createLoadGuard();
  const destroyed = [];
  let resolveOld;
  const oldLoad = new Promise(resolve => { resolveOld = resolve; });
  const t1 = guard.begin();
  const first = guard.settle(t1, oldLoad, m => destroyed.push(m));
  const t2 = guard.begin();
  const second = guard.settle(t2, Promise.resolve('new-model'), m => destroyed.push(m));
  assert.equal(await second, 'new-model');
  resolveOld('old-model');
  assert.equal(await first, null);
  assert.deepEqual(destroyed, ['old-model']);
  assert.equal(guard.isCurrent(t1), false); assert.equal(guard.isCurrent(t2), true);
});

// ---- server ----------------------------------------------------------------------------
async function fixture({textures = ['tex/texture_00.png'], extraModel = {}} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'preview-'));
  const vendor = path.join(dir, 'vendor');
  await mkdir(vendor);
  for (const name of ['core.js', 'pixi.js', 'cubism4.js']) await writeFile(path.join(vendor, name), `/* synthetic ${name} */`);
  for (const slot of ['before', 'after']) {
    const root = path.join(dir, slot);
    await mkdir(path.join(root, 'tex'), {recursive: true});
    await writeFile(path.join(root, 'hiyori.moc3'), `FAKE-${slot}`);
    await writeFile(path.join(root, 'tex', 'texture_00.png'), `png-${slot}`);
    await writeFile(path.join(root, 'hiyori.physics3.json'), '{}');
    await writeFile(path.join(root, 'hiyori.cmo3'), 'editor source');
    await writeFile(path.join(root, '.env'), 'SECRET=1');
    await writeFile(path.join(root, 'hiyori.model3.json'), JSON.stringify({Version: 3,
      FileReferences: {Moc: 'hiyori.moc3', Textures: textures, Physics: 'hiyori.physics3.json', ...extraModel}}));
  }
  await writeFile(path.join(dir, 'poses.json'), JSON.stringify({version: 1, poses: [{name: 'shrug', parameters: {ParamShoulder: 1}}]}));
  const opts = {before: path.join(dir, 'before', 'hiyori.model3.json'), after: path.join(dir, 'after', 'hiyori.model3.json'), poses: path.join(dir, 'poses.json'),
    core: path.join(vendor, 'core.js'), pixi: path.join(vendor, 'pixi.js'), live2dDisplay: path.join(vendor, 'cubism4.js')};
  return {dir, opts, cleanup: () => rm(dir, {recursive: true, force: true})};
}

async function withServer(prepared, fn) {
  const server = createPreviewServer(prepared);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const get = (url, {method = 'GET', host = `127.0.0.1:${port}`} = {}) => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: url, method, headers: {host}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject); req.end();
  });
  try { return await fn(get, port); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('server serves exactly the page, preview files, three vendors, sanitized config and declared Moc/Textures', async () => {
  const fx = await fixture();
  try {
    const prepared = await preparePreview(fx.opts);
    const urls = [...prepared.routes.keys()].sort();
    assert.deepEqual(urls, ['/', '/app/app.mjs', '/app/load-guard.mjs', '/app/pose-core.mjs', '/app/render-step.mjs', '/app/style.css', '/config.json',
      '/m/after/r/0.moc3', '/m/after/r/1.png', '/m/before/r/0.moc3', '/m/before/r/1.png', '/vendor/core.js', '/vendor/live2d-display.js', '/vendor/pixi.js']);
    const configText = JSON.stringify(prepared.config);
    assert.ok(!configText.includes(fx.dir) && !configText.includes(tmpdir()), 'no absolute paths in config');
    assert.equal(prepared.config.mode, 'raw-core');
    assert.deepEqual(prepared.config.poses.map(p => p.name), ['default', 'shrug']);
    await withServer(prepared, async get => {
      const page = await get('/');
      assert.equal(page.status, 200); assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
      assert.ok(!/'unsafe-eval'/.test(page.headers['content-security-policy']), 'no unsafe-eval CSP');
      assert.equal((await get('/vendor/pixi-unsafe-eval.js')).status, 404, 'helper not configured: not served');
      assert.equal(page.headers['access-control-allow-origin'], undefined, 'no CORS');
      assert.equal((await get('/m/before/r/0.moc3')).body.toString(), 'FAKE-before');
      assert.equal((await get('/m/after/r/1.png')).body.toString(), 'png-after');
      assert.equal((await get('/vendor/pixi.js')).status, 200);
      const config = JSON.parse((await get('/config.json')).body);
      assert.equal(config.models[0].moc, '/m/before/r/0.moc3');
      for (const bad of ['/m/before/r/', '/m/before/', '/m/before/hiyori.cmo3', '/m/before/.env', '/m/before/hiyori.physics3.json', '/m/before/r/2.png',
        '/m/other/r/0.moc3', '/m/before/r/../../poses.json', '/m/before/r/%2e%2e/%2e%2e/.env', '/app/', '/app/../tools/serve-native-preview.mjs', '/app/index.html',
        '/vendor/', '/vendor/other.js', '/model-work/hiyori-cubism/README.md', '/%E0%A4%A']) {
        const r = await get(bad);
        assert.ok(r.status === 404 || r.status === 400, `${bad} -> ${r.status}`);
        assert.ok(!r.body.toString().includes(fx.dir));
      }
      assert.equal((await get('http://example.invalid/')).status, 400, 'absolute-form URL');
      assert.equal((await get('/', {method: 'POST'})).status, 405);
      assert.equal((await get('/', {method: 'PUT'})).status, 405);
      assert.equal((await get('/', {host: 'evil.example:80'})).status, 421, 'DNS-rebinding Host');
      assert.equal((await get('/', {method: 'HEAD'})).status, 200);
    });
  } finally { await fx.cleanup(); }
});

test('startup rejects URL, absolute, traversal and junction/link escapes, with redacted messages', async () => {
  for (const bad of ['https://example.invalid/t.png', '/Users/example-private/t.png', 'C:/Users/example-private/t.png', '../outside/t.png', 'tex\\t.png']) {
    const fx = await fixture({textures: [bad]});
    try {
      await assert.rejects(preparePreview(fx.opts), e => /^E_REF_/.test(e.code) && !e.message.includes('example-private') && !e.message.includes(fx.dir), bad);
    } finally { await fx.cleanup(); }
  }
  const fx = await fixture({textures: ['tex/linked/t.png']});
  try {
    await mkdir(path.join(fx.dir, 'outside'));
    await writeFile(path.join(fx.dir, 'outside', 't.png'), 'outside');
    for (const slot of ['before', 'after']) await linkDir(path.join(fx.dir, 'outside'), path.join(fx.dir, slot, 'tex', 'linked'));
    await assert.rejects(preparePreview(fx.opts), e => e.code === 'E_REF_ESCAPE' && !e.message.includes(fx.dir));
  } finally { await fx.cleanup(); }
});

test('a served file replaced by an escaping link after startup is refused', async t => {
  if (WIN) { t.skip('file symlink creation needs privileges on this Windows host; startup junction escape is covered separately'); return; }
  const fx = await fixture();
  try {
    const prepared = await preparePreview(fx.opts);
    await writeFile(path.join(fx.dir, 'secret.png'), 'outside');
    const texture = path.join(fx.dir, 'before', 'tex', 'texture_00.png');
    await unlink(texture); await symlink(path.join(fx.dir, 'secret.png'), texture);
    await withServer(prepared, async get => { assert.equal((await get('/m/before/r/1.png')).status, 404); });
  } finally { await fx.cleanup(); }
});

test('missing vendor, model, poses or bad inputs fail closed with stable codes and no paths', async () => {
  const fx = await fixture();
  try {
    const cases = [[{core: path.join(fx.dir, 'nope.js')}, 'E_VENDOR_MISSING'], [{pixi: undefined}, 'E_VENDOR_MISSING'], [{live2dDisplay: fx.opts.poses}, 'E_VENDOR_TYPE'],
      [{before: path.join(fx.dir, 'missing.model3.json')}, 'E_MODEL_MISSING'], [{poses: path.join(fx.dir, 'nope.json')}, 'E_POSES_READ']];
    for (const [patch, code] of cases) {
      await assert.rejects(preparePreview({...fx.opts, ...patch}), e => e.code === code && !e.message.includes(fx.dir), code);
    }
    await writeFile(path.join(fx.dir, 'after', 'hiyori.moc3.missing'), '');
    await rm(path.join(fx.dir, 'after', 'hiyori.moc3'));
    await assert.rejects(preparePreview(fx.opts), e => e.code === 'E_REF_MISSING' && e.message.startsWith('E_REF_MISSING: after'));
  } finally { await fx.cleanup(); }
  assert.throws(() => parseCamera({version: 1, zoom: -1}), e => e.code === 'E_CAMERA');
  assert.throws(() => parseCamera({version: 1, crop: {x: 0, y: 0, w: 0, h: 1}}), e => e.code === 'E_CAMERA');
  assert.deepEqual(parseCamera({version: 1, crop: {x: 0.2, y: 0.1, w: 0.3, h: 0.2}}).crop, {x: 0.2, y: 0.1, w: 0.3, h: 0.2});
});

test('CLI: explicit port required, usage/startup errors redacted, --help documents raw-core limits', async () => {
  assert.match(parseArgs(['--before', 'a']).error, /missing/);
  assert.match(parseArgs(['--before=a', '--after=b', '--poses=p', '--core=c', '--pixi=x', '--live2d-display=l', '--port=0']).error, /port/);
  assert.equal(parseArgs(['--/Users/example-private']).error, 'unknown argument (value redacted)');
  const cli = path.join(HERE, '..', 'tools', 'serve-native-preview.mjs');
  const help = spawnSync(process.execPath, [cli, '--help'], {encoding: 'utf8'});
  assert.equal(help.status, 0); assert.match(help.stdout, /Raw Core mode only/);
  const fx = await fixture();
  try {
    const run = spawnSync(process.execPath, [cli, '--before', fx.opts.before, '--after', fx.opts.after, '--poses', fx.opts.poses, '--port', '5199',
      '--core', path.join(fx.dir, 'missing-core.js'), '--pixi', fx.opts.pixi, '--live2d-display', fx.opts.live2dDisplay], {encoding: 'utf8', timeout: 20000});
    assert.equal(run.status, 2); assert.match(run.stderr, /^E_VENDOR_MISSING: core/);
    assert.ok(!run.stderr.includes(fx.dir) && !run.stdout.includes(fx.dir));
  } finally { await fx.cleanup(); }
});

test('preview files reference only same-origin resources and expected routes', async () => {
  const dir = path.join(HERE, '..', 'preview');
  assert.deepEqual((await readdir(dir)).sort(), [...PREVIEW_FILES].sort());
  for (const name of PREVIEW_FILES) {
    const text = await readFile(path.join(dir, name), 'utf8');
    assert.ok(!/https?:\/\//.test(text), `${name} contains an absolute URL`);
    assert.ok(!/(XMLHttpRequest|sendBeacon|WebSocket|getUserMedia|AudioContext|localStorage)/.test(text), `${name} uses a disallowed API`);
  }
  const html = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.deepEqual([...html.matchAll(/src="([^"]+)"/g)].map(m => m[1]), ['/vendor/core.js', '/vendor/pixi.js', '/vendor/pixi-unsafe-eval.js', '/vendor/live2d-display.js', '/app/app.mjs']);
});

test('resolveRequest is total and exact', () => {
  const routes = new Map([['/', {}], ['/app/app.mjs', {}]]);
  for (const [url, status] of [['/', 200], ['/app/app.mjs', 200], ['/app/app.mjs?x=1', 200], ['/app//app.mjs', 404], ['relative', 400], ['//evil/x', 400], ['/%', 400], [undefined, 400]]) {
    assert.equal(resolveRequest(routes, url).status, status, String(url));
  }
});

test('optional pixi-unsafe-eval helper is served as an exact fourth vendor only when configured', async () => {
  const fx = await fixture();
  try {
    const helper = path.join(fx.dir, 'vendor', 'pixi-unsafe-eval-6.5.10.min.js');
    await writeFile(helper, '/* synthetic helper */');
    const prepared = await preparePreview({...fx.opts, pixiUnsafeEval: helper});
    assert.equal(prepared.config.pixiUnsafeEval, true);
    await withServer(prepared, async get => {
      const r = await get('/vendor/pixi-unsafe-eval.js');
      assert.equal(r.status, 200); assert.equal(r.body.toString(), '/* synthetic helper */');
      assert.equal((await get('/vendor/pixi-unsafe-eval-6.5.10.min.js')).status, 404);
    });
    await assert.rejects(preparePreview({...fx.opts, pixiUnsafeEval: path.join(fx.dir, 'none.js')}), e => e.code === 'E_VENDOR_MISSING' && !e.message.includes(fx.dir));
    assert.equal(parseArgs(['--before=a', '--after=b', '--poses=p', '--core=c', '--pixi=x', '--live2d-display=l', '--port=5190', '--pixi-unsafe-eval=u']).pixiUnsafeEval, 'u');
  } finally { await fx.cleanup(); }
});

// ---- review of d6ccb5f: delta gate, shared renderer, ownership -----------------------------
// Fake of pixi-live2d-display 0.4.0's gate: _render runs internalModel.update only when
// deltaTime (grown only by update(dt)) is non-zero, then resets it. Synthetic, not real Pixi.
function gatedModel(internal) {
  return {internalModel: internal, deltaTime: 0, elapsedTime: 0, visible: true, textures: [],
    update(dt) { this.deltaTime += dt; this.elapsedTime += dt; },
    _render() { if (this.deltaTime) { this.internalModel.update(this.deltaTime, this.elapsedTime); this.deltaTime = 0; } }};
}
const fakeRenderer = () => {
  const log = [];
  return {log, view: {id: 'shared-webgl-canvas'}, render(stage) { for (const child of stage.children) if (child.visible) { log.push(child.name); child._render(); } }};
};

test('delta gate: a render WITHOUT update(dt) never applies the pose; renderSlotOnce always does', () => {
  const f = fakeCore(SPEC());
  const state = readDeclaredState(f.core, MOC), raw = f.newModel();
  let applied = {}, pose = {name: 'shoulder-plus1', parameters: {ParamShoulder: 1}};
  const internal = {coreModel: {update() { raw.update(); }}};
  installDeterministicUpdate(internal, raw, state, () => pose, a => { applied = a; });
  const model = Object.assign(gatedModel(internal), {name: 'before'});
  const stage = {children: [model]}, renderer = fakeRenderer();
  renderer.render(stage);
  assert.deepEqual(applied, {}, 'reproduces the reported bug: gate closed, nothing applied');
  const copies = [];
  renderSlotOnce({renderer, stage, records: {before: {model}}, slot: 'before', copy: v => copies.push(v.id)});
  assert.deepEqual(applied, {ParamShoulder: 1}); assert.equal(raw.parameters.values[1], 1);
  assert.deepEqual(copies, ['shared-webgl-canvas']);
  assert.ok(FIXED_UPDATE_MS > 0 && Number.isFinite(FIXED_UPDATE_MS));
  pose = {name: 'default', parameters: {}};
  renderSlotOnce({renderer, stage, records: {before: {model}}, slot: 'before', copy: () => {}});
  assert.deepEqual(applied, {}); assert.equal(raw.parameters.values[1], 0, 'every render re-applies from defaults');
});

test('shared renderer: each slot renders alone and is copied before the next slot draws', () => {
  const f = fakeCore(SPEC());
  const state = readDeclaredState(f.core, MOC);
  const records = {}, children = [], applied = {};
  for (const slot of ['before', 'after']) {
    const raw = f.newModel(), internal = {coreModel: {update() { raw.update(); }}};
    installDeterministicUpdate(internal, raw, state, () => ({name: 'p', parameters: {ParamShoulder: 1}}), a => { applied[slot] = a; });
    const model = Object.assign(gatedModel(internal), {name: slot});
    records[slot] = {model}; children.push(model);
  }
  const renderer = fakeRenderer(), stage = {children}, sequence = [];
  for (const slot of ['before', 'after']) renderSlotOnce({renderer, stage, records, slot, copy: () => sequence.push(`copy:${slot}:${renderer.log.at(-1)}`)});
  assert.deepEqual(renderer.log, ['before', 'after'], 'only the requested slot is visible per render');
  assert.deepEqual(sequence, ['copy:before:before', 'copy:after:after']);
  assert.deepEqual(applied, {before: {ParamShoulder: 1}, after: {ParamShoulder: 1}});
  assert.throws(() => renderSlotOnce({renderer, stage, records: {}, slot: 'before', copy: () => {}}), e => e.code === 'E_RENDER_STATE');
});

test('disposeRecord destroys the model and its textures, purges its URLs, and is idempotent', () => {
  const destroyed = [];
  const texture = name => ({destroy: base => destroyed.push(`${name}:${base}`)});
  const parent = {removed: 0, removeChild() { this.removed++; }};
  const model = {parent, textures: [texture('t0'), texture('t1')], destroy: opts => destroyed.push(`model:${opts.texture && opts.baseTexture}`)};
  const purged = [];
  const record = {model, urls: ['/m/before/r/0.moc3?g=2', '/m/before/r/1.png?g=2']};
  disposeRecord(record, urls => purged.push(...urls));
  disposeRecord(record, urls => purged.push(...urls));
  assert.equal(parent.removed, 1);
  assert.deepEqual(destroyed, ['model:true', 't0:true', 't1:true']);
  assert.deepEqual(purged, record.urls);
  const cache = {'/m/before/r/1.png?g=2': texture('cached'), 'http://127.0.0.1:5190/m/before/r/1.png?g=2': texture('abs'), '/m/after/r/1.png?g=2': texture('keep')};
  assert.equal(purgeTextureCache([cache, null], ['/m/before/r/1.png?g=2'], 'http://127.0.0.1:5190/'), 2);
  assert.deepEqual(Object.keys(cache), ['/m/after/r/1.png?g=2'], 'other slot texture untouched');
  assert.equal(generationUrl('/m/before/r/1.png', 3), '/m/before/r/1.png?g=3');
});

test('owned two-slot loads: success, rejected second slot, stale mid-load and reload invalidation', async () => {
  const entries = [{slot: 'before'}, {slot: 'after'}];
  const disposed = [];
  const dispose = r => disposed.push(r.id);
  // success
  let guard = createLoadGuard(), token = guard.begin();
  const ok = await loadSlotsOwned(entries, {guard, token, dispose, loadOne: async e => ({id: `${e.slot}-${token}`})});
  assert.deepEqual(Object.keys(ok), ['before', 'after']); assert.deepEqual(disposed, []);
  // rejected second slot: the loaded first slot is disposed, the error propagates
  guard = createLoadGuard(); token = guard.begin();
  await assert.rejects(loadSlotsOwned(entries, {guard, token, dispose, loadOne: async e => { if (e.slot === 'after') throw new Error('reject'); return {id: 'before-rejected-run'}; }}), /reject/);
  assert.deepEqual(disposed, ['before-rejected-run']);
  // stale: a reload begins while the first slot loads; the older run disposes what it holds
  disposed.length = 0;
  guard = createLoadGuard();
  const t1 = guard.begin();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const older = loadSlotsOwned(entries, {guard, token: t1, dispose, loadOne: async e => { await gate; return {id: `${e.slot}-old`}; }});
  const t2 = guard.begin();
  const newer = await loadSlotsOwned(entries, {guard, token: t2, dispose, loadOne: async e => ({id: `${e.slot}-new`})});
  release();
  assert.equal(await older, null);
  assert.deepEqual(disposed, ['before-old'], 'old generation disposed; loading stopped before its second slot');
  assert.deepEqual(Object.values(newer).map(r => r.id), ['before-new', 'after-new']);
  // loadOne returning null (its own stale cleanup) aborts and disposes earlier slots
  disposed.length = 0; guard = createLoadGuard(); token = guard.begin();
  assert.equal(await loadSlotsOwned(entries, {guard, token, dispose, loadOne: async e => e.slot === 'after' ? null : {id: 'before-x'}}), null);
  assert.deepEqual(disposed, ['before-x']);
});

test('per-generation URLs still resolve to the exact served routes', async () => {
  const fx = await fixture();
  try {
    const prepared = await preparePreview(fx.opts);
    assert.equal(resolveRequest(prepared.routes, generationUrl('/m/before/r/1.png', 7)).status, 200);
    assert.equal(resolveRequest(prepared.routes, generationUrl('/m/before/r/9.png', 7)).status, 404);
  } finally { await fx.cleanup(); }
});

test('pose file errors reach pose validation (isolated fixture) and malformed IDs never reach /config.json', async () => {
  const cases = [
    [{version: 1, poses: [{name: 'default', parameters: {ParamShoulder: 1}}]}, 'E_POSE_NAME', 'E_POSE_NAME: poses default: invalid or reserved name'],
    [{version: 1, poses: [{name: 'p', parameters: {'/Users/example-private/x': 1}}]}, 'E_POSE_PARAM_ID', 'E_POSE_PARAM_ID: pose p: malformed parameter id (value redacted)'],
    [{version: 1, poses: [{name: 'p', parameters: {'C:\\Users\\example-private': 1}}]}, 'E_POSE_PARAM_ID', 'E_POSE_PARAM_ID: pose p: malformed parameter id (value redacted)'],
    [{version: 1, poses: [{name: 'p', parameters: {'https://example.invalid/x': 1}}]}, 'E_POSE_PARAM_ID', 'E_POSE_PARAM_ID: pose p: malformed parameter id (value redacted)'],
    [{version: 1, poses: [{name: 'p', parameters: {ParamShoulder: '1'}}]}, 'E_POSE_VALUE', 'E_POSE_VALUE: poses p: non-finite value for ParamShoulder'],
  ];
  for (const [poses, code, message] of cases) {
    const fx = await fixture(); // every model file present: only the pose file is wrong
    try {
      await writeFile(fx.opts.poses, JSON.stringify(poses));
      const first = await preparePreview(fx.opts).then(() => null, e => e);
      const second = await preparePreview(fx.opts).then(() => null, e => e);
      assert.equal(first?.code, code, JSON.stringify(poses));
      assert.equal(first.message, message, 'exact, deterministic message');
      assert.equal(second.message, first.message);
      assert.ok(!first.message.includes('example-private') && !first.message.includes(fx.dir));
    } finally { await fx.cleanup(); }
  }
  const fx = await fixture();
  try {
    const legal = {ParamAngleX: -30, ParamShoulder: 1, 'Param_Arm.L-2': 0.5};
    await writeFile(fx.opts.poses, JSON.stringify({version: 1, poses: [{name: 'legal', parameters: legal}]}));
    const prepared = await preparePreview(fx.opts);
    assert.deepEqual(prepared.config.poses[1].parameters, {'Param_Arm.L-2': 0.5, ParamAngleX: -30, ParamShoulder: 1}, 'legal SDK IDs preserved');
  } finally { await fx.cleanup(); }
});
