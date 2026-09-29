// Offline tests for the native export audit. Everything here is SYNTHETIC: a
// fake Core implements only the inspected API surface and reads a made-up
// "moc" (header + JSON). Passing these tests is NOT validation of a real model;
// the coordinator runs the CLI with the trusted local Core and actual exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, symlink, link, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runAudit, compareReports, declaredReferences, checkReference, parsePoses, inspectMoc, coreVersionText, SCHEMA} from '../src/export-audit.mjs';

const WIN = process.platform === 'win32';
// Directory links: a junction on Windows (no admin/Developer Mode needed), a symlink elsewhere.
const linkDir = (target, at) => symlink(target, at, WIN ? 'junction' : 'dir');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HEADER = 'FAKEMOC3';

// ---- synthetic Core --------------------------------------------------------------
function fakeCore({sharedState = false} = {}) {
  const stats = {models: 0, released: 0, mocs: 0, mocsReleased: 0};
  const parse = buffer => {
    const text = Buffer.from(buffer).toString('utf8');
    if (!text.startsWith(HEADER)) return null;
    try { return JSON.parse(text.slice(HEADER.length)); } catch { return null; }
  };
  class Moc {
    static fromArrayBuffer(buffer) { const spec = parse(buffer); if (!spec || spec.nullMoc) return null; stats.mocs++; return Object.assign(new Moc(), {spec}); }
    hasMocConsistency(buffer) { const spec = parse(buffer); return spec && !spec.inconsistent ? 1 : 0; }
    _release() { stats.mocsReleased++; }
  }
  let shared = null;
  const Model = {
    fromMoc(moc) {
      const s = moc.spec;
      if (s.nullModel) return null;
      stats.models++;
      const params = s.parameters;
      const values = sharedState && shared ? shared : Float32Array.from(params.map(p => p.default));
      if (sharedState) shared = values;
      const drawables = s.drawables;
      const model = {
        parameters: {ids: params.map(p => p.id), minimumValues: params.map(p => p.min), maximumValues: params.map(p => p.max), defaultValues: params.map(p => p.default), values},
        parts: {ids: s.parts ?? ['PartA'], opacities: Float32Array.from((s.parts ?? ['PartA']).map((_, i) => s.partOpacities?.[i] ?? 1))},
        drawables: {count: drawables.length, ids: drawables.map(d => d.id), vertexUvs: drawables.map(d => Float32Array.from(d.uvs ?? d.xy.map(v => (v + 1) / 2))),
          indices: drawables.map(d => Uint16Array.from(d.indices)), textureIndices: drawables.map(d => d.texture ?? 0), masks: drawables.map(d => d.masks ?? []),
          opacities: Float32Array.from(drawables.map(() => 1)), renderOrders: Int32Array.from(drawables.map((d, i) => d.order ?? i)),
          vertexPositions: drawables.map(d => Float32Array.from(d.xy))},
        update() {
          drawables.forEach((d, i) => {
            const out = this.drawables.vertexPositions[i];
            for (let k = 0; k < out.length; k++) {
              let v = d.xy[k];
              for (const [id, deltas] of Object.entries(d.deform ?? {})) { const j = params.findIndex(p => p.id === id); v += (values[j] - params[j].default) * deltas[k]; }
              out[k] = v;
            }
          });
        },
        release() { stats.released++; },
      };
      if (s.throwOnUpdate) model.update = () => { throw new Error('/secret/abs/path boom'); };
      return model;
    },
  };
    // Faithful to Core 5.1.0: csmGetMocVersion(moc, mocBytes) and it reads mocBytes.byteLength.
  const csmGetMocVersion = (moc, mocBytes) => {
    if (!(moc instanceof Moc)) throw new TypeError('moc expected');
    if (typeof mocBytes.byteLength !== 'number') throw new TypeError('mocBytes expected');
    return moc.spec.mocVersion ?? 0;
  };
  return {core: {Version: {csmGetVersion: () => 0x05010000, csmGetLatestMocVersion: () => 5, csmGetMocVersion}, Moc, Model}, stats};
}

const baseSpec = () => ({
  mocVersion: 5,
  parameters: [{id: 'ParamAngleX', min: -30, max: 30, default: 0}, {id: 'ParamArmL', min: 0, max: 10, default: 2}, {id: 'ParamMouthOpenY', min: 0, max: 1, default: 0}],
  drawables: [
    {id: 'ArtMeshArm', order: 500, xy: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2], deform: {ParamArmL: [0, 0, 0.3, 0, 0, 0]}},
    {id: 'ArtMeshMouth', order: 600, xy: [0, 0, 1, 0, 1, 1], indices: [0, 1, 2], texture: 1, masks: [0], deform: {ParamMouthOpenY: [0, 0, 0, 0, 0, 0.5]}},
  ],
});
const mocBytes = spec => Buffer.from(HEADER + JSON.stringify(spec));

async function fixture({spec = baseSpec(), model3 = null, extraFiles = {}} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'audit-'));
  const root = path.join(dir, 'export');
  await mkdir(path.join(root, 'tex'), {recursive: true});
  await mkdir(path.join(root, 'motions', 'idle'), {recursive: true});
  const files = {
    'hiyori.moc3': mocBytes(spec), 'tex/texture_00.png': 'png0', 'tex/texture_01.png': 'png1',
    'hiyori.physics3.json': '{}', 'hiyori.pose3.json': '{}', 'hiyori.cdi3.json': '{}', 'motions/idle/m01.motion3.json': '{}', ...extraFiles,
  };
  for (const [rel, data] of Object.entries(files)) await writeFile(path.join(root, rel), data);
  const m = model3 ?? {Version: 3, FileReferences: {Moc: 'hiyori.moc3', Textures: ['tex/texture_00.png', 'tex/texture_01.png'], Physics: 'hiyori.physics3.json',
    Pose: 'hiyori.pose3.json', DisplayInfo: 'hiyori.cdi3.json', Motions: {Idle: [{File: 'motions/idle/m01.motion3.json', FadeInTime: 0.5}]}}};
  await writeFile(path.join(root, 'hiyori.model3.json'), JSON.stringify(m));
  return {dir, root, modelPath: path.join(root, 'hiyori.model3.json'), outPath: path.join(dir, 'report.json'), cleanup: () => rm(dir, {recursive: true, force: true})};
}
const coreLoader = fake => async () => ({core: fake.core, sha256: 'f'.repeat(64)});
async function audit(fx, opts = {}, fake = fakeCore()) {
  const result = await runAudit({modelPath: fx.modelPath, outPath: fx.outPath, loadCore: coreLoader(fake), ...opts});
  return {...result, fake};
}
async function writePoses(fx, poses, name = 'poses.json') {
  const file = path.join(fx.dir, name);
  await writeFile(file, JSON.stringify({version: 1, poses}));
  return file;
}
const codes = r => r.report.errors.map(e => e.code);

// ---- references ------------------------------------------------------------------
test('valid export: nested and optional references are hashed; Core checks and structure reported', async () => {
  const fx = await fixture();
  try {
    const {report, exitCode, writeTo, fake} = await audit(fx);
    assert.equal(exitCode, 0, JSON.stringify(report.errors));
    assert.equal(report.schema, SCHEMA);
    assert.deepEqual(report.references.map(r => [r.kind, r.ref]), [['moc', 'hiyori.moc3'], ['texture', 'tex/texture_00.png'], ['texture', 'tex/texture_01.png'],
      ['physics', 'hiyori.physics3.json'], ['pose', 'hiyori.pose3.json'], ['displayInfo', 'hiyori.cdi3.json'], ['motion', 'motions/idle/m01.motion3.json']]);
    for (const r of report.references) { assert.match(r.sha256, /^[0-9a-f]{64}$/); assert.ok(r.bytes > 0); }
    assert.deepEqual(report.core.version, {raw: 0x05010000, text: '5.1.0'});
    assert.equal(report.core.versionCheck, 'passed');
    assert.equal(report.core.consistency, 'passed');
    assert.equal(report.coreCompatible, true);
    assert.deepEqual(report.parameters.map(p => [p.id, p.default]), [['ParamAngleX', 0], ['ParamArmL', 2], ['ParamMouthOpenY', 0]]);
    assert.deepEqual(report.structure.drawables.map(d => d.masks), [[], ['ArtMeshArm']]);
    assert.equal(report.poses[0].name, 'default');
    assert.equal(writeTo, fx.outPath);
    assert.equal(fake.stats.models, fake.stats.released, 'every model released');
    assert.equal(fake.stats.mocs, fake.stats.mocsReleased, 'moc released');
    const text = JSON.stringify(report);
    assert.ok(!text.includes(fx.dir), 'no absolute paths in the report');
  } finally { await fx.cleanup(); }
});

test('declared UserData, Expressions and Sound are checked; missing ones fail and are all listed', async () => {
  const fx = await fixture({model3: {Version: 3, FileReferences: {Moc: 'hiyori.moc3', Textures: ['tex/texture_00.png', 'tex/texture_01.png'], UserData: 'u.userdata3.json',
    Expressions: [{Name: 'smile', File: 'exp/smile.exp3.json'}], Motions: {Tap: [{File: 'motions/idle/m01.motion3.json', Sound: 'snd/a.wav'}]}}}});
  try {
    const {report, exitCode} = await audit(fx);
    assert.equal(exitCode, 2);
    assert.deepEqual(report.errors.map(e => [e.code, e.ref]), [['E_REF_MISSING', 'u.userdata3.json'], ['E_REF_MISSING', 'exp/smile.exp3.json'], ['E_REF_MISSING', 'snd/a.wav']]);
    assert.equal(report.references.length, 7); // moc, 2 textures, userData, expression, motion, sound
    assert.equal(report.coreCompatible, false);
    assert.equal(report.status, 'failed');
  } finally { await fx.cleanup(); }
});

test('reference strings: URL, absolute, drive, UNC, traversal and malformed are rejected; nested paths accepted', () => {
  assert.equal(checkReference('a/b/../c.png'), 'a/c.png');
  for (const [ref, code] of [['https://x/y.moc3', 'E_REF_URL'], ['file:x', 'E_REF_URL'], ['/etc/passwd', 'E_REF_ABSOLUTE'], ['C:/x.png', 'E_REF_ABSOLUTE'],
    ['\\\\server\\share\\x', 'E_REF_ABSOLUTE'], ['//server/x', 'E_REF_ABSOLUTE'], ['../x.png', 'E_REF_ESCAPE'], ['a/../../x', 'E_REF_ESCAPE'], ['a\\b.png', 'E_REF_MALFORMED'], ['', 'E_REF_MALFORMED'], [42, 'E_REF_MALFORMED']]) {
    assert.throws(() => checkReference(ref), e => e.code === code, String(ref));
  }
  const base = {Version: 3, FileReferences: {Moc: 'm.moc3', Textures: ['t.png']}};
  assert.throws(() => declaredReferences({...base, Version: 2}), e => e.code === 'E_MODEL_SCHEMA');
  assert.throws(() => declaredReferences({Version: 3, FileReferences: {Moc: 'm.moc3', Textures: []}}), e => e.code === 'E_MODEL_SCHEMA');
  assert.throws(() => declaredReferences({Version: 3, FileReferences: {Moc: '', Textures: ['t.png']}}), e => e.code === 'E_MODEL_SCHEMA');
  for (const bad of [{Physics: 3}, {Expressions: {}}, {Expressions: [{File: 'x'}]}, {Motions: []}, {Motions: {Idle: {}}}, {Motions: {Idle: [{Sound: 'a.wav'}]}}]) {
    assert.throws(() => declaredReferences({...base, FileReferences: {...base.FileReferences, ...bad}}), e => e.code === 'E_REF_MALFORMED' || e.code === 'E_REF_ABSOLUTE', JSON.stringify(bad));
  }
});

test('linked directory escaping the model directory is rejected before reading (junction on win32)', async () => {
  const fx = await fixture();
  try {
    await mkdir(path.join(fx.dir, 'outside'));
    await writeFile(path.join(fx.dir, 'outside', 'tex.png'), 'secret');
    await linkDir(path.join(fx.dir, 'outside'), path.join(fx.root, 'tex', 'linked'));
    const m = JSON.parse(await readFile(fx.modelPath, 'utf8'));
    m.FileReferences.Textures = ['tex/linked/tex.png'];
    await writeFile(fx.modelPath, JSON.stringify(m));
    const {report, exitCode} = await audit(fx);
    assert.equal(exitCode, 2);
    assert.deepEqual(report.errors[0], {code: 'E_REF_ESCAPE', ref: 'tex/linked/tex.png', detail: 'resolves outside the model directory'});
    assert.equal(report.references.find(r => r.ref === 'tex/linked/tex.png').sha256, null, 'escaped file never hashed');
  } finally { await fx.cleanup(); }
});

test('output may not alias the model, a referenced asset or an input file', async () => {
  const fx = await fixture();
  try {
    for (const target of [fx.modelPath, path.join(fx.root, 'hiyori.moc3'), path.join(fx.root, 'tex', 'texture_01.png')]) {
      const before = await readFile(target);
      const {exitCode, writeTo, report} = await audit(fx, {outPath: target});
      assert.equal(exitCode, 2); assert.equal(writeTo, null); assert.deepEqual(codes({report}), ['E_OUT_ALIAS']);
      assert.deepEqual(await readFile(target), before);
    }
    const poses = await writePoses(fx, [{name: 'a', parameters: {ParamAngleX: 5}}]);
    assert.deepEqual(codes(await audit(fx, {outPath: poses, posesPath: poses})), ['E_OUT_ALIAS']);
  } finally { await fx.cleanup(); }
});

test('oversized model JSON and invalid JSON are refused', async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.modelPath, '{"Version":3,' + ' '.repeat(1 << 20) + '}');
    assert.deepEqual(codes(await audit(fx)), ['E_TOO_LARGE']);
    await writeFile(fx.modelPath, '{nope');
    assert.deepEqual(codes(await audit(fx)), ['E_MODEL_JSON']);
  } finally { await fx.cleanup(); }
});

// ---- Core boundary -----------------------------------------------------------------
test('unsupported, inconsistent, null moc/model and Core failures exit nonzero and release', async () => {
  for (const [patch, code] of [[{mocVersion: 6}, 'E_MOC_UNSUPPORTED'], [{mocVersion: 0}, 'E_MOC_INVALID'], [{inconsistent: true}, 'E_MOC_INCONSISTENT'],
    [{nullMoc: true}, 'E_MOC_INVALID'], [{nullModel: true}, 'E_MODEL_INSTANTIATE'], [{throwOnUpdate: true}, 'E_INTERNAL']]) {
    const fx = await fixture({spec: {...baseSpec(), ...patch}});
    try {
      const {report, exitCode, fake} = await audit(fx);
      assert.equal(exitCode, 2, code);
      assert.deepEqual(codes({report}), [code]);
      assert.equal(report.coreCompatible, false);
      assert.equal(fake.stats.models, fake.stats.released, `${code}: models released`);
      assert.equal(fake.stats.mocs, fake.stats.mocsReleased, `${code}: moc released`);
      assert.ok(!JSON.stringify(report).includes('/secret/abs/path'), 'raw exception text never reported');
    } finally { await fx.cleanup(); }
  }
  const fx = await fixture();
  try {
    const r = await runAudit({modelPath: fx.modelPath, outPath: fx.outPath, loadCore: async () => { throw new Error('/abs/core missing'); }});
    assert.equal(r.exitCode, 2); assert.deepEqual(codes(r), ['E_CORE_INIT']);
  } finally { await fx.cleanup(); }
});

test('missing Core capabilities are reported as unavailable, never as passed', () => {
  const fake = fakeCore();
  delete fake.core.Moc.prototype.hasMocConsistency;
  const noVersion = {...fake.core, Version: {csmGetVersion: () => 0x05010000}};
  const r = inspectMoc(noVersion, mocBytes(baseSpec()), {textureCount: 2});
  assert.equal(r.core.consistency, 'unavailable');
  assert.equal(r.core.versionCheck, 'unavailable');
  assert.deepEqual(r.core.unavailable, ['mocConsistency', 'mocVersion']);
  assert.equal(coreVersionText(0x05010000), '5.1.0');
});

test('structure validation: index bounds, XY/UV length, texture index, mask reference, duplicate ids, incoherent parameters', () => {
  const cases = [
    [s => { s.drawables[0].indices = [0, 1, 3]; }, 'triangle index'], [s => { s.drawables[0].uvs = [0, 0]; }, 'XY/UV'],
    [s => { s.drawables[1].texture = 2; }, 'texture index'], [s => { s.drawables[1].masks = [5]; }, 'mask'],
    [s => { s.drawables[1].id = 'ArtMeshArm'; }, 'duplicate drawable'], [s => { s.parameters[1].default = 11; }, 'incoherent'],
    [s => { s.drawables[0].xy[0] = 'NaN'; }, 'non-finite'],
  ];
  for (const [mutate, message] of cases) {
    const spec = baseSpec(); mutate(spec);
    assert.throws(() => inspectMoc(fakeCore().core, mocBytes(spec), {textureCount: 2}), e => e.code === 'E_STRUCTURE' && e.detail.includes(message), message);
  }
});

// ---- poses ---------------------------------------------------------------------------
test('pose input validation: names, duplicates, counts, unknown channels and ranges are errors (no clamping)', async () => {
  assert.throws(() => parsePoses({version: 1, poses: [{name: 'default', parameters: {ParamAngleX: 1}}]}), e => e.code === 'E_POSE_NAME');
  assert.throws(() => parsePoses({version: 1, poses: [{name: 'a b', parameters: {ParamAngleX: 1}}]}), e => e.code === 'E_POSE_NAME');
  assert.throws(() => parsePoses({version: 1, poses: [{name: 'a', parameters: {X: 1}}, {name: 'a', parameters: {X: 2}}]}), e => e.code === 'E_POSE_NAME');
  assert.throws(() => parsePoses({version: 1, poses: Array.from({length: 13}, (_, i) => ({name: `p${i}`, parameters: {X: 1}}))}), e => e.code === 'E_POSES_SCHEMA');
  assert.throws(() => parsePoses({version: 1, poses: [{name: 'a', parameters: {X: '1'}}]}), e => e.code === 'E_POSE_VALUE');
  assert.throws(() => parsePoses({version: 1, poses: [{name: 'a', parameters: {}}]}), e => e.code === 'E_POSES_SCHEMA');
  assert.throws(() => parsePoses({version: 2, poses: []}), e => e.code === 'E_POSES_SCHEMA');
  const fx = await fixture();
  try {
    assert.deepEqual(codes(await audit(fx, {posesPath: await writePoses(fx, [{name: 'x', parameters: {ParamArmLRaise: 1}}])})), ['E_POSE_UNKNOWN_PARAM']);
    assert.deepEqual(codes(await audit(fx, {posesPath: await writePoses(fx, [{name: 'x', parameters: {ParamArmL: 10.5}}])})), ['E_POSE_RANGE']);
  } finally { await fx.cleanup(); }
});

test('pose measurements are independent of order and use native defaults; stale Core state is detected', async () => {
  const fx = await fixture();
  try {
    const a = {name: 'arm-up', parameters: {ParamArmL: 10}}, b = {name: 'head', parameters: {ParamAngleX: 20}};
    const r1 = await audit(fx, {posesPath: await writePoses(fx, [a, b], 'p1.json')});
    const r2 = await audit(fx, {posesPath: await writePoses(fx, [b, a], 'p2.json')});
    assert.equal(r1.exitCode, 0);
    const byName = r => Object.fromEntries(r.report.poses.map(p => [p.name, p]));
    assert.deepEqual(byName(r1)['arm-up'], byName(r2)['arm-up']);
    assert.deepEqual(byName(r1).head, byName(r2).head);
    // default pose uses the native default (ParamArmL=2), not zero
    assert.notEqual(byName(r1)['arm-up'].geometrySignature, byName(r1).default.geometrySignature);
    assert.equal(byName(r1).head.geometrySignature, byName(r1).default.geometrySignature, 'unbound parameter moves nothing');
    const leaky = await audit(fx, {posesPath: await writePoses(fx, [a, b], 'p3.json')}, fakeCore({sharedState: true}));
    assert.deepEqual(codes(leaky), ['E_CORE_STATE']);
  } finally { await fx.cleanup(); }
});

test('triangle orientation flips against the default pose are counted per drawable', () => {
  const spec = baseSpec();
  spec.drawables[0].deform = {ParamArmL: [0, 0, 0, 0, 0, -0.5]}; // raising ArmL folds vertex 2 below the base edge
  const r = inspectMoc(fakeCore().core, mocBytes(spec), {textureCount: 2, poses: [{name: 'fold', parameters: {ParamArmL: 10}}]});
  assert.equal(r.poses[1].drawables.find(d => d.id === 'ArtMeshArm').invertedVsDefault, 1);
  assert.equal(r.poses[0].drawables.every(d => d.invertedVsDefault === 0), true);
});

// ---- comparison ------------------------------------------------------------------------
async function reportFor(spec, poses, extra = {}) {
  const fx = await fixture({spec, extraFiles: extra});
  try {
    const r = await audit(fx, {posesPath: await writePoses(fx, poses)});
    assert.equal(r.exitCode, 0, JSON.stringify(r.report.errors) + ' ' + JSON.stringify(spec).slice(0, 80));
    return r.report;
  } finally { await fx.cleanup(); }
}
const POSES = [{name: 'arm-up', parameters: {ParamArmL: 10}}, {name: 'mouth', parameters: {ParamMouthOpenY: 1}}];

test('comparison: unchanged baseline, hash-only change, geometry change and incompatible inputs are distinguished', async () => {
  const base = await reportFor(baseSpec(), POSES);
  const same = compareReports(base, base);
  assert.equal(same.classification, 'identical-moc'); assert.equal(same.editProof, false);

  const hashOnly = await reportFor({...baseSpec(), note: 'metadata only'}, POSES);
  const h = compareReports(hashOnly, base);
  assert.equal(h.classification, 'bytes-changed-poses-identical'); assert.equal(h.editProof, false);

  const edited = baseSpec(); edited.drawables[0].deform = {ParamArmL: [0, 0, 0.6, 0.1, 0, 0]};
  const g = compareReports(await reportFor(edited, POSES), base);
  assert.equal(g.classification, 'geometry-changed'); assert.equal(g.editProof, true);
  assert.deepEqual(g.changedPoses.map(p => [p.name, p.geometryChanged.map(d => d.id)]), [['arm-up', ['ArtMeshArm']]]);

  const mouthOnly = baseSpec(); mouthOnly.drawables[1].deform = {ParamMouthOpenY: [0, 0, 0, 0, 0, 0.9]};
  const m = compareReports(await reportFor(mouthOnly, POSES), base);
  assert.deepEqual(m.changedPoses.map(p => [p.name, p.geometryChanged.map(d => d.id)]), [['mouth', ['ArtMeshMouth']]], 'attributed to the mouth mesh, not the arm');

  assert.equal(compareReports(await reportFor(baseSpec(), [POSES[0]]), base).classification, 'incompatible', 'different pose inputs');
  const topo = baseSpec(); topo.drawables[0].xy.push(1, 1); topo.drawables[0].indices.push(1, 3, 2); topo.drawables[0].deform.ParamArmL.push(0, 0);
  assert.equal(compareReports(await reportFor(topo, POSES), base).classification, 'incompatible', 'topology');
  assert.equal(compareReports(base, {...base, core: {...base.core, sha256: '0'.repeat(64)}}).classification, 'incompatible', 'different Core');
  assert.equal(compareReports(base, {schema: 'x'}).classification, 'incompatible');
});

test('--require-pose-change: fails without change or evidence, passes only on requested geometry change', async () => {
  const fx = await fixture();
  try {
    const poses = await writePoses(fx, POSES);
    const first = await audit(fx, {posesPath: poses});
    const baselinePath = path.join(fx.dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(first.report));
    const unchanged = await audit(fx, {posesPath: poses, baselinePath, requirePoseChange: true});
    assert.equal(unchanged.exitCode, 3); assert.deepEqual(codes(unchanged), ['E_REQUIRE_POSE_CHANGE']);
    assert.equal(unchanged.report.comparison.classification, 'identical-moc');
    assert.deepEqual(codes(await audit(fx, {baselinePath, requirePoseChange: true})), ['E_REQUIRE_POSE_CHANGE'], 'no poses: no evidence');
    const edited = baseSpec(); edited.drawables[0].deform = {ParamArmL: [0, 0, 0.6, 0.1, 0, 0]};
    await writeFile(path.join(fx.root, 'hiyori.moc3'), mocBytes(edited));
    const changed = await audit(fx, {posesPath: poses, baselinePath, requirePoseChange: true});
    assert.equal(changed.exitCode, 0); assert.equal(changed.report.comparison.editProof, true);
    await writeFile(baselinePath, '{"schema":"hiyori-cubism-export-audit/1","status":"ok","poses":[{}],"references":[],"core":' + JSON.stringify(first.report.core) + ',"structure":' + JSON.stringify(first.report.structure) + '}');
    const malformed = await audit(fx, {posesPath: poses, baselinePath, requirePoseChange: true});
    assert.equal(malformed.exitCode, 3); assert.equal(malformed.report.comparison.classification, 'incompatible');
  } finally { await fx.cleanup(); }
});

test('reports are deterministic across runs (no timestamps or paths)', async () => {
  const fx = await fixture();
  try {
    const poses = await writePoses(fx, POSES);
    const a = await audit(fx, {posesPath: poses}), b = await audit(fx, {posesPath: poses});
    assert.equal(JSON.stringify(a.report), JSON.stringify(b.report));
  } finally { await fx.cleanup(); }
});

// ---- CLI --------------------------------------------------------------------------------
test('CLI: --help, usage errors and missing Core exit without stacks or absolute paths', async () => {
  const cli = path.join(HERE, '..', 'tools', 'audit-export.mjs');
  const help = spawnSync(process.execPath, [cli, '--help'], {encoding: 'utf8'});
  assert.equal(help.status, 0); assert.match(help.stdout, /raw Core deformation only/); assert.match(help.stdout, /--require-pose-change/);
  const usage = spawnSync(process.execPath, [cli, '--bogus'], {encoding: 'utf8'});
  assert.equal(usage.status, 64); assert.match(usage.stderr, /E_USAGE/);
  const fx = await fixture();
  try {
    const run = spawnSync(process.execPath, [cli, '--model', fx.modelPath, '--out', fx.outPath], {encoding: 'utf8'});
    // In the cloud checkout the trusted Core is absent (ignored path): expect a clean E_CORE_INIT.
    // Where a local Core exists this synthetic moc is not a real moc3 and must still be refused.
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /E_CORE_INIT|E_MOC_INVALID|E_MOC_INCONSISTENT/);
    assert.ok(!run.stderr.includes(fx.dir) && !run.stdout.includes(fx.dir) && !/\n\s+at /.test(run.stderr), 'no absolute paths or stacks');
    const written = JSON.parse(await readFile(fx.outPath, 'utf8'));
    assert.equal(written.status, 'failed'); assert.equal(written.coreCompatible, false);
  } finally { await fx.cleanup(); }
});

// ---- regression tests for acceptance review of f1c2d64 --------------------------------
test('review 1: csmGetMocVersion is called as (moc, mocBytes) after Moc creation; early failures release the Moc', () => {
  const fake = fakeCore();
  assert.throws(() => fake.core.Version.csmGetMocVersion(mocBytes(baseSpec()).buffer), TypeError, 'fake rejects the one-argument form like Core 5.1.0');
  const r = inspectMoc(fake.core, mocBytes(baseSpec()), {textureCount: 2});
  assert.equal(r.core.mocVersion, 5);
  for (const patch of [{mocVersion: 6}, {mocVersion: 0}, {nullModel: true}]) {
    const f = fakeCore();
    assert.throws(() => inspectMoc(f.core, mocBytes({...baseSpec(), ...patch}), {textureCount: 2}), e => e.code.startsWith('E_'));
    assert.equal(f.stats.mocs, 1, JSON.stringify(patch)); assert.equal(f.stats.mocsReleased, 1, `${JSON.stringify(patch)}: moc released`);
  }
  const throwing = fakeCore();
  throwing.core.Version.csmGetMocVersion = () => { throw new TypeError('/private/abs/path'); };
  assert.throws(() => inspectMoc(throwing.core, mocBytes(baseSpec()), {textureCount: 2}), e => e.code === 'E_MOC_INVALID' && !e.message.includes('/private'));
  assert.equal(throwing.stats.mocsReleased, 1);
});

test('review 2: identical moc bytes with different measurements are inconsistent evidence, never editProof', async () => {
  const fx = await fixture();
  try {
    const poses = await writePoses(fx, POSES);
    const first = await audit(fx, {posesPath: poses});
    const tampered = structuredClone(first.report);
    tampered.poses[1].drawables[0].geometrySha = '0'.repeat(64);
    const c = compareReports(first.report, tampered);
    assert.equal(c.classification, 'inconsistent-evidence'); assert.equal(c.editProof, false);
    const baselinePath = path.join(fx.dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(tampered));
    for (const requirePoseChange of [false, true]) {
      const r = await audit(fx, {posesPath: poses, baselinePath, requirePoseChange});
      assert.equal(r.exitCode, 2); assert.deepEqual(codes(r), ['E_EVIDENCE_INCONSISTENT']);
    }
  } finally { await fx.cleanup(); }
});

test('review 3: invalid references, keys, group and pose names are redacted from reports and CLI output', async () => {
  const PRIVATE = 'example-private-user';
  const badRefs = [`/Users/${PRIVATE}/tex.png`, `C:/Users/${PRIVATE}/tex.png`, `\\\\host\\${PRIVATE}\\tex.png`, `https://example.invalid/${PRIVATE}.png`, `../${PRIVATE}/tex.png`];
  const cli = path.join(HERE, '..', 'tools', 'audit-export.mjs');
  for (const bad of badRefs) {
    const fx = await fixture({model3: {Version: 3, FileReferences: {Moc: 'hiyori.moc3', Textures: ['tex/texture_00.png', bad]}}});
    try {
      const r = await audit(fx);
      assert.equal(r.exitCode, 2);
      assert.equal(r.report.errors[0].ref, 'texture[1]');
      assert.ok(!JSON.stringify(r.report).includes(PRIVATE), bad);
      const run = spawnSync(process.execPath, [cli, '--model', fx.modelPath, '--out', fx.outPath], {encoding: 'utf8'});
      assert.equal(run.status, 2);
      assert.ok(!run.stderr.includes(PRIVATE) && !run.stdout.includes(PRIVATE), `CLI echoed ${bad}`);
    } finally { await fx.cleanup(); }
  }
  const group = `/home/${PRIVATE}/g`;
  assert.throws(() => declaredReferences({Version: 3, FileReferences: {Moc: 'm.moc3', Textures: ['t.png'], Motions: {[group]: {}}}}), e => !e.message.includes(PRIVATE));
  for (const poses of [{version: 1, poses: [], [`C:/${PRIVATE}`]: 1}, {version: 1, poses: [{name: `/${PRIVATE}`, parameters: {X: 1}}]},
    {version: 1, poses: [{name: 'a', parameters: {X: 1}, [`/${PRIVATE}`]: 1}]}, {version: 1, poses: [{name: 'a', parameters: {[`/${PRIVATE}`]: 'x'}}]}]) {
    assert.throws(() => parsePoses(poses), e => !e.message.includes(PRIVATE) && !String(e.ref).includes(PRIVATE));
  }
  const fx = await fixture();
  try {
    const r = await audit(fx, {posesPath: await writePoses(fx, [{name: 'x', parameters: {[`/Users/${PRIVATE}`]: 1}}])});
    assert.deepEqual(codes(r), ['E_POSE_UNKNOWN_PARAM']); assert.ok(!JSON.stringify(r.report).includes(PRIVATE));
    const usage = spawnSync(process.execPath, [cli, `--/Users/${PRIVATE}`], {encoding: 'utf8'});
    assert.equal(usage.status, 64); assert.ok(!usage.stderr.includes(PRIVATE));
  } finally { await fx.cleanup(); }
});

test('review 4: output may not alias protected dependencies or inputs, including hardlinks (disposable fixtures only)', async () => {
  const fx = await fixture();
  try {
    // Disposable stand-ins for the trusted Core and CLI/library sources.
    const fakeCoreFile = path.join(fx.dir, 'fake-core.js'), fakeSource = path.join(fx.dir, 'fake-cli.mjs');
    await writeFile(fakeCoreFile, 'core'); await writeFile(fakeSource, 'cli');
    const protectedPaths = [fakeCoreFile, fakeSource];
    const hardCore = path.join(fx.dir, 'hard-core.json'), hardMoc = path.join(fx.dir, 'hard-moc.json');
    await link(fakeCoreFile, hardCore); await link(path.join(fx.root, 'hiyori.moc3'), hardMoc);
    for (const outPath of [fakeCoreFile, fakeSource, hardCore, hardMoc]) {
      const before = await readFile(outPath);
      const r = await audit(fx, {outPath, protectedPaths});
      assert.equal(r.exitCode, 2, outPath); assert.equal(r.writeTo, null); assert.deepEqual(codes(r), ['E_OUT_ALIAS']);
      assert.deepEqual(await readFile(outPath), before);
    }
    // A failing audit (missing reference) must not target an input either.
    const m = JSON.parse(await readFile(fx.modelPath, 'utf8'));
    m.FileReferences.Physics = 'missing.physics3.json';
    await writeFile(fx.modelPath, JSON.stringify(m));
    const hardModel = path.join(fx.dir, 'hard-model.json');
    await link(fx.modelPath, hardModel);
    const failing = await audit(fx, {outPath: hardModel, protectedPaths});
    assert.equal(failing.writeTo, null); assert.deepEqual(codes(failing), ['E_OUT_ALIAS']);
    // An ordinary new file is still allowed.
    const ok = await audit(fx, {outPath: path.join(fx.dir, 'new-report.json'), protectedPaths});
    assert.equal(ok.writeTo, path.join(await (await import('node:fs/promises')).realpath(fx.dir), 'new-report.json'));
  } finally { await fx.cleanup(); }
});

test('review 5: drawable reordering (masks remapped) and pose/parameter ordering compare as equivalent; real differences do not', async () => {
  const twoParams = [{name: 'both', parameters: {ParamArmL: 10, ParamAngleX: 5}}, {name: 'arm-up', parameters: {ParamArmL: 10}}];
  const base = await reportFor(baseSpec(), twoParams);
  const reordered = baseSpec();
  reordered.drawables = [{...reordered.drawables[1], masks: [1]}, reordered.drawables[0]];
  const swappedPoses = [{name: 'arm-up', parameters: {ParamArmL: 10}}, {name: 'both', parameters: {ParamAngleX: 5, ParamArmL: 10}}];
  const c = compareReports(await reportFor(reordered, swappedPoses), base);
  assert.equal(c.classification, 'bytes-changed-poses-identical', JSON.stringify(c.reasons)); assert.equal(c.editProof, false);
  const maskChanged = baseSpec(); maskChanged.drawables[1].masks = [];
  assert.equal(compareReports(await reportFor(maskChanged, twoParams), base).classification, 'incompatible', 'mask difference');
  const uvChanged = baseSpec(); uvChanged.drawables[0].uvs = [0, 0, 0.9, 0, 0, 1];
  assert.equal(compareReports(await reportFor(uvChanged, twoParams), base).classification, 'incompatible', 'UV difference');
  const valueChanged = [{name: 'both', parameters: {ParamArmL: 9, ParamAngleX: 5}}, twoParams[1]];
  assert.equal(compareReports(await reportFor(baseSpec(), valueChanged), base).classification, 'incompatible', 'pose value difference');
});
