// Resolves the project's existing @napi-rs/canvas (no install) and loads textures.
import {createRequire} from 'node:module';
import path from 'node:path';
import {projectRoot, hiyoriDir} from '../src/cubism-core-node.mjs';

let canvasModule = null;
export async function loadCanvasModule() {
  canvasModule ??= createRequire(path.join(projectRoot, 'package.json'))('@napi-rs/canvas');
  return canvasModule;
}

export async function loadHiyoriTextures() {
  const {loadImage} = await loadCanvasModule();
  return Promise.all(['texture_00.png', 'texture_01.png'].map(name => loadImage(path.join(hiyoriDir, 'hiyori_pro_t11.2048', name))));
}

export async function loadImageFile(file) {
  const {loadImage} = await loadCanvasModule();
  return loadImage(file);
}
