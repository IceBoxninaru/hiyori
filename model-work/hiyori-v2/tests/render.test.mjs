import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench} from '../tools/workbench-node.mjs';

const wb = await createWorkbench();

function opaqueCount(canvas, x0, y0, x1, y1, bg) {
  const d = canvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 30) n++;
  return n;
}

test('rest render of the rig matches the original model render (arms region)', () => {
  const a = wb.render({}, {width: 450, height: 630});
  // Original: rig items removed, Core Arm A shown instead.
  wb.model.reset();
  const drawables = wb.model.update();
  const frame = drawables.filter(d => d.part !== 'PartArmB' && d.id !== 'HitArea').sort((x, y) => x.order - y.order).map(d => ({...d, masks: d.masks.map(i => drawables[i])}));
  return import('../src/render-canvas2d.mjs').then(({renderFrameCanvas2D, fitView}) => {
    const b = wb.createCanvas(450, 630), g = b.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 450, 630);
    renderFrameCanvas2D(g, frame, wb.textures, fitView(wb.model.canvas, 450, 630), {createLayer: (w, h) => wb.createCanvas(w, h)});
    const da = a.canvas.getContext('2d').getImageData(0, 0, 450, 630).data, db = g.getImageData(0, 0, 450, 630).data;
    let diff = 0;
    for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 60) diff++;
    assert.ok(diff / (450 * 630) < 0.002, `rest differs from original in ${diff} px`);
  });
});

test('raised arm puts arm pixels above the shoulders and near the head', () => {
  const bg = [255, 255, 255];
  const rest = wb.render({}, {width: 450, height: 630}).canvas;
  const up = wb.render({channels: {ArmShoulderL: 162, ArmElbowL: -22}}, {width: 450, height: 630}).canvas;
  // Region right of the head, above shoulder height (viewer right = character L).
  const region = [260, 40, 400, 190];
  assert.ok(opaqueCount(up, ...region, bg) > opaqueCount(rest, ...region, bg) + 800);
});

test('renders are non-blank on light and dark backgrounds', () => {
  for (const background of ['#ffffff', '#1e1f26']) {
    const {canvas} = wb.render({channels: {ArmShoulderR: 90, ArmElbowR: 40}}, {width: 300, height: 420, background});
    const bg = background === '#ffffff' ? [255, 255, 255] : [30, 31, 38];
    assert.ok(opaqueCount(canvas, 0, 0, 300, 420, bg) > 20000);
  }
});

test('sleeve fist: finger + thumb items are fully clipped at the cuff; rest/half show them', async () => {
  const {renderFrameCanvas2D, fitView} = await import('../src/render-canvas2d.mjs');
  const visibleHandPixels = (side, channels) => {
    wb.rig.reset();
    for (const [k, v] of Object.entries(channels)) wb.rig.set(k, v);
    const items = wb.rig.solve().filter(i => i.id.startsWith(`finger.${side}.`) || i.id === `thumb.${side}`).map(i => ({...i, masks: []}));
    const [wx, wy] = wb.manifest.arms[side].pivots.wrist;
    const c = wb.createCanvas(240, 240), g = c.getContext('2d');
    renderFrameCanvas2D(g, items, wb.textures, fitView(wb.model.canvas, 240, 240, {zoom: 11, focusX: wx, focusY: wy - 0.015}));
    const d = g.getImageData(0, 0, 240, 240).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 16) n++;
    wb.rig.reset();
    return n;
  };
  for (const side of ['L', 'R']) {
    const rest = visibleHandPixels(side, {}), half = visibleHandPixels(side, {[`HandCurl${side}`]: 0.5}), fist = visibleHandPixels(side, {[`HandCurl${side}`]: 1});
    assert.ok(rest > 1500, `${side} rest ${rest}`);
    assert.ok(half > 100 && half < rest, `${side} half ${half} vs rest ${rest}`);
    assert.ok(fist < rest * 0.02, `${side} fist ${fist} vs rest ${rest}`);
  }
});
