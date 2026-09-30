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
import {readDeclaredState, validatePoseForModel, applyPose, installDeterministicUpdate, partOpacityDiff, topologyNotes, deriveCamera, cropToView, parsePosesV2, poseForSlot, sharedPosesAsModels, partOpacities, sdkPoseSettleSeconds, checkPosePartIds, posePartIdsFromCubismPose} from '../preview/pose-core.mjs';
import {compareReports, runAudit} from '../src/export-audit.mjs';
import {createLoadGuard} from '../preview/load-guard.mjs';
import {renderSlotOnce, disposeRecord, loadSlotsOwned, loadOwnedModel, purgeTextureCache, generationUrl, FIXED_UPDATE_MS, watchSdkPose, requireSdkPose, installOrDispose} from '../preview/render-step.mjs';

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
  assert.equal(help.status, 0); assert.match(help.stdout, /--mode raw-core \(default\)/); assert.match(help.stdout, /--mode sdk-pose/);
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

test('disposeRecord destroys model and textures once, skips already-destroyed cache entries, and is idempotent', async () => {
  const destroyed = [];
  const texture = name => ({name, destroy: base => destroyed.push(`${name}:${base}`)});
  const parent = {removed: 0, removeChild() { this.removed++; }};
  const t0 = texture('t0'), t1 = texture('t1');
  const model = {parent, internalModel: {}, textures: [t0, t1], destroy: opts => destroyed.push(`model:${opts.children}`)};
  const purged = [];
  const record = {model, textures: new Set([t0]), textureTasks: [], urls: ['/m/before/r/0.moc3?g=2', '/m/before/r/1.png?g=2']};
  const cache = {'/m/before/r/1.png?g=2': t1, 'http://127.0.0.1:5190/m/before/r/1.png?g=2': texture('abs'), '/m/after/r/1.png?g=2': texture('keep')};
  const purge = (urls, skip) => { purged.push(...urls); purgeTextureCache([cache, null], urls, 'http://127.0.0.1:5190/', skip); };
  await Promise.all([disposeRecord(record, {purge}), disposeRecord(record, {purge})]);
  assert.equal(parent.removed, 1);
  assert.deepEqual(destroyed.sort(), ['abs:true', 'model:true', 't0:true', 't1:true'], 'each destroyed exactly once (t1 was both owned and cached)');
  assert.deepEqual(model.textures, [], 'wrapper will not destroy the textures again');
  assert.deepEqual(purged, record.urls);
  assert.deepEqual(Object.keys(cache), ['/m/after/r/1.png?g=2'], 'other slot texture untouched');
  assert.equal(generationUrl('/m/before/r/1.png', 3), '/m/before/r/1.png?g=3');
});

// ---- explicit ownership of Live2DModel setup (fake of the 0.4.0 wrapper; not real Pixi) ----
function fakePixi({script}) {
  const log = [];
  const count = key => { log.push(key); };
  class FakeTexture {
    constructor(url, kind) { this.url = url; this.kind = kind; this.destroyed = 0; }
    destroy() { this.destroyed++; count(`texture:${this.kind}:${this.url}`); }
  }
  class Live2DModel {
    constructor(options) { this.options = options; this.listeners = {}; this.textures = []; this.internalModel = null; this.autoUpdate = true; this.unregistered = 0; this.containerDestroyed = 0; this.destroyed = 0; }
    once(event, fn) { this.listeners[event] = fn; }
    emit(event, arg) { const fn = this.listeners[event]; delete this.listeners[event]; fn?.(arg); if (event === 'destroy') count('model:destroy-event'); }
    unregisterInteraction() { this.unregistered++; }
    destroy() { this.destroyed++; if (this.internalModel) { this.internalModel.coreReleased++; count('core:released'); } count('model:destroy'); }
  }
  const PIXI = {
    live2d: {Live2DModel, Live2DFactory: {setupLive2DModel: (model, settings, options) => script(model, settings, options, {FakeTexture})}},
    Texture: {from: (url, opts, strict) => new FakeTexture(url, `from:${opts.resourceOptions.autoLoad}:${strict}`),
      fromURL: url => PIXI.fetchImage(url).then(() => new FakeTexture(url, 'loaded'))},
    fetchImage: () => Promise.resolve(),
    Container: {prototype: {destroy() { this.containerDestroyed++; count('container:destroy'); }}},
  };
  return {PIXI, log};
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emitSettings = (model, urls) => model.emit('settingsLoaded', {textures: urls, resolveURL: f => f});
const ownedDispose = PIXI => record => disposeRecord(record, {containerDestroy: PIXI.Container.prototype.destroy, purge: () => {}});

test('delayed second-texture failure after partial Core creation: all owned resources disposed once, other generation untouched', async () => {
  const urlsG1 = ['/m/before/r/1.png?g=1', '/m/before/r/2.png?g=1'];
  const {PIXI, log} = fakePixi({script: async (model, settings) => {
    emitSettings(model, settings.FileReferences.Textures);
    model.internalModel = {coreReleased: 0}; // Core/moc created before textures finish
    await delay(15);
    throw new Error('texture 2 failed');
  }});
  PIXI.fetchImage = url => url.endsWith('2.png?g=1') ? delay(10).then(() => { throw new Error('404'); }) : delay(5);
  const other = {model: null, textures: new Set([{destroyed: 0, destroy() { this.destroyed++; }}]), textureTasks: [], urls: ['/m/before/r/1.png?g=2']};
  let captured = null;
  const dispose = record => { captured = record; return ownedDispose(PIXI)(record); };
  await assert.rejects(loadOwnedModel({PIXI, settings: {FileReferences: {Textures: urlsG1}}, options: {}, urls: urlsG1, isCurrent: () => true, dispose}), /texture 2 failed/);
  assert.equal(captured.model.internalModel.coreReleased, 1, 'partial Core released once');
  assert.equal(captured.model.destroyed, 1);
  // owned: two autoLoad:false textures + one successfully loaded image; the failed image created none
  const destroyedTextures = log.filter(l => l.startsWith('texture:')).sort();
  assert.deepEqual(destroyedTextures, ['texture:from:false:false:/m/before/r/1.png?g=1', 'texture:from:false:false:/m/before/r/2.png?g=1', 'texture:loaded:/m/before/r/1.png?g=1']);
  for (const t of captured.textures) assert.equal(t.destroyed, 1);
  assert.equal([...other.textures][0].destroyed, 0, 'other generation untouched');
  await ownedDispose(PIXI)(captured);
  assert.equal(log.filter(l => l === 'core:released').length, 1, 'second dispose is a no-op');
});

test('setup rejecting before any internal model: emit destroy, stop updates, unregister interaction, container destroy', async () => {
  const {PIXI, log} = fakePixi({script: async () => { throw new Error('moc fetch failed'); }});
  let captured = null;
  const dispose = record => { captured = record; return ownedDispose(PIXI)(record); };
  await assert.rejects(loadOwnedModel({PIXI, settings: {}, options: {}, urls: [], isCurrent: () => true, dispose}), /moc fetch failed/);
  const m = captured.model;
  assert.equal(m.destroyed, 0); assert.equal(m.containerDestroyed, 1); assert.equal(m.unregistered, 1); assert.equal(m.autoUpdate, false);
  assert.deepEqual(log, ['model:destroy-event', 'container:destroy']);
});

test('stale generation with a late image completion: disposed after setup, late texture destroyed exactly once', async () => {
  const urls = ['/m/after/r/1.png?g=4'];
  let releaseImage;
  const imageGate = new Promise(resolve => { releaseImage = resolve; });
  const {PIXI, log} = fakePixi({script: async (model, settings) => {
    emitSettings(model, settings.FileReferences.Textures);
    model.internalModel = {coreReleased: 0};
    model.textures = [new (class { destroy() { log.push('texture:wrapper'); } })()];
  }});
  PIXI.fetchImage = () => imageGate;
  const guard = createLoadGuard();
  const token = guard.begin();
  let captured = null;
  const dispose = record => { captured = record; return ownedDispose(PIXI)(record); };
  const pending = loadOwnedModel({PIXI, settings: {FileReferences: {Textures: urls}}, options: {}, urls, isCurrent: () => guard.isCurrent(token), dispose});
  guard.begin(); // a reload supersedes this generation
  await delay(5);
  assert.equal(log.length, 0, 'disposal waits for the pending image work');
  releaseImage();
  assert.equal(await pending, null);
  assert.equal(captured.model.internalModel.coreReleased, 1);
  assert.deepEqual(log.filter(l => l.startsWith('texture:')).sort(), ['texture:from:false:false:/m/after/r/1.png?g=4', 'texture:loaded:/m/after/r/1.png?g=4', 'texture:wrapper']);
});

test('successful current setup returns the owned record without disposing anything', async () => {
  const urls = ['/m/before/r/1.png?g=5'];
  const {PIXI, log} = fakePixi({script: async (model, settings) => { emitSettings(model, settings.FileReferences.Textures); model.internalModel = {coreReleased: 0}; }});
  const record = await loadOwnedModel({PIXI, settings: {FileReferences: {Textures: urls}}, options: {autoUpdate: false}, urls, isCurrent: () => true, dispose: ownedDispose(PIXI)});
  await Promise.allSettled(record.textureTasks);
  assert.equal(record.model.options.autoUpdate, false);
  assert.equal(record.textures.size, 2); assert.deepEqual(log, []);
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
    const expected = {'Param_Arm.L-2': 0.5, ParamAngleX: -30, ParamShoulder: 1};
    assert.equal(prepared.config.posesVersion, 1);
    assert.deepEqual(prepared.config.poses[1].models, {before: {parameters: expected}, after: {parameters: expected}}, 'legal SDK IDs preserved; v1 values shared by both models');
  } finally { await fx.cleanup(); }
});

// ---- v2 per-model poses (preview only) ------------------------------------------------------
const V2 = poses => ({version: 2, poses});
const AFTER_ONLY = {name: 'raise-overhead', models: {before: {parameters: {}}, after: {parameters: {ParamArmRaiseR: 1}}}};
const PROBE_SPEC = () => { const s = SPEC(); s.params.push({id: 'ParamArmRaiseR', min: 0, max: 1, default: 0}); return s; };

test('v2 parsing: both branches required; unknown fields, IDs, non-finite values rejected with redacted deterministic messages', () => {
  assert.deepEqual(parsePosesV2(V2([AFTER_ONLY])), [{name: 'raise-overhead', version: 2, models: {before: {parameters: {}}, after: {parameters: {ParamArmRaiseR: 1}}}}]);
  const bad = [
    [V2([{name: 'x', models: {after: {parameters: {}}}}]), 'E_POSES_SCHEMA', 'pose x: missing model branch before'],
    [V2([{name: 'x', models: {before: {parameters: {}}}}]), 'E_POSES_SCHEMA', 'pose x: missing model branch after'],
    [V2([{name: 'x', models: {before: {parameters: {}}, after: {parameters: {}}, middle: {parameters: {}}}}]), 'E_POSES_SCHEMA', 'pose x: unknown model branch middle'],
    [V2([{name: 'x', models: {before: {parameters: {}, extra: 1}, after: {parameters: {}}}}]), 'E_POSES_SCHEMA', 'pose x.before: unknown key extra'],
    [V2([{name: 'x', parameters: {}, models: {before: {parameters: {}}, after: {parameters: {}}}}]), 'E_POSES_SCHEMA', 'pose[0]: unknown key parameters'],
    [{version: 2, poses: [], note: 1}, 'E_POSES_SCHEMA', 'unknown key note'],
    [V2([{name: 'x', models: {before: {}, after: {parameters: {}}}}]), 'E_POSES_SCHEMA', 'pose x.before: parameters must be an object'],
    [V2([{name: 'x', models: {before: {parameters: {}}, after: {parameters: {'/Users/example-private/p': 1}}}}]), 'E_POSE_PARAM_ID', 'pose x.after: malformed parameter id (value redacted)'],
    [V2([{name: 'x', models: {before: {parameters: {}}, after: {parameters: {ParamArmRaiseR: Infinity}}}}]), 'E_POSE_VALUE', 'pose x.after: non-finite value for ParamArmRaiseR'],
    [V2([{name: 'x', models: {before: {parameters: {}}, after: {parameters: {ParamArmRaiseR: '1'}}}}]), 'E_POSE_VALUE', 'pose x.after: non-finite value for ParamArmRaiseR'],
    [V2([{name: 'default', models: {before: {parameters: {}}, after: {parameters: {}}}}]), 'E_POSE_NAME', 'pose[0]: invalid or reserved name'],
    [V2([AFTER_ONLY, AFTER_ONLY]), 'E_POSE_NAME', 'pose raise-overhead: duplicate name'],
    [V2(Array.from({length: 13}, (_, i) => ({...AFTER_ONLY, name: `p${i}`}))), 'E_POSES_SCHEMA', 'at most 12 poses'],
  ];
  for (const [json, code, detail] of bad) {
    const e1 = (() => { try { parsePosesV2(json); } catch (e) { return e; } })();
    const e2 = (() => { try { parsePosesV2(json); } catch (e) { return e; } })();
    assert.equal(e1?.code, code, detail); assert.equal(e1.detail, detail); assert.equal(e2.message, e1.message);
    assert.ok(!e1.message.includes('example-private'));
  }
});

test('v2 per-slot validation: after-only new ID works; a typo or new ID on the old model still fails; v1 stays shared', () => {
  const original = readDeclaredState(fakeCore(SPEC()).core, MOC), probe = readDeclaredState(fakeCore(PROBE_SPEC()).core, MOC);
  const [pose] = parsePosesV2(V2([AFTER_ONLY]));
  assert.doesNotThrow(() => validatePoseForModel(poseForSlot(pose, 'before'), original));
  assert.doesNotThrow(() => validatePoseForModel(poseForSlot(pose, 'after'), probe));
  const [typo] = parsePosesV2(V2([{name: 't', models: {before: {parameters: {}}, after: {parameters: {ParamArmRaizeR: 1}}}}]));
  assert.throws(() => validatePoseForModel(poseForSlot(typo, 'after'), probe), e => e.code === 'E_POSE_UNKNOWN_PARAM' && e.detail === 't: unknown parameter ParamArmRaizeR');
  const [wrongSide] = parsePosesV2(V2([{name: 'w', models: {before: {parameters: {ParamArmRaiseR: 1}}, after: {parameters: {}}}}]));
  assert.throws(() => validatePoseForModel(poseForSlot(wrongSide, 'before'), original), e => e.code === 'E_POSE_UNKNOWN_PARAM');
  const [range] = parsePosesV2(V2([{name: 'r', models: {before: {parameters: {}}, after: {parameters: {ParamArmRaiseR: 1.5}}}}]));
  assert.throws(() => validatePoseForModel(poseForSlot(range, 'after'), probe), e => e.code === 'E_POSE_RANGE');
  // v1 shared poses: identical branches; a v1 pose using the new ID fails on the old model (unchanged behaviour)
  const [shared] = sharedPosesAsModels([{name: 's', parameters: {ParamArmRaiseR: 1}}]);
  assert.deepEqual(poseForSlot(shared, 'before'), poseForSlot(shared, 'after'));
  assert.throws(() => validatePoseForModel(poseForSlot(shared, 'before'), original), e => e.code === 'E_POSE_UNKNOWN_PARAM');
  const [oldShared] = sharedPosesAsModels([{name: 'shrug', parameters: {ParamShoulder: 1}}]);
  for (const [slot, state] of [['before', original], ['after', probe]]) assert.doesNotThrow(() => validatePoseForModel(poseForSlot(oldShared, slot), state));
  assert.throws(() => poseForSlot({name: 'z', models: {before: {parameters: {}}}}, 'after'), e => e.code === 'E_POSES_SCHEMA');
});

test('v2 pose changes reset every parameter and part opacity per slot (the empty branch is the all-default baseline)', () => {
  const f = fakeCore(PROBE_SPEC());
  const probe = readDeclaredState(f.core, MOC), raw = f.newModel();
  const [raise] = parsePosesV2(V2([AFTER_ONLY]));
  const [shrug] = sharedPosesAsModels([{name: 'shrug', parameters: {ParamShoulder: 1}}]);
  let current = shrug, applied = null;
  const internal = {coreModel: {update() { raw.update(); }}};
  installDeterministicUpdate(internal, raw, probe, () => poseForSlot(current, 'after'), a => { applied = a; });
  internal.update();
  assert.deepEqual(Array.from(raw.parameters.values), [0, 1, 0.5, 0]);
  raw.parts.opacities[1] = 1; // e.g. a stale write
  current = raise; internal.update();
  assert.deepEqual(applied, {ParamArmRaiseR: 1});
  assert.deepEqual(Array.from(raw.parameters.values), [0, 0, 0.5, 1], 'ParamShoulder from the previous pose was reset');
  assert.deepEqual(partOpacityDiff(raw, probe), []);
  const beforeRaw = fakeCore(SPEC()).newModel(), original = readDeclaredState(fakeCore(SPEC()).core, MOC);
  assert.deepEqual(applyPose(beforeRaw, original, poseForSlot(raise, 'before')), {});
  assert.deepEqual(Array.from(beforeRaw.parameters.values), [0, 0, 0.5], 'before branch: declared defaults only');
});

test('server: v2 file reaches /config.json per slot; v1 unchanged; invalid v2 fails closed', async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.opts.poses, JSON.stringify(V2([AFTER_ONLY])));
    const prepared = await preparePreview(fx.opts);
    assert.equal(prepared.config.posesVersion, 2);
    assert.deepEqual(prepared.config.poses.map(p => [p.name, p.models.before.parameters, p.models.after.parameters]),
      [['default', {}, {}], ['raise-overhead', {}, {ParamArmRaiseR: 1}]]);
    await writeFile(fx.opts.poses, JSON.stringify(V2([{name: 'x', models: {after: {parameters: {}}}}])));
    await assert.rejects(preparePreview(fx.opts), e => e.code === 'E_POSES_SCHEMA' && e.message === 'E_POSES_SCHEMA: pose x: missing model branch before');
    await writeFile(fx.opts.poses, JSON.stringify({version: 1, poses: [{name: 'x', parameters: {}}]}));
    await assert.rejects(preparePreview(fx.opts), e => e.code === 'E_POSES_SCHEMA', 'v1 still requires at least one parameter');
  } finally { await fx.cleanup(); }
});

test('audit stays strict: v2 files are refused and differing pose inputs never become editProof', async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.opts.poses, JSON.stringify(V2([AFTER_ONLY])));
    const r = await runAudit({modelPath: fx.opts.before, outPath: path.join(fx.dir, 'report-v2.json'), posesPath: fx.opts.poses, loadCore: async () => ({core: {}, sha256: 'x'})});
    assert.equal(r.exitCode, 2); assert.equal(r.report.errors[0].code, 'E_POSES_SCHEMA');
  } finally { await fx.cleanup(); }
  const report = (poses, moc) => ({schema: 'hiyori-cubism-export-audit/1', status: 'ok', core: {sha256: 'c', version: {raw: 1}}, structure: {signature: 's'},
    references: [{kind: 'moc', sha256: moc}], poses: poses.map(([name, parameters, geo]) => ({name, parameters, drawables: [{id: 'ArtMeshArm', geometrySha: geo, bbox: null, opacity: 1, renderOrder: 0}]}))});
  const original = report([['default', {}, 'g0'], ['shrug', {ParamShoulder: 1}, 'g1']], 'm0');
  const probe = report([['default', {}, 'g0'], ['raise', {ParamArmRaiseR: 1}, 'g9']], 'm1');
  const c = compareReports(probe, original);
  assert.equal(c.classification, 'incompatible'); assert.equal(c.editProof, false);
  const sameInputs = compareReports(report([['default', {}, 'g0'], ['shrug', {ParamShoulder: 1}, 'g1']], 'm1'), original);
  assert.equal(sameInputs.classification, 'bytes-changed-poses-identical', 'shared old poses unchanged: comparable, no editProof');
  assert.equal(sameInputs.editProof, false);
});

// ---- sdk-pose mode (synthetic: fake pose3 files, fake CubismPose; not real SDK rendering) --------
const POSE3 = {Type: 'Live2D Pose', FadeInTime: 0.5, Groups: [[{Id: 'PartArmA', Link: []}, {Id: 'PartArmB', Link: []}]]};
async function poseFixture(pose = POSE3, ref = 'hiyori.pose3.json') {
  const fx = await fixture({extraModel: {Pose: ref}});
  for (const slot of ['before', 'after']) await writeFile(path.join(fx.dir, slot, 'hiyori.pose3.json'), typeof pose === 'string' ? pose : JSON.stringify(pose));
  return fx;
}

test('mode argument: raw-core by default, sdk-pose explicit, anything else refused', async () => {
  const base = ['--before=a', '--after=b', '--poses=p', '--core=c', '--pixi=x', '--live2d-display=l', '--port=5190'];
  assert.equal(parseArgs(base).mode, 'raw-core');
  assert.equal(parseArgs([...base, '--mode', 'sdk-pose']).mode, 'sdk-pose');
  assert.match(parseArgs([...base, '--mode=sdk_pose']).error, /--mode must be one of raw-core, sdk-pose/);
  const fx = await fixture();
  try {
    await assert.rejects(preparePreview({...fx.opts, mode: 'pose'}), e => e.code === 'E_MODE');
    const raw = await preparePreview(fx.opts);
    assert.equal(raw.config.mode, 'raw-core'); assert.equal(raw.config.models[0].pose, null);
  } finally { await fx.cleanup(); }
});

test('sdk-pose serves only the model3 Pose besides Moc/Textures; raw-core never serves it', async () => {
  const fx = await poseFixture();
  try {
    const prepared = await preparePreview({...fx.opts, mode: 'sdk-pose'});
    assert.equal(prepared.config.mode, 'sdk-pose');
    assert.deepEqual(prepared.config.models.map(m => [m.pose, m.poseGroupEntries]), [['/m/before/r/2.json', 2], ['/m/after/r/2.json', 2]]);
    assert.deepEqual(prepared.config.models[0].posePartIds, {groups: [['PartArmA', 'PartArmB']], links: []});
    await withServer(prepared, async get => {
      const r = await get('/m/after/r/2.json?g=3');
      assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).Groups[0][1].Id, 'PartArmB');
      assert.equal(r.headers['cache-control'], 'no-store'); assert.match(r.headers['content-security-policy'], /default-src 'none'/);
      for (const bad of ['/m/before/hiyori.physics3.json', '/m/before/r/3.json', '/m/before/hiyori.pose3.json']) assert.equal((await get(bad)).status, 404, bad);
    });
    assert.ok(!JSON.stringify(prepared.config).includes(fx.dir));
    const raw = await preparePreview(fx.opts); // same model3 files, default mode
    assert.ok(![...raw.routes.keys()].some(u => u.endsWith('.json') && u.startsWith('/m/')), 'raw-core: Pose not served');
  } finally { await fx.cleanup(); }
});

test('sdk-pose fails closed: missing Pose (either slot), invalid JSON, bad schema, URL/absolute/escaping refs', async () => {
  let fx = await fixture();
  try { await assert.rejects(preparePreview({...fx.opts, mode: 'sdk-pose'}), e => e.code === 'E_POSE_FILE_MISSING' && e.message.includes('before')); }
  finally { await fx.cleanup(); }
  fx = await poseFixture();
  try {
    const m = JSON.parse(await readFile(fx.opts.after, 'utf8')); delete m.FileReferences.Pose;
    await writeFile(fx.opts.after, JSON.stringify(m));
    await assert.rejects(preparePreview({...fx.opts, mode: 'sdk-pose'}), e => e.code === 'E_POSE_FILE_MISSING' && e.message.startsWith('E_POSE_FILE_MISSING: after'));
  } finally { await fx.cleanup(); }
  for (const [pose, code] of [['{not json', 'E_POSE_FILE_JSON'], [{Groups: []}, 'E_POSE_FILE_SCHEMA'], [{Groups: [[{Link: []}]]}, 'E_POSE_FILE_SCHEMA'], [{FadeInTime: 'x', Groups: [[{Id: 'A'}]]}, 'E_POSE_FILE_SCHEMA']]) {
    fx = await poseFixture(pose);
    try { await assert.rejects(preparePreview({...fx.opts, mode: 'sdk-pose'}), e => e.code === code && !e.message.includes(fx.dir), code); }
    finally { await fx.cleanup(); }
  }
  for (const ref of ['https://example.invalid/p.pose3.json', '/Users/example-private/p.pose3.json', '../outside.pose3.json']) {
    fx = await poseFixture(POSE3, ref);
    try { await assert.rejects(preparePreview({...fx.opts, mode: 'sdk-pose'}), e => /^E_REF_/.test(e.code) && !e.message.includes('example-private') && !e.message.includes(fx.dir), ref); }
    finally { await fx.cleanup(); }
  }
});

test('SDK Pose load failures never count as sdk-pose success', () => {
  const model = () => { const l = {}; return {once(e, f) { l[e] = f; }, fire(e) { l[e]?.(); }}; };
  const pose = {reset() {}, updateParameters() {}};
  let m = model(), status = watchSdkPose(m, true); m.fire('poseLoadError');
  assert.throws(() => requireSdkPose({pose}, status), e => e.code === 'E_SDK_POSE_UNAVAILABLE' && /poseLoadError/.test(e.detail));
  m = model(); status = watchSdkPose(m, true);
  assert.throws(() => requireSdkPose({pose}, status), e => e.code === 'E_SDK_POSE_UNAVAILABLE' && /not emitted/.test(e.detail));
  m = model(); status = watchSdkPose(m, true); m.fire('poseLoaded');
  assert.throws(() => requireSdkPose({pose: {reset() {}}}, status), e => e.code === 'E_SDK_POSE_UNAVAILABLE');
  assert.throws(() => requireSdkPose({}, status), e => e.code === 'E_SDK_POSE_UNAVAILABLE');
  assert.equal(requireSdkPose({pose}, status), pose);
  assert.deepEqual(watchSdkPose(model(), false), {requested: false, loaded: false, error: false, ran: 0});
  const f = fakeCore(SPEC()); const state = readDeclaredState(f.core, MOC);
  assert.throws(() => installDeterministicUpdate({coreModel: {}}, f.newModel(), state, () => ({name: 'd', parameters: {}}), () => {}, {sdkPose: {}}), e => e.code === 'E_SDK_POSE_UNAVAILABLE');
});

// A fake CubismPose that follows the pinned framework's reset/updateParameters/doFade rules for
// one group, with its switch values held OUTSIDE the raw Core arrays (framework-side), as for
// part IDs that are not real parameters.
function fakeCubismPose(log, fadeSeconds = 0.5, rig = null) {
  // Switch values: a real parameter with the part's ID when the moc3 has one (read/written in
  // the raw Core arrays), otherwise a framework-side value - as in the pinned CubismPose.
  const sw = {PartArmA: 0, PartArmB: 0};
  const getSwitch = (model, id) => rig?.hasParam(id) ? rig.param(id) : sw[id];
  const setSwitch = (model, id, v) => { if (rig?.hasParam(id)) rig.setParam(id, v); else sw[id] = v; };
  return {
    _lastModel: undefined, _fadeTimeSeconds: fadeSeconds, parts: ['PartArmA', 'PartArmB'],
    _partGroups: [{partId: 'PartArmA', link: []}, {partId: 'PartArmB', link: []}], _partGroupCounts: [2],
    reset(model) { log.push('reset'); this.parts.forEach((id, j) => { model.setPartOpacity(id, j === 0 ? 1 : 0); setSwitch(model, id, j === 0 ? 1 : 0); }); },
    updateParameters(model, dt) {
      log.push(`update:${this._lastModel === model ? 'same' : 'hidden-reset'}:${dt}`);
      if (model !== this._lastModel) this.reset(model);
      this._lastModel = model;
      let visible = this.parts.findIndex(id => getSwitch(model, id) > 0.001), next = 1;
      if (visible >= 0) next = Math.min(1, model.getPartOpacity(this.parts[visible]) + dt / this._fadeTimeSeconds); else visible = 0;
      this.parts.forEach((id, i) => {
        if (i === visible) model.setPartOpacity(id, next);
        else {
          let a1 = next < 0.5 ? next * (0.5 - 1) / 0.5 + 1 : (1 - next) * 0.5 / 0.5;
          if ((1 - a1) * (1 - next) > 0.15) a1 = 1 - 0.15 / (1 - next);
          model.setPartOpacity(id, Math.min(model.getPartOpacity(id), a1));
        }
      });
    },
  };
}
function sdkPoseRig(log, spec = PROBE_SPEC()) {
  const f = fakeCore(spec);
  const state = readDeclaredState(f.core, MOC), raw = f.newModel();
  const idx = id => state.parts.findIndex(p => p.id === id);
  const coreModel = {
    setPartOpacity(id, v) { raw.parts.opacities[idx(id)] = v; }, getPartOpacity(id) { return raw.parts.opacities[idx(id)]; },
    update() { log.push(`core:${Array.from(raw.parts.opacities).join(',')}:${Array.from(raw.parameters.values).join(',')}`); raw.update(); },
  };
  const pidx = id => state.parameters.findIndex(q => q.id === id);
  const rig = {hasParam: id => pidx(id) >= 0, param: id => raw.parameters.values[pidx(id)], setParam: (id, v) => { raw.parameters.values[pidx(id)] = v; }};
  return {state, raw, coreModel, rig};
}

test('sdk-pose order: declared reset + named values, CubismPose.reset, named re-applied, no hidden reset, settled update, Core update', () => {
  const log = [];
  const {state, raw, coreModel} = sdkPoseRig(log);
  const sdkPose = fakeCubismPose(log);
  const origReset = sdkPose.reset.bind(sdkPose);
  sdkPose.reset = model => { log.push(`named-before-reset:${raw.parameters.values[3]}`); origReset(model); raw.parameters.values[3] = 0; }; // a reset that clobbers a named value
  let applied = null, steps = 0;
  const internal = {coreModel};
  installDeterministicUpdate(internal, raw, state, () => ({name: 'raise', parameters: {ParamArmRaiseR: 1}}), a => { applied = a; }, {sdkPose, onPoseStep: () => { steps++; }});
  raw.parts.opacities[1] = 0.7; raw.parameters.values[1] = 1; // stale state from a previous pose
  internal.update();
  assert.deepEqual(log, ['named-before-reset:1', 'reset', 'update:same:1', 'core:1,0:0,0,0.5,1'], 'settle = 2 x the pose fade time (0.5 s)');
  assert.deepEqual(applied, {ParamArmRaiseR: 1}, 'explicit value re-applied after the pose switch reset');
  assert.equal(steps, 1);
  assert.deepEqual(partOpacities(raw, state), {PartArmA: 1, PartArmB: 0}, 'one arm set visible after the settled SDK fade');
});

test('sdk-pose repeated selection is path independent (A, B, A equals A fresh; first render equals later ones)', () => {
  const render = sequence => {
    const log = [];
    const {state, raw, coreModel} = sdkPoseRig(log);
    const sdkPose = fakeCubismPose(log);
    let current;
    const internal = {coreModel};
    installDeterministicUpdate(internal, raw, state, () => current, () => {}, {sdkPose});
    const snaps = [];
    for (const pose of sequence) { current = pose; internal.update(); snaps.push([Array.from(raw.parameters.values), Array.from(raw.parts.opacities)]); }
    return snaps;
  };
  const A = {name: 'a', parameters: {ParamArmRaiseR: 1}}, B = {name: 'b', parameters: {ParamShoulder: 1, ParamAngleX: -20}};
  const fresh = render([A])[0];
  const path = render([A, B, A, A]);
  assert.deepEqual(path[2], fresh); assert.deepEqual(path[3], fresh); assert.deepEqual(path[0], fresh);
  assert.deepEqual(render([B, A])[1], fresh);
});

test('raw-core compatibility: no pose object is touched and the update order is unchanged', () => {
  const log = [];
  const {state, raw, coreModel} = sdkPoseRig(log);
  const internal = {coreModel};
  installDeterministicUpdate(internal, raw, state, () => ({name: 'r', parameters: {ParamArmRaiseR: 1}}), () => {});
  raw.parts.opacities[1] = 0.7;
  internal.update();
  assert.deepEqual(log, ['core:1,0.25:0,0,0.5,1'], 'raw Core: declared part opacities kept, no SDK Pose step');
});

// ---- review of 06743ea -----------------------------------------------------------------------------
test('pose group part IDs must exist in the moc3 (config and loaded-pose checks)', () => {
  const state = readDeclaredState(fakeCore(SPEC()).core, MOC); // parts: PartArmA, PartArmB
  assert.doesNotThrow(() => checkPosePartIds({groups: [['PartArmA', 'PartArmB']], links: []}, state));
  assert.throws(() => checkPosePartIds({groups: [['PartArmA', 'PartArmBx']], links: []}, state),
    e => e.code === 'E_POSE_PART_UNKNOWN' && e.detail === 'pose group 0: part PartArmBx is not a part of this moc3');
  assert.throws(() => checkPosePartIds({groups: [], links: []}, state), e => e.code === 'E_POSE_PART_UNKNOWN');
  // what the SDK actually loaded: an ArmB group entry that the export forgot
  const loaded = posePartIdsFromCubismPose({_partGroups: [{partId: 'PartArmA', link: []}, {partId: 'PartArmMissing', link: []}], _partGroupCounts: [2]});
  assert.deepEqual(loaded, {groups: [['PartArmA', 'PartArmMissing']], links: []});
  assert.throws(() => checkPosePartIds(loaded, state), e => e.code === 'E_POSE_PART_UNKNOWN' && /PartArmMissing/.test(e.detail));
  assert.equal(posePartIdsFromCubismPose({}), null);
});

test('pose Link part IDs must exist in the moc3', () => {
  const state = readDeclaredState(fakeCore(SPEC()).core, MOC);
  assert.throws(() => checkPosePartIds({groups: [['PartArmA', 'PartArmB']], links: [{from: 'PartArmB', to: 'PartArmBLeft'}]}, state),
    e => e.code === 'E_POSE_PART_UNKNOWN' && e.detail === 'pose link from PartArmB: part PartArmBLeft is not a part of this moc3');
  const loaded = posePartIdsFromCubismPose({_partGroups: [{partId: 'PartArmA', link: [{partId: 'PartArmA'}]}, {partId: 'PartArmB', link: [{partId: 'NoSuchPart'}]}], _partGroupCounts: [2]});
  assert.throws(() => checkPosePartIds(loaded, state), e => e.code === 'E_POSE_PART_UNKNOWN' && /NoSuchPart/.test(e.detail));
});

test('settle follows the real pose fade time: FadeInTime above 1000 s with a switch to the second part fully settles', () => {
  const spec = PROBE_SPEC();
  spec.params.push({id: 'PartArmA', min: 0, max: 1, default: 0}, {id: 'PartArmB', min: 0, max: 1, default: 0}); // real switch parameters
  const log = [];
  const {state, raw, coreModel, rig} = sdkPoseRig(log, spec);
  const sdkPose = fakeCubismPose(log, 5000, rig);
  let current = {name: 'arm-b', parameters: {PartArmA: 0, PartArmB: 1}};
  const internal = {coreModel};
  installDeterministicUpdate(internal, raw, state, () => current, () => {}, {sdkPose});
  internal.update();
  assert.deepEqual(partOpacities(raw, state), {PartArmA: 0, PartArmB: 1}, 'second part fully visible, first fully hidden');
  assert.ok(log.includes('update:same:10000'));
  // the previous fixed 1000 s step would NOT settle this fade (shows the test is meaningful)
  const log2 = [], rig2 = sdkPoseRig(log2, spec), pose2 = fakeCubismPose(log2, 5000, rig2.rig);
  pose2.reset(rig2.coreModel); rig2.rig.setParam('PartArmA', 0); rig2.rig.setParam('PartArmB', 1); pose2._lastModel = rig2.coreModel;
  pose2.updateParameters(rig2.coreModel, 1000);
  assert.ok(partOpacities(rig2.raw, rig2.state).PartArmB < 1, 'fixed 1000 s leaves the fade unfinished');
  // back to the first part and again: still a still image
  current = {name: 'arm-a', parameters: {PartArmA: 1, PartArmB: 0}}; internal.update();
  assert.deepEqual(partOpacities(raw, state), {PartArmA: 1, PartArmB: 0});
  for (const bad of [undefined, 0, -1, NaN, Infinity, Number.MAX_VALUE]) {
    assert.throws(() => sdkPoseSettleSeconds({_fadeTimeSeconds: bad}), e => e.code === 'E_SDK_POSE_FADE', String(bad));
  }
  assert.throws(() => installDeterministicUpdate({coreModel}, raw, state, () => current, () => {}, {sdkPose: {...sdkPose, _fadeTimeSeconds: undefined}}), e => e.code === 'E_SDK_POSE_FADE');
});

test('actual mode is shown: page tag set from config, CLI start line names the mode', async () => {
  const html = await readFile(path.join(HERE, '..', 'preview', 'index.html'), 'utf8');
  assert.ok(!/raw Core mode/i.test(html), 'no hard-coded mode text in the page');
  assert.match(await readFile(path.join(HERE, '..', 'preview', 'app.mjs'), 'utf8'), /\$\('mode-tag'\)\.textContent = `local diagnostic · \$\{config\.mode\}`/);
  const fx = await poseFixture();
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  const {spawn} = await import('node:child_process');
  const cli = path.join(HERE, '..', 'tools', 'serve-native-preview.mjs');
  const child = spawn(process.execPath, [cli, '--before', fx.opts.before, '--after', fx.opts.after, '--poses', fx.opts.poses, '--port', String(port),
    '--core', fx.opts.core, '--pixi', fx.opts.pixi, '--live2d-display', fx.opts.live2dDisplay, '--mode', 'sdk-pose']);
  try {
    let timer;
    const line = await new Promise((resolve, reject) => {
      child.stdout.once('data', d => resolve(String(d)));
      child.once('exit', code => reject(new Error(`exited ${code}`)));
      timer = setTimeout(() => reject(new Error('timeout')), 10000);
    }).finally(() => clearTimeout(timer));
    assert.match(line, /^Native preview \(sdk-pose, read-only\): http:\/\/127\.0\.0\.1:/);
    assert.ok(!line.includes(fx.dir));
  } finally { child.kill(); await fx.cleanup(); }
});

test('a loaded model whose SDK Pose cannot settle (FadeInTime 1e308) is disposed once, with each texture once', async () => {
  const urls = ['/m/after/r/1.png?g=6'];
  const {PIXI, log} = fakePixi({script: async (model, settings) => {
    emitSettings(model, settings.FileReferences.Textures);
    model.internalModel = {coreReleased: 0};
  }});
  let disposals = 0;
  const dispose = record => { disposals++; return ownedDispose(PIXI)(record); };
  const record = await loadOwnedModel({PIXI, settings: {FileReferences: {Textures: urls}}, options: {}, urls, isCurrent: () => true, dispose});
  assert.ok(record, 'load itself succeeded');
  const f = fakeCore(SPEC()), state = readDeclaredState(f.core, MOC), raw = f.newModel();
  const sdkPose = {reset() {}, updateParameters() {}, _fadeTimeSeconds: 1e308}; // finite, but 2 x fade overflows
  await assert.rejects(installOrDispose(record, dispose, () => {
    installDeterministicUpdate({coreModel: {}}, raw, state, () => ({name: 'd', parameters: {}}), () => {}, {sdkPose});
  }), e => e.code === 'E_SDK_POSE_FADE');
  await ownedDispose(PIXI)(record); // a later cleanup pass must be a no-op
  assert.equal(disposals, 1);
  assert.equal(record.model.destroyed, 1); assert.equal(record.model.internalModel.coreReleased, 1);
  const destroyedTextures = log.filter(l => l.startsWith('texture:')).sort();
  assert.deepEqual(destroyedTextures, ['texture:from:false:false:/m/after/r/1.png?g=6', 'texture:loaded:/m/after/r/1.png?g=6'], 'each texture destroyed exactly once');
  for (const t of record.textures) assert.equal(t.destroyed, 1);
  // success path: the record is returned and nothing is disposed
  const ok = await loadOwnedModel({PIXI, settings: {FileReferences: {Textures: ['/m/after/r/1.png?g=7']}}, options: {}, urls: [], isCurrent: () => true, dispose});
  assert.equal(await installOrDispose(ok, dispose, () => {}), ok); assert.equal(disposals, 1);
});
