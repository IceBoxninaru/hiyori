// Headless render of the ORIGINAL model (Arm A pose) for side-by-side reference.
// Usage: node tools/render-original.mjs [out.png] [--zoom=N --focus=x,y]
import {writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {loadCubismCore, loadHiyoriMocBuffer, workRoot} from '../src/cubism-core-node.mjs';
import {OriginalModel} from '../src/original-model.mjs';
import {renderFrameCanvas2D, fitView} from '../src/render-canvas2d.mjs';
import {loadCanvasModule, loadHiyoriTextures} from './node-canvas.mjs';

const args = process.argv.slice(2);
const out = args.find(a => !a.startsWith('--')) || path.join(workRoot, 'out', 'original-rest.png');
const opt = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')));
const {createCanvas} = await loadCanvasModule();
const core = await loadCubismCore();
const model = new OriginalModel(core, await loadHiyoriMocBuffer());
const drawables = model.update();
const byIndex = drawables;
const frame = drawables
  .filter(d => d.part !== 'PartArmB' && d.id !== 'HitArea')
  .sort((a, b) => a.order - b.order)
  .map(d => ({...d, masks: d.masks.map(i => byIndex[i])}));
const W = 900, H = 1260;
const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
ctx.fillStyle = opt.bg || '#ffffff'; ctx.fillRect(0, 0, W, H);
const [fx, fy] = (opt.focus || '0,0').split(',').map(Number);
const view = fitView(model.canvas, W, H, {zoom: Number(opt.zoom || 1), focusX: fx, focusY: fy});
renderFrameCanvas2D(ctx, frame, await loadHiyoriTextures(), view, {createLayer: (w, h) => createCanvas(w, h)});
await mkdir(path.dirname(out), {recursive: true});
await writeFile(out, canvas.toBuffer('image/png'));
console.log('wrote', out);
