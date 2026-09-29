# External assets and runtime

This repository contains the isolated rig workbench source, tests, and design
documents. It does not include the original Hiyori model, textures, Cubism editor
projects, Cubism Core, derived texture atlases, reference artwork, or render
captures. It also does not include the conversation application or its data.

The current workbench needs these separately obtained files at runtime:

- `public/live2d/hiyori/hiyori_pro_t11.moc3`
- `public/live2d/hiyori/hiyori_pro_t11.2048/texture_00.png`
- `public/live2d/hiyori/hiyori_pro_t11.2048/texture_01.png`
- `third-party/live2d/live2dcubismcore-5.2.min.js`

Obtain these only from official sources under their applicable terms. Their
licenses are separate from the workbench code; the original character and Core
must not be assumed to be MIT-licensed or freely redistributable. Keep obtained
files and generated assets outside this repository's tracked content.

- [Official Hiyori sample](https://www.live2d.com/learn/sample/momose-hiyori/)
- [Sample model terms](https://www.live2d.com/learn/sample/model-terms/)
- [Free material license](https://www.live2d.com/eula/live2d-free-material-license-agreement_jp.html)
- [Cubism SDK for Web](https://www.live2d.com/sdk/download/web/)
- [Cubism Core license](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_jp.html)

The root development dependency is pinned to `@napi-rs/canvas` 1.0.9. It is not
vendored. Install dependencies in the execution environment only when authorized.
The build generates the ignored finger atlas and part data from the original
assets. The test and render commands require those assets and cannot run from
this source-only checkout alone. No API credentials are needed for this local
rig workbench.

Copied model documents describe the original local prototype and may link to
private review artifacts that are deliberately absent here. Public reference and
acceptance documentation should supply the portable instructions for this
checkout.
