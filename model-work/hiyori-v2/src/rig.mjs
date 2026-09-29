// Hiyori v2 arm/hand rig: pure math, no DOM, no I/O.
// Inputs: the rig manifest, the ORIGINAL rest-pose drawables (from Cubism Core
// at default parameters) and the derived finger parts (tools/build-parts.mjs).
// Output per solve(): render items in model units.
//
// Sleeves use angle blending along the joint chain: a vertex rotates about the
// REST elbow pivot by (w_elbow * elbowAngle), then about the rest shoulder pivot
// by (w_shoulder * shoulderAngle), then by the torso transform. Blending angles
// (not matrices) keeps the sleeve width at deep bends instead of pinching.

export const SIDES = ['L', 'R'];
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
export const LAYERS = ['back', 'chest', 'front'];
export const FINGER_TEXTURE = 2; // texture slot of build/finger-atlas.png
const FINGER_CHANNEL = {thumb: 'FingerThumb', index: 'FingerIndex', middle: 'FingerMiddle', ring: 'FingerRing', pinky: 'FingerPinky'};
const DEG = Math.PI / 180;

const MANIFEST_KEYS = ['schema', 'status', 'units', 'hiddenCoreParts', 'torsoAnchor', 'slots', 'arms', 'skin', 'hand', 'channels'];

export function validateManifest(manifest) {
  const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
  const finitePair = v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
  if (!isObject(manifest) || manifest.schema !== 'hiyori-v2-rig/1') throw new Error('rig: bad schema');
  for (const key of Object.keys(manifest)) if (!MANIFEST_KEYS.includes(key)) throw new Error(`rig: unknown key ${key}`);
  for (const key of MANIFEST_KEYS) if (!(key in manifest)) throw new Error(`rig: missing ${key}`);
  for (const side of SIDES) {
    const arm = manifest.arms[side];
    if (!isObject(arm) || ![1, -1].includes(arm.mirror)) throw new Error(`rig: arm ${side}`);
    for (const joint of ['shoulder', 'elbow', 'wrist']) if (!finitePair(arm.pivots?.[joint])) throw new Error(`rig: pivot ${side}.${joint}`);
    for (const mesh of ['cap', 'upper', 'forearm', 'thumb']) if (typeof arm.meshes?.[mesh] !== 'string') throw new Error(`rig: mesh ${side}.${mesh}`);
    for (const strip of ['base', 'tip']) if (typeof arm.fingerStrips?.[strip] !== 'string') throw new Error(`rig: strip ${side}.${strip}`);
  }
  for (const [name, spec] of Object.entries(manifest.channels)) {
    if (spec.enum) { if (!spec.enum.includes(spec.rest)) throw new Error(`rig: channel ${name} rest`); continue; }
    if (!(Number.isFinite(spec.min) && Number.isFinite(spec.max) && spec.min < spec.max && spec.rest >= spec.min && spec.rest <= spec.max)) throw new Error(`rig: channel ${name} limits`);
  }
  for (const layer of Object.keys(manifest.slots)) if (!LAYERS.includes(layer)) throw new Error(`rig: slot ${layer}`);
  return manifest;
}

// ---- 2D affine helpers: m = [a, b, c, d, e, f], p' = (a x + c y + e, b x + d y + f)
export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
export function compose(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export function rotationAbout(px, py, radians) {
  const c = Math.cos(radians), s = Math.sin(radians);
  return [c, s, -s, c, px - c * px + s * py, py - s * px - c * py];
}
export function translation(x, y) { return [1, 0, 0, 1, x, y]; }
export function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
// Similarity mapping segment (p0,p1) onto (q0,q1).
export function similarity(p0, p1, q0, q1) {
  const px = p1[0] - p0[0], py = p1[1] - p0[1], qx = q1[0] - q0[0], qy = q1[1] - q0[1];
  const den = px * px + py * py || 1;
  const a = (px * qx + py * qy) / den, b = (px * qy - py * qx) / den;
  return [a, b, -b, a, q0[0] - (a * p0[0] - b * p0[1]), q0[1] - (b * p0[0] + a * p0[1])];
}

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class HiyoriRig {
  constructor(manifest, restDrawables, fingerParts) {
    this.manifest = validateManifest(manifest);
    this.rest = new Map(restDrawables.map(d => [d.id, d]));
    const anchor = this.rest.get(manifest.torsoAnchor.drawable);
    if (!anchor) throw new Error('rig: torso anchor drawable missing');
    this.anchorVertices = manifest.torsoAnchor.near.map(([x, y]) => {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < anchor.positions.length; i += 2) {
        const d = (anchor.positions[i] - x) ** 2 + (anchor.positions[i + 1] - y) ** 2;
        if (d < bestD) { bestD = d; best = i / 2; }
      }
      return best;
    });
    this.anchorRest = this.anchorVertices.map(i => [anchor.positions[i * 2], anchor.positions[i * 2 + 1]]);
    this.channelSpecs = new Map();
    for (const side of SIDES) for (const [name, spec] of Object.entries(manifest.channels)) this.channelSpecs.set(name + side, spec);
    this.values = new Map();
    this.reset();
    this.arms = Object.fromEntries(SIDES.map(side => [side, this.buildArm(side, fingerParts)]));
  }

  // ---- channels
  reset() { for (const [name, spec] of this.channelSpecs) this.values.set(name, spec.rest); }
  channelNames() { return [...this.channelSpecs.keys()]; }
  get(name) { if (!this.values.has(name)) throw new Error(`rig: unknown channel ${name}`); return this.values.get(name); }
  set(name, value) {
    const spec = this.channelSpecs.get(name);
    if (!spec) throw new Error(`rig: unknown channel ${name}`);
    if (spec.enum) { if (!spec.enum.includes(value)) throw new Error(`rig: bad value for ${name}`); this.values.set(name, value); return value; }
    if (!Number.isFinite(value)) throw new Error(`rig: non-finite ${name}`);
    const v = Math.min(spec.max, Math.max(spec.min, value));
    this.values.set(name, v);
    return v;
  }
  isAtRest() { for (const [name, spec] of this.channelSpecs) if (this.values.get(name) !== spec.rest) return false; return true; }

  // ---- build
  buildArm(side, fingerParts) {
    const def = this.manifest.arms[side], m = def.mirror, P = def.pivots;
    const upperAxis = [P.elbow[0] - P.shoulder[0], P.elbow[1] - P.shoulder[1]];
    const foreAxis = [P.wrist[0] - P.elbow[0], P.wrist[1] - P.elbow[1]];
    const axes = {upper: {origin: P.shoulder, axis: upperAxis}, forearm: {origin: P.elbow, axis: foreAxis}};
    const project = (axisName, x, y) => {
      const {origin, axis} = axes[axisName];
      return ((x - origin[0]) * axis[0] + (y - origin[1]) * axis[1]) / (axis[0] ** 2 + axis[1] ** 2);
    };
    const drawable = id => { const d = this.rest.get(id); if (!d) throw new Error(`rig: drawable ${id} missing`); return d; };
    // Sleeve meshes: per-vertex joint weights [shoulder, elbow].
    const sleeves = ['cap', 'upper', 'forearm'].map(kind => {
      const d = drawable(def.meshes[kind]);
      const spec = this.manifest.skin[kind];
      const n = d.positions.length / 2, ws = new Float32Array(n), we = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = project(spec.axis, d.positions[i * 2], d.positions[i * 2 + 1]);
        const w = (range, fallback) => range ? range[2] * smoothstep(range[0], range[1], t) : fallback;
        ws[i] = w(spec.shoulder, 1);
        we[i] = w(spec.elbow, kind === 'forearm' ? 1 : 0);
      }
      return {kind, id: `${kind}.${side}`, drawable: d.id, texture: d.texture, uvs: d.uvs, indices: d.indices, rest: d.positions, order: d.order, ws, we,
        group: kind === 'forearm' ? 'hand' : 'body'};
    });
    // Hand parts: rigid, attached to the wrist, clipped at the cuff opening.
    const axisLen = Math.hypot(...foreAxis), dir = [foreAxis[0] / axisLen, foreAxis[1] / axisLen];
    const hand = this.manifest.hand;
    const clipOrigin = [P.wrist[0] - dir[0] * hand.cuffClipOffset, P.wrist[1] - dir[1] * hand.cuffClipOffset];
    const rigidPart = (id, finger, segment, source) => {
      // Pivot: centroid of vertices in the band nearest the cuff (min projection).
      const pr = [];
      for (let i = 0; i < source.rest.length; i += 2) pr.push((source.rest[i] - P.wrist[0]) * dir[0] + (source.rest[i + 1] - P.wrist[1]) * dir[1]);
      const lo = Math.min(...pr), hi = Math.max(...pr), band = lo + (hi - lo) * 0.2;
      let px = 0, py = 0, n = 0;
      for (let i = 0; i < pr.length; i++) if (pr[i] <= band) { px += source.rest[i * 2]; py += source.rest[i * 2 + 1]; n++; }
      // Distance needed to pull the whole part behind the cuff clip line.
      const retract = hi + hand.cuffClipOffset + 0.004;
      return {kind: 'finger', id, finger, segment, ...source, pivot: [px / n, py / n], retract, group: 'hand'};
    };
    const fingers = [];
    const thumbDrawable = drawable(def.meshes.thumb);
    fingers.push(rigidPart(`thumb.${side}`, 'thumb', 'whole', {drawable: thumbDrawable.id, texture: thumbDrawable.texture, uvs: thumbDrawable.uvs, indices: thumbDrawable.indices, rest: thumbDrawable.positions, order: thumbDrawable.order}));
    for (const segment of ['base', 'tip']) {
      const strip = drawable(def.fingerStrips[segment]);
      const names = ['index', 'middle', 'ring', 'pinky'];
      for (const [k, finger] of names.entries()) {
        const part = fingerParts.parts.find(p => p.side === side && p.finger === finger && p.segment === segment);
        if (!part) throw new Error(`rig: finger part ${side}.${finger}.${segment} missing (run tools/build-parts.mjs)`);
        fingers.push(rigidPart(part.id, finger, segment, {
          drawable: strip.id, texture: FINGER_TEXTURE, uvs: Float32Array.from(part.uvs), indices: Uint16Array.from(part.indices),
          rest: Float32Array.from(part.positions), order: strip.order + (3 - k) * 0.01,
        }));
      }
    }
    // Tip segments pivot on their base finger's pivot line (they sit over it).
    for (const tip of fingers.filter(f => f.segment === 'tip')) tip.base = fingers.find(f => f.segment === 'base' && f.finger === tip.finger);
    // Both segments of a finger retract together, far enough to hide either.
    for (const part of fingers) {
      const same = fingers.filter(f => f.finger === part.finger);
      part.retract = Math.max(...same.map(f => f.retract));
    }
    return {side, mirror: m, pivots: P, dir, clipOrigin, sleeves, fingers};
  }

  torsoTransform(currentAnchor) {
    if (!currentAnchor) return IDENTITY;
    const q = this.anchorVertices.map(i => [currentAnchor[i * 2], currentAnchor[i * 2 + 1]]);
    return similarity(this.anchorRest[0], this.anchorRest[1], q[0], q[1]);
  }

  // Joint transforms for one arm (rest-space pivots).
  jointTransforms(side, torso = IDENTITY) {
    const arm = this.arms[side], P = arm.pivots, m = arm.mirror;
    const s = this.get('ArmShoulder' + side) * DEG * m, e = this.get('ArmElbow' + side) * DEG * m, w = this.get('ArmWrist' + side) * DEG * m;
    const shoulder = compose(torso, rotationAbout(...P.shoulder, s));
    const elbow = compose(shoulder, rotationAbout(...P.elbow, e));
    const wrist = compose(elbow, rotationAbout(...P.wrist, w));
    return {torso, shoulder, elbow, wrist, angles: {s, e, w}};
  }

  // Returns render items for both arms. anchorPositions: current positions of
  // the torso anchor drawable (Core), or null for the rest torso.
  solve(anchorPositions = null) {
    const torso = this.torsoTransform(anchorPositions);
    const items = [];
    for (const side of SIDES) items.push(...this.solveArm(side, torso));
    return items;
  }

  solveArm(side, torso) {
    const arm = this.arms[side], P = arm.pivots, m = arm.mirror, hand = this.manifest.hand;
    const J = this.jointTransforms(side, torso);
    const layer = this.get('ArmLayer' + side);
    const slot = this.manifest.slots[layer];
    const orderFor = (part) => part.group === 'hand' && slot !== null ? slot + (part.order - 20) / 100 : part.order;
    const items = [];
    for (const sleeve of arm.sleeves) {
      const out = new Float32Array(sleeve.rest.length);
      for (let i = 0; i < out.length; i += 2) {
        let x = sleeve.rest[i], y = sleeve.rest[i + 1];
        const we = sleeve.we[i / 2], ws = sleeve.ws[i / 2];
        if (we) [x, y] = apply(rotationAbout(...P.elbow, J.angles.e * we), x, y);
        if (ws) [x, y] = apply(rotationAbout(...P.shoulder, J.angles.s * ws), x, y);
        [out[i], out[i + 1]] = apply(torso, x, y);
      }
      items.push({id: sleeve.id, source: sleeve.drawable, texture: sleeve.texture, uvs: sleeve.uvs, indices: sleeve.indices, positions: out, opacity: 1, order: orderFor(sleeve)});
    }
    // Cuff clip plane in world space, attached to the forearm (not the hand).
    const [cx, cy] = apply(J.elbow, ...arm.clipOrigin);
    const [ax, ay] = apply(J.elbow, arm.clipOrigin[0] + arm.dir[0], arm.clipOrigin[1] + arm.dir[1]);
    const nx = ax - cx, ny = ay - cy, nl = Math.hypot(nx, ny);
    const clipPlane = [nx / nl, ny / nl, -(nx * cx + ny * cy) / nl];
    const master = this.get('HandCurl' + side), spread = this.get('FingerSpread' + side);
    const inward = -m; // curling turns fingers toward the body midline
    for (const part of arm.fingers) {
      const c = Math.min(1, Math.max(-1, this.get(FINGER_CHANNEL[part.finger] + side) + master));
      const base = part.segment === 'tip' ? part.base : part;
      const curlAngle = part.finger === 'thumb' ? hand.thumbCurlAngle : hand.curlAngle;
      const angle = (c >= 0 ? c * curlAngle * inward : c * hand.extendAngle * inward) + spread * hand.spreadAngle[part.finger] * m;
      const shift = c >= 0 ? -c * part.retract : -c * hand.extendShift;
      let local = compose(translation(arm.dir[0] * shift, arm.dir[1] * shift), rotationAbout(...base.pivot, angle * DEG));
      if (part.segment === 'tip') {
        const tipAngle = (c >= 0 ? c * hand.tipCurlAngle : c * hand.extendAngle) * inward * DEG;
        local = compose(local, rotationAbout(...part.pivot, tipAngle));
      }
      const world = compose(J.wrist, local);
      const out = new Float32Array(part.rest.length);
      for (let i = 0; i < out.length; i += 2) [out[i], out[i + 1]] = apply(world, part.rest[i], part.rest[i + 1]);
      items.push({id: part.id, source: part.drawable, texture: part.texture, uvs: part.uvs, indices: part.indices, positions: out, opacity: 1, order: orderFor(part), clipPlane});
    }
    return items;
  }

  // World-space wrist and fingertip reference points for tests / tools.
  landmarks(side, anchorPositions = null) {
    const torso = this.torsoTransform(anchorPositions);
    const J = this.jointTransforms(side, torso), P = this.arms[side].pivots;
    return {shoulder: apply(J.shoulder, ...P.shoulder), elbow: apply(J.elbow, ...P.elbow), wrist: apply(J.wrist, ...P.wrist)};
  }
}
