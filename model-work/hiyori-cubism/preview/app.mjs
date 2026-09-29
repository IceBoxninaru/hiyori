// Native export pose comparison page. Raw Core mode only: every render resets all
// parameters/part opacities to the declared defaults, applies the named pose and
// runs Core. No motion, expression, blink, breath, physics, SDK Pose or gaze.
// Nothing leaves the browser; "Download PNG" saves a local file.
import {readDeclaredState, validatePoseForModel, installDeterministicUpdate, partOpacityDiff, topologyNotes, deriveCamera, cropToView, PreviewError} from './pose-core.mjs';
import {createLoadGuard} from './load-guard.mjs';

const SLOTS = ['before', 'after'];
const DEFAULT_CROP = Object.freeze({x: 0.25, y: 0.18, w: 0.3, h: 0.22});
const BG = {white: 0xffffff, dark: 0x1e1f26};
const BG_CSS = {white: '#ffffff', dark: '#1e1f26'};
const $ = id => document.getElementById(id);
const guard = createLoadGuard();
let config = null, camera = null, crop = {...DEFAULT_CROP}, currentPose = {name: 'default', parameters: {}};
let slots = {}; // slot -> {app, model, raw, state, applied, entry}
const poseErrors = new Map();

// Concise, path-free error text; details stay in the local console only.
function describe(error) {
  if (error instanceof PreviewError || /^E_[A-Z_]+$/.test(error?.code ?? '')) return `${error.code}${error.detail ? `: ${error.detail}` : ''}`;
  return 'E_RENDER_FAILED (details in the local browser console)';
}
function showError(error) { console.error(error); $('error').textContent = describe(error); }

async function fetchChecked(url, kind) {
  const response = await fetch(url, {cache: 'no-store', credentials: 'omit'});
  if (!response.ok) throw new PreviewError('E_FETCH', `${url} HTTP ${response.status}`);
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

function freshCanvas(id) {
  const old = $(id), fresh = old.cloneNode(false);
  old.replaceWith(fresh); // a destroyed WebGL context cannot be reused
  return fresh;
}

function destroySlot(record) {
  if (!record) return;
  try { record.app?.stage.removeChildren(); } catch { /* ignore */ }
  try { record.model?.destroy({children: true}); } catch { /* ignore */ }
  try { record.app?.destroy(false, {children: true, texture: true, baseTexture: true}); } catch { /* ignore */ }
}

async function loadSlot(core, slot, entry, token) {
  const state = readDeclaredState(core, await fetchChecked(entry.moc, 'binary'));
  if (!guard.isCurrent(token)) return null;
  const view = freshCanvas(`view-${slot}`);
  const app = new PIXI.Application({view, width: view.width, height: view.height, backgroundColor: BG[$('bg').value], antialias: true,
    preserveDrawingBuffer: true, autoStart: false, sharedTicker: false});
  app.ticker?.stop();
  const interaction = app.renderer.plugins?.interaction;
  if (interaction) interaction.useSystemTicker = false;
  const record = {app, model: null, raw: null, state, applied: {}, entry, view: {width: view.width, height: view.height}};
  // Settings object with Moc + Textures only: no physics, pose, motion or expression files are requested.
  const settings = {url: `/m/${slot}/model3.json`, Version: 3, FileReferences: {Moc: entry.moc, Textures: entry.textures}};
  const model = await guard.settle(token, PIXI.live2d.Live2DModel.from(settings, {autoInteract: false, autoUpdate: false, motionPreload: 'none'}),
    stale => { destroySlot({app, model: stale}); });
  if (!model) return null; // stale: the settle callback already destroyed it and its app
  record.model = model;
  const internal = model.internalModel, coreModel = internal.coreModel;
  const raw = coreModel?.getModel?.() ?? coreModel?._model;
  if (!raw?.parameters?.values || !raw?.parts?.opacities) { destroySlot(record); throw new PreviewError('E_RENDERER_API', 'raw Core model not reachable through pixi-live2d-display'); }
  record.raw = raw;
  try { internal.motionManager?.stopAllMotions?.(); } catch { /* ignore */ }
  installDeterministicUpdate(internal, raw, state, () => currentPose, applied => { record.applied = applied; });
  app.stage.addChild(model);
  return record;
}

async function loadAll() {
  const token = guard.begin();
  for (const slot of SLOTS) destroySlot(slots[slot]);
  slots = {}; camera = null;
  $('error').textContent = ''; $('diag').textContent = 'loading…';
  const core = await waitForVendors();
  const loaded = {};
  for (const entry of config.models) {
    const record = await loadSlot(core, entry.slot, entry, token);
    if (!record || !guard.isCurrent(token)) { destroySlot(record); for (const r of Object.values(loaded)) destroySlot(r); return; }
    loaded[entry.slot] = record;
    // One camera from the BEFORE canvas info (or explicit config), shared by both, never re-fitted per pose.
    if (entry.slot === 'before') camera = deriveCamera(record.state.canvas, record.view, config.camera);
    record.model.scale.set(camera.scale);
    record.model.position.set(camera.x, camera.y);
  }
  slots = loaded;
  poseErrors.clear();
  for (const pose of config.poses) for (const slot of SLOTS) {
    try { validatePoseForModel(pose, slots[slot].state); } catch (e) { poseErrors.set(pose.name, `${slot}: ${describe(e)}`); }
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
  const record = slots[slot], target = $(`crop-${slot}`), g = target.getContext('2d');
  g.fillStyle = BG_CSS[$('bg').value]; g.fillRect(0, 0, target.width, target.height);
  const r = cropToView(camera, crop);
  const k = Math.min(target.width / r.w, target.height / r.h);
  const w = r.w * k, h = r.h * k;
  g.imageSmoothingEnabled = true;
  g.drawImage(record.app.view, r.x, r.y, r.w, r.h, (target.width - w) / 2, (target.height - h) / 2, w, h);
}

function renderAll() {
  if (!slots.before || !slots.after || !camera) return;
  for (const slot of SLOTS) {
    const {app} = slots[slot];
    app.renderer.backgroundColor = BG[$('bg').value];
    app.renderer.render(app.stage); // calls the deterministic update installed above
    drawCrop(slot);
  }
  updateDiagnostics();
}

function updateDiagnostics() {
  const notes = topologyNotes(slots.before.state, slots.after.state);
  const perSlot = Object.fromEntries(SLOTS.map(slot => {
    const {state, raw, applied, entry, view} = slots[slot];
    $(`label-${slot}`).textContent = entry.label;
    return [slot, {label: entry.label, coreVersion: state.version, mocVersion: state.mocVersion, modelCanvas: state.canvas, viewCanvasPx: view,
      drawables: state.drawableIds.length, parameters: state.parameters.length, parts: state.parts.length,
      appliedReadBack: applied, nonDefaultPartOpacities: partOpacityDiff(raw, state)}];
  }));
  $('diag').textContent = JSON.stringify({mode: config.mode, note: config.note, pose: currentPose, camera, crop,
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
  const a = slots.before.app.view, cropA = $('crop-before');
  const pad = 8, header = 28, width = pad * 3 + a.width * 2, height = header + pad * 3 + a.height + cropA.height;
  const out = document.createElement('canvas'); out.width = width; out.height = height;
  const g = out.getContext('2d');
  g.fillStyle = BG_CSS[$('bg').value]; g.fillRect(0, 0, width, height);
  g.fillStyle = $('bg').value === 'dark' ? '#ffd166' : '#b00020'; g.font = '14px sans-serif';
  g.fillText(`raw-core | pose ${currentPose.name} | ${JSON.stringify(currentPose.parameters)}`, pad, 18);
  SLOTS.forEach((slot, i) => {
    const x = pad + i * (a.width + pad);
    g.drawImage(slots[slot].app.view, x, header + pad);
    g.drawImage($(`crop-${slot}`), x, header + pad * 2 + a.height);
    g.fillText(slots[slot].entry.label, x + 4, header + pad + 16);
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
