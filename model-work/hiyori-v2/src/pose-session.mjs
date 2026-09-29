// Session state shared by the browser adapter and Node tests: one place that
// decides how gestures, manual (workbench) posing, stop, reset, reduced motion
// and disposal interact. Environment-neutral.
//
// Documented behavior:
//  - playGesture(id, now): on success clears any manual pose; on refusal
//    (unknown id, non-finite time, reduced motion, disposed) nothing changes.
//  - setPose(channels): ATOMIC. Every name/value is validated first; if any is
//    invalid, returns false and the pose is untouched. On success any gesture
//    stops immediately and the manual pose is held until stop/reset/gesture.
//  - stopGesture({immediate}): clears the manual pose too, then eases (or
//    snaps) every channel to rest. reset() == immediate stop.
//  - setReducedMotion(true): clears manual pose, snaps to rest, refuses
//    gestures and manual poses until turned off.
//  - The audio mouth level is never changed by any of the above.

export function validatePose(rig, channels) {
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) return {ok: false, reason: 'channels must be an object'};
  const values = {};
  for (const [name, value] of Object.entries(channels)) {
    const spec = rig.channelSpecs.get(name);
    if (!spec) return {ok: false, reason: `unknown channel ${name}`};
    if (spec.enum) {
      if (typeof value !== 'string' || !spec.enum.includes(value)) return {ok: false, reason: `bad value for ${name}`};
      values[name] = value;
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value)) return {ok: false, reason: `non-finite value for ${name}`};
      values[name] = Math.min(spec.max, Math.max(spec.min, value));
    }
  }
  return {ok: true, values};
}

export class PoseSession {
  constructor(rig, controller) {
    this.rig = rig;
    this.controller = controller;
    this.manual = null;
    this.reduced = false;
    this.disposed = false;
  }

  playGesture(id, now) {
    if (this.disposed || this.reduced) return false;
    if (!this.controller.play(id, now)) return false;
    this.manual = null;
    return true;
  }

  setPose(channels) {
    if (this.disposed || this.reduced) return false;
    const result = validatePose(this.rig, channels);
    if (!result.ok) return false;
    this.controller.stop({immediate: true});
    this.manual = {...(this.manual || {}), ...result.values};
    for (const [name, v] of Object.entries(this.manual)) this.rig.set(name, v);
    return true;
  }

  stopGesture({immediate = false} = {}, now) {
    if (this.disposed) return;
    // Snapshot for the ease includes the manual pose (it is in the rig now).
    this.manual = null;
    this.controller.stop({immediate: !!immediate}, now);
  }

  reset() { this.stopGesture({immediate: true}); }

  setReducedMotion(value) {
    this.reduced = !!value;
    this.manual = null;
    this.controller.setReducedMotion(this.reduced);
  }

  setMouthOpen(level) { this.controller.setMouthOpen(level); }

  // Advances the controller; re-applies the held manual pose when idle.
  update(now) {
    const core = this.controller.update(now);
    if (this.manual && !this.controller.playing && !this.controller.fade) for (const [name, v] of Object.entries(this.manual)) this.rig.set(name, v);
    return core;
  }

  get idle() { return !this.controller.playing && !this.controller.fade; }

  dispose() {
    if (this.disposed) return;
    this.manual = null;
    this.controller.dispose();
    this.disposed = true;
  }
}

// Returns a usable 2D context for `canvas`. A canvas that already holds a
// WebGL context returns null for getContext('2d'); in that case a fresh
// canvas replaces it in the DOM (same id/class/style). Throws clearly if no
// 2D context can be obtained, instead of continuing with null.
export function acquireCanvas2D(canvas, doc = globalThis.document) {
  let ctx = canvas.getContext('2d');
  if (ctx) return {canvas, ctx};
  if (!doc?.createElement || !canvas.parentNode) throw new Error('Canvas2D fallback unavailable: canvas already holds a WebGL context and cannot be replaced');
  const fresh = doc.createElement('canvas');
  for (const attr of ['id', 'class', 'style']) { const v = canvas.getAttribute?.(attr); if (v !== null && v !== undefined) fresh.setAttribute(attr, v); }
  fresh.width = canvas.width; fresh.height = canvas.height;
  canvas.parentNode.replaceChild(fresh, canvas);
  ctx = fresh.getContext('2d');
  if (!ctx) throw new Error('Canvas2D fallback unavailable: 2D context could not be created');
  return {canvas: fresh, ctx};
}
