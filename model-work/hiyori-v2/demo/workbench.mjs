import {createHiyoriV2Avatar, GESTURE_IDS, GESTURE_LABELS, DEFAULT_VIEW} from '../src/hiyori-v2-avatar.mjs';

const $ = id => document.getElementById(id);
const overlay = $('overlay');
const params = new URLSearchParams(location.search);

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // Query the live canvas: the Canvas2D fallback may have replaced #view.
  for (const c of [$('view'), overlay]) {
    c.width = Math.max(1, Math.round(c.clientWidth * dpr));
    c.height = Math.max(1, Math.round(c.clientHeight * dpr));
  }
}
resize();

let avatar;
try {
  avatar = await createHiyoriV2Avatar({canvas: $('view'), renderer: params.get('renderer') === 'canvas2d' ? 'canvas2d' : 'webgl', onError: e => console.warn(e)});
} catch (error) {
  $('error').textContent = `Load failed: ${error.message}`;
  throw error;
}
window.hiyoriV2 = avatar; // for automated browser checks
addEventListener('resize', resize);

const RANGES = {ArmShoulder: [-25, 170, 1], ArmElbow: [-165, 150, 1], ArmWrist: [-70, 70, 1]};
const sliders = new Map();
function syncSliders() {
  const {channels} = avatar.getState();
  for (const [name, {input, value}] of sliders) {
    input.value = channels[name];
    value.textContent = typeof channels[name] === 'number' ? String(+channels[name].toFixed(2)) : '';
  }
}

// Gesture buttons
for (const id of GESTURE_IDS) {
  const b = document.createElement('button');
  b.textContent = id === 'return' ? 'return (rest)' : id;
  b.title = GESTURE_LABELS[id] || 'ease every channel back to rest';
  b.onclick = () => { const ok = avatar.playGesture(id); $('error').textContent = ok ? '' : `refused: ${id} (reduced motion?)`; syncSliders(); };
  $('gestures').append(b);
}
$('stop').onclick = () => { avatar.stopGesture(); syncSliders(); };
$('stopNow').onclick = () => { avatar.stopGesture({immediate: true}); syncSliders(); };
$('reset').onclick = () => { avatar.reset(); syncSliders(); };
$('reduced').onchange = e => { avatar.setReducedMotion(e.target.checked); syncSliders(); };
$('bones').onchange = e => avatar.setView({debugBones: e.target.checked});
const applyBg = () => avatar.setView({background: $('dark').checked ? [0.12, 0.12, 0.15, 1] : [0.957, 0.949, 0.933, 1]});
$('dark').onchange = applyBg; applyBg();
const bindRange = (id, fn) => { const el = $(id); el.oninput = () => { $(id + 'V').textContent = el.value; fn(Number(el.value)); }; };
bindRange('mouth', v => avatar.setMouthOpen(v));
bindRange('speed', v => avatar.setView({speed: v}));
bindRange('zoom', v => avatar.setView({zoom: v}));
const focusPresets = {full: [DEFAULT_VIEW.zoom, DEFAULT_VIEW.focus], upper: [1.9, [0, 0.3]], handL: [7, [0.19, -0.03]], handR: [7, [-0.16, -0.04]]};
for (const b of document.querySelectorAll('[data-focus]')) b.onclick = () => {
  const [zoom, focus] = focusPresets[b.dataset.focus];
  avatar.setView({zoom, focus}); $('zoom').value = zoom; $('zoomV').textContent = zoom;
};

// Manual channel sliders (one column per side, stacked: no horizontal overflow)
for (const side of ['L', 'R']) {
  const host = $('ch' + side);
  const title = document.createElement('h3'); title.textContent = side === 'L' ? 'L arm (viewer right)' : 'R arm (viewer left)'; host.append(title);
  for (const base of ['ArmShoulder', 'ArmElbow', 'ArmWrist', 'HandCurl', 'FingerThumb', 'FingerIndex', 'FingerMiddle', 'FingerRing', 'FingerPinky', 'FingerSpread', 'ArmLayer']) {
    const name = base + side;
    const label = document.createElement('label'); label.className = 'ch';
    const text = document.createElement('span'); text.textContent = base.replace('Finger', 'F.').replace('Arm', '');
    const value = document.createElement('span');
    let input;
    if (base === 'ArmLayer') {
      input = document.createElement('select');
      for (const v of ['back', 'chest', 'front']) input.append(new Option(v, v));
      input.onchange = () => { if (!avatar.setPose({[name]: input.value})) syncSliders(); };
    } else {
      input = document.createElement('input'); input.type = 'range';
      const [min, max, step] = RANGES[base] || [-1, 1, 0.01];
      Object.assign(input, {min, max, step, value: 0});
      input.oninput = () => { if (avatar.setPose({[name]: Number(input.value)})) value.textContent = input.value; else syncSliders(); };
    }
    label.append(text, input, value); host.append(label);
    sliders.set(name, {input, value});
  }
}
syncSliders();

// Bones overlay, state panel, and slider sync on every transition to idle.
const og = overlay.getContext('2d');
let tick = 0, wasIdle = true;
avatar.onFrame = a => {
  og.clearRect(0, 0, overlay.width, overlay.height);
  if ($('bones').checked) {
    const v = a.view();
    const X = x => v.originX + x * v.scale, Y = y => v.originY - y * v.scale;
    for (const side of ['L', 'R']) {
      const p = a.landmarks(side);
      og.strokeStyle = side === 'L' ? '#e0306a' : '#2a6ee0'; og.lineWidth = 2;
      og.beginPath(); og.moveTo(X(p.shoulder[0]), Y(p.shoulder[1])); og.lineTo(X(p.elbow[0]), Y(p.elbow[1])); og.lineTo(X(p.wrist[0]), Y(p.wrist[1])); og.stroke();
      for (const q of [p.shoulder, p.elbow, p.wrist]) { og.beginPath(); og.arc(X(q[0]), Y(q[1]), 5, 0, Math.PI * 2); og.stroke(); }
    }
  }
  const s = a.getState();
  tick++;
  if (s.idle && !wasIdle) syncSliders();      // natural completion / end of an ease
  else if (!s.idle && tick % 6 === 0) syncSliders(); // follow a playing gesture
  wasIdle = s.idle;
  if (tick % 6 === 0) {
    $('state').textContent = JSON.stringify({gesture: s.gesture, playing: s.playing, fading: s.fading, idle: s.idle, manual: s.manual, reduced: s.reduced,
      atRest: s.atRest, mouth: s.mouth, renderer: s.renderer, frameMs: s.frameMs, coreOwned: s.coreOwned}, null, 1);
  }
};
