import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench, loadManifest} from '../tools/workbench-node.mjs';
import {HiyoriRig, validateManifest, SIDES} from '../src/rig.mjs';
import {verifyAtlasIsolation} from '../tools/build-parts.mjs';

const wb = await createWorkbench({rebuild: true});
const restDrawables = (() => { wb.model.reset(); return wb.model.update().map(d => ({...d, positions: Float32Array.from(d.positions)})); })();
const byId = new Map(restDrawables.map(d => [d.id, d]));
const FINGER = {thumb: 'FingerThumb', index: 'FingerIndex', middle: 'FingerMiddle', ring: 'FingerRing', pinky: 'FingerPinky'};

test('manifest validates and rejects unknown keys / bad limits', async () => {
  const m = await loadManifest();
  assert.doesNotThrow(() => validateManifest(m));
  assert.throws(() => validateManifest({...m, url: 'https://example.com/x.png'}), /unknown key/);
  const bad = structuredClone(m); bad.channels.ArmElbow.min = 500;
  assert.throws(() => validateManifest(bad), /limits/);
  const badPivot = structuredClone(m); badPivot.arms.L.pivots.elbow = [0, NaN];
  assert.throws(() => validateManifest(badPivot), /pivot/);
});

test('rest pose reproduces the original Arm A vertices exactly', () => {
  wb.rig.reset();
  for (const item of wb.rig.solve()) {
    if (item.id.startsWith('finger.')) continue; // derived grid meshes, checked below
    const original = byId.get(item.source);
    assert.ok(original, item.id);
    for (let i = 0; i < item.positions.length; i++) assert.ok(Math.abs(item.positions[i] - original.positions[i]) < 1e-6, `${item.id}[${i}]`);
  }
});

test('derived finger parts sit on the original strip at rest (within 1.5 px)', () => {
  wb.rig.reset();
  const items = wb.rig.solve();
  for (const side of SIDES) for (const segment of ['base', 'tip']) {
    const strip = byId.get(wb.manifest.arms[side].fingerStrips[segment]);
    let a = Infinity, b = Infinity, c = -Infinity, e = -Infinity;
    for (let i = 0; i < strip.positions.length; i += 2) { a = Math.min(a, strip.positions[i]); c = Math.max(c, strip.positions[i]); b = Math.min(b, strip.positions[i + 1]); e = Math.max(e, strip.positions[i + 1]); }
    const tol = 1.5 / 2976 + 6 / 2976; // grid cell overhang (<= CELL px) + 1.5 px
    for (const item of items.filter(i => i.id.startsWith(`finger.${side}.`) && i.id.endsWith(`.${segment}`))) {
      for (let i = 0; i < item.positions.length; i += 2) {
        assert.ok(item.positions[i] >= a - tol && item.positions[i] <= c + tol && item.positions[i + 1] >= b - tol && item.positions[i + 1] <= e + tol, `${item.id} outside its strip`);
      }
    }
  }
});

test('finger atlas: no triangle can sample another finger (bleed check)', async () => {
  const {readFile} = await import('node:fs/promises');
  const parts = JSON.parse(await readFile(new URL('../build/finger-parts.json', import.meta.url), 'utf8'));
  assert.equal(parts.parts.length, 16);
  assert.doesNotThrow(() => verifyAtlasIsolation(parts.parts, parts.atlasSize));
});

test('overhead reach: left wrist above the top of the head', () => {
  wb.rig.reset();
  wb.rig.set('ArmShoulderL', 162); wb.rig.set('ArmElbowL', -22);
  const wrist = wb.rig.landmarks('L').wrist;
  let top = -Infinity;
  for (const d of restDrawables) if (['PartHairFront', 'PartHairBack', 'PartFace'].includes(d.part)) for (let i = 1; i < d.positions.length; i += 2) top = Math.max(top, d.positions[i]);
  assert.ok(wrist[1] > top, `wrist ${wrist[1]} vs head top ${top}`);
  wb.rig.reset();
});

test('left and right shoulder/elbow/wrist are independent', () => {
  for (const joint of ['ArmShoulder', 'ArmElbow', 'ArmWrist']) {
    wb.rig.reset();
    const restR = wb.rig.solve().filter(i => i.id.endsWith('.R') || i.id.includes('.R.'));
    wb.rig.set(joint + 'L', 60);
    const after = wb.rig.solve();
    for (const r of restR) {
      const now = after.find(i => i.id === r.id);
      assert.deepEqual([...now.positions], [...r.positions], `${joint}L moved ${r.id}`);
    }
  }
  wb.rig.reset();
});

test('each finger channel moves only that finger (both segments), per side', () => {
  for (const side of SIDES) for (const [finger, channel] of Object.entries(FINGER)) {
    wb.rig.reset();
    const rest = new Map(wb.rig.solve().map(i => [i.id, i.positions]));
    wb.rig.set(channel + side, 0.6);
    const moved = wb.rig.solve().filter(i => i.positions.some((p, k) => Math.abs(p - rest.get(i.id)[k]) > 1e-7)).map(i => i.id).sort();
    const expected = finger === 'thumb' ? [`thumb.${side}`] : [`finger.${side}.${finger}.base`, `finger.${side}.${finger}.tip`];
    assert.deepEqual(moved, expected.sort(), `${side}.${finger}`);
  }
  wb.rig.reset();
});

test('elbow joint: no gap opens between upper sleeve and forearm at 0..150 deg', () => {
  // Nearest distance from each forearm top-edge vertex to the upper sleeve mesh stays small.
  const upper = restDrawables.find(d => d.id === wb.manifest.arms.L.meshes.upper);
  const fore = restDrawables.find(d => d.id === wb.manifest.arms.L.meshes.forearm);
  const tops = [];
  for (let i = 0; i < fore.positions.length; i += 2) if (fore.positions[i + 1] > 0.12) tops.push(i / 2);
  for (const bend of [0, 60, 120, 150, -120, -160]) {
    wb.rig.reset(); wb.rig.set('ArmElbowL', bend); wb.rig.set('ArmShoulderL', 40);
    const items = wb.rig.solve();
    const u = items.find(i => i.id === 'upper.L').positions, f = items.find(i => i.id === 'forearm.L').positions;
    for (const v of tops) {
      let best = Infinity;
      for (let j = 0; j < u.length; j += 2) best = Math.min(best, Math.hypot(u[j] - f[v * 2], u[j + 1] - f[v * 2 + 1]));
      assert.ok(best < 0.03, `bend ${bend}: forearm top vertex ${v} is ${best.toFixed(4)} from the upper sleeve`);
    }
  }
  wb.rig.reset();
  assert.equal(upper.id, 'ArtMesh75');
});

test('channel set clamps, rejects unknown names, non-finite values and bad layers', () => {
  wb.rig.reset();
  assert.equal(wb.rig.set('ArmShoulderL', 999), 170);
  assert.equal(wb.rig.set('FingerIndexR', -5), -1);
  assert.throws(() => wb.rig.set('ArmShoulderX', 1), /unknown/);
  assert.throws(() => wb.rig.set('ArmElbowL', NaN), /non-finite/);
  assert.throws(() => wb.rig.set('ArmLayerL', 'javascript:alert(1)'), /bad value/);
  wb.rig.reset();
  assert.ok(wb.rig.isAtRest());
});

test('layer slots reorder only forearm + hand items', () => {
  wb.rig.reset();
  const back = new Map(wb.rig.solve().map(i => [i.id, i.order]));
  wb.rig.set('ArmLayerL', 'front');
  const front = new Map(wb.rig.solve().map(i => [i.id, i.order]));
  for (const [id, order] of front) {
    const hand = id.startsWith('forearm.L') || id.startsWith('finger.L.') || id === 'thumb.L';
    if (hand) assert.ok(order > 118 && order < 128, id); else assert.equal(order, back.get(id), id);
  }
  wb.rig.reset();
});

test('rig rebuild from manifest is deterministic', async () => {
  const {readFile} = await import('node:fs/promises');
  const parts = JSON.parse(await readFile(new URL('../build/finger-parts.json', import.meta.url), 'utf8'));
  const a = new HiyoriRig(await loadManifest(), restDrawables, parts), b = new HiyoriRig(await loadManifest(), restDrawables, parts);
  a.set('ArmShoulderR', 77); b.set('ArmShoulderR', 77);
  assert.deepEqual(a.solve().map(i => [...i.positions]), b.solve().map(i => [...i.positions]));
});
