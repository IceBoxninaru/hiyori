// Build step: derive individually movable finger parts from ORIGINAL Hiyori
// ArtMeshes. Nothing is painted: every output pixel is an original texture
// pixel; only a per-finger label mask is added (alpha of other fingers -> 0).
//
//   node tools/build-parts.mjs
//   -> build/finger-atlas.png  (derived, private; reproducible from originals)
//   -> build/finger-parts.json (per-part grid mesh, atlas UVs, rest positions)
//
// Method per finger strip (4 fingers side by side, separated by outlines):
//  1. rasterize the strip's own mesh coverage in texture space;
//  2. "interior" = opaque, light pixels (skin), split into 4-connected
//     components; the 4 largest are the fingers;
//  3. every opaque covered pixel (incl. outlines) is assigned to the nearest
//     finger interior by multi-source BFS, so a shared outline is split;
//  4. each finger is copied into the atlas and meshed with a trimmed grid
//     (only cells containing its pixels), rest positions via the original
//     mesh's piecewise-affine UV->model map.
import {writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadCubismCore, loadHiyoriMocBuffer, workRoot} from '../src/cubism-core-node.mjs';
import {OriginalModel} from '../src/original-model.mjs';
import {loadCanvasModule, loadHiyoriTextures} from './node-canvas.mjs';

export const STRIPS = [
  // side, drawable, segment, finger ids ordered from the body side outward (toward the thumb)
  {side: 'L', drawable: 'ArtMesh79', segment: 'base'},
  {side: 'L', drawable: 'ArtMesh76', segment: 'tip'},
  {side: 'R', drawable: 'ArtMesh74', segment: 'base'},
  {side: 'R', drawable: 'ArtMesh70', segment: 'tip'},
];
// Thumbs of the Arm A hands sit on the outer side (away from the body).
const FINGERS_FROM_THUMB = ['index', 'middle', 'ring', 'pinky'];
const CELL = 6; // texture px per grid cell
// Atlas margin per side. A used grid cell's far vertex can lie up to CELL-1 px
// beyond the finger's pixel box (and 1 px before it); bilinear filtering reads
// one more texel. PAD must exceed that so no triangle reaches a neighbour box.
const PAD = CELL + 3;
const FILTER_MARGIN = 2;

function barycentric(px, py, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-12) return null;
  const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  return [l1, l2, 1 - l1 - l2];
}

// Texture px -> model units through the original mesh (extrapolates from the
// best triangle when the point lies slightly outside).
function makeUvToModel(drawable, texW, texH) {
  const {uvs, positions, indices} = drawable;
  const tris = [];
  for (let k = 0; k < indices.length; k += 3) {
    const v = [indices[k], indices[k + 1], indices[k + 2]];
    tris.push(v.map(i => ({u: uvs[i * 2] * texW, t: (1 - uvs[i * 2 + 1]) * texH, x: positions[i * 2], y: positions[i * 2 + 1]})));
  }
  return (u, t) => {
    let best = null, bestScore = -Infinity;
    for (const [a, b, c] of tris) {
      const l = barycentric(u, t, a.u, a.t, b.u, b.t, c.u, c.t);
      if (!l) continue;
      const score = Math.min(...l);
      if (score > bestScore) { bestScore = score; best = [l, a, b, c]; }
      if (score >= 0) break;
    }
    const [[l1, l2, l3], a, b, c] = best;
    return [l1 * a.x + l2 * b.x + l3 * c.x, l1 * a.y + l2 * b.y + l3 * c.y];
  };
}

function coverageMask(drawable, x0, y0, w, h, texW, texH) {
  const mask = new Uint8Array(w * h);
  const {uvs, indices} = drawable;
  for (let k = 0; k < indices.length; k += 3) {
    const p = [0, 1, 2].map(j => [uvs[indices[k + j] * 2] * texW - x0, (1 - uvs[indices[k + j] * 2 + 1]) * texH - y0]);
    const minX = Math.max(0, Math.floor(Math.min(...p.map(q => q[0])))), maxX = Math.min(w - 1, Math.ceil(Math.max(...p.map(q => q[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...p.map(q => q[1])))), maxY = Math.min(h - 1, Math.ceil(Math.max(...p.map(q => q[1]))));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const l = barycentric(x + .5, y + .5, ...p[0], ...p[1], ...p[2]);
      if (l && Math.min(...l) >= -0.02) mask[y * w + x] = 1;
    }
  }
  return mask;
}

// Every triangle's UV bounds (+ filter margin) must stay clear of every OTHER
// part's pixel box, so no part can sample a neighbour's pixels.
export function verifyAtlasIsolation(parts, atlasSize) {
  for (const part of parts) {
    for (let k = 0; k < part.indices.length; k += 3) {
      let a = Infinity, b = Infinity, c = -Infinity, e = -Infinity;
      for (let j = 0; j < 3; j++) {
        const v = part.indices[k + j], x = part.uvs[v * 2] * atlasSize, y = (1 - part.uvs[v * 2 + 1]) * atlasSize;
        a = Math.min(a, x); c = Math.max(c, x); b = Math.min(b, y); e = Math.max(e, y);
      }
      a -= FILTER_MARGIN; b -= FILTER_MARGIN; c += FILTER_MARGIN; e += FILTER_MARGIN;
      for (const other of parts) {
        if (other === part) continue;
        const [ox, oy, ow, oh] = other.atlasPx;
        if (a < ox + ow && c > ox && b < oy + oh && e > oy) throw new Error(`atlas bleed: ${part.id} triangle reaches ${other.id}`);
      }
    }
  }
}

export async function buildParts({write = true} = {}) {
  const {createCanvas} = await loadCanvasModule();
  const textures = await loadHiyoriTextures();
  const model = new OriginalModel(await loadCubismCore(), await loadHiyoriMocBuffer());
  const drawables = model.update();
  const parts = [];
  const pieces = [];
  for (const strip of STRIPS) {
    const d = drawables[model.drawableIndex.get(strip.drawable)];
    const tex = textures[d.texture];
    const texW = tex.width, texH = tex.height;
    let u0 = Infinity, t0 = Infinity, u1 = -Infinity, t1 = -Infinity;
    for (let i = 0; i < d.uvs.length; i += 2) {
      u0 = Math.min(u0, d.uvs[i] * texW); u1 = Math.max(u1, d.uvs[i] * texW);
      t0 = Math.min(t0, (1 - d.uvs[i + 1]) * texH); t1 = Math.max(t1, (1 - d.uvs[i + 1]) * texH);
    }
    const x0 = Math.floor(u0), y0 = Math.floor(t0), w = Math.ceil(u1) - x0, h = Math.ceil(t1) - y0;
    const cv = createCanvas(w, h), g = cv.getContext('2d');
    g.drawImage(tex, x0, y0, w, h, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    const cover = coverageMask(d, x0, y0, w, h, texW, texH);
    const alpha = i => cover[i] ? px[i * 4 + 3] : 0;
    const lum = i => 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    // 2. interior components. Thin or antialiased separating outlines merge
    // interiors, so tighten the lightness threshold and erode until four
    // substantial components (each >= 6% of the opaque area) appear.
    let opaque = 0;
    for (let i = 0; i < w * h; i++) if (alpha(i) > 200) opaque++;
    let comp = null, keep = null;
    search: for (const threshold of [185, 200, 212, 222, 230]) {
      for (let erode = 0; erode <= 3; erode++) {
        let interior = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) interior[i] = alpha(i) > 200 && lum(i) > threshold ? 1 : 0;
        for (let e = 0; e < erode; e++) {
          const next = new Uint8Array(w * h);
          for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            next[i] = interior[i] && interior[i - 1] && interior[i + 1] && interior[i - w] && interior[i + w] ? 1 : 0;
          }
          interior = next;
        }
        comp = new Int32Array(w * h).fill(-1);
        const sizes = [];
        for (let i = 0; i < w * h; i++) {
          if (!interior[i] || comp[i] >= 0) continue;
          const id = sizes.length, stack = [i]; comp[i] = id; let n = 0;
          while (stack.length) {
            const j = stack.pop(); n++;
            const x = j % w, y = (j - x) / w;
            for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const k = ny * w + nx;
              if (interior[k] && comp[k] < 0) { comp[k] = id; stack.push(k); }
            }
          }
          sizes.push(n);
        }
        const big = sizes.map((n, id) => [n, id]).filter(([n]) => n >= opaque * 0.06).sort((a, b) => b[0] - a[0]);
        if (big.length >= 4) { keep = big.slice(0, 4).map(([, id]) => id); strip.split = {threshold, erode}; break search; }
      }
    }
    if (!keep) throw new Error(`${strip.drawable}: could not separate 4 finger interiors`);
    // 3. multi-source BFS over opaque covered pixels
    const label = new Int8Array(w * h).fill(-1);
    let queue = [];
    for (let i = 0; i < w * h; i++) { const k = keep.indexOf(comp[i]); if (k >= 0) { label[i] = k; queue.push(i); } }
    while (queue.length) {
      const next = [];
      for (const j of queue) {
        const x = j % w, y = (j - x) / w;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const k = ny * w + nx;
          if (label[k] < 0 && alpha(k) > 0) { label[k] = label[j]; next.push(k); }
        }
      }
      queue = next;
    }
    // Order fingers by model x of their centroid, thumb side first.
    const uvToModel = makeUvToModel(d, texW, texH);
    const stats = keep.map((_, k) => {
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < w * h; i++) if (label[i] === k) { sx += i % w; sy += Math.floor(i / w); n++; }
      const [mx, my] = uvToModel(x0 + sx / n + .5, y0 + sy / n + .5);
      return {k, n, mx, my};
    });
    // L arm thumb is at +x (outer), R arm thumb at -x (outer).
    stats.sort((a, b) => strip.side === 'L' ? b.mx - a.mx : a.mx - b.mx);
    stats.forEach((s, order) => {
      pieces.push({strip, finger: FINGERS_FROM_THUMB[order], label: s.k, labels: label, px, w, h, x0, y0, uvToModel, pixels: s.n});
    });
  }
  // 4. pack atlas (single row per strip, simple shelf packing)
  const boxes = pieces.map(piece => {
    let a = Infinity, b = Infinity, c = -Infinity, e = -Infinity;
    for (let i = 0; i < piece.w * piece.h; i++) if (piece.labels[i] === piece.label) {
      const x = i % piece.w, y = (i - x) / piece.w;
      a = Math.min(a, x); c = Math.max(c, x); b = Math.min(b, y); e = Math.max(e, y);
    }
    return {sx: a, sy: b, sw: c - a + 1, sh: e - b + 1};
  });
  const ATLAS = 512;
  let cx = PAD, cy = PAD, rowH = 0;
  for (const box of boxes) {
    const bw = box.sw + 2 * PAD, bh = box.sh + 2 * PAD;
    if (cx + bw > ATLAS) { cx = PAD; cy += rowH; rowH = 0; }
    box.ax = cx + PAD; box.ay = cy + PAD; cx += bw; rowH = Math.max(rowH, bh);
  }
  if (cy + rowH > ATLAS) throw new Error('finger atlas overflow');
  const atlas = createCanvas(ATLAS, ATLAS), ag = atlas.getContext('2d');
  const img = ag.createImageData(ATLAS, ATLAS);
  pieces.forEach((piece, n) => {
    const box = boxes[n];
    for (let y = 0; y < box.sh; y++) for (let x = 0; x < box.sw; x++) {
      const i = (box.sy + y) * piece.w + box.sx + x;
      if (piece.labels[i] !== piece.label) continue;
      const o = ((box.ay + y) * ATLAS + box.ax + x) * 4;
      for (let c = 0; c < 4; c++) img.data[o + c] = piece.px[i * 4 + c];
    }
    // Trimmed grid mesh: cells that contain any of this finger's pixels.
    const cols = Math.ceil(box.sw / CELL) + 1, rows = Math.ceil(box.sh / CELL) + 1;
    const used = new Uint8Array(cols * rows);
    for (let y = -1; y <= box.sh; y++) for (let x = -1; x <= box.sw; x++) {
      const sx = box.sx + x, sy = box.sy + y;
      if (sx < 0 || sy < 0 || sx >= piece.w || sy >= piece.h) continue;
      if (piece.labels[sy * piece.w + sx] !== piece.label) continue;
      const gx = Math.floor((x + 1) / CELL), gy = Math.floor((y + 1) / CELL);
      used[gy * cols + gx] = 1;
    }
    const vertexIndex = new Map(), uvs = [], positions = [], indices = [];
    const vertex = (gx, gy) => {
      const key = gy * (cols + 1) + gx;
      if (vertexIndex.has(key)) return vertexIndex.get(key);
      const lx = gx * CELL - 1, ly = gy * CELL - 1; // local px within the box
      uvs.push((box.ax + lx) / ATLAS, 1 - (box.ay + ly) / ATLAS);
      positions.push(...piece.uvToModel(piece.x0 + box.sx + lx, piece.y0 + box.sy + ly));
      vertexIndex.set(key, uvs.length / 2 - 1);
      return uvs.length / 2 - 1;
    };
    for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
      if (!used[gy * cols + gx]) continue;
      const a = vertex(gx, gy), b = vertex(gx + 1, gy), c = vertex(gx + 1, gy + 1), e = vertex(gx, gy + 1);
      indices.push(a, b, c, a, c, e);
    }
    parts.push({
      id: `finger.${piece.strip.side}.${piece.finger}.${piece.strip.segment}`,
      side: piece.strip.side, finger: piece.finger, segment: piece.strip.segment,
      source: {kind: 'original-derived', drawable: piece.strip.drawable, split: piece.strip.split, texturePx: [piece.x0 + box.sx, piece.y0 + box.sy, box.sw, box.sh], pixels: piece.pixels},
      atlasPx: [box.ax, box.ay, box.sw, box.sh],
      uvs: uvs.map(v => +v.toFixed(6)), positions: positions.map(v => +v.toFixed(6)), indices,
    });
  });
  ag.putImageData(img, 0, 0);
  verifyAtlasIsolation(parts, ATLAS);
  const result = {
    generatedBy: 'tools/build-parts.mjs',
    note: 'Derived from original Hiyori texture_01 pixels with a per-finger label mask. Not new artwork. Private work file.',
    atlas: 'finger-atlas.png', atlasSize: ATLAS, cell: CELL, parts,
  };
  if (write) {
    const dir = path.join(workRoot, 'build');
    await mkdir(dir, {recursive: true});
    await writeFile(path.join(dir, 'finger-atlas.png'), atlas.toBuffer('image/png'));
    await writeFile(path.join(dir, 'finger-parts.json'), JSON.stringify(result));
  }
  model.release();
  return {result, atlas};
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const {result} = await buildParts();
  for (const part of result.parts) console.log(part.id, part.source.drawable, 'px', part.source.pixels, 'tris', part.indices.length / 3);
  console.log('wrote build/finger-atlas.png, build/finger-parts.json');
}
