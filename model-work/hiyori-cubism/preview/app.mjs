// Native export pose comparison page (--mode raw-core default, or sdk-pose). Every render resets all
// parameters/part opacities to the declared defaults, applies the named pose and
// runs Core. No motion, expression, blink, breath, physics, SDK Pose or gaze.
// One shared WebGL renderer/stage draws each model in turn; the result is copied
// into that slot's 2D canvas. Nothing leaves the browser; "Download PNG" saves locally.
import {readDeclaredState, validatePoseForModel, installDeterministicUpdate, partOpacities, partOpacityDiff, checkPosePartIds, posePartIdsFromCubismPose, topologyNotes, deriveCamera, cropToView, poseForSlot, PreviewError} from './pose-core.mjs';
import {createLoadGuard} from './load-guard.mjs';
import {renderSlotOnce, disposeRecord, loadSlotsOwned, loadOwnedModel, purgeTextureCache, generationUrl, watchSdkPose, requireSdkPose, installOrDispose} from './render-step.mjs';

const SLOTS = ['before', 'after'];
const DEFAULT_CROP = Object.freeze({x: 0.25, y: 0.18, w: 0.3, h: 0.22});
const BG = {white: 0xffffff, dark: 0x1e1f26};
const BG_CSS = {white: '#ffffff', dark: '#1e1f26'};
const $ = id => document.getElementById(id);
const guard = createLoadGuard();
let config = null, camera = null, crop = {...DEFAULT_CROP}, currentPose = {name: 'default', models: {before: {parameters: {}}, after: {parameters: {}}}};
let slots = {}; // slot -> {model, raw, state, applied, entry, urls}
let shared = null; // {app, view: {width, height}} - one renderer for the page lifetime
const poseErrors = new Map();

// Concise, path-free error text; details stay in the local console only.
function describe(error) {
  if (error instanceof PreviewError || /^E_[A-Z_]+$/.test(error?.code ?? '')) return `${error.code}${error.detail ? `: ${error.detail}` : ''}`;
  return 'E_RENDER_FAILED (details in the local browser console)';
}
function showError(error) { console.error(error); $('error').textContent = describe(error); }

async function fetchChecked(url, kind) {
  const response = await fetch(url, {cache: 'no-store', credentials: 'omit'});
  if (!response.ok) throw new PreviewError('E_FETCH', `${url.split('?')[0]} HTTP ${response.status}`);
  return kind === 'json' ? response.json() : response.arrayBuffer();
}

async function waitForVendors() {
  const core = globalThis.Live2DCubismCore;
  if (!core || !globalThis.PIXI || !globalThis.PIXI.live2d?.Live2DModel) throw new PreviewError('E_VENDOR_UNAVAILABLE', 'Core, Pixi or pixi-live2d-display did not load');
  for (let i = 0; i < 500; i++) {
    try { if (core.Version.csmGetVersion()) return core; } catch { /* initializing */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new PreviewError('E_VENDOR_UNAVAILABLE', 'Core did not initialize');
}

// The single WebGL renderer, on an off-DOM canvas the size of the slot views.
function sharedRenderer() {
  if (shared) return shared;
  const size = {width: $('view-before').width, height: $('view-before').height};
  const view = Object.assign(document.createElement('canvas'), size);
  const app = new PIXI.Application({view, ...size, backgroundColor: BG[$('bg').value], antialias: true,
    preserveDrawingBuffer: true, autoStart: false, sharedTicker: false});
  app.ticker?.stop();
  const interaction = app.renderer.plugins?.interaction;
  if (interaction) interaction.useSystemTicker = false;
  shared = {app, view: size};
  return shared;
}

const purge = (urls, destroyed) => purgeTextureCache([PIXI.utils?.TextureCache, PIXI.utils?.BaseTextureCache], urls, location.href, destroyed);
const dispose = record => disposeRecord(record, {purge, containerDestroy: PIXI.Container.prototype.destroy});

// Loads one slot with explicit ownership of its model and per-generation texture URLs.
async function loadOne(core, entry, token) {
  const moc = generationUrl(entry.moc, token), textures = entry.textures.map(t => generationUrl(t, token));
  const state = readDeclaredState(core, await fetchChecked(moc, 'binary'));
  if (!guard.isCurrent(token)) return null;
  // Nothing is loaded yet, so a pose naming unknown parts fails here without cleanup.
  if (config.mode === 'sdk-pose') checkPosePartIds(entry.posePartIds, state);
  // Settings with Moc + Textures (+ the model3's own Pose in sdk-pose mode) only: no physics,
  // motion or expression files are requested.
  const sdkPoseMode = config.mode === 'sdk-pose';
  const pose = sdkPoseMode ? generationUrl(entry.pose, token) : null;
  const refs = {Moc: moc, Textures: textures, ...(sdkPoseMode ? {Pose: pose} : {})};
  const settings = {url: `/m/${entry.slot}/model3.json`, Version: 3, FileReferences: refs};
  let poseStatus = null;
  // Explicit instance ownership: a rejected or stale setup is fully disposed, partial Core included.
  const owned = await loadOwnedModel({PIXI, settings, options: {autoInteract: false, autoUpdate: false, motionPreload: 'none'},
    urls: [moc, ...textures, ...(pose ? [pose] : [])], isCurrent: () => guard.isCurrent(token), dispose,
    onCreate: model => { poseStatus = watchSdkPose(model, sdkPoseMode); }});
  if (!owned) return null;
  const record = Object.assign(owned, {raw: null, state, applied: {}, entry, poseStatus});
  const model = record.model;
  const internal = model.internalModel, coreModel = internal?.coreModel;
  const raw = coreModel?.getModel?.() ?? coreModel?._model;
  if (!raw?.parameters?.values || !raw?.parts?.opacities) { await dispose(record); throw new PreviewError('E_RENDERER_API', 'raw Core model not reachable through pixi-live2d-display'); }
  record.raw = raw;
  try { internal.motionManager?.stopAllMotions?.(); } catch { /* ignore */ }
  // Every post-load step that can throw runs inside the same dispose-on-failure guard.
  await installOrDispose(record, dispose, () => {
    let sdkPose = null;
    if (sdkPoseMode) {
      sdkPose = requireSdkPose(internal, poseStatus);
      // Re-check against what the SDK actually loaded (it maps unknown IDs to dummy indices).
      const loadedIds = posePartIdsFromCubismPose(sdkPose);
      poseStatus.loadedPartIdsChecked = !!loadedIds;
      if (loadedIds) checkPosePartIds(loadedIds, state);
    }
    // Each slot applies its own branch of the current pose (v1 poses carry identical branches).
    installDeterministicUpdate(internal, raw, state, () => poseForSlot(currentPose, entry.slot), applied => { record.applied = applied; },
      {sdkPose, onPoseStep: step => { poseStatus.ran++; poseStatus.settleSeconds = step.settleSeconds; }});
  });
  model.visible = false;
  return record;
}

async function loadAll() {
  const token = guard.begin();
  const previous = slots;
  slots = {}; camera = null;
  await Promise.all(SLOTS.map(slot => dispose(previous[slot])));
  $('error').textContent = ''; $('diag').textContent = 'loading…';
  const core = await waitForVendors();
  const {app, view} = sharedRenderer();
  const loaded = await loadSlotsOwned(config.models, {guard, token, loadOne: (entry, t) => loadOne(core, entry, t), dispose});
  if (!loaded) return; // superseded by a newer load; everything from this one is disposed
  try { installLoaded(loaded, app, view); } catch (error) {
    slots = {}; camera = null;
    await Promise.all(Object.values(loaded).map(record => dispose(record)));
    throw error;
  }
}

function installLoaded(loaded, app, view) {
  // One camera from the BEFORE canvas info (or explicit config), shared by both, never re-fitted per pose.
  camera = deriveCamera(loaded.before.state.canvas, view, config.camera);
  for (const record of Object.values(loaded)) {
    record.model.scale.set(camera.scale);
    record.model.position.set(camera.x, camera.y);
    app.stage.addChild(record.model);
  }
  slots = loaded;
  poseErrors.clear();
  for (const pose of config.poses) for (const slot of SLOTS) {
    try { validatePoseForModel(poseForSlot(pose, slot), slots[slot].state); } catch (e) { poseErrors.set(pose.name, `${slot}: ${describe(e)}`); }
  }
  const select = $('pose');
  select.textContent = '';
  for (const pose of config.poses) {
    const option = new Option(poseErrors.has(pose.name) ? `${pose.name} (invalid)` : pose.name, pose.name);
    option.disabled = poseErrors.has(pose.name);
    select.append(option);
  }
  const keep = config.poses.find(p => p.name === currentPose.name && !poseErrors.has(p.name));
  currentPose = keep ?? config.poses[0];
  select.value = currentPose.name;
  if (poseErrors.size) $('error').textContent = [...poseErrors].map(([name, text]) => `pose ${name}: ${text}`).join('\n');
  renderAll();
}

function drawCrop(slot) {
  const source = $(`view-${slot}`), target = $(`crop-${slot}`), g = target.getContext('2d');
  g.fillStyle = BG_CSS[$('bg').value]; g.fillRect(0, 0, target.width, target.height);
  const r = cropToView(camera, crop);
  const k = Math.min(target.width / r.w, target.height / r.h);
  const w = r.w * k, h = r.h * k;
  g.imageSmoothingEnabled = true;
  g.drawImage(source, r.x, r.y, r.w, r.h, (target.width - w) / 2, (target.height - h) / 2, w, h);
}

function renderAll() {
  if (!slots.before || !slots.after || !camera || !shared) return;
  const {app} = shared;
  app.renderer.backgroundColor = BG[$('bg').value];
  for (const slot of SLOTS) {
    const target = $(`view-${slot}`), g = target.getContext('2d');
    renderSlotOnce({renderer: app.renderer, stage: app.stage, records: slots, slot, copy: source => {
      g.clearRect(0, 0, target.width, target.height);
      g.drawImage(source, 0, 0, target.width, target.height);
    }});
    drawCrop(slot);
  }
  updateDiagnostics();
}

function updateDiagnostics() {
  const notes = topologyNotes(slots.before.state, slots.after.state);
  const perSlot = Object.fromEntries(SLOTS.map(slot => {
    const {state, raw, applied, entry, poseStatus} = slots[slot];
    $(`label-${slot}`).textContent = entry.label;
    return [slot, {label: entry.label, coreVersion: state.version, mocVersion: state.mocVersion, modelCanvas: state.canvas, viewCanvasPx: shared.view,
      drawables: state.drawableIds.length, parameters: state.parameters.length, parts: state.parts.length,
      sdkPose: poseStatus?.requested ? {loaded: poseStatus.loaded, loadError: poseStatus.error, evaluatedRenders: poseStatus.ran,
        settleSeconds: poseStatus.settleSeconds ?? null, partIdsCheckedAgainstMoc: true, loadedPoseIdsRechecked: poseStatus.loadedPartIdsChecked ?? false} : 'not used (raw-core)',
      requestedParameters: poseForSlot(currentPose, slot).parameters, appliedReadBack: applied,
      nonDefaultPartOpacities: partOpacityDiff(raw, state), partOpacities: partOpacities(raw, state)}];
  }));
  const missing = SLOTS.filter(slot => Object.keys(poseForSlot(currentPose, slot).parameters).some(id => !(id in slots[slot].applied)));
  $('diag').textContent = JSON.stringify({mode: config.mode, note: config.note, posesVersion: config.posesVersion, pose: currentPose.name, camera, crop,
    applyCheck: missing.length ? `REQUESTED VALUES NOT READ BACK for ${missing.join(', ')}` : 'requested values read back from Core for both models',
    topology: notes.length ? notes : ['same drawable IDs, parameter IDs and canvas size'],
    reminder: 'Visual differences never override an export-audit incompatibility and do not judge anatomy.', models: perSlot}, null, 1);
}

function readCrop() {
  const next = {x: Number($('cx').value), y: Number($('cy').value), w: Number($('cw').value), h: Number($('ch').value)};
  if (!Object.values(next).every(Number.isFinite) || next.w <= 0 || next.h <= 0) { $('error').textContent = 'E_CROP: crop values must be finite, w/h > 0'; return; }
  crop = next; renderAll();
}

async function downloadPng() {
  if (!slots.before || !slots.after) return;
  renderAll();
  const a = $('view-before'), cropA = $('crop-before');
  const pad = 8, header = 28, width = pad * 3 + a.width * 2, height = header + pad * 3 + a.height + cropA.height;
  const out = document.createElement('canvas'); out.width = width; out.height = height;
  const g = out.getContext('2d');
  g.fillStyle = BG_CSS[$('bg').value]; g.fillRect(0, 0, width, height);
  g.fillStyle = $('bg').value === 'dark' ? '#ffd166' : '#b00020'; g.font = '14px sans-serif';
  const poseRun = config.mode === 'sdk-pose' ? SLOTS.map(slot => `${slot}:${slots[slot].poseStatus?.loaded && slots[slot].poseStatus.ran ? 'pose evaluated' : 'POSE NOT EVALUATED'}`).join(' ') : 'SDK Pose off';
  g.fillText(`${config.mode} | ${poseRun} | pose ${currentPose.name} (v${config.posesVersion})`, pad, 18);
  SLOTS.forEach((slot, i) => {
    const x = pad + i * (a.width + pad);
    g.drawImage($(`view-${slot}`), x, header + pad);
    g.drawImage($(`crop-${slot}`), x, header + pad * 2 + a.height);
    g.fillText(slots[slot].entry.label, x + 4, header + pad + 16);
    g.fillText(JSON.stringify(poseForSlot(currentPose, slot).parameters), x + 4, header + pad + 34);
  });
  const blob = await new Promise(resolve => out.toBlob(resolve, 'image/png'));
  if (!blob) { $('error').textContent = 'E_DOWNLOAD: PNG encoding failed'; return; }
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), {href: url, download: `native-preview-${currentPose.name}-${$('bg').value}.png`});
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function main() {
  config = await fetchChecked('/config.json', 'json');
  $('mode-tag').textContent = `local diagnostic · ${config.mode}`;
  $('note').textContent = config.pixiUnsafeEval ? config.note
    : `${config.note} No pixi-unsafe-eval helper was configured; under this page's CSP Pixi 6 shader setup is expected to fail.`;
  crop = {...(config.camera?.crop ?? DEFAULT_CROP)};
  for (const [id, key] of [['cx', 'x'], ['cy', 'y'], ['cw', 'w'], ['ch', 'h']]) { $(id).value = crop[key]; $(id).onchange = readCrop; }
  $('pose').onchange = () => { currentPose = config.poses.find(p => p.name === $('pose').value) ?? config.poses[0]; renderAll(); };
  $('bg').onchange = renderAll;
  $('reload').onclick = () => loadAll().catch(showError);
  $('download').onclick = () => downloadPng().catch(showError);
  await loadAll();
}

main().catch(showError);
