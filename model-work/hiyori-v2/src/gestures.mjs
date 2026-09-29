// Closed gesture catalog for the Hiyori v2 rig. Pure data + sampling.
// Keys are [fraction, value]; the rest value is implied at fraction 0 and 1,
// so every gesture starts and ends at rest. Numeric tracks use monotone cubic
// interpolation (no overshoot). ArmLayer tracks are steps.
//
// Joint values were chosen from wrist landmarks measured on the rig
// (see tools/render-poses.mjs), e.g. shoulder 168 / elbow -29 puts the left
// wrist at y=0.656, above the top of the head (~0.59).

// Core parameters a gesture may drive. ParamMouthOpenY is deliberately absent:
// audio owns the mouth.
export const CORE_ALLOWLIST = Object.freeze([
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
  'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeLSmile', 'ParamEyeRSmile',
  'ParamBrowLY', 'ParamBrowRY', 'ParamCheek', 'ParamMouthForm', 'ParamShoulder', 'ParamBreath',
]);

const wave = (t0, t1, cycles, center, amplitude) => {
  const keys = [];
  const n = cycles * 2;
  for (let i = 0; i <= n; i++) keys.push([+(t0 + (t1 - t0) * i / n).toFixed(4), i === 0 || i === n ? center : center + (i % 2 ? amplitude : -amplitude)]);
  return keys;
};

export const GESTURES = Object.freeze({
  'arm-raise': {
    label: '腕を高く上げる', duration: 2.8,
    tracks: {
      ArmShoulderL: [[0.12, -6], [0.36, 150], [0.44, 162], [0.68, 160], [0.86, 30]],
      ArmElbowL: [[0.3, 40], [0.44, -20], [0.68, -22], [0.86, 10]],
      ArmWristL: [[0.4, -10], [0.68, -12]],
      HandCurlL: [[0.36, -0.5], [0.7, -0.6], [0.86, 0]],
      FingerSpreadL: [[0.4, 0.7], [0.7, 0.8]],
    },
    core: {
      ParamAngleZ: [[0.4, -6], [0.7, -5]], ParamEyeBallY: [[0.3, 0.5], [0.7, 0.4]], ParamEyeBallX: [[0.35, 0.3], [0.7, 0.25]],
      ParamBodyAngleZ: [[0.4, -3], [0.7, -2.5]], ParamEyeLSmile: [[0.4, 0.4], [0.72, 0.4]], ParamEyeRSmile: [[0.4, 0.4], [0.72, 0.4]],
    },
  },
  'big-wave': {
    label: '大きく手を振る', duration: 3.8,
    tracks: {
      ArmShoulderL: [[0.14, 92], [0.84, 88], [0.93, 20]],
      ArmElbowL: [[0.1, 20], [0.16, 55], ...wave(0.2, 0.8, 4, 52, 24), [0.9, 30]],
      ArmWristL: wave(0.22, 0.82, 4, 0, 18),
      HandCurlL: [[0.14, -0.8], [0.84, -0.8], [0.93, 0]],
      FingerSpreadL: [[0.16, 1], [0.84, 1]],
    },
    core: {
      ParamAngleZ: wave(0.2, 0.8, 2, -3, 3), ParamBodyAngleZ: wave(0.22, 0.82, 2, -1.5, 2),
      ParamEyeLSmile: [[0.15, 0.7], [0.85, 0.7]], ParamEyeRSmile: [[0.15, 0.7], [0.85, 0.7]], ParamCheek: [[0.2, 0.3], [0.8, 0.3]],
    },
  },
  'open-palm': {
    label: '手を開いて見せる', duration: 3.0,
    tracks: {
      ArmShoulderL: [[0.2, 10], [0.7, 12], [0.88, 2]],
      ArmElbowL: [[0.12, 20], [0.3, 82], [0.7, 80], [0.88, 10]],
      ArmWristL: [[0.3, -25], [0.7, -22]],
      HandCurlL: [[0.2, 0.4], [0.4, -1], [0.7, -1], [0.86, 0]],
      FingerSpreadL: [[0.4, 1], [0.7, 1]],
      ArmLayerL: [[0.2, 'chest'], [0.9, 'back']],
    },
    core: {ParamEyeBallX: [[0.3, 0.3], [0.7, 0.25]], ParamAngleX: [[0.35, 6], [0.7, 5]], ParamMouthForm: [[0.35, 1], [0.7, 1]]},
  },
  point: {
    label: '指差す', duration: 3.0,
    tracks: {
      ArmShoulderR: [[0.12, -5], [0.3, 78], [0.7, 74], [0.88, 10]],
      ArmElbowR: [[0.2, 45], [0.32, 28], [0.7, 31], [0.88, 5]],
      ArmWristR: [[0.3, 8], [0.7, 6]],
      FingerIndexR: [[0.22, 0.3], [0.32, -1], [0.72, -1], [0.88, 0]],
      FingerMiddleR: [[0.25, 1], [0.72, 1], [0.88, 0.2]],
      FingerRingR: [[0.25, 1], [0.72, 1], [0.88, 0.2]],
      FingerPinkyR: [[0.25, 1], [0.72, 1], [0.88, 0.2]],
      FingerThumbR: [[0.25, 0.8], [0.72, 0.8], [0.88, 0.1]],
    },
    core: {ParamEyeBallX: [[0.2, -0.6], [0.72, -0.55]], ParamAngleX: [[0.3, -14], [0.72, -12]], ParamAngleZ: [[0.3, 4], [0.72, 3]], ParamBodyAngleX: [[0.32, -4], [0.72, -3]]},
  },
  'fist-close': {
    label: '指を順に握る', duration: 3.6,
    tracks: {
      ArmShoulderL: [[0.12, 21], [0.85, 21]],
      ArmElbowL: [[0.12, 102], [0.85, 102]],
      ArmWristL: [[0.12, -10], [0.85, -10]],
      FingerThumbL: [[0.12, -1], [0.3, -1], [0.62, 1], [0.8, 1]],
      FingerIndexL: [[0.12, -1], [0.3, -1], [0.56, 1], [0.8, 1]],
      FingerMiddleL: [[0.12, -1], [0.3, -1], [0.5, 1], [0.8, 1]],
      FingerRingL: [[0.12, -1], [0.3, -1], [0.44, 1], [0.8, 1]],
      FingerPinkyL: [[0.12, -1], [0.3, -1], [0.38, 1], [0.8, 1]],
      FingerSpreadL: [[0.14, 1], [0.3, 1], [0.5, 0]],
      ArmLayerL: [[0.1, 'front'], [0.92, 'back']],
    },
    core: {ParamEyeBallX: [[0.2, 0.35], [0.8, 0.35]], ParamEyeBallY: [[0.2, 0.2], [0.8, 0.2]], ParamAngleX: [[0.25, 8], [0.8, 8]]},
  },
  'shy-hands': {
    label: '照れて手を顔の横へ', duration: 3.6,
    tracks: {
      ArmShoulderL: [[0.12, 4], [0.3, 12], [0.72, 10], [0.9, 2]],
      ArmElbowL: [[0.14, 60], [0.3, 146], [0.72, 144], [0.9, 30]],
      ArmWristL: [[0.3, -18], [0.72, -14]],
      ArmShoulderR: [[0.14, 6], [0.32, 30], [0.74, 28], [0.9, 4]],
      ArmElbowR: [[0.16, 60], [0.32, 146], [0.74, 144], [0.9, 30]],
      ArmWristR: [[0.32, -18], [0.74, -14]],
      HandCurlL: [[0.3, 0.35], [0.72, 0.45], [0.9, 0]],
      HandCurlR: [[0.32, 0.35], [0.74, 0.45], [0.9, 0]],
      ArmLayerL: [[0.16, 'front'], [0.9, 'back']],
      ArmLayerR: [[0.18, 'front'], [0.9, 'back']],
    },
    core: {
      ParamCheek: [[0.25, 0.8], [0.75, 0.8]], ParamEyeBallX: [[0.3, -0.5], [0.6, -0.5], [0.72, 0]], ParamEyeBallY: [[0.3, -0.3], [0.6, -0.3], [0.72, 0]],
      ParamAngleX: [[0.3, -8], [0.62, -8], [0.75, -2]], ParamAngleY: [[0.3, -6], [0.62, -6]], ParamAngleZ: [[0.3, 6], [0.7, 5]],
      ParamEyeLSmile: [[0.3, 0.5], [0.75, 0.5]], ParamEyeRSmile: [[0.3, 0.5], [0.75, 0.5]], ParamShoulder: [[0.3, 0.6], [0.72, 0.5]],
    },
  },
});

// 'return' is a catalog id handled by the controller: ease every channel to rest.
export const GESTURE_IDS = Object.freeze([...Object.keys(GESTURES), 'return']);

export function isGestureId(id) {
  return typeof id === 'string' && GESTURE_IDS.includes(id);
}

// Fritsch-Carlson monotone cubic through points [[x,y],...] (x strictly increasing).
export function monotoneCubic(points) {
  const n = points.length;
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  if (n > 1) { m[0] = 0; m[n - 1] = 0; } // ease in/out at the rest endpoints
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

// Compiles a gesture against rest values. Returns {channels: Map(name->fn), core: Map(id->fn)}.
export function compileGesture(id, {channelRest, channelSpec, coreDefault}) {
  const g = GESTURES[id];
  if (!g) throw new Error(`unknown gesture ${id}`);
  const compileTrack = (keys, rest, spec) => {
    if (spec?.enum) {
      const steps = keys.map(([x, v]) => { if (!spec.enum.includes(v)) throw new Error(`bad enum ${v}`); return [x, v]; });
      return x => { let v = rest; for (const [kx, kv] of steps) if (x >= kx) v = kv; return x >= 1 ? rest : v; };
    }
    const points = [[0, rest], ...keys.map(([x, v]) => [x, spec ? Math.min(spec.max, Math.max(spec.min, v)) : v]), [1, rest]];
    for (let i = 1; i < points.length; i++) if (!(points[i][0] > points[i - 1][0])) throw new Error(`${id}: keys not increasing`);
    return monotoneCubic(points);
  };
  const channels = new Map(), core = new Map();
  for (const [name, keys] of Object.entries(g.tracks)) {
    if (!channelRest.has(name)) throw new Error(`${id}: unknown channel ${name}`);
    channels.set(name, compileTrack(keys, channelRest.get(name), channelSpec.get(name)));
  }
  for (const [param, keys] of Object.entries(g.core || {})) {
    if (!CORE_ALLOWLIST.includes(param)) throw new Error(`${id}: core parameter not allowed: ${param}`);
    if (!coreDefault.has(param)) throw new Error(`${id}: unknown core parameter ${param}`);
    core.set(param, compileTrack(keys, coreDefault.get(param), null));
  }
  return {id, duration: g.duration, channels, core};
}
