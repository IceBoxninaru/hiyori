# Stable-renderer backport candidate: async motion-start guard

This is a candidate only. It does not activate anything in production. Codex inspects and
tests it before any code is copied into the app.

## Baseline

The baseline is `51f02c102c9658c034817369712e6d1c8e149968:model-work/hiyori-runtime-candidate/`.
The shipped renderer blob is `bf67a94c225a53d6944538e562ac931b33bebbc3`, which matches before
editing.

These files are copied byte-identical from the baseline:
- `public/behavior.mjs`
- `public/characters.mjs`
- `public/motion-presets.mjs`
- `public/performance-catalog.mjs`
- `tests/live2d-raised-arms.test.mjs`
- `tests/live2d-performance.test.mjs`

The native candidate (`model-work/hiyori-runtime-candidate/`) is unchanged.

## Renderer diff (`public/live2d-avatar.mjs`, new blob `866b7c03…`)

The diff against the baseline is 37 insertions and 1 deletion, and it contains only these
three parts:
1. **`select()`:** calls `this.guardMotionStarts(loaded)` right after `this.model=loaded…`,
   before the first model update (which may request SDK Idle).
2. **`react()` catch:** the check changes from `model===this.model` to
   `action===this.action&&model===this.model&&!this.disposed`.
3. **`guardMotionStarts(model)`:** identical to commit `4b50eee`. A per-call facade over the
   actual manager's `startMotion`; the guarded `state.reserve`/`start` reject stale calls
   before touching the real state. `_startMotion` and `playing=true` are skipped after
   `motionStart` re-entry. Loads, events and other writes use the actual manager.

There is no `nativeArmPolicy`, no parameter or part policy, and no change to characters,
metadata or assets.

## Tests (Linux, Node v22.22.2)

`node --check` passed for the renderer and the new test file.

| File | Result |
|---|---|
| `live2d-raised-arms.test.mjs` | 28/28 (baseline, unchanged) |
| `live2d-performance.test.mjs` | 23/23 (baseline, unchanged) |
| `motion-start-guard.test.mjs` | 23/23 (new, policy-free) |
| **Total** | **74/74** |

**New test file.** `motion-start-guard.test.mjs` is the reviewed SDK-faithful fixture from
`4b50eee`, with the native policy removed. It models reservations keyed by group/index, a
separate Idle slot, and one shared pending load per actual manager and pair. It does not use
request identity. It covers:
- the same preset with a shared pending load, where only the newest starts (Hiyori, Chitose)
- separate presets in both completion orders
- an old preview followed by a new performance request
- delayed SDK Idle after a reset, where only the current owner claims the Idle slot, and
  uninterrupted Idle starting once
- select, release and destroy while a start is pending
- the real manager's `playing` flag and a natural `motionFinish`
- `motionStart` re-entry (stop, release, destroy): no phantom `playing`, the state is
  clear, and no later `motionFinish`
- stale versus current `react` error ownership
- a current-model `motionLoadError` that is still reported

**Mutation check.** Removing the guard install made 11 of the 23 new tests fail. Reverting
only the catch check made the stale-error test fail. The source was then restored.

## Not verified here

- There was no run against the real pixi-live2d-display 0.4.0 bundle, Cubism Core, WebGL or
  a browser. The local WebGL review is still pending.
- There was no Windows run of this directory.
- The `config.sound=true` paths are not exercised.
- A call that goes stale during `motionStart` re-entry still resolves `true`, as the SDK
  does. The avatar's own action checks ignore it.
