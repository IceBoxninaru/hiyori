# Implementation task: native Cubism export audit

Design owner and acceptance reviewer: Codex. Implementation author: Claude Code Opus 5.5, Max effort.

## Purpose and fidelity

The final product remains an editable native cmo3 and a real SDK-exported moc3 with large, clean shoulder/arm/hand movement. This task implements the **local measurement tool needed for the Editor round trip**. It does not edit a model, create a substitute renderer, complete G0, or replace visual acceptance. The Editor installation/agreement step is still pending locally.

Implement this concrete specification, not another planning or research pass. Preserve the existing prototype. Do not fetch blocked assets, change network policy, install tools, use paid generation, or request local model uploads. Code and synthetic test fixtures may be committed; licensed files and audit output must remain local/ignored.

## Allowed changes

- `model-work/hiyori-cubism/src/export-audit.mjs`
- `model-work/hiyori-cubism/tools/audit-export.mjs`
- `model-work/hiyori-cubism/tests/export-audit.test.mjs`
- `model-work/hiyori-cubism/README.md`
- `model-work/hiyori-cubism/.gitignore`
- This task document may receive a concise implementation/evidence section.

Use built-in Node modules, no new package dependencies. Import the existing trusted `model-work/hiyori-v2/src/cubism-core-node.mjs` loader for actual Core initialization; leave it and all prototype files unchanged. Synthetic test injection is allowed at a narrow Core-inspection boundary. Never load JavaScript from an exported model's references.

## Command and outputs

Provide a CLI with:

```
node model-work/hiyori-cubism/tools/audit-export.mjs --model <local.model3.json> --out <local-report.json> [--poses <poses.json>] [--baseline <previous-report.json>] [--require-pose-change]
```

The reusable library must not execute a CLI or initialize Core when imported. `--help` documents options and evidence limitations. Normal successful inspection exits 0. Invalid input, missing assets, unsupported/invalid moc3, Core initialization errors or unmet `--require-pose-change` exit nonzero. A machine-readable report may contain explicit failure states but never call missing checks passed. Do not print raw exception stacks containing personal absolute paths; use concise stable error codes and referenced relative names. Do not overwrite input files or let the report output alias a referenced source asset.

Report schema includes schema version; model-relative file references with byte lengths and SHA-256; trusted Core SHA-256, actual Core version and supported/moc version; actual parameter IDs/minimum/maximum/default; part/drawable counts; named pose measurements; and optional baseline comparison. Reports contain no absolute paths, environment values or timestamps needed for deterministic comparison. Store no screenshots, model buffers or textures inside reports.

## Asset and structure checks

1. Parse actual model3 JSON with Version 3, a non-empty FileReferences.Moc and non-empty Textures array. Resolve from the model3 directory, never cwd.
2. Validate existence of Moc, all Textures, and every declared Physics, Pose, DisplayInfo, UserData, Expressions[].File, Motions[group][].File and optional motion Sound. Report all checked references. Reject malformed declared entries instead of silently skipping them. The original local Hiyori model declares 16 file references (1 moc, 2 textures, physics, pose, display info, 10 motions); do not hard-code that as a universal count.
3. Reject URLs, absolute/drive/UNC paths and references escaping the model directory. Resolve real paths to reject symlink escapes before opening files. Bounded model/pose/report JSON sizes should avoid accidental huge reads. Accept ordinary nested paths. Do not search surrounding directories for missing assets.
4. Inspect moc3 through the trusted local Core. Detect malformed/unsupported files before treating a model as usable; use documented available consistency/version functions if present and report when a check is unavailable. Release Model/Moc in finally on both success and failure.
5. Require finite and coherent actual parameter ranges/defaults and finite geometry; unknown or out-of-range requested pose values are errors, not clamped successes. No invented native parameter IDs.

Check Model.fromMoc as well as Moc.fromArrayBuffer for null. In the coordinator's Core inspection, moc consistency is an instance method, not a static Moc method. Check actual runtime capabilities rather than guessing API names. Validate drawable IDs, XY/UV lengths, finite values, triangle-index bounds, texture indices and mask references. Degenerate triangles/internal overlap alone are not proof of a visible defect.

## Pose evidence

Always measure the model's true default pose. Optional pose JSON:

```json
{"version":1,"poses":[{"name":"head-turn","parameters":{"ParamAngleX":15}}]}
```

At most 12 uniquely named poses, bounded parameter count, finite numeric values. Do not silently drive unknown channels. Use actual parameter defaults (not zero) and part opacities captured from the freshly instantiated native model (not an assumed all-ones replacement). Restore that native initial state before each pose, and record a stable geometry/opacity/order signature with drawable IDs and topology information. Measurements must permit baseline comparison by drawable identity rather than array order alone. Avoid storing an unnecessarily huge raw vertex dump if hashes plus per-pose geometric metrics suffice; if precise coordinate comparison needs a compact sample, document its limited coverage. Reset/isolate Core state so pose results do not depend on previous pose order. Do not reuse the prototype OriginalModel's clamping or all-ones opacity reset as validation truth.

Comparison must distinguish identical moc bytes, changed bytes with identical sampled poses, genuinely changed sampled geometry, and incompatible pose inputs/topology. A new file hash alone is not proof that an edited key reached the runtime. `--require-pose-change` succeeds only for comparable reports with at least one requested pose's actual geometry changed; metadata-only differences and missing/incompatible evidence fail. Different Core versions or pose inputs are not directly comparable. Clearly state that numeric differences do not prove shoulder quality, valid cmo3 editing, Editor save/reopen, SDK export provenance, or correct browser rendering.

Keep `coreCompatible` and `editProof` separate: an unedited Editor round trip may legitimately produce identical moc bytes and still prove runtime compatibility. It simply provides no editing witness. Pose geometry changes must be attributed to named drawable IDs; mouth-only or unrelated changes must not be described as shoulder repair.

Report that snapshots are raw Core deformation only: SDK Pose switching, physics, motion and blink are not applied. In particular the original Hiyori Pose switches arm parts, so raw Core neutral is not necessarily its final visible SDK neutral. Never label a mesh digest as successful Web rendering.

## Tests and review

Write meaningful offline tests using synthetic files and a narrow fake inspection boundary; do not check in original binaries or Core. Cover valid nested refs, declared optional refs, missing/malformed references, traversal/URL/absolute/symlink escape, invalid pose names/channels/ranges, reset/order independence, release on failure, unchanged baseline, hash-only change, comparable geometric change, incompatible comparison and source-output aliasing as appropriate to the chosen design. Do not call fake-Core tests real model validation.

The coordinator will fetch the branch and independently run the CLI with the locally installed trusted Core and actual original Hiyori export, then re-run identical poses to establish determinism, reject the unchanged baseline with require-pose-change, and exercise invalid/missing input. A genuinely edited export and live browser comparison wait for the actual Editor round trip. Existing asset-dependent cloud tests may remain unavailable; record that explicitly.

## Delivery

Implement and run the focused synthetic tests and syntax checks. Use synthetic Git identity `Hiyori Build <build@localhost>`. Audit changed paths/content for secrets and personal data. Commit only allowlisted task files on the existing session branch and push to the already authorized `IceBoxninaru/hiyori` repository through its supported attached-repository mechanism. Do not create a PR, merge main, add broad credentials or publish model assets. Report branch/hash, changed paths, commands/results and real-asset checks not run. If branch push is blocked, report the exact supported-retrieval option rather than probing secrets.
