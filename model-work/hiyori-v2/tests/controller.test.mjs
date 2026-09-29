import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench} from '../tools/workbench-node.mjs';
import {GestureController, MOUTH_PARAMETER} from '../src/controller.mjs';
import {GESTURES, GESTURE_IDS, CORE_ALLOWLIST, isGestureId, monotoneCubic} from '../src/gestures.mjs';

const wb = await createWorkbench();
const defaults = new Map(wb.model.parameterIds.map((id, i) => [id, wb.model.parameterDefault[i]]));
const fresh = () => { wb.rig.reset(); return new GestureController(wb.rig, defaults); };
const run = (c, from, to, step = 1 / 30) => { let out; for (let t = from; t <= to + 1e-9; t += step) out = c.update(t); return out; };

test('catalog is closed: exactly the documented ids', () => {
  assert.deepEqual([...GESTURE_IDS].sort(), ['arm-raise', 'big-wave', 'fist-close', 'open-palm', 'point', 'return', 'shy-hands'].sort());
  for (const bad of ['', 'wave()', 'https://x/y.json', '../big-wave', 'BIG-WAVE', 'constructor', '__proto__', null, 42, {id: 'point'}]) assert.equal(isGestureId(bad), false, String(bad));
});

test('no gesture owns the mouth; core tracks are allowlisted', () => {
  assert.ok(!CORE_ALLOWLIST.includes(MOUTH_PARAMETER));
  for (const [id, g] of Object.entries(GESTURES)) {
    for (const p of Object.keys(g.core || {})) assert.ok(CORE_ALLOWLIST.includes(p), `${id}:${p}`);
    assert.ok(!Object.keys(g.tracks).some(k => /Mouth/.test(k)), id);
  }
});

test('every gesture starts from and returns to rest; mouth held at 0.2 throughout', () => {
  for (const id of Object.keys(GESTURES)) {
    const c = fresh();
    c.setMouthOpen(0.2);
    assert.ok(c.play(id, 0));
    let moved = false;
    for (let t = 0; t <= GESTURES[id].duration + 0.5; t += 1 / 30) {
      const out = c.update(t);
      assert.equal(out.get(MOUTH_PARAMETER), 0.2, `${id} mouth at ${t}`);
      if (!wb.rig.isAtRest()) moved = true;
    }
    assert.ok(moved, `${id} never moved`);
    assert.ok(wb.rig.isAtRest(), `${id} not at rest`);
    assert.equal(c.core.size, 0, `${id} left core params`);
    assert.equal(c.playing, false);
  }
});

test('changing gesture during a wave cross-fades without jumps, then ends at rest', () => {
  const c = fresh();
  c.play('big-wave', 0); run(c, 0, 1.3);
  const before = wb.rig.get('ArmElbowL');
  assert.ok(c.play('fist-close', 1.3));
  c.update(1.3 + 1 / 60);
  assert.ok(Math.abs(wb.rig.get('ArmElbowL') - before) < 5, 'no pop at the switch');
  run(c, 1.3, 1.3 + GESTURES['fist-close'].duration + 0.5);
  assert.ok(wb.rig.isAtRest());
});

test('stop (ease), return, immediate stop, reduced motion, dispose all reach documented defaults', () => {
  let c = fresh(); c.setMouthOpen(0.2);
  c.play('shy-hands', 0); run(c, 0, 1.5); c.stop({}, 1.5); run(c, 1.5, 2.2);
  assert.ok(wb.rig.isAtRest()); assert.equal(c.core.size, 0); assert.equal(c.mouth, 0.2);

  c = fresh(); c.play('big-wave', 0); run(c, 0, 1); assert.ok(c.play('return', 1)); run(c, 1, 1.6);
  assert.ok(wb.rig.isAtRest());

  c = fresh(); c.play('point', 0); run(c, 0, 1); c.stop({immediate: true});
  assert.ok(wb.rig.isAtRest()); assert.equal(c.core.size, 0);

  c = fresh(); c.setMouthOpen(0.2); c.play('arm-raise', 0); run(c, 0, 1);
  c.setReducedMotion(true);
  assert.ok(wb.rig.isAtRest()); assert.equal(c.play('big-wave', 1.1), false, 'refused while reduced');
  assert.equal(c.update(1.2).get(MOUTH_PARAMETER), 0.2, 'mouth survives reduced motion');
  c.setReducedMotion(false); assert.ok(c.play('big-wave', 1.3));

  c = fresh(); c.play('fist-close', 0); run(c, 0, 1); c.dispose();
  assert.ok(wb.rig.isAtRest()); assert.equal(c.play('point', 2), false, 'refused after dispose');
  wb.rig.reset();
});

test('layer and fingers return to documented defaults after interruption', () => {
  const c = fresh();
  c.play('fist-close', 0); run(c, 0, 1.5);
  assert.equal(wb.rig.get('ArmLayerL'), 'front');
  assert.ok(wb.rig.get('FingerPinkyL') > 0.5);
  c.play('shy-hands', 1.5); run(c, 1.5, 1.5 + GESTURES['shy-hands'].duration + 0.4);
  for (const n of wb.rig.channelNames()) assert.equal(wb.rig.get(n), wb.rig.channelSpecs.get(n).rest, n);
});

test('non-finite timestamps are rejected before any state change', () => {
  const c = fresh();
  for (const t of [undefined, NaN, Infinity, -Infinity, '1', null]) {
    assert.equal(c.play('big-wave', t), false, String(t));
    assert.equal(c.playing, false);
  }
  assert.doesNotThrow(() => c.update(NaN));
  assert.ok(wb.rig.isAtRest());
  c.play('big-wave', 0); run(c, 0, 1);
  c.stop({}, NaN); // falls back to last valid time
  run(c, 1, 1.6);
  assert.ok(wb.rig.isAtRest());
  c.play('big-wave', 2); c.update(2.5); assert.doesNotThrow(() => c.update(Infinity)); run(c, 2.5, 7);
  assert.ok(wb.rig.isAtRest());
});

test('monotone cubic never overshoots its keys', () => {
  const f = monotoneCubic([[0, 0], [0.2, 10], [0.4, 10], [0.6, -5], [1, 0]]);
  for (let x = 0; x <= 1; x += 0.001) { const y = f(x); assert.ok(y <= 10 + 1e-9 && y >= -5 - 1e-9, `${x}:${y}`); }
});

test('the mouth level is clamped and only set through setMouthOpen', () => {
  const c = fresh();
  c.setMouthOpen(5); assert.equal(c.mouth, 1);
  c.setMouthOpen(-1); assert.equal(c.mouth, 0);
  c.setMouthOpen(NaN); assert.equal(c.mouth, 0);
  c.setMouthOpen(0.2); c.play('big-wave', 0); c.stop({immediate: true}); assert.equal(c.mouth, 0.2);
});
