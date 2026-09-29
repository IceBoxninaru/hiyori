# Native Cubism export audit

A local measurement tool for the native Hiyori route. The target is a `.cmo3` edited in
Cubism Editor and a real SDK-exported `.moc3`. The tool reads an exported `model3.json`
and its declared files, then measures the `.moc3` through the trusted local Cubism Core.

It does not edit models, render, complete G0, or replace visual acceptance. The Editor
installation and licence agreement are still pending locally. The prototype in
`../hiyori-v2` is unchanged; only its Core loader is reused.

## Command

```sh
node model-work/hiyori-cubism/tools/audit-export.mjs --model <local.model3.json> --out <local-report.json> \
     [--poses <poses.json>] [--baseline <previous-report.json>] [--require-pose-change]
node model-work/hiyori-cubism/tools/audit-export.mjs --help
node --test model-work/hiyori-cubism/tests/*.test.mjs   # synthetic, offline
```

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 2 | audit failure (the report is still written with `status: "failed"` when the output path is safe) |
| 3 | `--require-pose-change` not met (the inspection itself may be `ok`) |
| 64 | usage error |

stderr lists stable error codes (`E_REF_MISSING`, `E_MOC_UNSUPPORTED`, …) with
model-relative names only. It never prints stacks or absolute paths.

Rejected references (absolute, drive, UNC, URL, `..`) are reported only by their
declaration slot, such as `texture[1]`; the string itself is never echoed. JSON keys,
motion group names, pose names and parameter IDs that could carry a path are shown as
`<redacted>`.

Core: the file loaded by `../hiyori-v2/src/cubism-core-node.mjs`, i.e.
`third-party/live2d/live2dcubismcore-5.2.min.js`. That path is ignored, and the file name
is not version evidence: the report records the Core's SHA-256 and its actual
`csmGetVersion()`.

Pose file:

```json
{"version":1,"poses":[{"name":"head-turn","parameters":{"ParamAngleX":15}}]}
```

- At most 12 unique names; `default` is reserved.
- At most 64 finite values per pose.
- An unknown parameter ID or out-of-range value is an error. Nothing is clamped.

## What it checks

1. **model3.json:**
   - `Version` is 3, `Moc` is non-empty, and `Textures` is a non-empty array.
   - Every declared Physics, Pose, DisplayInfo, UserData, MotionSync, `Expressions[].File`,
     `Motions[group][].File` and `Sound` reference is checked; malformed entries fail.
   - References resolve from the model3 directory only (never the cwd). No surrounding
     directory is searched for missing assets.
   - URLs, absolute, drive and UNC paths, backslashes, `..` escapes and symlink escapes
     (after `realpath`) are rejected.
   - The report lists every checked reference with its byte length and SHA-256.
   - JSON inputs have size bounds.
2. **Output safety:**
   - The report path must not be any of these, compared by resolved path and by
     filesystem identity (device + inode), so hardlinks and symlinks are caught:
     - the model3, a referenced file, the poses file or the baseline;
     - the trusted Core file;
     - the Core loader, CLI or library source.
   - The report is never written before this is proven, including when the audit fails.
3. **Core, through capabilities detected at runtime:**
   - `Moc.prototype.hasMocConsistency(bytes)`, called before the Moc is created, the way
     the official Framework calls it.
   - `Moc.fromArrayBuffer` and `Model.fromMoc` null checks.
   - `csmGetMocVersion(moc, bytes)` (the Core 5.1.0 signature) against
     `csmGetLatestMocVersion`.
   - A Core call that throws becomes a stable code, never its message.
   - A missing capability is recorded in `core.unavailable`, never as passed.
   - Model and Moc are released in `finally`.
4. **Structure:**
   - Unique parameter IDs with finite, coherent min/max/default.
   - Unique drawable IDs.
   - XY and UV lengths, finite values, triangle index bounds.
   - Texture indices within the model3 `Textures`, and mask references.
   - Topology, UV, texture and mask data are digested per drawable ID.
5. **Poses:**
   - The true default pose is always measured.
   - Each pose runs on a **fresh model instance**, whose parameters and part opacities are
     checked against the native initial state captured on the first instance (not zeros,
     not all-ones). Results do not depend on pose order.
   - Per drawable ID the report records: geometry SHA-256, bounding box, opacity, render
     order, and `invertedVsDefault` (triangles whose orientation flipped against the
     default pose).
   - No raw vertex dump is stored.
6. **Baseline comparison** (`--baseline`):
   - `incompatible`: a different Core file or version, different pose names or values,
     or a different drawable/topology/UV/texture/mask structure.
   - Comparison is keyed by drawable ID, pose name and parameter ID. Reordering drawables
     (with masks remapped to the same IDs), poses or parameter maps is equivalent.
   - `identical-moc`: the moc bytes and every measurement are identical.
   - `inconsistent-evidence`: the moc bytes are identical but the measurements differ
     (nondeterminism or an edited report). This exits 2 with `E_EVIDENCE_INCONSISTENT`
     and is never `editProof`.
   - `bytes-changed-poses-identical`: the bytes changed but no sampled pose changed.
   - `bytes-changed-state-only`: only opacity or render order changed.
   - `geometry-changed`: changed drawable IDs are listed per pose.

   `editProof` is true only when a requested (non-default) pose's geometry changed.
   `coreCompatible` is reported separately: an unedited round trip can be Core-compatible
   without being an edit witness.

## Evidence limits

- Snapshots are raw Core deformation. SDK Pose switching, physics, motion and blink are
  **not** applied. The original Hiyori `pose3` switches arm parts, so the raw neutral is
  not necessarily the visible SDK neutral.
- A digest is not a render. It proves nothing about browser/Web rendering, shoulder
  quality, a valid cmo3 edit, Editor save/reopen or export provenance.
- Changed drawable IDs are evidence of *where* geometry moved, not that it improved.
  Mouth-only changes are not shoulder repair.
- Degenerate triangles or internal overlap alone are not proof of a visible defect.

## Tests

`tests/export-audit.test.mjs` uses **synthetic** files and a fake Core that only mimics
the inspected API surface, including the two-argument `csmGetMocVersion`. Passing it is
not validation of any real model.

Link fixtures:
- The escape test links a directory: a junction on Windows (no admin or Developer Mode
  needed), a directory symlink elsewhere.
- The output-alias tests use hardlinks to disposable files. They never touch the real
  Core or sources.

The coordinator runs the real checks locally:
- the trusted Core with the actual original export;
- determinism with identical poses;
- an unchanged baseline, which `--require-pose-change` must reject;
- invalid and missing input.

A genuinely edited export and a live browser comparison wait for the real Editor round
trip.

Reports, pose files and exports stay local. This folder's `.gitignore` covers `reports/`,
`local/`, `out/`, `source/`, `report*.json`, `*.report.json` and `poses*.json`.

# Native export pose comparison preview (local diagnostic)

A local, read-only harness that shows **two native SDK exports** (before/after) side by
side at **fixed named poses**, rendered by the existing local Pixi + pixi-live2d-display +
Cubism Core. It is a diagnostic viewer. It is not a rig, does not correct geometry, and
does not judge anatomy. Pixel differences say nothing about shoulder quality.

It never overrides the export audit: if the audit reports `incompatible`, a visual
difference here is not an edit witness. A topology difference between the two exports is
shown as a warning and does not block viewing.

## Launch (local only)

```sh
node model-work/hiyori-cubism/tools/serve-native-preview.mjs \
  --before <before-export>/<name>.model3.json --after <after-export>/<name>.model3.json \
  --poses <local-poses.json> --port 5190 \
  --core <local>/live2dcubismcore.min.js --pixi <local>/pixi.min.js \
  --live2d-display <local>/cubism4.min.js --pixi-unsafe-eval <local>/pixi-unsafe-eval.min.js \
  [--camera <local-camera.json>]
# then open http://127.0.0.1:5190/
```

- `--pixi` is a Pixi v6 UMD build and `--live2d-display` is the pixi-live2d-display
  0.4.0 Cubism4 UMD build, both already present locally (no CDN, no install).
- `--pixi-unsafe-eval` (optional, but needed in practice) is the local
  `@pixi/unsafe-eval` helper for the same Pixi version. It is served as the fourth exact
  vendor file and loaded right after Pixi, so the CSP needs no `'unsafe-eval'`. Without
  it, Pixi 6 shader setup is expected to fail under the CSP, and the page says so.
- `--port` is required and must be 1–65535. The server binds **127.0.0.1 only** and
  exits if the port is busy.
- `--camera` (optional) is
  `{"version":1,"zoom":1,"centerX":0.5,"centerY":0.5,"crop":{"x":0.25,"y":0.18,"w":0.3,"h":0.22}}`.
  All values are in normalized **before**-model canvas coordinates. Without it, the
  camera is derived once from the before model's canvas info (full body, centred), and
  the default shoulder crop is a starting guess that you adjust in the page.
- The poses file uses the audit's shape:
  `{"version":1,"poses":[{"name":"shrug","parameters":{"ParamShoulder":1}}]}`. A
  `default` pose (all declared defaults) is always offered first.

## Specification (implemented)

**Serving:**
- Exact routes only:
  - `/` (the page);
  - `/app/<file>` for the fixed files in `preview/`;
  - `/vendor/core.js`, `/vendor/pixi.js`, `/vendor/live2d-display.js`, plus
    `/vendor/pixi-unsafe-eval.js` only when `--pixi-unsafe-eval` is given;
  - `/config.json`;
  - `/m/<before|after>/r/<n>.<ext>` for each model3's declared **Moc and Textures only**.
- Model resources are served through opaque aliases. Physics, pose, motion, expression,
  sound, `.cmo3`, `.env`, directories and anything else return 404. There are no write
  endpoints: methods other than GET/HEAD get 405.
- Requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` get 421.
  Absolute-form or otherwise malformed URLs get 400.
- No CORS headers, and `nosniff`. A strict CSP: `connect-src 'self'`, no external
  origins, no `'unsafe-eval'`; only `'wasm-unsafe-eval'`, which Core needs for its
  WebAssembly.
- References are validated with the audit's `declaredReferences` rules: URL, absolute,
  drive, UNC, `..` and backslash references are rejected. Each file's realpath must stay
  inside its model directory; directory links and Windows junctions are resolved by
  realpath.
- The realpath is checked again on every request, so a file swapped for an escaping link
  after startup is refused.
- Startup fails closed with a stable code if a model, a declared Moc/Texture, the poses
  file or any vendor file is missing or invalid.
- Errors never contain absolute paths. `/config.json` contains only aliases, redacted
  labels, poses and camera numbers.

**Poses** (`preview/pose-core.mjs`, pure and unit-tested):
- The server validates pose shape with the audit's `parsePoses`.
- The page validates IDs and ranges against each model's actual Core parameters.
  Unknown IDs and out-of-range values are errors, never clamped.
- Declared defaults are captured from a separately instantiated raw Core model: parameter
  `defaultValues` and the fresh part opacities.
- Every render resets **all** parameters and part opacities to those captured defaults,
  then applies the named values and reads them back. Results cannot depend on pose order
  or history.

**Rendering (raw-core mode only):**
- The Pixi model is created from a settings object containing just Moc and Textures,
  with `autoInteract:false`, `autoUpdate:false` and `motionPreload:'none'`.
- **One** Pixi application (one WebGL renderer, one stage) on an off-DOM canvas is used
  for both models. It is created with `autoStart:false` and `sharedTicker:false`, and
  `interaction.useSystemTicker` is disabled.
  - Why: in a real browser, two applications left the before canvas blank. Cubism's
    WebGL shader state is tied to one GL context.
  - Each slot is rendered alone (the other model is hidden) and copied immediately into
    that slot's visible 2D canvas. Crops and the PNG are drawn from those copies.
- Before every intended render, `model.update(1000/60)` is called. pixi-live2d-display
  0.4.0 runs `internalModel.update` from `_render` only when its accumulated `deltaTime`
  is non-zero; without this step the pose was never applied (`appliedReadBack` stayed
  `{}`). The diagnostics flag any requested value that was not read back from Core.
- **Ownership:**
  - Every load generation uses per-generation resource URLs (`?g=<n>`; the server
    ignores the query), so a reload cannot reuse a texture cached by an earlier
    generation.
  - Disposing a slot removes the model, destroys it and each of its textures, and purges
    its URLs from Pixi's texture caches.
  - A stale load is disposed when it arrives. A rejected `Live2DModel.from` purges its
    cached textures; its partial Cubism model is not reachable.
  - A failure in either slot disposes the other slot's loaded model. The raw Core model is read through
  `internalModel.coreModel.getModel()`, as the current app does.
- Its `internalModel.update` is replaced by the deterministic reset/apply/Core update
  above. So motion, idle, expressions, blinking, breath, physics, SDK Pose, gaze/focus
  and natural movement are all off.
- Because SDK Pose is disabled, **both A and B arm parts can be visible**. The page says
  so; nothing is hidden.
- One camera (scale/position) is derived once from the **before** canvas info or the
  explicit `--camera`, applied identically to both models, and never re-fitted per pose.
  The same normalized shoulder crop is magnified for both.
- Background: white or dark.
- "Download PNG" composes the current before/after view and crops into a local file in
  the browser. Nothing is uploaded.
- Diagnostics: mode, labels, model canvas and view dimensions, Core version, moc version,
  applied parameter values read back from Core, non-default part opacities, and a
  topology/ID difference warning.
- Reloading uses a generation guard: a stale asynchronous load is destroyed on arrival,
  and old models/applications are destroyed before replacement.

**Tests:** `tests/native-preview.test.mjs` is offline and synthetic. It covers pose
validation, reset and order independence, stale-load disposal, a fake of the 0.4.0
`deltaTime` render gate, shared-renderer render/copy order, texture ownership and purge,
rejected, stale and partial two-slot loads, exact serving,
traversal/URL/junction escapes, unknown files, Host checks, path redaction, and safe
missing-vendor/model failures. A fake Core and fake loads are **not** evidence of real
WebGL, Pixi or texture rendering, which is verified locally.

**Local checks for the coordinator:**
- before vs before is identical across pose orderings;
- the edited export differs at `ParamShoulder=1` but not at 0;
- real Core/Pixi rendering with textures;
- an identical shoulder crop camera for before and after;
- no app behaviour changes.
