# Hiyori model work

This repository is a minimal, audited source export for a 2D avatar prototype.
Read `docs/reference-analysis.md` and `docs/task.md` before editing.
The source author must be Claude Opus 5.5, effort max. Do not silently substitute a model.

Work only on this prototype, its setup, docs and meaningful tests. No application
conversation data, credentials, API requests, purchases or cloud-account settings
are needed. Do not add personal data, environment files, generated screenshots,
original model binaries, model source files, textures or Cubism Core to Git.
Do not remove the ignore rules or force-add ignored files. The prototype's API
and renderer are separate from production speech and Jev integrations.

Original model and Core assets are intentionally absent. The project owner has
previously authorized acquisition and use of the official Hiyori sample and SDK
for this model work. `python3 scripts/setup-model-assets.py` downloads pinned
public assets to ignored paths; it uploads nothing. Preserve their terms and do
not redistribute them in commits. Stop and report a hash mismatch; do not replace
the pin blindly. Install only the declared pinned canvas development dependency.

Use normal tool approvals; do not enable bypass permissions or broaden access.
Do not create or merge a pull request automatically. Commit model changes on the
session branch after checks, and report which visual checks were actually run.
Use the local repository commit identity `Hiyori Build <build@localhost>` when
creating commits; do not insert a person's name or email in Git metadata.
