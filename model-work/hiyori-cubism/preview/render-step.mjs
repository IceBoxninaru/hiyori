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

// Removes cached textures for exact URLs (and their absolute forms) and destroys them.
export function purgeTextureCache(caches, urls, base = null) {
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
      try { entry.destroy?.(true); } catch { /* ignore */ }
      purged++;
    }
  }
  return purged;
}

// Destroys one slot's model and every texture it owns, then purges its URLs.
// Idempotent. purge(urls) is injected (Pixi caches in the browser, fakes in tests).
export function disposeRecord(record, purge = () => {}) {
  if (!record || record.disposed) return;
  record.disposed = true;
  const model = record.model;
  const textures = [...(model?.textures ?? [])];
  try { model?.parent?.removeChild?.(model); } catch { /* ignore */ }
  try { model?.destroy?.({children: true, texture: true, baseTexture: true}); } catch { /* ignore */ }
  for (const texture of textures) { try { texture.destroy?.(true); } catch { /* ignore */ } }
  try { purge(record.urls ?? []); } catch { /* ignore */ }
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
    if (!committed) for (const record of Object.values(loaded)) dispose(record);
  }
}

// Per-generation resource URLs: the server ignores the query, and a reload can
// never be served a texture cached by an earlier generation.
export const generationUrl = (url, token) => `${url}?g=${token}`;
