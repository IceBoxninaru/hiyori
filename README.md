# Hiyori 2D rig workbench

An isolated experimental 2D avatar renderer: original Cubism Core face/body plus
custom articulated arms. This source export is not a finished Cubism model, the
conversation application or a production release.

Use Node 22.16 or later and Python 3. Original assets are not redistributed here.
Read THIRD_PARTY.md before obtaining them under the applicable terms.

```sh
npm install --ignore-scripts
python3 scripts/setup-model-assets.py
npm test
npm run build
npm run serve
```

The workbench listens on localhost port 5178. Generated atlases, images and
original assets stay ignored. No API key or account data is needed.

Current task: [shoulder reconstruction and expressive acting](docs/task.md).
Research: [eleven model-production references and their limits](docs/reference-analysis.md).
Prototype details: [model README](model-work/hiyori-v2/README.md).

The current arm/hand implementation is experimental. Larger ranges do not imply
correct anatomical joints; inspect actual rendered poses and intermediate motion.
