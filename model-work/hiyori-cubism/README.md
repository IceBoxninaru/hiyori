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
