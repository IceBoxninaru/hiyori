// Browser adapter: the integration API for the existing app.
// PROTOTYPE: original Hiyori moc3 (Cubism Core) for body/face/hair + the v2
// bone rig for arms/hands. Not a modified moc3.
//
//   const avatar = await createHiyoriV2Avatar({canvas, hiyoriBase, workBase});
//   avatar.playGesture('big-wave')      // closed catalog ids only
//   avatar.stopGesture({immediate})     // ease (or snap) to rest
//   avatar.setReducedMotion(true)       // stop + rest; gestures refused
//   avatar.setMouthOpen(level)          // audio-owned; only writer of ParamMouthOpenY
//   avatar.setPose({ArmShoulderL: 90})  // workbench/debug; validated + clamped
//   avatar.reset(); avatar.destroy();
//
// Assets are fetched only from the two configured local bases. No provider
// input can name URLs, parts, code or vertex data.
import {OriginalModel} from './original-model.mjs';
import {HiyoriRig} from './rig.mjs';
import {GestureController, MOUTH_PARAMETER} from './controller.mjs';
import {GESTURE_IDS, GESTURES} from './gestures.mjs';
import {composeFrame} from './scene.mjs';
import {fitView, renderFrameCanvas2D} from './render-canvas2d.mjs';
import {WebGLFrameRenderer} from './render-webgl.mjs';
import {PoseSession, acquireCanvas2D} from './pose-session.mjs';

export {GESTURE_IDS};
// Full body with headroom for an overhead reach (fingertips ~y 0.72) and feet (~y -0.67).
export const DEFAULT_VIEW = Object.freeze({zoom: 0.85, focus: Object.freeze([0, 0.06])});
export const GESTURE_LABELS = Object.freeze(Object.fromEntries(Object.entries(GESTURES).map(([id, g]) => [id, g.label])));

async function waitForCore(core) {
  for (let i = 0; i < 500; i++) {
    try { if (core?.Version?.csmGetVersion()) return core; } catch { /* initializing */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Live2D Cubism Core is not available');
}

const loadImage = src => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(`image load failed: ${src}`));
  image.src = src;
});

async function fetchChecked(url, kind) {
  const response = await fetch(url, {cache: 'no-cache'});
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return kind === 'json' ? response.json() : response.arrayBuffer();
}

export async function createHiyoriV2Avatar({
  canvas,
  hiyoriBase = '/hiyori/',
  workBase = '/work/',
  core = globalThis.Live2DCubismCore,
  renderer = 'webgl',
  idle = true,
  onError = () => {},
} = {}) {
  if (!canvas) throw new Error('canvas required');
  const Core = await waitForCore(core);
  const [moc, manifest, fingerParts, textures] = await Promise.all([
    fetchChecked(`${hiyoriBase}hiyori_pro_t11.moc3`, 'binary'),
    fetchChecked(`${workBase}rig/hiyori-v2.rig.json`, 'json'),
    fetchChecked(`${workBase}build/finger-parts.json`, 'json'),
    Promise.all([
      loadImage(`${hiyoriBase}hiyori_pro_t11.2048/texture_00.png`),
      loadImage(`${hiyoriBase}hiyori_pro_t11.2048/texture_01.png`),
      loadImage(`${workBase}build/finger-atlas.png`),
    ]),
  ]);
  const model = new OriginalModel(Core, moc);
  const restDrawables = model.update().map(d => ({...d, positions: Float32Array.from(d.positions)}));
  const rig = new HiyoriRig(manifest, restDrawables, fingerParts);
  const coreDefaults = new Map(model.parameterIds.map((id, i) => [id, model.parameterDefault[i]]));
  const controller = new GestureController(rig, coreDefaults);
  const anchorIndex = model.drawableIndex.get(manifest.torsoAnchor.drawable);

  const session = new PoseSession(rig, controller);

  // Renderer: WebGL, else Canvas2D. If WebGL setup fails AFTER the context was
  // created, that canvas cannot give a 2D context; acquireCanvas2D replaces it
  // with a fresh canvas (api.canvas reflects the one in use) or throws clearly.
  let backend = null, backendName = renderer;
  const useCanvas2D = () => {
    const acquired = acquireCanvas2D(canvas);
    canvas = acquired.canvas;
    backendName = 'canvas2d'; backend = {kind: 'canvas2d', ctx: acquired.ctx};
  };
  if (renderer === 'webgl') {
    let gl = null;
    try { gl = new WebGLFrameRenderer(canvas); gl.setTextures(textures); gl.kind = 'webgl'; backend = gl; }
    catch (error) { onError(error); try { gl?.destroy(); } catch { /* ignore */ } useCanvas2D(); }
  } else useCanvas2D();

  const state = {
    debugBones: false, background: null, zoom: DEFAULT_VIEW.zoom, focus: [...DEFAULT_VIEW.focus], speed: 1,
    disposed: false, anchor: null, raf: 0, clock: 0, last: null, lastFrameMs: 0,
  };

  function view() {
    return fitView(model.canvas, canvas.width, canvas.height, {zoom: state.zoom, focusX: state.focus[0], focusY: state.focus[1]});
  }

  function frame(now) {
    if (state.disposed) return;
    const t0 = performance.now();
    const dt = state.last === null ? 0 : Math.min(0.1, (now - state.last) / 1000);
    state.last = now; state.clock += dt * state.speed;
    const core = session.update(state.clock);
    model.reset();
    if (idle && !session.reduced) model.set('ParamBreath', 0.5 + 0.5 * Math.sin(state.clock * 2 * Math.PI / 3.6));
    for (const [id, v] of core) if (model.has(id)) model.set(id, v);
    const drawables = model.update();
    state.anchor = drawables[anchorIndex].positions;
    const items = composeFrame(drawables, rig.solve(drawables[anchorIndex].positions), {hiddenParts: manifest.hiddenCoreParts});
    const v = view();
    if (backend.kind === 'webgl') backend.render(items, v, state.background);
    else {
      const ctx = backend.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (state.background) { const [r, g, b, a] = state.background; ctx.fillStyle = `rgba(${r * 255},${g * 255},${b * 255},${a})`; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      renderFrameCanvas2D(ctx, items, textures, v, {createLayer: (w, h) => Object.assign(document.createElement('canvas'), {width: w, height: h})});
    }
    state.lastFrameMs = performance.now() - t0;
    api.onFrame?.(api);
    state.raf = requestAnimationFrame(frame);
  }
  state.raf = requestAnimationFrame(frame);

  const api = {
    kind: 'hiyori-v2-prototype',
    get renderer() { return backendName; },
    gestureIds: GESTURE_IDS,
    // Semantics are defined (and tested) in pose-session.mjs.
    playGesture(id) { return !state.disposed && session.playGesture(id, state.clock); },
    stopGesture({immediate = false} = {}) { if (!state.disposed) session.stopGesture({immediate}, state.clock); },
    setReducedMotion(value) { if (!state.disposed) session.setReducedMotion(value); },
    setMouthOpen(level) { if (!state.disposed) session.setMouthOpen(level); },
    // Workbench only. Atomic: all channels validated before any change.
    setPose(channels) { return !state.disposed && session.setPose(channels); },
    reset() { if (!state.disposed) session.reset(); },
    getState() {
      return {
        gesture: controller.currentId, playing: controller.playing, fading: !!controller.fade, idle: session.idle, manual: !!session.manual, reduced: session.reduced,
        mouth: controller.mouth, atRest: rig.isAtRest(), renderer: backendName, frameMs: +state.lastFrameMs.toFixed(2),
        channels: Object.fromEntries(rig.channelNames().map(n => [n, rig.get(n)])),
        coreOwned: Object.fromEntries(controller.core), mouthParameter: MOUTH_PARAMETER,
      };
    },
    setView({zoom, focus, background, speed, debugBones} = {}) {
      if (Number.isFinite(zoom)) state.zoom = Math.min(12, Math.max(0.3, zoom));
      if (Array.isArray(focus) && focus.every(Number.isFinite)) state.focus = focus.slice(0, 2);
      if (background === null || (Array.isArray(background) && background.length === 4)) state.background = background;
      if (Number.isFinite(speed)) state.speed = Math.min(2, Math.max(0.05, speed));
      if (typeof debugBones === 'boolean') state.debugBones = debugBones;
    },
    landmarks(side) { return rig.landmarks(side, state.anchor ?? null); },
    view() { return view(); },
    destroy() {
      if (state.disposed) return;
      session.dispose();
      state.disposed = true;
      cancelAnimationFrame(state.raf);
      if (backend.kind === 'webgl') backend.destroy();
      model.release();
    },
    get disposed() { return state.disposed; },
    get canvas() { return canvas; },
    onFrame: null,
  };
  return api;
}
