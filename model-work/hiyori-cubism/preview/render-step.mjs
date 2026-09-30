// Rendering and ownership helpers for the native preview (browser + Node tests).
// One WebGL renderer and one stage are shared by both models: Cubism's WebGL
// shader state in pixi-live2d-display is tied to one GL context, so two Pixi
// applications can leave one canvas blank. Each slot is rendered alone and the
// result is copied into that slot's 2D canvas.

// pixi-live2d-display 0.4.0 only runs internalModel.update from _render when the
// model's accumulated deltaTime is non-zero, and deltaTime only grows through
// model.update(dt). A fixed positive step is therefore applied before every
// intended render; the installed deterministic update ignores its value.
export const FIXED_UPDATE_MS = 1000 / 60;

export function renderSlotOnce({renderer, stage, records, slot, copy}) {
  const record = records[slot];
  if (!record?.model) throw Object.assign(new Error('E_RENDER_STATE'), {code: 'E_RENDER_STATE', detail: `no model for ${slot}`});
  for (const [name, r] of Object.entries(records)) if (r?.model) r.model.visible = name === slot;
  record.model.update(FIXED_UPDATE_MS);
  renderer.render(stage);
  copy(renderer.view); // copy immediately after this render, before the next slot draws
}

// Removes cached textures for exact URLs (and their absolute forms). Entries in
// `alreadyDestroyed` are only unlinked from the cache, never destroyed twice.
export function purgeTextureCache(caches, urls, base = null, alreadyDestroyed = new Set()) {
  const keys = new Set();
  for (const url of urls) {
    keys.add(url);
    if (base) { try { keys.add(new URL(url, base).href); } catch { /* ignore */ } }
  }
  let purged = 0;
  for (const cache of caches) {
    if (!cache) continue;
    for (const key of keys) {
      const entry = cache[key];
      if (!entry) continue;
      delete cache[key];
      if (!alreadyDestroyed.has(entry)) { try { entry.destroy?.(true); } catch { /* ignore */ } alreadyDestroyed.add(entry); }
      purged++;
    }
  }
  return purged;
}

// Loads a model with EXPLICIT instance ownership instead of Live2DModel.from, so a
// rejected setup cannot hide a partially created model/Core or its textures.
// Returns {model, textures, textureTasks, urls} or null when superseded; on
// rejection everything created so far is disposed and the error is rethrown.
export async function loadOwnedModel({PIXI, settings, options, urls, isCurrent, dispose, onCreate = () => {}}) {
  const model = new PIXI.live2d.Live2DModel(options);
  const record = {model, textures: new Set(), textureTasks: [], urls, disposed: false};
  onCreate(model, record); // attach listeners before setup emits load events
  model.once('settingsLoaded', loaded => {
    for (const file of loaded.textures) {
      const url = loaded.resolveURL(file);
      record.textures.add(PIXI.Texture.from(url, {resourceOptions: {autoLoad: false}}, false));
      record.textureTasks.push(PIXI.Texture.fromURL(url).then(texture => { record.textures.add(texture); }, () => {}));
    }
  });
  try {
    await PIXI.live2d.Live2DFactory.setupLive2DModel(model, settings, options);
  } catch (error) {
    await dispose(record);
    throw error;
  }
  if (!isCurrent()) { await dispose(record); return null; }
  return record;
}

// Destroys one slot's model (including a partially created Core) and every texture it
// owns, once, after pending image work settles; then purges its URLs. Idempotent.
// containerDestroy: PIXI.Container.prototype.destroy, used when no internalModel exists.
export async function disposeRecord(record, {purge = () => {}, containerDestroy = null} = {}) {
  if (!record || record.disposed) return;
  record.disposed = true;
  await Promise.allSettled(record.textureTasks ?? []);
  const model = record.model;
  const textures = new Set(record.textures ?? []);
  for (const texture of model?.textures ?? []) textures.add(texture);
  if (model) {
    try { model.parent?.removeChild?.(model); } catch { /* ignore */ }
    try { model.textures = []; } catch { /* ignore */ } // textures are destroyed below, exactly once
    try {
      if (model.internalModel) model.destroy({children: true});
      else {
        model.emit?.('destroy');
        model.autoUpdate = false;
        model.unregisterInteraction?.();
        containerDestroy?.call(model, {children: true});
      }
    } catch { /* ignore */ }
  }
  for (const texture of textures) { try { texture.destroy?.(true); } catch { /* ignore */ } }
  try { purge(record.urls ?? [], textures); } catch { /* ignore */ }
}

// Loads every slot in order and owns the partial result: on a stale generation,
// a rejected load or any later failure, every already-loaded slot is disposed.
// loadOne(entry, token) must itself clean up its own rejected or stale load and
// return null when stale. Returns the records map, or null if superseded.
export async function loadSlotsOwned(entries, {guard, token, loadOne, dispose}) {
  const loaded = {};
  let committed = false;
  try {
    for (const entry of entries) {
      const record = await loadOne(entry, token);
      if (!record) return null;
      loaded[entry.slot] = record;
      if (!guard.isCurrent(token)) return null;
    }
    committed = true;
    return loaded;
  } finally {
    if (!committed) await Promise.all(Object.values(loaded).map(record => dispose(record)));
  }
}

// SDK Pose load state. pixi-live2d-display 0.4.0 (setupOptionals) loads FileReferences.Pose,
// sets internalModel.pose = runtime.createPose(...) and emits 'poseLoaded', or emits
// 'poseLoadError' WITHOUT rejecting setup - so the page must watch these events itself.
export function watchSdkPose(model, requested) {
  const status = {requested, loaded: false, error: false, ran: 0};
  if (requested) {
    model.once('poseLoaded', () => { status.loaded = true; });
    model.once('poseLoadError', () => { status.error = true; });
  }
  return status;
}

// Returns the loaded CubismPose, or throws: sdk-pose mode never reports success without it.
export function requireSdkPose(internalModel, status) {
  const pose = internalModel?.pose;
  const usable = pose && typeof pose.reset === 'function' && typeof pose.updateParameters === 'function';
  if (!status.loaded || status.error || !usable) {
    throw Object.assign(new Error('E_SDK_POSE_UNAVAILABLE'), {code: 'E_SDK_POSE_UNAVAILABLE',
      detail: status.error ? 'pose3.json failed to load (poseLoadError)' : !status.loaded ? 'poseLoaded was not emitted' : 'CubismPose reset/updateParameters missing'});
  }
  return pose;
}

// Per-generation resource URLs: the server ignores the query, and a reload can
// never be served a texture cached by an earlier generation.
export const generationUrl = (url, token) => `${url}?g=${token}`;
