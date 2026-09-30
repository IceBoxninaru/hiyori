# Stale motion-start repair: result

Branch `codex/native-arm-policy`. This is one bounded repair, pending Codex review. It changes
only `public/live2d-avatar.mjs` and `tests/native-arm-policy.test.mjs` in this candidate.

## Defect

pixi-live2d-display 0.4.0 shares one pending Factory load per actual manager and
group/index. `startMotion` reads `this.state` again after that load, and `state.start`
consumes a matching reservation before it checks the motion.

After `stopAllMotions()` resets the reservations, an old continuation can consume a newer
reservation for the same pair, or the Idle slot. It then starts an obsolete motion, and the
newer request fails. Checks in the caller's `.then` run too late to prevent this.

A stale rejection of a legacy `react()` could also call `onError` during a newer turn.

## Repair (`guardMotionStarts`, installed in `select()` before the first model update)

- **Where the guard sits:** the actual manager gets an instance-local `startMotion`. The
  pinned SDK's own Idle path (`startRandomMotion` → `this.startMotion`) goes through it too.
- **Per-call ticket:** each call records the manager's reset count (from a wrapped
  `state.reset`), the avatar generation and the avatar action. The action is ignored for
  SDK Idle, which uses priority 1.
- **Facade:** the SDK's original `startMotion` runs with a facade as its receiver.
  - `state.reserve` and `state.start` return false for a stale call **before** they touch the
    real state. A stale Idle continuation therefore never clears a newer Idle reservation.
  - If a synchronous `motionStart` listener makes the call stale, the facade skips
    `_startMotion` and ignores the `playing=true` write.
  - Everything else, including `loadMotion`/`_loadMotion`, `emit` and other writes, is bound
    to or forwarded to the actual manager. The Factory WeakMap key and `motionLoadError`
    therefore behave as before.
- **Stale means any of:** a reset since the call began, a new generation, a different or
  released model, a disposed avatar, or (for non-Idle calls) a newer avatar action.
- **`react()` catch:** it now reports only when its own action, model and avatar are still
  current.
- **Unchanged:**
  - `MouthOpenY` audio ownership
  - the native ArmA policy
  - production code, native-model and art files
  - the vendor SDK (not patched or copied)
  - dependencies

## Tests (Linux, Node v22.22.2)

`node --check` passed for both changed files.

| File | Result |
|---|---|
| `live2d-raised-arms.test.mjs` | 28/28 (baseline, unchanged) |
| `live2d-performance.test.mjs` | 23/23 (baseline, unchanged) |
| `native-arm-policy.test.mjs` | 85/85 (62 earlier, adapted to the new fixture; 23 new) |
| **Total** | **136/136** |

**Fixture correction.** The earlier fake reserved by request identity, and its Idle curve
played synchronously, which hid the defect. It now models 0.4.0 `MotionState` and
`MotionManager` in its own code; nothing is copied from the SDK. It models:
- reservations keyed by group/index, plus a separate Idle slot
- `startMotion` that reads the state again after the load
- `start` that consumes the reservation before checking the motion
- one shared pending load per manager and pair
- failures that emit `motionLoadError` and resolve `undefined`
- `playing` and `motionFinish`
- `destroy`

Idle picks the first available index instead of a random one. Two earlier tests now warm up
the asynchronous Idle start first. Their assertions are unchanged.

**New cases:**
- an old and a new request for the same preset sharing one pending load (Hiyori and the
  native opt-in); only the newest starts
- separate presets in both completion orders
- an old preview followed by a new performance request for the same preset
- delayed SDK Idle, both interrupted and uninterrupted, where only the current owner may
  claim the Idle slot
- select, release and destroy while a start is pending
- the actual manager's `playing` flag and a natural `motionFinish`
- synchronous `motionStart` re-entry (stop, release, destroy): no start, no phantom
  `playing`, the state is clear, and no later `motionFinish`
- a stale versus a current legacy `react` rejection
- a current-model `motionLoadError` that is still reported

**Mutation check.** Disabling the guard made 11 tests fail. Reverting only the `react` catch
fix made the stale-rejection test fail. The source was then restored.

## Not verified

- **Real SDK:** there is no real pixi-live2d-display, Cubism Core or WebGL run and no
  browser. The fake follows the pinned source as I read it but is not the SDK.
- **Proxy compatibility:** it is inferred from the pinned source, which reads `this.state`,
  `this.definitions`, `this.currentAudio` and `this.playing` and calls `this.loadMotion`,
  `this.emit` and `this._startMotion`. It was not run against the built UMD bundle.
- **`config.sound=true`:** its audio paths are not exercised.
- **Return value:** a call made stale by `motionStart` re-entry still resolves `true`, as
  the SDK does after `state.start` succeeds. The avatar's own action checks ignore it.
- **Platform:** there was no local Windows run. The native-rig, pose3 `Link` and browser
  acceptance items listed in `NATIVE-ARM-POLICY.md` remain open.
