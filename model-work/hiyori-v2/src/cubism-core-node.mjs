// Loads the vendored Cubism Core (a browser script) inside a Node vm context.
// Read-only use of the original runtime; nothing here writes model files.
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const workRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const projectRoot = path.resolve(workRoot, '..', '..');
export const corePath = path.join(projectRoot, 'third-party', 'live2d', 'live2dcubismcore-5.2.min.js');
export const hiyoriDir = path.join(projectRoot, 'public', 'live2d', 'hiyori');

let corePromise = null;

export function loadCubismCore() {
  corePromise ??= (async () => {
    const source = await readFile(corePath, 'utf8');
    const context = {
      atob, btoa, console, setTimeout, clearTimeout, WebAssembly, TextDecoder, TextEncoder, performance,
      document: {currentScript: {src: 'live2dcubismcore.js'}},
    };
    context.window = context; context.self = context;
    vm.createContext(context);
    vm.runInContext(`${source};this.Live2DCubismCore=Live2DCubismCore;`, context, {filename: 'live2dcubismcore-5.2.min.js'});
    const core = context.Live2DCubismCore;
    // The emscripten module instantiates WebAssembly asynchronously.
    for (let i = 0; i < 400; i++) {
      try { if (core.Version.csmGetVersion()) return core; } catch { /* not ready */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Cubism Core did not initialize');
  })();
  return corePromise;
}

export async function loadHiyoriMocBuffer() {
  const buffer = await readFile(path.join(hiyoriDir, 'hiyori_pro_t11.moc3'));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
