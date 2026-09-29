# Hiyori v2 — model plan (as built, 2026-09-29)

**Status:** a *layered 2D mesh/bone prototype* on Hiyori's original meshes and textures.
- **Not** a modified moc3 or a Cubism Editor project.
- No Cubism Editor is installed, so no `.cmo3`/`.moc3` is written.
- `source/` and `public/live2d/hiyori/` are read-only.

For status, commands and API, see `README.md`.

## 1. Route

| Route | Verdict |
| --- | --- |
| Edit `hiyori_pro_t11.cmo3` in Cubism Editor | Best final route. **Blocked:** the Editor is not available and installing it is not authorized. |
| Hand-written moc3 / "JSON deformers" | Rejected. It would be a fake binary. |
| **Hybrid: original moc3 in Cubism Core + our own bone rig for the arms** | **Built.** Every visible arm pixel is an original texture pixel. |

## 2. Assets (verified with Core in Node)

Scale and conventions:
- Model canvas 2976 × 4175 px; 2976 px per unit; origin at the centre; +y up.
- Texture px = canvas px (1:1).
- L = character's left = viewer's right (x > 0).

Totals: 134 drawables, 3,426 triangles. Only the 8 eyeballs are masked, by the eye whites.

| Part | R arm (x<0) | L arm (x>0) | Render order |
| --- | --- | --- | --- |
| Shoulder cap (glued to torso) | ArtMesh68 | ArtMesh69 | 33 / 32 |
| Upper sleeve | ArtMesh72 | ArtMesh75 | 29 / 26 |
| Forearm + cuff | ArtMesh71 | ArtMesh77 | 30 / 24 |
| 4 finger bodies (behind the cuff) | ArtMesh74 | ArtMesh79 | 27 / 22 |
| 4 fingertips (in front of the cuff) | ArtMesh70 | ArtMesh76 | 31 / 25 |
| Thumb | ArtMesh73 | ArtMesh78 | 28 / 23 |
| Torso anchor | ArtMesh99 (cardigan) | | 47 |

There is no original art for an open palm, a straight pointing index, or an anatomical fist. The design keeps the hands inside long sleeves.

## 3. Rig (`rig/hiyori-v2.rig.json`, `src/rig.mjs`)

Bones per side:

```
torso (similarity from 2 ArtMesh99 vertices)
 └ shoulder ─ elbow ─ wrist ─ {thumb, index, middle, ring, pinky} × {base, tip}
```

**Sleeve skinning: angle blending along the chain.** A vertex rotates about the *rest* elbow pivot by `w_e·θe`, then about the shoulder by `w_s·θs`, then by the torso transform.

| Mesh | Weights (fraction t along the bone) |
| --- | --- |
| Shoulder cap | Stays with the torso. Chosen by visual comparison of three variants. |
| Upper sleeve | Shoulder `smoothstep(−0.1, 0.06, t)`. Elbow `0.75·smoothstep(0.7, 1.2, t)`: an arc that avoids a sharp elbow corner at 150°. |
| Forearm | Elbow `smoothstep(−0.2, 0.2, t)` |

**Fingers** (`tools/build-parts.mjs`):
- Each strip is split into 4 fingers using its outline strokes. Interiors are found by an adaptive lightness threshold and erosion; outline pixels go to the nearest interior.
- The result is a derived atlas of original pixels plus a label mask, meshed with silhouette-trimmed 6 px grids. `PAD = CELL + 3` stops triangles from reaching a neighbouring finger, and this is asserted.
- Each finger is rigid on the wrist. Curl > 0 rotates it toward the body and retracts it along the forearm axis. Its tip adds its own rotation.
- All finger parts are clipped by the cuff-opening plane, which is attached to the forearm. At +1 the finger is fully inside the sleeve.

**Channels** are listed in the README table. They are clamped. The layer is a discrete draw slot:

| Slot | Render order |
| --- | --- |
| `back` | original order |
| `chest` | 54 |
| `front` | 119 (the old Arm B slot, above the face and hair) |

## 4. Runtime

- **Browser:** WebGL1 (premultiplied alpha, stencil masks, clip plane in the shader). Falls back to Canvas2D on a fresh canvas when needed.
- **Node:** Canvas2D on `@napi-rs/canvas`.
- **Dependencies:** none new. Nothing is fetched from the network at runtime.
- **API:** `src/hiyori-v2-avatar.mjs`, with semantics in `src/pose-session.mjs` and `src/controller.mjs`.

## 5. Gestures (`src/gestures.mjs`)

The closed catalog:
- `arm-raise`, `big-wave`, `open-palm`, `point`, `fist-close`, `shy-hands`;
- `return` (ease to rest).

Track mechanics:
- Keys are `[fraction, value]`. Rest is implied at 0 and 1.
- Monotone cubic interpolation, with zero slope at the ends.
- `ArmLayer` tracks are steps.

Joint values come from measured wrist landmarks. For example, shoulder 162 / elbow −22 puts the wrist above the head.

## 6. Acceptance tests (`node --test tests/*.test.mjs`; 5 files, 33 tests — 33 pass, 0 fail on 2026-09-29, Node 22.16)

- **`rig`:**
  - manifest strictness;
  - rest equals the original vertices (≤1e-6);
  - fingers lie on their strip;
  - atlas isolation;
  - overhead reach;
  - L/R independence;
  - per-finger isolation;
  - elbow gap at 0–150°;
  - clamping and enum rejection;
  - layer slots;
  - determinism.
- **`controller`:**
  - closed catalog;
  - no mouth ownership;
  - all gestures start and end at rest, with the mouth held at 0.2;
  - a switch during a wave has no pop;
  - stop, return, immediate stop, reduced motion and dispose;
  - layers and fingers reach their defaults;
  - non-finite timestamps (review 1);
  - no overshoot.
- **`session`:**
  - atomic `setPose` (review 4);
  - stop/reset end a manual pose (review 2);
  - safe 2D fallback (review 3);
  - refusals preserve the pose.
- **`serve`:**
  - malformed URLs return 400 and the server keeps serving (review 5);
  - allowlist.
- **`render`:**
  - the rest render matches the original (< 0.2% of pixels differ);
  - raised-arm pixels appear;
  - renders are non-blank on light and dark backgrounds;
  - the sleeve fist hides the fingers.

Review 6 (slider sync) lives in `demo/workbench.mjs`. It is verified in the browser by Codex.

**Visual acceptance is Codex's, in a real browser.** `tools/render-poses.mjs` produces the review sheets.

## 7. Remaining work

- Natural open palm, straight pointing index and anatomical fist: use the opaque masters through a silhouette-mesh route, or new transparent art (`ASSET-REQUESTS.md`).
- The sleeve interior when the forearm points at the viewer. The torso armhole at extreme raises.
- Coordinated full-body acting: anticipation → action → follow-through → settle, staggered (see the README's next steps).
- A true Cubism build of these deformers, which requires Cubism Editor.
