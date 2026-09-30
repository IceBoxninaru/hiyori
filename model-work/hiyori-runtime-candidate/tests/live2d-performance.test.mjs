import test from 'node:test';
import assert from 'node:assert/strict';
import {Live2DAvatar} from '../public/live2d-avatar.mjs';
import {performanceGestures} from '../public/performance-catalog.mjs';
import {motionPresets} from '../public/motion-presets.mjs';
import {characters} from '../public/characters.mjs';

const normalize = id => id.replace(/_/g, '').toLowerCase();
function deferred() {let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve};}
async function flush() {for (let i = 0; i < 5; i++) await Promise.resolve();}
function fixture(t, {motionResult = true, underscore = false, character = characters.hiyori} = {}) {
  let now = 0; const values = new Map(), savedValues = new Map(), motions = [], expressions = [], errors = [], focus = [];
  const parameters = [
    ['ParamAngleX', -30, 30, 0], ['ParamAngleY', -30, 30, 0], ['ParamAngleZ', -30, 30, 0],
    ['ParamBodyAngleX', -10, 10, 0], ['ParamArmLA', -30, 30, 0], ['ParamHairFront', -1, 1, 0], ['ParamEyeBallX', -1, 1, 0], ['ParamEyeBallY', -1, 1, 0],
    ['ParamMouthOpenY', 0, 1, 0], ['ParamMouthForm', -1, 1, 0], ['ParamEyeLOpen', 0, 1, 1],
    ['ParamBrowLY', -1, 1, 0], ['ParamBrowRY', -1, 1, 0], ['ParamBrowLAngle', -1, 1, 0], ['ParamBrowRAngle', -1, 1, 0],
  ].map(([name, min, max, value]) => ({id: underscore ? name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() : name, min, max, default: value}));
  for (const p of parameters) values.set(p.id, p.default);
  const core = {setParameterValueById(id, value) {assert.ok(values.has(id), 'must not create absent rig parameters'); assert.ok(Number.isFinite(value)); values.set(id, value);},
    getParameterValueById: id => values.get(id), saveParameters() {for (const [id,value] of values) savedValues.set(id,value);},
    loadParameters() {for (const [id,value] of savedValues) values.set(id,value);}};
  core.saveParameters();
  const manager = {stops: 0, stopAllMotions() {this.stops++;}, groups: {idle: 'Idle'}, definitions: {App: Array.from({length: 21}, () => ({}))},
    expressionManager: {reserveExpressionIndex: -1, definitions: [{Name: 'Smile.exp3.json'}], resets: 0, resetExpression() {this.resets++;}}};
  const avatar = new Live2DAvatar({canvas: {}, now: () => now, onError: error => errors.push(error)});
  avatar.parameters = new Map(parameters.map(p => [normalize(p.id), p]));
  const id = name => avatar.parameters.get(normalize(name))?.id;
  avatar.lipIds = [id('ParamMouthOpenY')]; avatar.eyeIds = [id('ParamEyeLOpen')]; avatar.character = character;
  avatar.model = {internalModel: {coreModel: core, motionManager: manager, focusController: {focus: (...args) => focus.push(args)}},
    motion(group, index, priority) {motions.push({group, index, priority}); return motionResult;}, expression(name) {expressions.push(name);},
    update() {core.loadParameters(); avatar.applyFace(); core.loadParameters();}, destroy() {}};
  avatar.app = {stage: {removeChild() {}}, renderer: {render() {}, clear() {}}, destroy() {}};
  const saved = new Map(['requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'requestAnimationFrame', {value: () => 1, configurable: true});
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {value: () => {}, configurable: true});
  t.after(() => {avatar.destroy(); for (const [key, descriptor] of saved) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}});
  return {avatar, manager, motions, expressions, errors, values, id,
    draw(pose = {}) {core.loadParameters(); for (const [name,value] of Object.entries(pose)) core.setParameterValueById(id(name),value);
      core.saveParameters(); avatar.applyFace(); const rendered = new Map(values); core.loadParameters(); return rendered;},
    setTime(value) {now = value;}, tick(ms = 16) {now += ms; avatar.tick(now);}};
}
function frame(extra = {}) {return {state: 'speaking', expression: 'happy', gesture: 'none', head: 'still', gaze: 'forward', intensity: .5,
  holdMs: 1200, expiresAt: 5000, epoch: 1, inputSeq: 1, turnId: 'reply-1', ...extra};}

test('performance face updates have no implicit Tap, expression async load, or repeated motion stop', async t => {
  const f = fixture(t); assert.equal(f.avatar.applyPerformance(frame()), true); const stops = f.manager.stops;
  f.avatar.applyPerformance(frame({expression: 'concerned'})); await flush();
  assert.equal(f.motions.length, 0); assert.equal(f.expressions.length, 0); assert.equal(f.manager.stops, stops);
  assert.equal(f.manager.groups.idle, '__disabled__'); assert.equal(f.avatar.reaction, 'concerned');
});

test('explicit gestures use the authored App presets once and survive an unrelated face update', async t => {
  const f = fixture(t); f.avatar.applyPerformance(frame({gesture: 'joy'})); await flush();
  assert.deepEqual(f.motions, [{group: 'App', index: 6, priority: 3}]); const gesture = f.avatar.performanceGesture, stops = f.manager.stops;
  f.avatar.applyPerformance(frame({expression: 'focused', gesture: 'none'}));
  f.avatar.applyPerformance(frame({gesture: 'joy'})); await flush();
  assert.equal(f.motions.length, 1); assert.equal(f.avatar.performanceGesture, gesture); assert.equal(f.manager.stops, stops);
});

test('listening interrupts an old motion and a late motion promise cannot revive it', async t => {
  const pending = deferred(); const f = fixture(t, {motionResult: pending.promise});
  f.avatar.applyPerformance(frame({gesture: 'wave'})); const stops = f.manager.stops;
  f.avatar.applyPerformance(frame({state: 'listening', expression: 'calm', inputSeq: 2, gesture: 'none'}));
  assert.equal(f.avatar.performanceGesture, null); assert.ok(f.manager.stops > stops);
  pending.resolve(true); await flush(); assert.equal(f.avatar.performanceGesture, null); assert.equal(f.errors.length, 0);
});

test('pose/gaze layers affect supported rig parameters but never replace audible mouth animation', t => {
  const f = fixture(t, {underscore: true}); f.avatar.applyPerformance(frame({head: 'tilt', gaze: 'away', intensity: .5}));
  f.avatar.face = {smile: .5, brow: .2, browAngle: 0, eye: 1, tilt: 9}; f.avatar.mouth = .65;
  f.avatar.applyFace(); assert.equal(f.values.get(f.id('ParamMouthOpenY')), .65);
  assert.equal(f.values.get(f.id('ParamAngleZ')), 3, 'head layer owns tilt, not the expression tilt');
  assert.equal(f.values.get(f.id('ParamEyeBallX')), .15); assert.equal(f.values.get(f.id('ParamMouthForm')), .5);
  f.avatar.lookAt(-1, -1); f.avatar.applyFace(); assert.equal(f.values.get(f.id('ParamEyeBallX')), .15);
});

test('invalid, expired and old identity frames have no visual side effects', t => {
  const f = fixture(t); f.avatar.applyPerformance(frame({epoch: 3, inputSeq: 2}));
  for (const value of [frame(), frame({epoch: 3, inputSeq: 1}), frame({epoch: 3, inputSeq: 2, expiresAt: -1}),
    frame({epoch: 3, inputSeq: 2, head: 'invented'}), frame({epoch: 3, inputSeq: 2, intensity: NaN})]) assert.equal(f.avatar.applyPerformance(value), false);
  assert.equal(f.avatar.performanceFrame.epoch, 3); assert.equal(f.motions.length, 0);
});

test('reduced motion suppresses a gesture and does not play it later on a duplicate frame', async t => {
  const f = fixture(t); f.avatar.applyPerformance(frame({gesture: 'wave', reducedMotion: true, head: 'tilt'}));
  f.avatar.applyPerformance(frame({gesture: 'wave', reducedMotion: false})); await flush(); assert.equal(f.motions.length, 0);
  f.avatar.applyPerformance(frame({gesture: 'nod', turnId: 'reply-2', inputSeq: 2})); await flush(); assert.equal(f.motions.length, 1);
  f.avatar.setReducedMotion(true); assert.equal(f.avatar.performanceGesture, null); assert.equal(f.manager.groups.idle, '__disabled__');
});

test('frame deadlines neutralize a gesture even when its owner does not send a reset', async t => {
  const f = fixture(t); f.avatar.applyPerformance(frame({gesture: 'joy', expiresAt: 100})); await flush();
  f.tick(110); assert.equal(f.avatar.performanceGesture, null); assert.equal(f.avatar.performanceFrame.expression, 'calm');
  assert.equal(f.avatar.performanceFrame.expiresAt, null); assert.equal(f.motions.length, 1);
});

test('legacy lab react retains its happy Tap behavior after leaving performance mode', async t => {
  const f = fixture(t); f.avatar.applyPerformance(frame()); f.avatar.react('happy'); await flush();
  assert.equal(f.avatar.performanceFrame, null); assert.equal(f.manager.groups.idle, 'Idle');
  assert.equal(f.motions[0].group, 'Tap'); assert.deepEqual(f.expressions, ['Smile.exp3.json']);
});

test('the fixed catalog selects existing App motions and legacy aliases retain their targets', async t => {
  const f = fixture(t);
  assert.equal(performanceGestures.wave, 'greeting'); assert.equal(performanceGestures.joy, 'happy');
  let index = 1;
  for (const gesture of ['thinking','tilt-head','laugh','shy','surprised','worried','focused','polite-bow','inspiration','settle','shake-head','happy','greeting']) {
    assert.equal(f.avatar.applyPerformance(frame({gesture, inputSeq: index++, turnId: gesture})), true);
    await flush();
    assert.equal(f.motions.at(-1).group, 'App');
    assert.equal(f.motions.at(-1).index, motionPresets.find(preset => preset.id === gesture).index);
  }
  assert.equal(f.motions.length, 13);
  assert.equal(f.avatar.applyPerformance(frame({gesture: 'constructor', inputSeq: index})), false);
});

test('authored face and gaze survive the semantic layer without doubling the head or replacing audio mouth', async t => {
  const f = fixture(t, {underscore: true});
  f.avatar.applyPerformance(frame({gesture: 'thinking', head: 'tilt', gaze: 'away', intensity: 1})); await flush();
  f.avatar.face = {smile: .5, brow: .25, browAngle: 0, eye: .9, tilt: 0}; f.avatar.mouth = .62;
  const rendered = f.draw({ParamAngleZ: -8, ParamEyeBallX: -.4, ParamEyeBallY: .3, ParamMouthForm: -.3,
    ParamEyeLOpen: .7, ParamBrowLY: -.2, ParamBrowLAngle: .2, ParamMouthOpenY: .95});
  // Hiyori's sparse thinking motion does not own BrowLAngle; the semantic
  // expression must still control it even though Chitose authors that channel.
  for (const [name,value] of Object.entries({ParamAngleZ: -8, ParamEyeBallX: -.4, ParamEyeBallY: .3,
    ParamMouthForm: -.3, ParamEyeLOpen: .7, ParamBrowLY: -.2, ParamBrowLAngle: 0, ParamMouthOpenY: .62}))
    assert.ok(Math.abs(rendered.get(f.id(name)) - value) < 1e-9, name);
});

test('motion strength blends authored channels while unowned expression channels remain independent', async t => {
  const f = fixture(t); f.avatar.applyPerformance(frame({gesture: 'thinking', head: 'tilt', gaze: 'away', intensity: .5})); await flush();
  f.avatar.face = {smile: .5, brow: .25, browAngle: 0, eye: .9, tilt: 0};
  const rendered = f.draw({ParamAngleZ: -8, ParamEyeBallX: -.4, ParamMouthForm: -.3, ParamEyeLOpen: .7, ParamHairFront: .8});
  assert.equal(rendered.get(f.id('ParamAngleZ')), -4);
  assert.ok(Math.abs(rendered.get(f.id('ParamMouthForm')) - .1) < 1e-9);
  assert.ok(Math.abs(rendered.get(f.id('ParamEyeBallX')) + .125) < 1e-9);
  assert.ok(Math.abs(rendered.get(f.id('ParamEyeLOpen')) - .8) < 1e-9);
  assert.equal(rendered.get(f.id('ParamHairFront')), .8, 'physics output is not scaled by gesture intensity');
  f.avatar.applyPerformance(frame({gesture: 'nod', inputSeq: 2, turnId: 'nod', intensity: 1})); await flush();
  f.avatar.elapsed += .3;
  const nod = f.draw({ParamAngleY: -6, ParamMouthForm: 0});
  assert.equal(nod.get(f.id('ParamMouthForm')), .5, 'a nod without mouth curves leaves the semantic face intact');
});

test('a Hiyori motion without a mouth curve preserves its semantic smile while Chitose retains its authored mouth', async t => {
  for(const character of [characters.hiyori,characters.chitose])await t.test(character.id,async child=>{
    const f=fixture(child,{character,underscore:character.id==='chitose'});
    f.avatar.applyPerformance(frame({gesture:'greeting',intensity:1}));await flush();
    f.avatar.face={smile:.8,brow:.25,browAngle:0,eye:.9,tilt:0};f.avatar.mouth=.6;
    const rendered=f.draw({ParamMouthForm:.25,ParamMouthOpenY:.95});
    assert.equal(rendered.get(f.id('ParamMouthForm')),character.id==='hiyori'?.8:.25);
    assert.equal(rendered.get(f.id('ParamMouthOpenY')),.6,'audible mouth opening remains independent in both rigs');
  });
});

test('an embedded character keeps its rig ownership and an unknown character inherits no channels',async t=>{
  const cases=[
    ['embedded',{...characters.hiyori,modelURL:`https://embed.example/assets${characters.hiyori.modelURL}`},true],
    ['unknown',{id:'custom',name:'Custom model'},false],
    ['missing-id',{name:'桃瀬ひより'},false],
  ];
  for(const [label,character,known]of cases)await t.test(label,async child=>{
    const f=fixture(child,{character});
    f.avatar.applyPerformance(frame({gesture:'greeting',intensity:1}));await flush();
    assert.equal(f.avatar.performanceGesture.parameters.has(normalize('ParamAngleY')),known);
    if(!known)assert.equal(f.avatar.performanceGesture.parameters.size,0);
    f.avatar.face={smile:.8,brow:.25,browAngle:0,eye:.9,tilt:0};
    assert.equal(f.draw({ParamMouthForm:.25}).get(f.id('ParamMouthForm')),.8);
  });
});

test('interruption clears saved motion pose but eases the visible pose without delaying live mouth changes', async t => {
  const f = fixture(t); f.avatar.applyPerformance(frame({gesture: 'thinking', intensity: 1})); await flush();
  f.avatar.mouth = .2; f.draw({ParamAngleZ: -8, ParamEyeBallX: -.4, ParamHairFront: .7});
  f.avatar.applyPerformance(frame({state: 'listening', expression: 'calm', inputSeq: 2}));
  assert.equal(f.avatar.performanceGesture, null); assert.ok(f.avatar.performanceRelease);
  assert.equal(f.values.get(f.id('ParamAngleZ')), 0, 'the native saved pose is immediately neutral');
  assert.equal(f.values.get(f.id('ParamHairFront')), .7, 'unowned simulation parameters are not reset');
  f.avatar.mouth = .72;
  const first = f.draw();
  assert.equal(first.get(f.id('ParamAngleZ')), -8, 'no visible snap at the interruption boundary');
  assert.equal(first.get(f.id('ParamMouthOpenY')), .72, 'mouth never waits for the body transition');
  f.avatar.elapsed += .14; const middle = f.draw(); assert.ok(Math.abs(middle.get(f.id('ParamAngleZ')) + 4) < 1e-9);
  f.avatar.elapsed += .14; const end = f.draw(); assert.equal(end.get(f.id('ParamAngleZ')), 0); assert.equal(f.avatar.performanceRelease, null);
  for (let i = 0; i < 200; i++) assert.equal(f.draw().get(f.id('ParamAngleZ')), 0, 'render updates cannot accumulate the old offset');
});

test('reduced motion, disconnected reset and hidden state cancel release immediately and cannot replay it', async t => {
  for (const [index,stop] of [f => f.avatar.setReducedMotion(true), f => f.avatar.setActive(false),
    f => f.avatar.applyPerformance(frame({state: 'disconnected', expression: 'calm', gesture: 'none', inputSeq: 2, expiresAt: null}))].entries()) await t.test(String(index),async child=>{
    const f = fixture(child); f.avatar.applyPerformance(frame({gesture: 'thinking', intensity: 1})); await flush();
    f.draw({ParamAngleZ: -8}); f.avatar.stopPerformanceGesture(); assert.ok(f.avatar.performanceRelease);
    stop(f); assert.equal(f.avatar.performanceRelease, null); assert.equal(f.avatar.performanceGesture, null);
    assert.equal(f.values.get(f.id('ParamAngleZ')), 0);
    f.avatar.setReducedMotion(false); f.avatar.setActive(true); f.avatar.elapsed += 1;
    assert.equal(f.draw().get(f.id('ParamAngleZ')), 0); assert.equal(f.motions.length, 1);
  });
});
