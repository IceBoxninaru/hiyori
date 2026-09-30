# Opt-in native ArmA runtime policy

This is an isolated copy of seven application code/test files, prepared for Claude Code Opus 5.5 at maximum effort. Codex plans and reviews; Opus implements. The user authorized sanitized code and instructions in this GitHub repository and Claude cloud. Do not fetch personal data, environment files, local session logs, model binaries, source artwork or screenshots. No purchases, credentials, new dependencies, extra model/API calls, permission changes, PR or merge.

## Problem and boundary

The forthcoming Hiyori native rig adds the real parameter `ParamArmRaiseR`, declared min/default/max 0/0/1, to the existing ArmA drawing. The native candidate is not accepted or exported yet. Current runtime happy/shy/surprised use the alternate ArmB drawing through `startArmPose`/`writeArmPose`. Legacy happy/Tap and SDK idle can also write the selector outside performance mode. Changing only generated motion metadata to normal is insufficient.

Implement a small explicit opt-in policy for a future accepted model, in this isolated candidate only. No existing character opts in by default. Preserve current Hiyori/Chitose/unknown-model behavior. Do not change model URLs, activate the native candidate, author speculative choreography, hand-edit generated motion metadata, or claim rendered/native success from stubs.

## Required behavior

1. An explicit character/model configuration opts into native ArmA ownership. Define and document its small contract. Validate actual Core parameter declarations and actual ArmA/ArmB parts after load. Missing IDs, incompatible range/default or malformed policy must fail clearly and clean up the loaded model, not silently activate a partial rig. Preserve older models when the policy is absent. Treat native selectors according to the pinned existing SDK, not as mandatory real parameters when the SDK synthesizes them.
2. For the validated opt-in model only, enforce A visible/B hidden in the existing post-SDK-update ownership hook, covering App gestures, manual preview and legacy Tap/Idle. Existing motion metadata must not override this policy. Avoid duplicated animation tickers or network calls. Validate ownership through tests that simulate a subsequent SDK load/update trying to select B; an assertion against a one-time initialization write is insufficient.
3. Keep `ParamArmRaiseR` animation compatible with the existing owned-parameter/intensity/release path. Add only the narrowly necessary policy support. Actual new motion curves and generated ownership metadata will be created after the native rig is accepted, by the existing generator, in a later task. Use injected/stub data to exercise the ownership path without inventing accepted motions or changing the shared catalog.
4. Stop/cancel/interruption/listening/disconnected/reduced/inactive/model-switch/destroy and stale async completion must not revive B or an old raised parameter value. Preserve the existing distinction between a smooth ordinary release and immediate lifecycle reset. After cleanup and the next SDK parameter reload, RaiseR returns to its declared default.
5. Audio continues to own mouth-open. An arm gesture or release must not alter the current mouth level or take ownership of MouthOpenY. No blocking work on the voice/Jev path.

## Inputs and tests

The original file layout is mirrored here (`public/`, `tests/`) so imports are unchanged. All seven files initially match the current app source. `motion-presets.mjs` is generated metadata and `characters.mjs` is existing configuration; read them but keep their production defaults unchanged.

Run the two supplied Node tests before modification, then add meaningful policy tests using actual exported renderer behavior. Baseline command, no dependencies or real assets required:

```sh
node --test model-work/hiyori-runtime-candidate/tests/live2d-raised-arms.test.mjs model-work/hiyori-runtime-candidate/tests/live2d-performance.test.mjs
```

Cover old models, valid opt-in, malformed/missing declarations, setup cleanup, legacy SDK selector overwrite, preview/performance, stale promise, interrupt/reset and audible-mouth preservation. Do not weaken old tests or replace behavior assertions with text matching. If a richer test fixture is necessary, keep it synthetic and explain what it cannot prove.

Work only in `model-work/hiyori-runtime-candidate/`. Keep the existing Cubism diagnostic preview unchanged. First report the exact files and implementation approach, then implement and test. Commit/push to a dedicated `codex/native-arm-policy` branch using the repository's generic build identity. Do not merge into the production app. Report commit, changed files, test results and remaining browser/native acceptance work for Codex review.
