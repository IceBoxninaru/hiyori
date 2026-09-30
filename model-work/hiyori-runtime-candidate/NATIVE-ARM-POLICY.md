# Native ArmA policy: checkpoint handoff

The cloud session was checkpointed at the user's direction before its usage limit.
This candidate is isolated. Production code, the characters' defaults and the generated
motion metadata are unchanged, and no shipped character opts in.

## Contract

`character.nativeArmPolicy` is optional. When it is absent (or `undefined`), the previous
arm policy is kept. When present, it must be exactly this, with no extra keys and a plain
or null-prototype object:

```js
{version:1,visiblePart:'PartArmA',hiddenPart:'PartArmB',parameters:{ParamArmRaiseR:{min:0,default:0,max:1}}}
```

- **Any other value:** `select()` fails before a model is created or requested.
- **After load, before the model is attached or hooked:**
  - `ParamArmRaiseR` must be a real Core parameter, matched by its exact ID, declared 0/0/1.
  - `PartArmA` and `PartArmB` must be real parts.
  - The `PartArm*` selectors may be absent, because the pinned SDK synthesizes them.
  - A declared selector must represent both 0 and 1.
- **On mismatch:** the loaded model is destroyed once, with its textures. The error status
  names the ID, and a later valid select works.

## Implemented (`public/live2d-avatar.mjs`)

- **Every frame:** the existing `beforeModelUpdate` hook (`applyArmPose`) writes A visible and
  B hidden, selectors and opacities, for the validated model. This covers App gestures,
  preview and legacy Tap/Idle. `startArmPose` ignores `motionArmPoseByModel` for that model.
  `resetArmPose` and `releaseModel` restore A synchronously.
- **Ownership:** the policy parameters are added to every App gesture's owned set, so
  intensity scaling, the smooth 0.28 s ordinary release and the immediate lifecycle reset
  apply even before generated metadata lists `ParamArmRaiseR`.
- **Mouth and tickers:** lip-sync IDs stay excluded, so `MouthOpenY` stays owned by audio.
  There are no new tickers or network calls.

## Checked in the cloud (Linux, Node v22.22.2)

```sh
node --test model-work/hiyori-runtime-candidate/tests/live2d-raised-arms.test.mjs model-work/hiyori-runtime-candidate/tests/live2d-performance.test.mjs model-work/hiyori-runtime-candidate/tests/native-arm-policy.test.mjs
```

- **Result:** 113/113 passed: 51 baseline (unchanged) and 62 in `native-arm-policy.test.mjs`.
  `node --check` also passed on both changed files.
- **What the new tests cover:**
  - old models (shipped characters, a Hiyori without the policy, Chitose)
  - a valid opt-in (synthesized selectors, declared selectors, frozen config)
  - 15 malformed policies and 9 mismatched rigs, including cleanup and retry
  - Idle/Tap selecting B on every SDK update
  - raised-metadata App gestures at intensity 1 and 0.5, and preview
  - six stale-completion paths
  - ordinary release versus six immediate resets, followed by the SDK reload
  - the audible mouth level at 0.4 and 0.65
  - model switching

## What the synthetic fixture cannot prove

The fixture mimics the pinned pixi-live2d-display 0.4.0 and CubismWebFramework 1f9cdfd
behaviour: synthesized selectors, update order, a ported `doFade` and motion reservation.
It is not Core, WebGL or the native rig. `ParamArmRaiseR` curves in the tests are stubs.

## Remaining

1. Codex review of the diff. A local Windows run of the same command has not been done.
2. The pose3 `Link` gap. `CubismPose.copyPartOpacities` copies linked-part opacities before
   the hook. If the accepted rig's pose3 links parts to ArmA or ArmB, those links are not
   rewritten, and a curve that keeps selecting B could still show them. Check the accepted
   pose3 and decide.
3. Browser and native acceptance with the accepted rig:
   - a real WebGL render showing A only
   - `ParamArmRaiseR` motion
   - Tap/Idle
   - interruption continuity
   - the mouth staying on audio
4. Later tasks: generate the real `ParamArmRaiseR` curves and metadata with the existing
   generator, add the opt-in to a character config, and integrate into production. None
   of these are done here.
