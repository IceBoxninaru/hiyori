// Native Cubism export audit: measures a locally exported model3.json + moc3
// through a trusted Cubism Core. Pure library: importing it never runs a CLI,
// never initializes Core and never reads files until a function is called.
//
// Evidence limits (also written into every report):
//  - Snapshots are raw Core deformation only. SDK Pose switching, physics,
//    motions and blinking are not applied.
//  - A digest is not a rendering. Nothing here proves browser rendering,
//    shoulder quality, cmo3 validity, Editor save/reopen or export provenance.
import {createHash} from 'node:crypto';
import {promises as fsp} from 'node:fs';
import path from 'node:path';

export const SCHEMA = 'hiyori-cubism-export-audit/1';
export const LIMITS = Object.freeze({
  modelJsonBytes: 1 << 20, poseJsonBytes: 256 << 10, reportJsonBytes: 32 << 20, assetBytes: 512 << 20,
  poses: 12, poseParameters: 64,
});
export const LIMITATIONS = Object.freeze([
  'Snapshots are raw Core deformation only: SDK Pose switching, physics, motion and blink are not applied.',
  'The original Hiyori pose3 switches arm parts, so the raw Core neutral is not necessarily the visible SDK neutral.',
  'Geometry digests are not renders; they do not prove correct Web or browser rendering.',
  'Numeric differences do not prove shoulder quality, a valid cmo3 edit, Editor save/reopen or SDK export provenance.',
  'invertedVsDefault counts triangles whose orientation flipped against the default pose; internal or hidden overlap is not proof of a visible defect.',
]);
const POSE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EPS_AREA = 1e-9;

export class AuditError extends Error {
  constructor(code, detail = '', ref = null) {
    super(`${code}${ref ? ` ${ref}` : ''}${detail ? `: ${detail}` : ''}`);
    this.code = code; this.detail = detail; this.ref = ref;
  }
}
const fail = (code, detail, ref) => { throw new AuditError(code, detail, ref); };
const errorRecord = e => e instanceof AuditError
  ? {code: e.code, ...(e.ref ? {ref: e.ref} : {}), ...(e.detail ? {detail: e.detail} : {})}
  : {code: 'E_INTERNAL'}; // never leak raw messages/stacks (may hold absolute paths)

export const sha256 = data => createHash('sha256').update(data).digest('hex');

// Reads a file with a hard size bound (checked on the handle actually read).
export async function readBounded(file, limit, code, label) {
  let handle;
  try { handle = await fsp.open(file, 'r'); } catch { fail(code, 'cannot read', label); }
  try {
    const {size} = await handle.stat();
    if (size > limit) fail('E_TOO_LARGE', `${size} > ${limit} bytes`, label);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const {bytesRead} = await handle.read(buffer, offset, size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

async function readJson(file, limit, code, label) {
  const text = (await readBounded(file, limit, code, label)).toString('utf8');
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch { fail(code, 'invalid JSON', label); }
}

// ---- model3.json references --------------------------------------------------

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Validates one model-relative reference string; returns its normalized form.
export function checkReference(ref) {
  if (typeof ref !== 'string' || !ref.length || ref.includes('\0')) fail('E_REF_MALFORMED', 'not a non-empty string', typeof ref === 'string' ? ref : null);
  if (/^[A-Za-z]:/.test(ref) || ref.startsWith('/') || ref.startsWith('\\') || ref.startsWith('//')) fail('E_REF_ABSOLUTE', '', ref);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref)) fail('E_REF_URL', '', ref);
  if (ref.includes('\\')) fail('E_REF_MALFORMED', 'backslash separators are not accepted', ref);
  const normal = path.posix.normalize(ref);
  if (normal === '..' || normal.startsWith('../') || normal === '.') fail('E_REF_ESCAPE', '', ref);
  return normal;
}

// Lists every declared reference as {kind, ref}. Malformed declarations throw.
export function declaredReferences(model3) {
  if (!isObject(model3)) fail('E_MODEL_SCHEMA', 'model3 must be an object');
  if (model3.Version !== 3) fail('E_MODEL_SCHEMA', 'Version must be 3');
  const refs = model3.FileReferences;
  if (!isObject(refs)) fail('E_MODEL_SCHEMA', 'FileReferences missing');
  const out = [];
  const add = (kind, value) => { out.push({kind, ref: checkReference(value)}); };
  if (typeof refs.Moc !== 'string' || !refs.Moc) fail('E_MODEL_SCHEMA', 'FileReferences.Moc must be a non-empty string');
  add('moc', refs.Moc);
  if (!Array.isArray(refs.Textures) || !refs.Textures.length) fail('E_MODEL_SCHEMA', 'FileReferences.Textures must be a non-empty array');
  refs.Textures.forEach(t => add('texture', t));
  for (const [key, kind] of [['Physics', 'physics'], ['Pose', 'pose'], ['DisplayInfo', 'displayInfo'], ['UserData', 'userData'], ['MotionSync', 'motionSync']]) {
    if (key in refs) add(kind, refs[key]);
  }
  if ('Expressions' in refs) {
    if (!Array.isArray(refs.Expressions)) fail('E_REF_MALFORMED', 'Expressions must be an array');
    for (const e of refs.Expressions) {
      if (!isObject(e) || typeof e.Name !== 'string') fail('E_REF_MALFORMED', 'expression entry needs Name and File');
      add('expression', e.File);
    }
  }
  if ('Motions' in refs) {
    if (!isObject(refs.Motions)) fail('E_REF_MALFORMED', 'Motions must be an object of groups');
    for (const [group, list] of Object.entries(refs.Motions)) {
      if (!Array.isArray(list)) fail('E_REF_MALFORMED', `motion group ${group} must be an array`);
      for (const m of list) {
        if (!isObject(m)) fail('E_REF_MALFORMED', `motion entry in ${group}`);
        add('motion', m.File);
        if ('Sound' in m) add('sound', m.Sound);
      }
    }
  }
  return out;
}

// Resolves references inside the real model directory (symlinks resolved first).
export async function resolveReferences(modelDirReal, refs) {
  const resolved = [], errors = [];
  for (const {kind, ref} of refs) {
    const candidate = path.resolve(modelDirReal, ...ref.split('/'));
    let real;
    try { real = await fsp.realpath(candidate); } catch { errors.push({code: 'E_REF_MISSING', ref}); resolved.push({kind, ref, file: null}); continue; }
    const inside = real === modelDirReal || real.startsWith(modelDirReal + path.sep);
    if (!inside) { errors.push({code: 'E_REF_ESCAPE', ref, detail: 'resolves outside the model directory'}); resolved.push({kind, ref, file: null}); continue; }
    const info = await fsp.stat(real);
    if (!info.isFile()) { errors.push({code: 'E_REF_MISSING', ref, detail: 'not a regular file'}); resolved.push({kind, ref, file: null}); continue; }
    resolved.push({kind, ref, file: real});
  }
  return {resolved, errors};
}

// ---- pose input ----------------------------------------------------------------

export function parsePoses(json) {
  if (!isObject(json) || json.version !== 1 || !Array.isArray(json.poses)) fail('E_POSES_SCHEMA', 'expected {"version":1,"poses":[...]}');
  for (const key of Object.keys(json)) if (!['version', 'poses'].includes(key)) fail('E_POSES_SCHEMA', `unknown key ${key}`);
  if (json.poses.length > LIMITS.poses) fail('E_POSES_SCHEMA', `at most ${LIMITS.poses} poses`);
  const names = new Set();
  return json.poses.map(p => {
    if (!isObject(p)) fail('E_POSES_SCHEMA', 'pose must be an object');
    for (const key of Object.keys(p)) if (!['name', 'parameters'].includes(key)) fail('E_POSES_SCHEMA', `unknown pose key ${key}`);
    if (typeof p.name !== 'string' || !POSE_NAME.test(p.name) || p.name === 'default') fail('E_POSE_NAME', 'invalid or reserved name', typeof p.name === 'string' ? p.name.slice(0, 64) : null);
    if (names.has(p.name)) fail('E_POSE_NAME', 'duplicate name', p.name);
    names.add(p.name);
    if (!isObject(p.parameters)) fail('E_POSES_SCHEMA', 'parameters must be an object', p.name);
    const entries = Object.entries(p.parameters);
    if (!entries.length || entries.length > LIMITS.poseParameters) fail('E_POSES_SCHEMA', `1..${LIMITS.poseParameters} parameters`, p.name);
    for (const [id, v] of entries) if (typeof v !== 'number' || !Number.isFinite(v)) fail('E_POSE_VALUE', `non-finite value for ${id}`, p.name);
    return {name: p.name, parameters: Object.fromEntries(entries)};
  });
}

// ---- Core inspection boundary ------------------------------------------------------

const fn = (obj, name) => typeof obj?.[name] === 'function';
const finite = v => typeof v === 'number' && Number.isFinite(v);
const round6 = v => Math.round(v * 1e6) / 1e6;
const floatDigest = arr => sha256(Buffer.from(Float32Array.from(arr).buffer));
const intDigest = arr => sha256(Buffer.from(Uint32Array.from(arr).buffer));

export function coreVersionText(raw) {
  if (!Number.isInteger(raw) || raw < 0) return null;
  return `${raw >>> 24}.${(raw >>> 16) & 0xff}.${raw & 0xffff}`;
}

// Everything the audit reads from Core goes through this function.
// core: Live2DCubismCore namespace (real, or a synthetic fake in tests).
// Returns {core: {...checks}, parameters, parts, structure, poses}. Throws AuditError.
export function inspectMoc(core, mocBytes, {textureCount, poses = []}) {
  const version = fn(core?.Version, 'csmGetVersion') ? core.Version.csmGetVersion() : null;
  const latest = fn(core?.Version, 'csmGetLatestMocVersion') ? core.Version.csmGetLatestMocVersion() : null;
  const buffer = mocBytes.buffer.slice(mocBytes.byteOffset, mocBytes.byteOffset + mocBytes.byteLength);
  const checks = {version: {raw: version, text: coreVersionText(version)}, latestMocVersion: latest, mocVersion: null,
    versionCheck: 'unavailable', consistency: 'unavailable', unavailable: []};
  if (fn(core?.Version, 'csmGetMocVersion')) {
    checks.mocVersion = core.Version.csmGetMocVersion(buffer);
    if (!Number.isInteger(checks.mocVersion) || checks.mocVersion <= 0) fail('E_MOC_INVALID', 'unknown moc3 version');
    if (Number.isInteger(latest)) {
      checks.versionCheck = checks.mocVersion <= latest ? 'passed' : 'failed';
      if (checks.versionCheck === 'failed') fail('E_MOC_UNSUPPORTED', `moc version ${checks.mocVersion} > supported ${latest}`);
    }
  }
  if (checks.versionCheck === 'unavailable') checks.unavailable.push('mocVersion');
  // Consistency is an instance method in the inspected Core; call it the way the
  // official Framework does (through the prototype) and only if it exists.
  const proto = core?.Moc?.prototype;
  if (fn(proto, 'hasMocConsistency')) {
    checks.consistency = proto.hasMocConsistency.call(proto, buffer) === 1 ? 'passed' : 'failed';
    if (checks.consistency === 'failed') fail('E_MOC_INCONSISTENT', 'hasMocConsistency returned false');
  } else checks.unavailable.push('mocConsistency');
  if (!fn(core?.Moc, 'fromArrayBuffer') || !fn(core?.Model, 'fromMoc')) fail('E_CORE_API', 'Moc.fromArrayBuffer/Model.fromMoc missing');

  let moc = null;
  const models = [];
  const instantiate = () => {
    const model = core.Model.fromMoc(moc);
    if (!model) fail('E_MODEL_INSTANTIATE', 'Model.fromMoc returned null');
    models.push(model);
    return model;
  };
  try {
    moc = core.Moc.fromArrayBuffer(buffer);
    if (!moc) fail('E_MOC_INVALID', 'Moc.fromArrayBuffer returned null');
    // Native initial state from a freshly instantiated model.
    const first = instantiate();
    const p = first.parameters;
    const parameters = [...p.ids].map((id, i) => ({id, min: p.minimumValues[i], max: p.maximumValues[i], default: p.defaultValues[i]}));
    const initialValues = Float64Array.from(p.values);
    const partIds = [...first.parts.ids], initialPartOpacities = Float64Array.from(first.parts.opacities);
    validateParameters(parameters, initialValues);
    for (const [i, o] of initialPartOpacities.entries()) if (!finite(o)) fail('E_STRUCTURE', 'non-finite part opacity', partIds[i]);
    const byId = new Map(parameters.map((q, i) => [q.id, {...q, index: i}]));
    for (const pose of poses) for (const [id, v] of Object.entries(pose.parameters)) {
      const q = byId.get(id);
      if (!q) fail('E_POSE_UNKNOWN_PARAM', `unknown parameter ${id}`, pose.name);
      if (v < q.min || v > q.max) fail('E_POSE_RANGE', `${id}=${v} outside [${q.min}, ${q.max}]`, pose.name);
    }
    releaseModel(models.pop());

    // Every pose (default first) uses its own fresh model: results cannot depend
    // on pose order, and the initial state is re-verified against the capture.
    let structure = null, defaultAreas = null;
    const measured = [];
    for (const pose of [{name: 'default', parameters: {}}, ...poses]) {
      const model = instantiate();
      try {
        const values = model.parameters.values, opacities = model.parts.opacities;
        for (let i = 0; i < initialValues.length; i++) if (!Object.is(values[i], initialValues[i])) fail('E_CORE_STATE', 'fresh model parameters differ from the native initial state', pose.name);
        for (let i = 0; i < initialPartOpacities.length; i++) if (!Object.is(opacities[i], initialPartOpacities[i])) fail('E_CORE_STATE', 'fresh model part opacities differ from the native initial state', pose.name);
        for (const [id, v] of Object.entries(pose.parameters)) {
          const i = byId.get(id).index;
          values[i] = v;
          if (Math.abs(values[i] - v) > 1e-6 * Math.max(1, Math.abs(v))) fail('E_POSE_RANGE', `Core did not accept ${id}=${v}`, pose.name);
        }
        model.update();
        const snapshot = readDrawables(model, textureCount);
        if (!structure) {
          structure = snapshot.structure;
          defaultAreas = snapshot.areas;
        } else if (snapshot.structure.signature !== structure.signature) fail('E_STRUCTURE', 'topology changed between poses', pose.name);
        measured.push(poseRecord(pose, snapshot, defaultAreas, model));
      } finally { releaseModel(models.pop()); }
    }
    const coreRecord = {...checks};
    return {core: coreRecord, parameters, parts: {count: partIds.length, ids: partIds, initialOpacityDigest: floatDigest(initialPartOpacities)},
      structure: {drawableCount: structure.drawables.length, signature: structure.signature, drawables: structure.drawables, renderOrderSource: structure.renderOrderSource},
      poses: measured};
  } finally {
    while (models.length) releaseModel(models.pop());
    if (moc && fn(moc, '_release')) { try { moc._release(); } catch { /* ignore */ } }
  }
}

function releaseModel(model) {
  if (model && fn(model, 'release')) { try { model.release(); } catch { /* ignore */ } }
}

function validateParameters(parameters, initialValues) {
  const seen = new Set();
  for (const [i, q] of parameters.entries()) {
    if (typeof q.id !== 'string' || !q.id || seen.has(q.id)) fail('E_STRUCTURE', 'invalid or duplicate parameter id', typeof q.id === 'string' ? q.id : null);
    seen.add(q.id);
    if (![q.min, q.max, q.default, initialValues[i]].every(finite) || q.min > q.max || q.default < q.min || q.default > q.max) fail('E_STRUCTURE', 'incoherent parameter range/default', q.id);
  }
}

function readDrawables(model, textureCount) {
  const d = model.drawables;
  const count = d.count;
  if (!Number.isInteger(count) || count < 0) fail('E_STRUCTURE', 'invalid drawable count');
  let orders = null, renderOrderSource = 'unavailable';
  if (fn(model, 'getRenderOrders')) { orders = model.getRenderOrders(); renderOrderSource = 'model.getRenderOrders'; }
  else if (d.renderOrders) { orders = d.renderOrders; renderOrderSource = 'drawables.renderOrders'; }
  const ids = new Set(), drawables = [], dynamic = [], areas = [];
  for (let i = 0; i < count; i++) {
    const id = d.ids[i];
    if (typeof id !== 'string' || !id || ids.has(id)) fail('E_STRUCTURE', 'invalid or duplicate drawable id', typeof id === 'string' ? id : null);
    ids.add(id);
    const xy = d.vertexPositions[i], uv = d.vertexUvs[i], idx = d.indices[i];
    if (!xy || xy.length % 2 || !uv || uv.length !== xy.length) fail('E_STRUCTURE', 'XY/UV length mismatch', id);
    const n = xy.length / 2;
    for (let k = 0; k < xy.length; k++) if (!finite(xy[k]) || !finite(uv[k])) fail('E_STRUCTURE', 'non-finite vertex or UV', id);
    if (!idx || idx.length % 3) fail('E_STRUCTURE', 'index count not a multiple of 3', id);
    for (let k = 0; k < idx.length; k++) if (!Number.isInteger(idx[k]) || idx[k] < 0 || idx[k] >= n) fail('E_STRUCTURE', 'triangle index out of bounds', id);
    const texture = d.textureIndices[i];
    if (!Number.isInteger(texture) || texture < 0 || texture >= textureCount) fail('E_STRUCTURE', `texture index ${texture} not in model3 Textures`, id);
    const masks = [...(d.masks?.[i] ?? [])];
    for (const m of masks) if (!Number.isInteger(m) || m < 0 || m >= count || m === i) fail('E_STRUCTURE', 'invalid mask reference', id);
    const opacity = d.opacities?.[i];
    if (!finite(opacity)) fail('E_STRUCTURE', 'non-finite drawable opacity', id);
    const tri = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < xy.length; k += 2) { minX = Math.min(minX, xy[k]); maxX = Math.max(maxX, xy[k]); minY = Math.min(minY, xy[k + 1]); maxY = Math.max(maxY, xy[k + 1]); }
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 2, b = idx[k + 1] * 2, c = idx[k + 2] * 2;
      tri.push((xy[b] - xy[a]) * (xy[c + 1] - xy[a + 1]) - (xy[c] - xy[a]) * (xy[b + 1] - xy[a + 1]));
    }
    areas.push(tri);
    drawables.push({id, vertexCount: n, indexCount: idx.length, topologySha: intDigest(idx), uvSha: floatDigest(uv), texture, masks: masks.map(m => d.ids[m])});
    dynamic.push({id, geometrySha: floatDigest(xy), bbox: n ? [minX, minY, maxX, maxY].map(round6) : null, opacity: round6(opacity),
      renderOrder: orders ? orders[i] : null});
  }
  const signature = sha256(JSON.stringify(drawables));
  return {structure: {drawables, signature, renderOrderSource}, dynamic, areas};
}

function poseRecord(pose, snapshot, defaultAreas, model) {
  const drawables = snapshot.dynamic.map((dyn, i) => {
    let inverted = 0;
    const now = snapshot.areas[i], base = defaultAreas[i];
    for (let k = 0; k < now.length; k++) if (Math.abs(now[k]) > EPS_AREA && Math.abs(base[k]) > EPS_AREA && Math.sign(now[k]) !== Math.sign(base[k])) inverted++;
    return {...dyn, invertedVsDefault: inverted};
  });
  const partOpacities = Float64Array.from(model.parts.opacities);
  return {name: pose.name, parameters: pose.parameters,
    geometrySignature: sha256(drawables.map(d => d.geometrySha).join('')),
    stateSignature: sha256(JSON.stringify(drawables.map(d => [d.id, d.opacity, d.renderOrder])) + floatDigest(partOpacities)),
    drawables};
}

// ---- comparison ----------------------------------------------------------------------

// Classifies current vs baseline. Result is never "passed" when evidence is missing.
export function compareReports(current, baseline) {
  const out = {classification: null, reasons: [], editProof: false, changedPoses: []};
  const incompatible = reason => { out.classification = 'incompatible'; out.reasons.push(reason); return out; };
  if (!isObject(baseline) || baseline.schema !== SCHEMA) return incompatible('baseline schema differs or is missing');
  if (!Array.isArray(baseline.poses) || !Array.isArray(baseline.references)) return incompatible('baseline is missing poses or references');
  if (baseline.status !== 'ok' || current.status !== 'ok') return incompatible('both reports must have status ok');
  if (baseline.core?.sha256 !== current.core?.sha256 || baseline.core?.version?.raw !== current.core?.version?.raw) return incompatible('different trusted Core file or version');
  const poseKey = r => JSON.stringify(r.poses.map(p => [p.name, p.parameters]));
  if (poseKey(baseline) !== poseKey(current)) return incompatible('different pose inputs');
  if (baseline.structure?.signature !== current.structure?.signature) return incompatible('different drawable identity/topology/UV/texture/mask structure');
  const mocSha = r => r.references.find(x => x.kind === 'moc')?.sha256;
  out.mocBytesIdentical = mocSha(baseline) === mocSha(current);
  for (const pose of current.poses) {
    const before = new Map(baseline.poses.find(p => p.name === pose.name).drawables.map(d => [d.id, d]));
    const geometry = [], state = [];
    for (const d of pose.drawables) {
      const b = before.get(d.id);
      if (b.geometrySha !== d.geometrySha) geometry.push({id: d.id, bboxBefore: b.bbox, bboxAfter: d.bbox, invertedBefore: b.invertedVsDefault, invertedAfter: d.invertedVsDefault});
      if (b.opacity !== d.opacity || b.renderOrder !== d.renderOrder) state.push(d.id);
    }
    if (geometry.length || state.length) out.changedPoses.push({name: pose.name, geometryChanged: geometry, opacityOrOrderChanged: state});
  }
  const requestedGeometry = out.changedPoses.some(p => p.name !== 'default' && p.geometryChanged.length);
  if (out.mocBytesIdentical) out.classification = 'identical-moc';
  else if (!out.changedPoses.some(p => p.geometryChanged.length)) out.classification = out.changedPoses.length ? 'bytes-changed-state-only' : 'bytes-changed-poses-identical';
  else out.classification = 'geometry-changed';
  out.editProof = requestedGeometry;
  if (!requestedGeometry) out.reasons.push('no requested (non-default) pose changed actual geometry');
  out.note = 'Changed drawable IDs are listed as evidence only; they do not by themselves show which body part was repaired or that it improved.';
  return out;
}

// ---- orchestration ---------------------------------------------------------------------

async function realOrNull(file) { try { return await fsp.realpath(file); } catch { return null; } }

// options: {modelPath, outPath, posesPath?, baselinePath?, requirePoseChange?, loadCore}
// loadCore(): Promise<{core, sha256}> - the trusted Core and the SHA-256 of its file.
// Returns {report, exitCode, writeTo}. Writes nothing itself; writeTo is null
// when the output path was not (or could not be) proven safe.
export async function runAudit({modelPath, outPath, posesPath = null, baselinePath = null, requirePoseChange = false, loadCore}) {
  const report = {schema: SCHEMA, status: 'failed', errors: [], model: path.basename(String(modelPath ?? '')), references: [], core: null,
    coreCompatible: false, parameters: [], parts: null, structure: null, poses: [], comparison: null, limitations: LIMITATIONS};
  let writeTo = null; // set only after the output path is proven not to alias an input
  const done = code => ({report, exitCode: code, writeTo});
  try {
    if (!modelPath || !outPath) fail('E_USAGE', '--model and --out are required');
    const modelReal = await realOrNull(modelPath);
    if (!modelReal) fail('E_MODEL_READ', 'model3.json not found', report.model);
    const modelDir = path.dirname(modelReal);
    const model3 = await readJson(modelReal, LIMITS.modelJsonBytes, 'E_MODEL_JSON', report.model);
    const {resolved, errors} = await resolveReferences(modelDir, declaredReferences(model3));

    // Output must not alias the model, any reference, the pose or baseline file.
    const outParent = await realOrNull(path.dirname(path.resolve(outPath)));
    if (!outParent) fail('E_OUT_PATH', 'output directory does not exist', path.basename(outPath));
    const outReal = (await realOrNull(outPath)) ?? path.join(outParent, path.basename(outPath));
    const inputs = [modelReal, ...resolved.map(r => r.file).filter(Boolean)];
    for (const extra of [posesPath, baselinePath]) if (extra) { const real = await realOrNull(extra); if (real) inputs.push(real); }
    if (inputs.includes(outReal)) fail('E_OUT_ALIAS', 'output would overwrite an input file', path.basename(outPath));
    writeTo = outReal;

    for (const r of resolved) {
      const entry = {kind: r.kind, ref: r.ref, bytes: null, sha256: null};
      if (r.file) { const data = await readBounded(r.file, LIMITS.assetBytes, 'E_REF_MISSING', r.ref); entry.bytes = data.length; entry.sha256 = sha256(data); }
      report.references.push(entry);
    }
    if (errors.length) { report.errors.push(...errors); return done(2); }

    const poses = posesPath ? parsePoses(await readJson(posesPath, LIMITS.poseJsonBytes, 'E_POSES_READ', path.basename(posesPath))) : [];
    const baseline = baselinePath ? await readJson(baselinePath, LIMITS.reportJsonBytes, 'E_BASELINE_READ', path.basename(baselinePath)) : null;
    if (requirePoseChange && (!baseline || !poses.length)) fail('E_REQUIRE_POSE_CHANGE', '--require-pose-change needs --baseline and --poses');

    let loaded;
    try { loaded = await loadCore(); } catch { fail('E_CORE_INIT', 'trusted Core could not be initialized'); }
    const mocRef = resolved.find(r => r.kind === 'moc');
    const mocBytes = await readBounded(mocRef.file, LIMITS.assetBytes, 'E_REF_MISSING', mocRef.ref);
    const textureCount = resolved.filter(r => r.kind === 'texture').length;
    const inspected = inspectMoc(loaded.core, mocBytes, {textureCount, poses});
    report.core = {sha256: loaded.sha256, ...inspected.core};
    report.coreCompatible = true; // consistency/version results listed; unavailable checks are named in core.unavailable
    Object.assign(report, {parameters: inspected.parameters, parts: inspected.parts, structure: inspected.structure, poses: inspected.poses});
    report.status = 'ok';
    if (baseline) {
      try { report.comparison = compareReports(report, baseline); }
      catch { report.comparison = {classification: 'incompatible', reasons: ['baseline report is malformed'], editProof: false, changedPoses: []}; }
      if (requirePoseChange && !report.comparison.editProof) {
        report.errors.push({code: 'E_REQUIRE_POSE_CHANGE', detail: report.comparison.reasons.join('; ')});
        return done(3);
      }
    }
    return done(0);
  } catch (error) {
    report.status = 'failed';
    report.coreCompatible = false;
    report.errors.push(errorRecord(error));
    return done(error?.code === 'E_USAGE' ? 64 : 2);
  }
}
