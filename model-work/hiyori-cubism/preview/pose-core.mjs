// Pure pose helpers for the native preview (browser + Node tests). No DOM, no I/O.
// Operates on a raw Live2DCubismCore namespace/model; never clamps values.

export class PreviewError extends Error {
  constructor(code, detail = '') { super(detail ? `${code}: ${detail}` : code); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new PreviewError(code, detail); };
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
export const safeId = v => typeof v === 'string' && SAFE_ID.test(v) ? v : '<redacted>';
const fn = (o, n) => typeof o?.[n] === 'function';

// Reads the declared state from a SEPARATE fresh raw Core model and releases it.
// Returns {version, mocVersion, parameters:[{id,min,max,default}], parts:[{id,initial}],
//          drawableIds, canvas:{width,height,pixelsPerUnit,originX,originY}}.
export function readDeclaredState(core, mocBuffer) {
  if (!fn(core?.Moc, 'fromArrayBuffer') || !fn(core?.Model, 'fromMoc')) fail('E_CORE_API', 'Moc.fromArrayBuffer/Model.fromMoc missing');
  const proto = core.Moc.prototype;
  if (fn(proto, 'hasMocConsistency') && proto.hasMocConsistency(mocBuffer) !== 1) fail('E_MOC_INCONSISTENT');
  let moc = null, model = null;
  try {
    moc = core.Moc.fromArrayBuffer(mocBuffer);
    if (!moc) fail('E_MOC_INVALID', 'Moc.fromArrayBuffer returned null');
    let mocVersion = null;
    if (fn(core.Version, 'csmGetMocVersion')) {
      mocVersion = core.Version.csmGetMocVersion(moc, mocBuffer);
      const latest = fn(core.Version, 'csmGetLatestMocVersion') ? core.Version.csmGetLatestMocVersion() : null;
      if (Number.isInteger(latest) && mocVersion > latest) fail('E_MOC_UNSUPPORTED', `moc version ${mocVersion} > ${latest}`);
    }
    model = core.Model.fromMoc(moc);
    if (!model) fail('E_MODEL_INSTANTIATE', 'Model.fromMoc returned null');
    const p = model.parameters;
    const parameters = [...p.ids].map((id, i) => ({id, min: p.minimumValues[i], max: p.maximumValues[i], default: p.defaultValues[i]}));
    const seen = new Set();
    for (const q of parameters) {
      if (typeof q.id !== 'string' || seen.has(q.id)) fail('E_STRUCTURE', `invalid or duplicate parameter ${safeId(q.id)}`);
      seen.add(q.id);
      if (![q.min, q.max, q.default].every(Number.isFinite) || q.min > q.max || q.default < q.min || q.default > q.max) fail('E_STRUCTURE', `incoherent parameter ${safeId(q.id)}`);
    }
    const parts = [...model.parts.ids].map((id, i) => ({id, initial: model.parts.opacities[i]}));
    for (const part of parts) if (!Number.isFinite(part.initial)) fail('E_STRUCTURE', `non-finite part opacity ${safeId(part.id)}`);
    const c = model.canvasinfo ?? {};
    const canvas = {width: c.CanvasWidth, height: c.CanvasHeight, pixelsPerUnit: c.PixelsPerUnit, originX: c.CanvasOriginX, originY: c.CanvasOriginY};
    if (!(canvas.width > 0 && canvas.height > 0)) fail('E_STRUCTURE', 'invalid canvas info');
    const version = fn(core.Version, 'csmGetVersion') ? core.Version.csmGetVersion() : null;
    return {version, mocVersion, parameters, parts, drawableIds: [...model.drawables.ids], canvas};
  } finally {
    try { model?.release?.(); } catch { /* ignore */ }
    try { moc?._release?.(); } catch { /* ignore */ }
  }
}

// ---- preview pose files -------------------------------------------------------------
// v1 (shared with the audit): {"version":1,"poses":[{"name","parameters":{id:value}}]},
//     the same values applied to both models. Parsed by the audit's parsePoses.
// v2 (preview only): {"version":2,"poses":[{"name","models":{"before":{"parameters":{}},
//     "after":{"parameters":{}}}}]} - explicit values per model. Both branches are required;
//     an empty parameters map is allowed only here and means "all declared defaults".
export const SLOT_NAMES = Object.freeze(['before', 'after']);
export const POSE_LIMITS = Object.freeze({poses: 12, parameters: 64});
const POSE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sortedEntries = obj => Object.entries(obj).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

export function parsePosesV2(json) {
  if (!isPlainObject(json) || json.version !== 2 || !Array.isArray(json.poses)) fail('E_POSES_SCHEMA', 'expected {"version":2,"poses":[...]}');
  for (const key of Object.keys(json)) if (!['version', 'poses'].includes(key)) fail('E_POSES_SCHEMA', `unknown key ${safeId(key)}`);
  if (json.poses.length > POSE_LIMITS.poses) fail('E_POSES_SCHEMA', `at most ${POSE_LIMITS.poses} poses`);
  const names = new Set();
  return json.poses.map((pose, index) => {
    if (!isPlainObject(pose)) fail('E_POSES_SCHEMA', `pose[${index}] must be an object`);
    for (const key of Object.keys(pose)) if (!['name', 'models'].includes(key)) fail('E_POSES_SCHEMA', `pose[${index}]: unknown key ${safeId(key)}`);
    if (typeof pose.name !== 'string' || !POSE_NAME.test(pose.name) || pose.name === 'default') fail('E_POSE_NAME', `pose[${index}]: invalid or reserved name`);
    if (names.has(pose.name)) fail('E_POSE_NAME', `pose ${pose.name}: duplicate name`);
    names.add(pose.name);
    if (!isPlainObject(pose.models)) fail('E_POSES_SCHEMA', `pose ${pose.name}: models must be an object`);
    for (const key of Object.keys(pose.models)) if (!SLOT_NAMES.includes(key)) fail('E_POSES_SCHEMA', `pose ${pose.name}: unknown model branch ${safeId(key)}`);
    const models = {};
    for (const slot of SLOT_NAMES) {
      const branch = pose.models[slot];
      if (!isPlainObject(branch)) fail('E_POSES_SCHEMA', `pose ${pose.name}: missing model branch ${slot}`);
      for (const key of Object.keys(branch)) if (key !== 'parameters') fail('E_POSES_SCHEMA', `pose ${pose.name}.${slot}: unknown key ${safeId(key)}`);
      if (!isPlainObject(branch.parameters)) fail('E_POSES_SCHEMA', `pose ${pose.name}.${slot}: parameters must be an object`);
      const entries = sortedEntries(branch.parameters);
      if (entries.length > POSE_LIMITS.parameters) fail('E_POSES_SCHEMA', `pose ${pose.name}.${slot}: at most ${POSE_LIMITS.parameters} parameters`);
      for (const [id, value] of entries) {
        if (safeId(id) !== id) fail('E_POSE_PARAM_ID', `pose ${pose.name}.${slot}: malformed parameter id (value redacted)`);
        if (typeof value !== 'number' || !Number.isFinite(value)) fail('E_POSE_VALUE', `pose ${pose.name}.${slot}: non-finite value for ${id}`);
      }
      models[slot] = {parameters: Object.fromEntries(entries)};
    }
    return {name: pose.name, version: 2, models};
  });
}

// v1 poses (already parsed by the audit) as per-model poses with identical values.
export function sharedPosesAsModels(poses) {
  return poses.map(p => ({name: p.name, version: 1, models: Object.fromEntries(SLOT_NAMES.map(slot => [slot, {parameters: {...p.parameters}}]))}));
}

// The pose one slot renders: {name, parameters} for applyPose/validatePoseForModel.
export function poseForSlot(pose, slot) {
  const branch = pose?.models?.[slot];
  if (!branch) fail('E_POSES_SCHEMA', `pose ${pose?.name ?? '?'}: missing model branch ${slot}`);
  return {name: pose.name, parameters: branch.parameters};
}

// Validates a parsed pose ({name, parameters}) against a model's declared state.
export function validatePoseForModel(pose, state) {
  const byId = new Map(state.parameters.map(q => [q.id, q]));
  for (const [id, v] of Object.entries(pose.parameters)) {
    const q = byId.get(id);
    if (!q) fail('E_POSE_UNKNOWN_PARAM', `${pose.name}: unknown parameter ${safeId(id)}`);
    if (typeof v !== 'number' || !Number.isFinite(v)) fail('E_POSE_VALUE', `${pose.name}: non-finite ${safeId(id)}`);
    if (v < q.min || v > q.max) fail('E_POSE_RANGE', `${pose.name}: ${id}=${v} outside [${q.min}, ${q.max}]`);
  }
}

// Resets EVERY parameter and part opacity to the captured declared state, then
// applies the named values. rawModel: Live2DCubismCore.Model (live values arrays).
// Returns the applied values read back from Core.
export function applyPose(rawModel, state, pose) {
  const values = rawModel.parameters.values, ids = rawModel.parameters.ids;
  if (values.length !== state.parameters.length) fail('E_STATE_MISMATCH', 'parameter count differs from declared state');
  state.parameters.forEach((q, i) => {
    if (ids[i] !== q.id) fail('E_STATE_MISMATCH', 'parameter order differs from declared state');
    values[i] = q.default;
  });
  const opacities = rawModel.parts.opacities;
  if (opacities.length !== state.parts.length) fail('E_STATE_MISMATCH', 'part count differs from declared state');
  state.parts.forEach((part, i) => { opacities[i] = part.initial; });
  const index = new Map(state.parameters.map((q, i) => [q.id, i]));
  const applied = {};
  for (const [id, v] of Object.entries(pose.parameters)) {
    const i = index.get(id);
    if (i === undefined) fail('E_POSE_UNKNOWN_PARAM', `${pose.name}: unknown parameter ${safeId(id)}`);
    values[i] = v;
    if (Math.abs(values[i] - v) > 1e-6 * Math.max(1, Math.abs(v))) fail('E_POSE_RANGE', `${pose.name}: Core did not accept ${id}=${v}`);
    applied[id] = values[i];
  }
  return applied;
}

// Non-default part opacities after a render (diagnostic).
export function partOpacityDiff(rawModel, state) {
  const out = [];
  state.parts.forEach((part, i) => { const v = rawModel.parts.opacities[i]; if (v !== part.initial) out.push({id: part.id, initial: part.initial, now: v}); });
  return out;
}

// Replaces the SDK wrapper's per-frame update with a deterministic still-image step.
//
// raw-core (sdkPose = null):
//   1. reset every parameter/part opacity to the declared state, apply the named values
//   2. Core update
// sdk-pose (sdkPose = the wrapper's CubismPose, internalModel.pose):
//   1. same reset + named values
//   2. sdkPose.reset(coreModel): re-initializes every pose group (first part visible) and the
//      pose switch parameters, including framework-side ones a raw reset cannot reach
//   3. re-apply the named values, so explicit pose-file values win over the switch reset
//   4. mark coreModel as the pose's last model, so updateParameters does not run a second,
//      hidden reset on its first call (that would make the first render differ from later ones)
//   5. sdkPose.updateParameters(coreModel, settle): the real SDK fade plus link copying.
//      settle comes from the loaded pose's own fade time (CubismPose._fadeTimeSeconds, set
//      from pose3 FadeInTime, SDK default 0.5 s when <= 0): doFade adds dt / fadeTime to
//      the visible part's opacity, so dt = 2 x fadeTime takes any part from 0 to 1 in one
//      call, and hidden parts then drop to 0.
//   6. Core update
// Motion, expression, blink, breath, physics and focus never run.
export function sdkPoseSettleSeconds(sdkPose) {
  const fade = sdkPose?._fadeTimeSeconds;
  if (typeof fade !== 'number' || !Number.isFinite(fade) || fade <= 0) fail('E_SDK_POSE_FADE', 'CubismPose fade time unavailable or not a finite positive number');
  const settle = fade * 2;
  if (!Number.isFinite(settle)) fail('E_SDK_POSE_FADE', 'CubismPose fade time too large to settle');
  return settle;
}

// Every part ID a pose addresses must be a real part of the moc3. CubismPose resolves
// unknown IDs to dummy indices, so a missing part would otherwise load and "run" silently.
export function checkPosePartIds(posePartIds, state) {
  const known = new Set(state.parts.map(p => p.id));
  for (const [g, group] of (posePartIds?.groups ?? []).entries()) {
    for (const id of group) if (!known.has(id)) fail('E_POSE_PART_UNKNOWN', `pose group ${g}: part ${safeId(id)} is not a part of this moc3`);
  }
  for (const {from, to} of posePartIds?.links ?? []) {
    if (!known.has(to)) fail('E_POSE_PART_UNKNOWN', `pose link from ${safeId(from)}: part ${safeId(to)} is not a part of this moc3`);
  }
  if (!posePartIds?.groups?.length) fail('E_POSE_PART_UNKNOWN', 'pose declares no part groups');
}

// Part IDs held by a loaded CubismPose (pinned framework: _partGroups[].partId / .link[].partId,
// _partGroupCounts). Returns null when those fields are not present.
export function posePartIdsFromCubismPose(sdkPose) {
  const parts = sdkPose?._partGroups, counts = sdkPose?._partGroupCounts;
  if (!Array.isArray(parts) || !Array.isArray(counts)) return null;
  const groups = [], links = [];
  let begin = 0;
  for (const count of counts) {
    const group = parts.slice(begin, begin + count);
    groups.push(group.map(p => p.partId));
    for (const p of group) for (const link of p.link ?? []) links.push({from: p.partId, to: link.partId});
    begin += count;
  }
  return {groups, links};
}

export function installDeterministicUpdate(internalModel, rawModel, state, getPose, onApplied = () => {}, {sdkPose = null, onPoseStep = () => {}} = {}) {
  const coreModel = internalModel.coreModel;
  if (sdkPose && !(fn(sdkPose, 'reset') && fn(sdkPose, 'updateParameters'))) fail('E_SDK_POSE_UNAVAILABLE', 'CubismPose reset/updateParameters not available');
  if (sdkPose) sdkPoseSettleSeconds(sdkPose); // fail at install, not on first render
  internalModel.update = function deterministicStillUpdate() {
    const pose = getPose();
    applyPose(rawModel, state, pose);
    if (sdkPose) {
      sdkPose.reset(coreModel);
      reapplyNamed(rawModel, state, pose);
      sdkPose._lastModel = coreModel;
      const settle = sdkPoseSettleSeconds(sdkPose);
      sdkPose.updateParameters(coreModel, settle);
      onPoseStep({ran: true, settleSeconds: settle});
    }
    onApplied(readBack(rawModel, state, pose));
    if (fn(coreModel, 'update')) coreModel.update(); else rawModel.update();
  };
}

function reapplyNamed(rawModel, state, pose) {
  const index = new Map(state.parameters.map((q, i) => [q.id, i]));
  for (const [id, v] of Object.entries(pose.parameters)) rawModel.parameters.values[index.get(id)] = v;
}

function readBack(rawModel, state, pose) {
  const index = new Map(state.parameters.map((q, i) => [q.id, i]));
  return Object.fromEntries(Object.keys(pose.parameters).map(id => [id, rawModel.parameters.values[index.get(id)]]));
}

// All part opacities after a render, by part ID (diagnostic).
export function partOpacities(rawModel, state) {
  return Object.fromEntries(state.parts.map((part, i) => [part.id, rawModel.parts.opacities[i]]));
}

// Differences that make before/after geometry non-comparable by identity.
export function topologyNotes(a, b) {
  const notes = [];
  const idsA = new Set(a.drawableIds), idsB = new Set(b.drawableIds);
  const onlyA = [...idsA].filter(id => !idsB.has(id)), onlyB = [...idsB].filter(id => !idsA.has(id));
  if (onlyA.length || onlyB.length) notes.push(`drawable IDs differ (${onlyA.length} only before, ${onlyB.length} only after)`);
  const pa = a.parameters.map(q => q.id).join('\n'), pb = b.parameters.map(q => q.id).join('\n');
  if (pa !== pb) notes.push('parameter IDs/order differ');
  if (a.canvas.width !== b.canvas.width || a.canvas.height !== b.canvas.height) notes.push('model canvas size differs; the before camera is still used for both');
  return notes;
}

// Shared camera: derived ONCE from the before canvas (or explicit config), never per pose.
export function deriveCamera(canvas, view, config = null) {
  const zoom = config?.zoom ?? 1, cx = config?.centerX ?? 0.5, cy = config?.centerY ?? 0.5;
  for (const v of [zoom, cx, cy]) if (!Number.isFinite(v)) fail('E_CAMERA', 'non-finite camera value');
  if (zoom <= 0) fail('E_CAMERA', 'zoom must be > 0');
  const scale = Math.min(view.width / canvas.width, view.height / canvas.height) * zoom;
  return Object.freeze({scale, x: view.width / 2 - cx * canvas.width * scale, y: view.height / 2 - cy * canvas.height * scale,
    canvasWidth: canvas.width, canvasHeight: canvas.height, viewWidth: view.width, viewHeight: view.height, zoom, centerX: cx, centerY: cy});
}

// Normalized before-canvas rect -> view pixel rect under the shared camera.
export function cropToView(camera, crop) {
  return {x: camera.x + crop.x * camera.canvasWidth * camera.scale, y: camera.y + crop.y * camera.canvasHeight * camera.scale,
    w: crop.w * camera.canvasWidth * camera.scale, h: crop.h * camera.canvasHeight * camera.scale};
}
