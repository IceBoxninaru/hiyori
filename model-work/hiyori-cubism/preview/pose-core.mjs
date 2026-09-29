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

// Replaces the SDK wrapper's per-frame update with: reset -> apply pose -> Core update.
// No motion, expression, blink, breath, physics, SDK Pose or focus runs.
export function installDeterministicUpdate(internalModel, rawModel, state, getPose, onApplied = () => {}) {
  const coreModel = internalModel.coreModel;
  internalModel.update = function deterministicRawCoreUpdate() {
    onApplied(applyPose(rawModel, state, getPose()));
    if (fn(coreModel, 'update')) coreModel.update(); else rawModel.update();
  };
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
