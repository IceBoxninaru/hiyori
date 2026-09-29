// Node-side workbench: original model (Core) + rig + headless renderer.
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {loadCubismCore, loadHiyoriMocBuffer, workRoot} from '../src/cubism-core-node.mjs';
import {OriginalModel} from '../src/original-model.mjs';
import {HiyoriRig} from '../src/rig.mjs';
import {composeFrame} from '../src/scene.mjs';
import {renderFrameCanvas2D, fitView} from '../src/render-canvas2d.mjs';
import {loadCanvasModule, loadHiyoriTextures, loadImageFile} from './node-canvas.mjs';
import {buildParts} from './build-parts.mjs';

export async function loadManifest() {
  return JSON.parse(await readFile(path.join(workRoot, 'rig', 'hiyori-v2.rig.json'), 'utf8'));
}

export async function createWorkbench({rebuild = false} = {}) {
  if (rebuild || !existsSync(path.join(workRoot, 'build', 'finger-parts.json'))) await buildParts();
  const fingerParts = JSON.parse(await readFile(path.join(workRoot, 'build', 'finger-parts.json'), 'utf8'));
  const core = await loadCubismCore();
  const model = new OriginalModel(core, await loadHiyoriMocBuffer());
  const restDrawables = model.update().map(d => ({...d, positions: Float32Array.from(d.positions)}));
  const manifest = await loadManifest();
  const rig = new HiyoriRig(manifest, restDrawables, fingerParts);
  const textures = [...await loadHiyoriTextures(), await loadImageFile(path.join(workRoot, 'build', 'finger-atlas.png'))];
  const {createCanvas} = await loadCanvasModule();
  const anchorIndex = model.drawableIndex.get(manifest.torsoAnchor.drawable);

  // coreParams: {ParamId: value}; channels: {ArmShoulderL: 90, ...}
  function frame({coreParams = {}, channels = {}} = {}) {
    model.reset();
    for (const [id, v] of Object.entries(coreParams)) model.set(id, v);
    rig.reset();
    for (const [name, v] of Object.entries(channels)) rig.set(name, v);
    const drawables = model.update();
    return composeFrame(drawables, rig.solve(drawables[anchorIndex].positions), {hiddenParts: manifest.hiddenCoreParts});
  }

  function render(pose = {}, {width = 900, height = 1260, zoom = 1, focus = [0, 0], background = '#ffffff', debug = false} = {}) {
    const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
    if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, width, height); }
    const view = fitView(model.canvas, width, height, {zoom, focusX: focus[0], focusY: focus[1]});
    const items = frame(pose);
    renderFrameCanvas2D(ctx, items, textures, view, {createLayer: (w, h) => createCanvas(w, h)});
    if (debug) drawBones(ctx, view, pose);
    return {canvas, view, items};
  }

  function drawBones(ctx, view, pose) {
    const X = x => view.originX + x * view.scale, Y = y => view.originY - y * view.scale;
    const drawables = model.update();
    for (const side of ['L', 'R']) {
      const p = rig.landmarks(side, drawables[anchorIndex].positions);
      ctx.strokeStyle = side === 'L' ? '#e0306a' : '#2a6ee0'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(X(p.shoulder[0]), Y(p.shoulder[1])); ctx.lineTo(X(p.elbow[0]), Y(p.elbow[1])); ctx.lineTo(X(p.wrist[0]), Y(p.wrist[1])); ctx.stroke();
      for (const q of [p.shoulder, p.elbow, p.wrist]) { ctx.beginPath(); ctx.arc(X(q[0]), Y(q[1]), 4, 0, Math.PI * 2); ctx.stroke(); }
    }
  }

  return {model, rig, manifest, textures, frame, render, createCanvas, anchorIndex};
}
