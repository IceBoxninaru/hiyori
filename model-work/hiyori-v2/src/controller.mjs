// Gesture lifecycle for the Hiyori v2 rig. Environment-neutral (inject time).
//
// Ownership:
//  - Gestures own rig channels and CORE_ALLOWLIST parameters only.
//  - The mouth (ParamMouthOpenY) is owned by audio via setMouthOpen(); no
//    gesture, stop, reset or reduced-motion change ever writes it.
//  - Every stop/interrupt/reduced-motion/dispose path ends with all rig
//    channels at rest and all gesture-owned Core parameters at default.
import {GESTURES, CORE_ALLOWLIST, compileGesture, isGestureId} from './gestures.mjs';

export const MOUTH_PARAMETER = 'ParamMouthOpenY';
const CROSSFADE = 0.25; // s, into a new gesture from the current pose
const RELEASE = 0.35;   // s, back to rest

const smooth = t => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

export class GestureController {
  // rig: HiyoriRig; coreDefaults: Map(paramId -> default)
  constructor(rig, coreDefaults) {
    this.rig = rig;
    this.coreDefault = new Map([...coreDefaults].filter(([id]) => CORE_ALLOWLIST.includes(id)));
    this.channelRest = new Map(rig.channelNames().map(n => [n, rig.channelSpecs.get(n).rest]));
    this.channelSpec = rig.channelSpecs;
    this.compiled = new Map(Object.keys(GESTURES).map(id => [id, compileGesture(id, this)]));
    this.active = null;     // {gesture, start}
    this.fade = null;       // {from: {channels, core}, start, duration}
    this.core = new Map();  // current gesture-owned core values
    this.mouth = 0;
    this.reduced = false;
    this.disposed = false;
    this.lastTime = 0;
  }

  // Current evaluated pose (for crossfades).
  snapshot() {
    return {channels: new Map(this.rig.channelNames().map(n => [n, this.rig.get(n)])), core: new Map(this.core)};
  }

  // Timestamps are seconds on the caller's clock and must be finite. Every
  // entry point validates time BEFORE changing state:
  //  - play(id, now): non-finite now -> returns false, nothing changes;
  //  - stop(opts, now): non-finite/omitted now -> the last valid update time;
  //  - update(now): non-finite now -> no state change, re-emits the last pose.
  play(id, now) {
    if (this.disposed || this.reduced || !isGestureId(id) || !Number.isFinite(now)) return false;
    if (id === 'return') { this.stop({immediate: false}, now); return true; }
    this.fade = {from: this.snapshot(), start: now, duration: CROSSFADE};
    this.active = {gesture: this.compiled.get(id), start: now};
    return true;
  }

  stop({immediate = false} = {}, now) {
    if (immediate || this.disposed) {
      this.active = null; this.fade = null;
      this.rig.reset(); this.core.clear();
      return;
    }
    const start = Number.isFinite(now) ? now : this.lastTime;
    this.fade = {from: this.snapshot(), start, duration: RELEASE};
    this.active = null;
  }

  setReducedMotion(value) {
    this.reduced = !!value;
    if (this.reduced) this.stop({immediate: true});
  }

  setMouthOpen(level) {
    this.mouth = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  }

  dispose() {
    this.stop({immediate: true});
    this.disposed = true;
  }

  get playing() { return !!this.active; }
  get currentId() { return this.active?.gesture.id ?? null; }

  // Advances to `now` (seconds). Writes rig channels; returns the Core
  // parameter values to apply this frame (gesture-owned + audio mouth).
  update(now) {
    if (!Number.isFinite(now)) return this.lastOutput();
    this.lastTime = now;
    const target = {channels: new Map(this.channelRest), core: new Map()};
    if (this.active) {
      const {gesture, start} = this.active;
      const x = (now - start) / gesture.duration;
      if (x >= 1) {
        this.active = null;
      } else {
        for (const [name, fn] of gesture.channels) target.channels.set(name, fn(Math.max(0, x)));
        for (const [id, fn] of gesture.core) target.core.set(id, fn(Math.max(0, x)));
      }
    }
    let k = 1, from = null;
    if (this.fade) {
      k = smooth((now - this.fade.start) / this.fade.duration);
      from = this.fade.from;
      if (k >= 1) this.fade = null;
    }
    for (const [name, rest] of this.channelRest) {
      let v = target.channels.get(name);
      if (from && k < 1) {
        const a = from.channels.get(name);
        v = typeof rest === 'string' ? (k < 0.5 ? a : v) : a + (v - a) * k;
      }
      this.rig.set(name, v);
    }
    this.core.clear();
    const coreIds = new Set([...target.core.keys(), ...(from && k < 1 ? from.core.keys() : [])]);
    for (const id of coreIds) {
      const def = this.coreDefault.get(id);
      const b = target.core.has(id) ? target.core.get(id) : def;
      const v = from && k < 1 ? (from.core.has(id) ? from.core.get(id) : def) + (b - (from.core.has(id) ? from.core.get(id) : def)) * k : b;
      if (v !== def) this.core.set(id, v);
    }
    return this.lastOutput();
  }

  // Current Core outputs without advancing time (gesture-owned + audio mouth).
  lastOutput() {
    const out = new Map(this.core);
    out.set(MOUTH_PARAMETER, this.mouth);
    return out;
  }
}
