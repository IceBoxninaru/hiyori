// Debug: wireframes of the original Arm A meshes over the rest render, plus
// vertex extents, to author pivots in rig/hiyori-v2.rig.json.
// Usage: node tools/debug-arm-mesh.mjs [R|L]
import {writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {loadCubismCore, loadHiyoriMocBuffer, workRoot} from '../src/cubism-core-node.mjs';
import {OriginalModel} from '../src/original-model.mjs';
import {renderFrameCanvas2D, fitView} from '../src/render-canvas2d.mjs';
import {loadCanvasModule, loadHiyoriTextures} from './node-canvas.mjs';

const side = process.argv[2] || 'L';
const meshes = side === 'R'
  ? {ArtMesh68: '#e00', ArtMesh72: '#0a0', ArtMesh71: '#00e', ArtMesh74: '#f0f', ArtMesh70: '#0cc', ArtMesh73: '#fa0'}
  : {ArtMesh69: '#e00', ArtMesh75: '#0a0', ArtMesh77: '#00e', ArtMesh79: '#f0f', ArtMesh76: '#0cc', ArtMesh78: '#fa0'};
const {createCanvas} = await loadCanvasModule();
const model = new OriginalModel(await loadCubismCore(), await loadHiyoriMocBuffer());
const drawables = model.update();
const frame = drawables.filter(d => d.part !== 'PartArmB' && d.id !== 'HitArea').sort((a, b) => a.order - b.order)
  .map(d => ({...d, masks: d.masks.map(i => drawables[i])}));
const W = 1000, H = 1400;
const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
const fx = side === 'R' ? -0.13 : 0.13;
const view = fitView(model.canvas, W, H, {zoom: 3.2, focusX: fx, focusY: 0.13});
renderFrameCanvas2D(ctx, frame, await loadHiyoriTextures(), view, {createLayer: (w, h) => createCanvas(w, h)});
const X = x => view.originX + x * view.scale, Y = y => view.originY - y * view.scale;
ctx.lineWidth = 1;
for (const [id, color] of Object.entries(meshes)) {
  const d = drawables[model.drawableIndex.get(id)];
  ctx.strokeStyle = color; ctx.globalAlpha = 0.7;
  const p = d.positions, idx = d.indices;
  for (let k = 0; k < idx.length; k += 3) {
    ctx.beginPath();
    ctx.moveTo(X(p[idx[k] * 2]), Y(p[idx[k] * 2 + 1]));
    ctx.lineTo(X(p[idx[k + 1] * 2]), Y(p[idx[k + 1] * 2 + 1]));
    ctx.lineTo(X(p[idx[k + 2] * 2]), Y(p[idx[k + 2] * 2 + 1]));
    ctx.closePath(); ctx.stroke();
  }
  let a = 9, b = 9, c = -9, e = -9;
  for (let i = 0; i < p.length; i += 2) { a = Math.min(a, p[i]); c = Math.max(c, p[i]); b = Math.min(b, p[i + 1]); e = Math.max(e, p[i + 1]); }
  console.log(id, color, 'x', a.toFixed(4), c.toFixed(4), 'y', b.toFixed(4), e.toFixed(4), 'order', d.order, 'verts', p.length / 2);
}
ctx.globalAlpha = 1;
// Grid every 0.02 units for reading coordinates.
ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.fillStyle = '#000'; ctx.font = '12px sans-serif';
for (let x = -0.4; x <= 0.4001; x += 0.02) { ctx.beginPath(); ctx.moveTo(X(x), 0); ctx.lineTo(X(x), H); ctx.stroke(); ctx.fillText(x.toFixed(2), X(x) + 2, 12); }
for (let y = -0.3; y <= 0.5001; y += 0.02) { ctx.beginPath(); ctx.moveTo(0, Y(y)); ctx.lineTo(W, Y(y)); ctx.stroke(); ctx.fillText(y.toFixed(2), 2, Y(y) - 2); }
const out = path.join(workRoot, 'out', `debug-arm-${side}.png`);
await mkdir(path.dirname(out), {recursive: true});
await writeFile(out, canvas.toBuffer('image/png'));
console.log('wrote', out);
