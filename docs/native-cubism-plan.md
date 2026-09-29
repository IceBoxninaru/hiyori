# Native Cubism Hiyori: G0 feasibility handoff (bounded draft)

Drafted 2026-09-29. Status: **draft; G0 pending locally.** This document covers code and
documentation only. It contains no model data, textures, renders, credentials or account
details.

## 1. Decision and scope

- **Final target:** a native, editable Cubism model. That means an edited copy of Hiyori's
  `.cmo3` saved by Cubism Editor, plus a real `.moc3` exported by the Editor with its
  runtime files (`model3.json`, textures, and `physics3.json` etc. as needed). Hiyori's
  appearance is preserved.
- **The hybrid Web mesh** (`model-work/hiyori-v2`) is a comparison prototype only. Its
  completion is not completion of this target. Its bounded shoulder/acting repair
  (`docs/task.md`) is **paused**. No prototype file was changed in this revision.
- **Motion data cannot add geometry.** A `motion3.json` only animates parameters, part
  opacities and model-level tracks that already exist in the `.moc3` (targets `Model`,
  `Parameter`, `PartOpacity` [V-src 1]). Missing meshes, deformers, keyforms or artwork
  must be built in the Editor. More or edited motion JSON cannot supply them, and that
  includes the existing motion files.
- **Actual audio remains the sole owner of mouth opening** (section 6).
- **Unchanged rules:** no purchases, no PR, synthetic Git identity, privacy/asset
  exclusions (`CLAUDE.md`). Local assets and source files stay local, with no upload request.

## 2. Evidence labels

| Label | Meaning |
| --- | --- |
| **[V-src n]** | Verified in the cloud session by reading official Live2D source repositories on GitHub (pinned commits in section 10). |
| **[V-idx n]** | An official page was located via a search index only. `docs.live2d.com` and `www.live2d.com` are blocked by this environment's egress policy, so the page was **not opened here**. The summaries come from search excerpts, and the attribution of a sentence to one specific listed page is approximate. Treat the wording as unconfirmed until read locally. |
| **[C-obs]** | Observed and reported by the local coordinator (Root), as technical metadata only. Not independently verified in the cloud. |
| **[R]** | A fact from this repository's existing prototype sources/docs. Not re-verified against assets here. |
| **[U]** | Unverified assumption or proposal. It must be proven locally before anyone relies on it. |

Cloud environment facts:
- Blocked hosts: `cubism.live2d.com` (CONNECT 403), `docs.live2d.com`, `www.live2d.com`.
- No blocked host was retried, and no network setting was changed. A web search index was
  used only to locate official URLs; those items are labelled [V-idx].
- `github.com` was reachable.
- Consequence: `scripts/setup-model-assets.py` could not run. Of the prototype's 33 tests,
  only the 3 server tests ran (and passed). The four asset-dependent test files failed at
  asset load, as `docs/task.md` anticipates.

## 3. Cloud / local split

| Work | Cloud session (this repo) | Local (Root + owner) |
| --- | --- | --- |
| Specs, parameter/deformer/keyform tables, acceptance criteria, review checklists | yes | reviews |
| Verification scripts (Core probes, geometry audits, motion/expression/physics ownership validators) | writes them and tests them on synthetic fixtures | runs them on real exported files |
| Motion authoring (`motion3.json`) | only after exported parameter IDs are fixed (G4) | playback review |
| Cubism Editor GUI: open/edit/save `.cmo3`, meshes, deformers, keyforms, glue, blend shapes, physics, PSD/art import, texture atlas, export | **no** (no Editor, no GUI, no assets) | **yes** |
| New artwork (armpit, sleeve underside, hands) | written request specs only | drawing/import; no paid generation |
| Renders, screenshots, captures | no | yes; kept local and never committed |

Storage rule:
- Masters, working copies and exports live only in ignored paths. Examples:
  - `model-work/native-cubism/source/` (covered by `**/source/`);
  - `public/live2d/hiyori-native/` (covered by `/public/live2d/`).
- JSON files from the sample package or from Editor exports (`model3.json`,
  `physics3.json`, `cdi3.json`, `pose3.json`, the original `motion3.json` files) are
  **not** ignored by extension. Keep them under those ignored directories and never commit
  them.
- `.gitignore` is not changed.

## 4. Official tooling: what is verified

| Capability | Official route | Evidence | Status for this project |
| --- | --- | --- | --- |
| Persistent ArtMesh editing (vertices, automatic mesh generation) | Editor GUI, Modeling | [V-idx 1, 2] | GUI only. No documented API for vertex coordinates [C-obs]. |
| Deformers (warp, rotation) and parenting | Editor GUI | [V-idx 3, 4] | GUI. Creation is also in the 5.4 alpha API (section 7) [C-obs]. |
| Parameters and keyforms | Editor GUI parameter palette | [V-idx 5] | GUI. Parameter/key creation and angle/scale at keys are in the 5.4 alpha API [C-obs]. |
| Blend shapes | Editor GUI (the version that introduced them is [U]) | [V-idx 6]; runtime parameter type Normal/BlendShape [V-src 3] | Candidate for shoulder×elbow correctives. The FREE limit counts blend-shape parameters [V-idx 8]. |
| Glue | Editor GUI | [U] (not located in the manual here) | Confirm locally before relying on it for seams. |
| Draw-order changes by key | Editor GUI | [U] | Needed when a forearm/hand passes in front of the face. |
| Physics (parameter → parameter pendulums) | Editor physics settings, exported as `physics3.json` | Input `Source` / output `Destination` parameters [V-src 1] | Candidate for wrist/finger follow-through. |
| Save `.cmo3` | Editor GUI (File > Save/Save As) | [U] wording. FREE cannot save a model over FREE limits; PRO data opens in FREE but must be reduced before saving [V-idx 8, 9]. | GUI only. No documented save command in any API [C-obs]. |
| Export `.moc3` + `model3.json` + textures (+ physics etc. via Export settings) | File > export embedded/runtime data > Export as moc3 file, with an export-version choice for SDK compatibility | [V-idx 7] (exact menu wording to confirm locally) | GUI only. An export **notification** in the external API is not export **execution** [C-obs]. |
| `.moc3` integrity and version at runtime | Core `Moc.prototype.hasMocConsistency(bytes)`, `Version.csmGetMocVersion(bytes)`, `Version.csmGetLatestMocVersion()` | [V-src 2]; SDK manual [V-idx 10] | Used in the G0 load proof. |
| File-format specifications | `CubismSpecs` has JSON formats (model3, motion3, physics3, pose3, cdi3, exp3, userdata3, motionsync3) | [V-src 1] | That repository has no `.moc3` or `.cmo3` specification. This project will not hand-write or generate `.moc3`/`.cmo3` binaries. |
| Cubism 5.3 blend modes / offscreen drawing | Web Framework 5-r.5 supports them. The 5.3 blend modes use WebGL2 `blitFramebuffer` | [V-src 2] (README, CHANGELOG) | **Do not use** in the model unless the whole runtime chain is upgraded and re-proven. |
| External application API (current release) | Parameter reads/writes, export notifications | [C-obs] | No confirmed authoring, save or export-execution route. |
| Editions | FREE, PRO, and a 42-day PRO trial; FREE allows up to 30 parameters including blend-shape parameters | [V-idx 8, 11] | Hiyori PRO data probably exceeds FREE [U]; count it in G0.4. **No purchase is authorized.** A trial needs the owner's EULA consent. |

Runtime chain facts:
- **Local Core** [C-obs]:
  - A local Core probe reports **5.1.0 (0x05010000)** with latest supported MocVersion **5
    (Cubism 5.0)**.
  - Record which Core file was probed.
  - The repository's setup script names its Core file `-5.2`. That file name is not
    version evidence; use `csmGetVersion()`.
- **Export version:** export with a moc3 version the target Core supports, currently
  ≤ Cubism 5.0. Reject any export for which `csmGetMocVersion(bytes)` is greater than
  `csmGetLatestMocVersion()`.
- **App wrapper** [C-obs]:
  - The app currently uses `pixi-live2d-display` 0.4.0 (Cubism4 UMD). This is a
    third-party wrapper, not an official Live2D SDK.
  - Loading Cubism 5 data, blend shapes and newer draw features through it is **unproven**
    [U]. Proving it is a later gate; this revision makes no app change.
- **The prototype's own Core renderers** (`src/render-canvas2d.mjs`, `src/render-webgl.mjs`)
  draw generic Core drawables with normal alpha blending and masks only [R, code].
  - They do not implement per-drawable additive/multiplicative blending, multiply/screen
    colors, 5.3 blend modes or offscreen drawing.
  - `src/original-model.mjs` reads `drawables.renderOrders`; newer Frameworks read render
    orders through `getRenderOrders()` [V-src 3]. Check this if the Core is upgraded.
  - Comparing two `.moc3` files with the same renderer proves round-trip equality. It does
    not prove fidelity to the official renderer.

## 5. G0: local feasibility checklist (Root)

G0 proves that the native route exists and round-trips losslessly **before any modeling**.
Report technical metadata only: versions, flags, counts, IDs, hashes and pass/fail. No
images, account names or license keys.

1. **Consent and edition.**
   - The owner approves Editor installation and its EULA [C-obs: pending].
   - The owner chooses the edition: FREE, or the PRO trial. Purchase is not authorized.
     Alpha is not an option here (section 7).
   - Record the Editor version/build and the OS.
   - Confirm that the Hiyori sample terms linked in `THIRD_PARTY.md` cover this personal
     modification, and that derived model files are not redistributed [U].
2. **Master copy.**
   - Keep the untouched `.cmo3` as a read-only master [C-obs: exists locally, not
     uploaded] and record its SHA-256.
   - Duplicate it into an ignored working path and make every edit on the duplicate.
3. **Open.** The duplicate opens. Record every dialog or warning: version, FREE limits,
   missing textures, missing PSD link.
4. **Limits.**
   - Record the counts of parameters (normal and blend shape), parts, ArtMeshes, deformers,
     and textures with their sizes.
   - If the edition cannot save this model, **stop** and return the decision to the owner.
5. **Save round trip.** Save As a new `.cmo3` without changes, reopen it, and confirm there
   are no new warnings.
6. **Export round trip.**
   - Export `.moc3`, `model3.json`, textures, and physics/pose/display-info if present.
   - Use an export version supported by the target Core (≤ Cubism 5.0 for the Core above).
   - Record the chosen export version, and the file names, sizes and hashes.
7. **Load proof (local Core).**
   - `hasMocConsistency` = 1.
   - moc version ≤ latest supported.
   - The model instantiates.
   - Compare with the original runtime `.moc3` from the same sample package, if it is
     available locally. Parameter IDs, ranges and defaults, part IDs, drawable IDs and
     vertex/index counts should form the same sets; list every difference.
   - Rest vertex positions are equal within tolerance. A regenerated texture atlas may
     change UVs; accept that only if the renders match.
8. **Render proof.**
   - Render the original runtime `.moc3` and the re-export with the same camera, on light
     and dark backgrounds, in the Node Canvas2D renderer and the WebGL workbench.
   - Starting threshold: the prototype's rest test (< 0.2% of pixels differ by more than 60
     summed RGB) [R], plus a human look.
   - Test the app wrapper only if app compatibility will be claimed.
9. **Arm inventory (names and counts only).**
   - The parts, deformers, parameters and key positions that drive the arms. The prototype
     hides `PartArmA`/`PartArmB` and maps sleeve and finger ArtMeshes 68–79 [R].
   - Glue and physics groups touching the arms.
   - Whether a layered PSD source exists locally (unknown).
10. **Go/No-Go for G1.** Name the edition, blockers and owner decisions.

```text
G0 REPORT (technical metadata only)
editor: version/build=  edition=FREE|PRO-trial  os=  eula_consent=yes|no
master_cmo3: sha256=  opened=yes|no  warnings=[]
limits: params(normal/blend)=  parts=  artmeshes=  deformers=  textures(count x size)=  over_edition_limit=yes|no
save_as_roundtrip: ok|fail  notes=
export: version_choice=  files=[name size sha256]  ok|fail
core: file=  csmGetVersion=  latestMocVersion=  exported mocVersion=  hasMocConsistency=
structure_equal_to_original: params|parts|drawables|counts = yes|no (list diffs)
rest_render_diff: canvas2d=%  webgl=%  light/dark inspected=yes|no
arm_inventory: parts=  deformers=  params(keys)=  glue=  physics=  psd_available=yes|no|unknown
decision: go|no-go  blockers=
```

## 6. Modeling plan after G0 (Editor GUI, specified in the cloud)

General rules:
- The default-parameter render must match the original.
- Keep every existing parameter ID and meaning. Add new IDs only after the G0.9 inventory,
  preferring the Editor's standard parameter IDs where one fits [U].
- If the FREE edition is used, the 30-parameter cap probably blocks this plan [V-idx 8, U].

**G1: first visual gate, one arm.** Character's left arm, matching the prototype's wave for
comparison.
- **Build:**
  - Shoulder rotation deformer at the joint centre.
  - Warp deformers over the cap and upper sleeve, keyed at 0/60/100/140/170-degree
    equivalents so that the silhouette stays rounded and the sleeve keeps its thickness.
  - Shared/glued seam vertices between cap, upper sleeve and forearm [glue U].
  - Elbow and wrist rotation deformers.
  - Shoulder×elbow correctives, as 2-parameter keyforms or blend shapes, only where the
    combination actually needs them.
  - Draw-order keys where the hand passes the face [U].
- **Follow-through:**
  - Wrist and finger lag through physics (input: arm parameters; output: wrist/finger
    parameters) [V-src 1], or through timed motion curves.
  - Fingers stay the current strips, which are not anatomical hands.
- **Missing pixels** are a separate art request, raised only if geometry work shows they
  are absent. Likely candidates:
  - torso side/armpit;
  - sleeve underside and lining;
  - cuff interior.

  Each request records the part, extent, side, pivot, overlap, transparency and target
  poses. Art is imported as new ArtMeshes (PSD import [U]).
- **Pass criteria** (proposed thresholds, for the coordinator to confirm):
  - A continuous sweep (≥ 60 steps up and down) and a 3–4-cycle wave show no inverted
    visible triangles (signed area versus rest) and no holes. Intentionally hidden overlaps
    are listed with a reason.
  - Designated seam pairs stay within 2 source px.
  - Sleeve width at 25/50/75% of the upper arm stays within ±15% of rest.
  - The shoulder cap shows no notch.
  - At the top of the raise the hand is beside the head at head height.
  - The wrist lags the forearm by about 70–130 ms, and the fingers lag the wrist.
  - Reviewed in the Editor preview and in exported-moc3 renders: same camera, before and
    after, light and dark backgrounds. Captures stay local.
- **Tooling:** geometry audits are cloud-written scripts that read Core drawable positions
  from the exported `.moc3` and are run locally. They are not part of this commit.

**G2: both arms.** Independent and simultaneous L/R, with shoulder+elbow combinations and
symmetric naming. Same criteria as G1.

**G3: real hand shapes.**
- Open, half-closed, fist and pointing need new hand art: a palm, finger segments, and
  curled-finger views.
- `model-work/hiyori-v2/ASSET-REQUESTS.md` is a starting specification. Its
  `check-assets` / `--hand-kit` tooling does not exist [R].
- Shapes are built as ArtMeshes with keyforms and opacity switching in the Editor. The
  current finger strips must not be presented as anatomical hands.

**G4: coordinated acting.**
- Gaze leads, the head follows, and the torso settles later. Blinks and brows support the
  intention.
- Required pieces: greeting/wave, curious listening, and a shy reaction.
- Motions use explicit hold keys for onset delays and existing face/body parameter IDs
  (the prototype allowlist [R]; confirm against the export).
- Ownership rules:
  - The `model3.json` `Groups` entry `LipSync` [V-src 1] lists exactly `ParamMouthOpenY`.
    Confirm that ID in the export.
  - No motion may contain a `Parameter` curve on a LipSync-group ID or a `Model`/`LipSync`
    curve. The official Web Framework applies a `Model`/`LipSync` curve to the lip-sync
    parameters: it adds to their own curves and otherwise sets them [V-src 2:
    `cubismmotion.ts`].
  - Expressions (`Add`/`Multiply`/`Overwrite` [V-src 1]) and physics outputs must not
    target mouth opening.
  - Blinking multiplies the intended eyelid pose and never opens intentionally closed eyes.
    For comparison, the official motion applies a `Model`/`EyeBlink` curve to the
    EyeBlink-group parameters: it multiplies their own curves and otherwise sets them
    [V-src 2].
  - Stop, reset, manual, reduced-motion and dispose clear secondary motion and stale
    sequences in our runtime layer.

**G5: runtime integration.** A later, separately approved step:
- the workbench loads the native `.moc3`;
- `pixi-live2d-display` compatibility is proven;
- no production, voice or live Jev integration happens in this revision.

## 7. Cubism 5.4 alpha: separate experiment only

Coordinator-observed facts [C-obs]:
- The announcement says: the alpha expires **2026-10-18**; data is alpha-only with no
  migration guarantee; creations must remain **personal-use**.
- The external-API link resolves to an `alpha1` reference, while the alpha Editor manual
  links to `alpha2`.
- The linked API **documents**: AddParameter/Key, AddRotationDeformer/AddWarpDeformer, and
  angle/scale editing at keys.
- It **does not establish**: ArtMesh vertex-coordinate editing, warp control-point
  coordinates, mesh creation, PSD import, `.cmo3` save, or SDK export commands.
- These are observations of the currently linked reference. They are not proof that no
  undocumented capability exists, and they are not a conclusion about other versions.

Cloud status: not inspected here (host blocked).

Use:
- Possibly scripted scaffolding of parameters, keys and deformers.
- Mesh work, save and export would still be GUI work.

Rules:
- Only on a separate duplicate, never on the master or the production working copy.
- Personal-use only.
- No alpha-only data enters the production toolchain unless migration is officially
  supported.
- Stop at expiry.
- It is **not** the public-site production toolchain.

## 8. Prototype preservation

- `model-work/hiyori-v2` is unchanged and remains the comparison baseline. Its prior audit
  found 2 left and 1 right inverted upper-arm triangles at 170° [R].
- The untracked `package-lock.json` created by `npm install --ignore-scripts` is left in
  place and is not committed.

## 9. Blockers and open decisions

1. The Editor is not installed and EULA consent is pending [C-obs].
2. Edition:
   - FREE limits probably prevent saving the Hiyori PRO data [V-idx 8, U].
   - The trial needs owner consent.
   - Purchase is not authorized.
   - The alpha is personal-use and expires 2026-10-18.
3. Runtime versions:
   - Local Core 5.1.0 supports MocVersion ≤ 5 [C-obs].
   - Cubism 5.3 features need a newer Core and Framework [V-src 2].
   - The app wrapper's compatibility is unproven.
4. Missing artwork (armpit, sleeve underside, cuff interior, hands) requires a separate,
   local art task.
5. The cloud cannot read assets or the blocked official manuals. Every Editor-specific step
   marked [V-idx] or [U] must be confirmed locally.
6. The sample-model license scope for modification must be confirmed locally [U].

## 10. Sources

Read in the cloud session:
1. [V-src 1] Live2D `CubismSpecs` @ `d0d30163967a8c2d477ab9e53d8b2a2bd7021780`:
   https://github.com/Live2D/CubismSpecs/tree/d0d30163967a8c2d477ab9e53d8b2a2bd7021780/FileFormats
   (`model3.json.md` groups `EyeBlink`/`LipSync`; `motion3.json.md` targets and model
   IDs; `physics3.json.md` input/output; `exp3.json.md` blend).
2. [V-src 2] Live2D `CubismWebFramework` 5-r.5 @ `d4da0aa07e47d2c1e4f5fa7ea6047861ea5e5d0b`:
   https://github.com/Live2D/CubismWebFramework/tree/d4da0aa07e47d2c1e4f5fa7ea6047861ea5e5d0b
   (`README.md` Cubism 5.3 compatibility; `CHANGELOG.md` blend mode/offscreen and moc
   version functions; `src/model/cubismmoc.ts` consistency/version;
   `src/motion/cubismmotion.ts` EyeBlink/LipSync model curves).
3. [V-src 3] Same commit, `src/model/cubismmodel.ts` `getParameterType`
   (Normal/BlendShape) and `getRenderOrders`.

Located via search index only; **not opened here**:
1. [V-idx 1] https://docs.live2d.com/4.2/en/cubism-editor-manual/concept-of-artmesh/
2. [V-idx 2] https://docs.live2d.com/cubism-editor-manual/mesh-edit/?locale=en_us
3. [V-idx 3] https://docs.live2d.com/en/cubism-editor-manual/deformer/
4. [V-idx 4] https://docs.live2d.com/en/cubism-editor-manual/making-and-placement-of-warp-deformer/
5. [V-idx 5] https://docs.live2d.com/en/cubism-editor-manual/palametorpalatte/
6. [V-idx 6] https://docs.live2d.com/en/cubism-editor-manual/blend-shape/
7. [V-idx 7] https://docs.live2d.com/en/cubism-editor-manual/export-moc3-motion3-files/
8. [V-idx 8] https://www.live2d.com/en/cubism/comparison/ and https://docs.live2d.com/en/cubism-editor-manual/faq/
9. [V-idx 9] https://help.live2d.com/en/other/other_05/
10. [V-idx 10] https://docs.live2d.com/en/cubism-sdk-manual/moc3-consistency/
11. [V-idx 11] https://www.live2d.com/en/cubism/download/editor/

Coordinator-observed [C-obs]:
- https://www.live2d.com/information/cubism-5_4-alpha/
- https://cubism.live2d.com/editor-alpha/doc/manual/alpha1/ja/external-api-intergration/index.html
  (URL as reported)
- the local Core probe and app-wrapper version.
