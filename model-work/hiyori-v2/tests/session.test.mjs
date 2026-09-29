// Regression tests for review findings 2, 3, 4 (adapter semantics live in
// src/pose-session.mjs so they can run in Node without a browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench} from '../tools/workbench-node.mjs';
import {GestureController} from '../src/controller.mjs';
import {PoseSession, validatePose, acquireCanvas2D} from '../src/pose-session.mjs';

const wb = await createWorkbench();
const defaults = new Map(wb.model.parameterIds.map((id, i) => [id, wb.model.parameterDefault[i]]));
const fresh = () => { wb.rig.reset(); return new PoseSession(wb.rig, new GestureController(wb.rig, defaults)); };
const run = (s, from, to) => { for (let t = from; t <= to + 1e-9; t += 1 / 30) s.update(t); };

test('finding 4: setPose is atomic — any invalid channel rejects the whole call', () => {
  const s = fresh();
  assert.equal(s.setPose({ArmShoulderL: 45, UnknownChannel: 1}), false);
  assert.equal(wb.rig.get('ArmShoulderL'), 0, 'shoulder must not change');
  for (const bad of [{ArmShoulderL: 45, ArmElbowL: NaN}, {ArmShoulderL: 45, ArmElbowL: '30'}, {ArmShoulderL: 45, ArmLayerL: 'top'}, {ArmShoulderL: 45, ArmLayerL: 3}, null, [], 'x']) {
    assert.equal(s.setPose(bad), false, JSON.stringify(bad));
    assert.ok(wb.rig.isAtRest());
  }
  // A held manual pose is preserved by a rejected call too.
  assert.equal(s.setPose({ArmShoulderL: 45}), true);
  assert.equal(s.setPose({ArmElbowL: 20, Nope: 1}), false);
  s.update(0.1);
  assert.equal(wb.rig.get('ArmShoulderL'), 45);
  assert.equal(wb.rig.get('ArmElbowL'), 0);
});

test('setPose clamps and merges; validatePose reports reasons', () => {
  const s = fresh();
  assert.ok(s.setPose({ArmShoulderL: 999, FingerIndexL: -9, ArmLayerL: 'front'}));
  s.update(0);
  assert.equal(wb.rig.get('ArmShoulderL'), 170);
  assert.equal(wb.rig.get('FingerIndexL'), -1);
  assert.equal(wb.rig.get('ArmLayerL'), 'front');
  assert.match(validatePose(wb.rig, {X: 1}).reason, /unknown channel/);
});

test('finding 2: stopGesture and reset also end a manual pose (ease and immediate)', () => {
  let s = fresh();
  s.setPose({ArmShoulderL: 90, ArmElbowL: 40});
  run(s, 0, 0.5);
  assert.equal(wb.rig.get('ArmShoulderL'), 90);
  s.stopGesture({}, 0.5);
  run(s, 0.5, 1.2);
  assert.ok(wb.rig.isAtRest(), 'eased stop clears manual pose');
  assert.equal(s.manual, null);

  s = fresh();
  s.setPose({ArmShoulderR: 60}); run(s, 0, 0.2);
  s.stopGesture({immediate: true}); run(s, 0.2, 0.5);
  assert.ok(wb.rig.isAtRest(), 'immediate stop clears manual pose');

  s = fresh();
  s.setPose({FingerPinkyL: 1}); run(s, 0, 0.2);
  s.reset(); run(s, 0.2, 0.5);
  assert.ok(wb.rig.isAtRest(), 'reset clears manual pose');
});

test('a gesture replaces a manual pose; reduced motion and dispose clear it', () => {
  let s = fresh();
  s.setPose({ArmShoulderL: 120});
  assert.ok(s.playGesture('point', 0));
  assert.equal(s.manual, null);
  run(s, 0, 4);
  assert.ok(wb.rig.isAtRest());

  s = fresh();
  s.setPose({ArmShoulderL: 120}); s.setMouthOpen(0.2);
  s.setReducedMotion(true);
  assert.ok(wb.rig.isAtRest());
  assert.equal(s.setPose({ArmShoulderL: 10}), false);
  assert.equal(s.playGesture('big-wave', 1), false);
  assert.equal(s.update(1).get('ParamMouthOpenY'), 0.2);
  s.setReducedMotion(false);
  assert.ok(s.playGesture('big-wave', 1));

  s = fresh();
  s.setPose({ArmElbowR: 50}); s.dispose();
  assert.ok(wb.rig.isAtRest());
  assert.equal(s.setPose({ArmElbowR: 50}), false);
  assert.equal(s.playGesture('point', 2), false);
});

test('a refused gesture keeps the manual pose (non-finite time, unknown id)', () => {
  const s = fresh();
  s.setPose({ArmShoulderL: 30});
  assert.equal(s.playGesture('big-wave', NaN), false);
  assert.equal(s.playGesture('wave<script>', 0), false);
  s.update(0.1);
  assert.equal(wb.rig.get('ArmShoulderL'), 30);
});

test('finding 3: 2D fallback replaces a WebGL-locked canvas, or throws clearly', () => {
  const ctx2d = {kind: '2d'};
  // Canvas that still gives 2D: used as-is.
  const plain = {getContext: () => ctx2d};
  assert.equal(acquireCanvas2D(plain).ctx, ctx2d);
  // WebGL-locked canvas in a DOM: replaced by a fresh canvas with same attributes.
  const attrs = {id: 'view', class: 'stage', style: 'x'};
  const fresh2d = {attrs: {}, getContext: () => ctx2d, setAttribute(k, v) { this.attrs[k] = v; }};
  let replaced = null;
  const parent = {replaceChild(a, b) { replaced = [a, b]; }};
  const locked = {width: 640, height: 480, parentNode: parent, getContext: () => null, getAttribute: k => attrs[k] ?? null};
  const out = acquireCanvas2D(locked, {createElement: () => fresh2d});
  assert.equal(out.canvas, fresh2d);
  assert.equal(out.ctx, ctx2d);
  assert.deepEqual(fresh2d.attrs, attrs);
  assert.deepEqual([fresh2d.width, fresh2d.height], [640, 480]);
  assert.deepEqual(replaced, [fresh2d, locked]);
  // Detached locked canvas, or no 2D anywhere: clear error, never a null context.
  assert.throws(() => acquireCanvas2D({getContext: () => null}, {createElement: () => fresh2d}), /fallback unavailable/);
  const dead = {getContext: () => null, setAttribute() {}};
  assert.throws(() => acquireCanvas2D({...locked}, {createElement: () => dead}), /could not be created/);
});
