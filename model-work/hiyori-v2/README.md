# Hiyori v2 — articulated arm/hand prototype (private work folder)

**What this is:** a *layered 2D mesh/bone prototype* that keeps Hiyori's original look.

- **Body, face, hair and breathing** come from the original `hiyori_pro_t11.moc3`, run by the vendored Cubism Core.
- **The original arm drawings** (`PartArmA` and `PartArmB`) are hidden.
- **The arms and hands** are redrawn by a new bone rig. It uses the original ArtMesh UVs and texture pixels.

**What it is not:** a modified `.moc3`/`.cmo3`, a Cubism Editor project, or new official character art.

- `source/` (cmo3/can3) and `public/live2d/hiyori/` are only ever read.
- The generated hand masters in `reference/` are **not** used at runtime (see "Artwork status").

## Run it (local only, no network, no installs)

```powershell
cd model-work/hiyori-v2
node tools/build-parts.mjs            # derive per-finger parts -> build/ (also run by tests)
node tools/serve.mjs --port=5178      # http://127.0.0.1:5178/  (workbench)
node --test tests/*.test.mjs          # 5 files, 33 tests: rig, controller, session, server, render
node tools/render-poses.mjs all       # review sheets -> out/review/*.png + report-all.json
node tools/render-original.mjs        # original model render for comparison -> out/original-rest.png
```

The same commands are in `package.json` (`npm run build|serve|test|review`); no dependencies are declared. Headless renders use the project's existing `@napi-rs/canvas`.

What the server serves:
- this folder's `demo/`, `src/`, `rig/`, `build/` and `out/review/`;
- the original moc3 and its two textures, read-only;
- the vendored Cubism Core.

Anything else returns 404, and malformed URLs return 400.

Workbench (`/work/demo/index.html`):
- **Gesture buttons** for the closed catalog.
- **Lifecycle controls:** Stop (ease), Stop (immediate), Reset, reduced motion.
- **Mouth (audio) slider** to check that the mouth survives gesture changes.
- **Per-channel sliders** for both arms.
- **View:** layer select, bones overlay, dark background, zoom presets.
- **Renderer:** WebGL by default; `?renderer=canvas2d` forces Canvas2D.
- **Automation:** `window.hiyoriV2` exposes the API.

## Status — implemented / numerically checked / visually checked / unresolved

Evidence sources are kept separate:
- **Node tests.** `node --test tests/*.test.mjs` covers 5 files and 33 tests; 33 passed and 0 failed on 2026-09-29 (Node 22.16). They run real Cubism Core with headless Canvas2D renders. Browser-only pieces are exercised with fakes.
- **Real-browser WebGL review.** Codex ran it in its in-app browser at `http://127.0.0.1:5178/work/demo/index.html` with local assets only; see `../../.artifacts/hiyori-v2-browser-review.md`. Claude did not run a browser.
- **Headless review sheets.** `tools/render-poses.mjs` renders them for inspection. They are not verdicts.

| Capability | Implemented | Numerically checked (Node tests) | Visually checked | Notes |
| --- | --- | --- | --- | --- |
| Original face/body/clothes + new arms in WebGL | yes | rest render matches the original Canvas2D render (< 0.2% px) | **real browser (Codex):** WebGL shows the original face, body and clothes with the articulated arms | |
| Independent L/R shoulder, elbow, wrist | yes | yes: moving L never touches R items | real browser: both shoulders at 170 | Angle-blended sleeves (no candy-wrapper pinch) |
| Hand above the head | yes | yes: wrist y 0.652 vs head top 0.600 | real browser: both shoulders at 170 put the hands above the head. After the framing fix, hands and feet fit the canvas. | The shoulder cap stays glued to the torso. |
| Hand beside the face | yes | — | real browser: L shoulder 65 / elbow 140 / `front` layer | **Sleeve deformation is prototype quality at large bends.** |
| Joint coverage at 0–150° elbow | yes (arc blend) | yes: forearm top stays within 0.03 of the upper sleeve | real browser at the pose above; the other angles only as headless sheets | See the line above. |
| Draw-order slots `back`/`chest`/`front` | yes | yes: only the forearm and hand reorder | real browser: `front` beside the face | Step switch, like a Cubism draw-order key. |
| Five individually moving fingers per hand | yes (**prototype controls**) | yes: each channel moves only its own finger items | real browser: the L index control moved independently in close-up | Cropped original finger art. **Not natural hand anatomy.** |
| Hand close | yes, as a **sleeve fist** | yes: the fist leaves < 2% of rest pixels | headless sheets only | Fingers retract into the sleeve. **Not an anatomical fist.** |
| Pointing | yes, as **one original fingertip left out** | — | headless sheets only | A straight pointing index needs new art. |
| Natural open palm | **no** | — | — | Needs artwork (opaque generated masters are not integrated). |
| Gestures: `arm-raise`, `big-wave`, `open-palm`, `point`, `fist-close`, `shy-hands`, `return` | yes | yes: each starts and ends at rest; the mouth stays at 0.2 throughout | headless strips (`out/review/gesture-*.png`); real browser: a wave was started | `open-palm` = fingers spread out of the sleeve |
| Stop / reset / manual pose | yes | yes (controller + session tests) | real browser: a manual raised pose then immediate Stop gave both shoulder sliders 0, manual=false, atRest=true, mouth preserved at 0.4 | |
| Reduced motion | yes | yes | real browser: wave → reduced motion → arm-raise stays at rest and is rejected; mouth preserved at 0.4 | |
| Interruption / dispose | yes | yes (controller + session tests) | — | |
| Timestamp / pose / URL input validation | yes | yes (regression tests for review findings 1–5) | — | |
| Workbench slider sync (finding 6), notice placement, 1280 px layout | yes | — | real browser: the notice sits in the controls; the L/R controls fit at 1280 px without horizontal clipping | |
| **Canvas2D fallback** | yes | **fake canvas/DOM objects only** (`tests/session.test.mjs`: WebGL-locked canvas replaced, or a clear error) | **not verified in a real browser** | Distinct from the WebGL review above. Force it with `?renderer=canvas2d`. |

Not validated anywhere:
- external AI/API requests, live audio, or Jev runtime integration;
- generated palm artwork;
- replacing the production avatar, the main app (port 4317 is untouched), or a rebuilt Cubism moc3/cmo3.

## Integration API (`src/hiyori-v2-avatar.mjs`)

```js
import {createHiyoriV2Avatar, GESTURE_IDS} from './src/hiyori-v2-avatar.mjs';
const avatar = await createHiyoriV2Avatar({canvas, hiyoriBase: '/hiyori/', workBase: '/work/'}); // needs window.Live2DCubismCore
avatar.playGesture('big-wave');        // closed ids only -> boolean
avatar.stopGesture();                  // ease to rest (also ends a manual pose)
avatar.stopGesture({immediate: true}); // snap to rest
avatar.setReducedMotion(true);         // snap to rest; gestures and manual poses refused
avatar.setMouthOpen(level);            // audio only; the ONLY writer of ParamMouthOpenY
avatar.setPose({ArmShoulderL: 90});    // workbench/debug; atomic (all-or-nothing), clamped
avatar.reset(); avatar.getState(); avatar.destroy();
```

Semantics live in `src/pose-session.mjs` and `src/controller.mjs` and are covered by Node tests.

### Ownership
- **Gestures own:**
  - rig channels;
  - an allowlist of face/head/body Core parameters (`CORE_ALLOWLIST` in `src/gestures.mjs`).
- **`ParamMouthOpenY` is not in the allowlist.** `setMouthOpen` is its only writer. Stop, reset, reduced motion and disposal never change the mouth level.
- **Interruption** cross-fades 0.25 s from the *current* pose. Stop eases over 0.35 s. Both end with every channel at rest and no gesture-owned Core values.
- **Manual pose** (`setPose`) is held until stop, reset, a gesture or reduced motion. A rejected call changes nothing.
- **Timestamps** must be finite:
  - a non-finite `play` time is refused;
  - `stop` falls back to the last valid time;
  - `update` ignores a non-finite time.
- **Closed catalog:** external providers (Jev) can only name a catalog id. There's no path for URLs, part ids, code, or vertex data.

### Rig channels (per side `L`/`R`; L = character's left = viewer's right)

| Channel | Range | Meaning |
| --- | --- | --- |
| `ArmShoulder` | −25…170° | 0 = hanging; + raises the arm outward and up |
| `ArmElbow` | −165…150° | + rotates outward; − folds across the body |
| `ArmWrist` | −70…70° | + bends the hand outward |
| `HandCurl` | −1…1 | added to every finger |
| `FingerThumb`, `FingerIndex`, `FingerMiddle`, `FingerRing`, `FingerPinky` | −1…1 | per-finger curl; +1 = into the sleeve, −1 = extended |
| `FingerSpread` | −1…1 | fans the fingers |
| `ArmLayer` | `back` / `chest` / `front` | draw slot of the forearm and hand |

Data: `rig/hiyori-v2.rig.json`, which holds pivots, mesh ids, skin bands, draw slots and limits.

## How the model is built

1. `src/original-model.mjs` runs the original moc3 in Cubism Core and hides `PartArmA`/`PartArmB`.
2. `src/rig.mjs` builds the bones: torso → shoulder → elbow → wrist → finger.
   - The torso is anchored to two vertices of the cardigan mesh (ArtMesh99), so the arms follow body motion from Core.
   - The sleeve meshes are original ArtMesh68/72/71 (right) and 69/75/77 (left): shoulder cap, upper sleeve, forearm+cuff.
3. `tools/build-parts.mjs` splits the original finger strips into individual fingers:
   - ArtMesh79/74: four finger bodies behind the cuff.
   - ArtMesh76/70: four fingertips in front of the cuff.
   - It finds the skin interiors between outline strokes and assigns each outline pixel to its nearest finger.
   - It writes a derived atlas (`build/finger-atlas.png`, original pixels plus a label mask) and silhouette-trimmed grid meshes.
   - An isolation check makes sure no triangle can sample a neighbouring finger.
4. The fingers are clipped at the forearm's cuff opening, so a retracted finger disappears into the sleeve.
5. `src/scene.mjs` merges the Core drawables and the rig items. `src/render-webgl.mjs` draws them in the browser; `src/render-canvas2d.mjs` draws them headless.
   - Canvas2D grows triangle edges (capped miter) to hide seams.
   - It clips to the mesh silhouette only for meshes flagged `clip`, i.e. opaque texture masters.

## Artwork status

- `reference/hand-L-open-master-v1.png` and `hand-L-fist-master-v1.png` are private, **opaque** generated masters. The open-palm master even has the checkerboard baked into its pixels. They do **not** satisfy `ASSET-REQUESTS.md` and are **not** used.
- The route to use them is a separate mesh format: authored silhouette meshes and UVs over the unchanged master, with silhouette clipping. The masters' proportions differ from the requested kit, so their landmarks must be fitted explicitly. This is not built yet.
- Until then, "open palm", "point" and "fist" are sleeve-hand versions made from the original finger pixels.

## Next steps

1. **Sleeve quality at large bends.** The real-browser review found it prototype-grade at shoulder 65 / elbow 140. Refine the elbow and cuff (skin bands, overlap, perhaps extra sleeve art). Then re-run the review gates in `.artifacts/hiyori-v2-review-gates.md`, including the Canvas2D fallback in a real browser.
2. **Hand-master mesh route:** a silhouette mesh plus per-finger surfaces from the opaque masters. Enable it only after separate light/dark silhouette checks pass.
3. **Coordinated acting.** User reference (via side chat): <https://x.com/KiranaYonome/status/2104300751875129453>. The verified content is a comparison of human puppeting vs. no puppeting, not autonomous AI.
   - Direction: coordinate gaze → face → head → torso → arms, with anticipation, main action, follow-through and settle, and staggered timing.
   - Keep Jev as a closed-catalog choice and keep the mouth audio-owned.
4. **App integration:** map `performanceGestures` ids to v2 gestures behind a flag, next to the existing `Live2DAvatar`. Nothing in the app has been changed.
5. **A true Cubism version:** rebuild these deformers in the Cubism Editor on `hiyori_pro_t11.cmo3`. That isn't possible here, because the Editor isn't installed.

## Files

| Path | Role |
| --- | --- |
| `MODEL-PLAN.md`, `ASSET-REQUESTS.md` | Plan and art requests |
| `rig/hiyori-v2.rig.json` | Rig manifest data |
| `src/` | Runtime: Core wrapper, rig, gestures, controller, session, scene, renderers, adapter |
| `demo/` | Browser workbench |
| `tools/` | Build, server, headless renders, debug |
| `tests/` | `node --test` suites |
| `build/` | Derived finger atlas and parts (reproducible) |
| `out/` | Renders (review evidence, not verdicts) |
