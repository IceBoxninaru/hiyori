# Shoulder reconstruction and expressive 2D acting

Implement the next bounded revision of `model-work/hiyori-v2`, preserving Hiyori's
appearance. Stay 2D. This task supersedes older stop-after-handoff instructions.

Read `docs/reference-analysis.md`, then inspect the actual source. First repair
the shoulder's fixed-cap/rotating-sleeve transition. The previous audit found 2
left and 1 right inverted upper-arm triangles at 170 degrees. Render a baseline
before changing it. Preserve neutral, rounded shoulders, sleeve thickness and
head-height hand reach at 0/60/100/140/170 degrees and their continuous sweep.
Do not merely reduce the permitted angle or hide the distorted part.

Use shared attachment points and localized pose corrections where appropriate.
If pixels are genuinely absent, separate that asset request from geometry repair;
document exact part, extent, side, pivot, overlap, transparency and target poses.
Do not represent the current finger strips as complete anatomical hands.

Then add coordinated facial and upper-body acting: gaze leads, head follows,
torso settles later, blink/brows support intention. Include a convincing greeting
or wave, curious listening and shy reaction, and a deterministic local demo that
can be stopped. Explicit rest-hold keys are needed for onset delays because the
current compiler prepends [0,rest]. Preserve per-frame parameter resets.

Audio alone owns ParamMouthOpenY. Compiled tracks, rather than output object keys,
determine gesture ownership. Blinking must not open intentionally closed eyes.
Stop/reset/manual/reduced/dispose clear all secondary motion and stale sequences.
Test mouth=0.4 through transitions and interruption continuity.

Setup: Node >=22.16, npm install --ignore-scripts, python3 scripts/setup-model-assets.py,
then npm --prefix model-work/hiyori-v2 test. Build/review scripts are in that folder.
No API credentials are necessary. Existing asset-dependent tests are not expected
to pass before setup; report failures honestly. Generated output stays ignored.

Acceptance: existing 33 tests plus focused geometry/lifecycle checks; both sides,
one/both arms and shoulder+elbow combinations; signed triangle/attachment checks;
same-camera before/after visual review in light and dark backgrounds. Inspect
actual renders, not only numerical maxima. Keep the developer workbench usable.
The local coordinator will review WebGL playback and integrate accepted changes.
No production application, voice or live Jev integration in this revision.
