// Canvas2D textured-triangle renderer. Works on a browser canvas and on
// @napi-rs/canvas (headless snapshots). Consumes the neutral frame list built by
// scene.mjs: [{texture, positions, uvs, indices, opacity, masks:[item...]}] in
// back-to-front order. Positions are model units (+y up); uvs are texture UVs
// with v measured upward (Cubism convention).
//
// Seams: each triangle is grown by moving its EDGES outward (capped miter), so
// thin fan triangles overlap their neighbours. The whole mesh is then clipped
// to its own outer boundary (edges used by one triangle), so growing can never
// sample texture outside the mesh silhouette. This matters for opaque texture
// masters whose background is not transparent.

const EXPAND = 1.0; // px
const MITER_CAP = 3; // px

const boundaryCache = new WeakMap();

// Outer boundary loops of a triangle mesh as vertex-index chains.
export function meshBoundaryLoops(indices) {
  let loops = boundaryCache.get(indices);
  if (loops) return loops;
  const count = new Map();
  const key = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  for (let k = 0; k < indices.length; k += 3) {
    for (const [a, b] of [[indices[k], indices[k + 1]], [indices[k + 1], indices[k + 2]], [indices[k + 2], indices[k]]]) {
      const id = key(a, b);
      const entry = count.get(id);
      if (entry) entry.n++; else count.set(id, {a, b, n: 1});
    }
  }
  const next = new Map();
  for (const {a, b, n} of count.values()) if (n === 1) { (next.get(a) ?? next.set(a, []).get(a)).push(b); (next.get(b) ?? next.set(b, []).get(b)).push(a); }
  const used = new Set();
  loops = [];
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop = [start]; used.add(start);
    let prev = -1, current = start;
    for (;;) {
      const candidates = next.get(current).filter(v => v !== prev && (!used.has(v) || (v === start && loop.length > 2)));
      if (!candidates.length) break;
      const v = candidates.find(c => !used.has(c)) ?? candidates[0];
      if (v === start) break;
      loop.push(v); used.add(v); prev = current; current = v;
    }
    if (loop.length > 2) loops.push(loop);
  }
  boundaryCache.set(indices, loops);
  return loops;
}

function offsetTriangle(out, x0, y0, x1, y1, x2, y2) {
  const xs = [x0, x1, x2], ys = [y0, y1, y2];
  const sign = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0) > 0 ? 1 : -1;
  const nx = [0, 0, 0], ny = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3, ex = xs[j] - xs[i], ey = ys[j] - ys[i], len = Math.hypot(ex, ey) || 1;
    nx[i] = ey / len * sign; ny[i] = -ex / len * sign;
  }
  for (let i = 0; i < 3; i++) {
    const p = (i + 2) % 3;
    const mx = nx[p] + nx[i], my = ny[p] + ny[i];
    const dot = mx * nx[i] + my * ny[i];
    let k = dot > 1e-6 ? EXPAND / dot : 0;
    const len = Math.hypot(mx, my) * k;
    if (len > MITER_CAP) k *= MITER_CAP / len;
    out[i * 2] = xs[i] + mx * k; out[i * 2 + 1] = ys[i] + my * k;
  }
  return out;
}

const quad = new Float64Array(6);

function drawMesh(ctx, item, image, view) {
  const {positions: p, uvs: t, indices: idx} = item;
  const tw = image.width, th = image.height;
  const s = view.scale, ox = view.originX, oy = view.originY;
  ctx.save();
  // Silhouette clip, only for meshes on OPAQUE texture masters (item.clip).
  // Atlas meshes sample transparent texels outside their outline; clipping
  // them would antialias the shared edge of abutting meshes into a seam.
  if (item.clip) {
    ctx.beginPath();
    for (const loop of meshBoundaryLoops(idx)) {
      ctx.moveTo(ox + p[loop[0] * 2] * s, oy - p[loop[0] * 2 + 1] * s);
      for (let i = 1; i < loop.length; i++) ctx.lineTo(ox + p[loop[i] * 2] * s, oy - p[loop[i] * 2 + 1] * s);
      ctx.closePath();
    }
    ctx.clip('nonzero');
  }
  // Half-plane clip in model space: keep nx*x + ny*y + c >= 0 (cuff opening).
  if (item.clipPlane) {
    const [nx, ny, c] = item.clipPlane;
    const px = -nx * c, py = -ny * c; // point on the line
    const tx = -ny, ty = nx, big = 50; // along the line / into the kept side (units)
    const corners = [[px + tx * big, py + ty * big], [px - tx * big, py - ty * big],
      [px - tx * big + nx * big, py - ty * big + ny * big], [px + tx * big + nx * big, py + ty * big + ny * big]];
    ctx.beginPath();
    corners.forEach(([x, y], i) => i ? ctx.lineTo(ox + x * s, oy - y * s) : ctx.moveTo(ox + x * s, oy - y * s));
    ctx.closePath();
    ctx.clip();
  }
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k] * 2, b = idx[k + 1] * 2, c = idx[k + 2] * 2;
    const x0 = ox + p[a] * s, y0 = oy - p[a + 1] * s;
    const x1 = ox + p[b] * s, y1 = oy - p[b + 1] * s;
    const x2 = ox + p[c] * s, y2 = oy - p[c + 1] * s;
    const u0 = t[a] * tw, v0 = (1 - t[a + 1]) * th;
    const u1 = t[b] * tw, v1 = (1 - t[b + 1]) * th;
    const u2 = t[c] * tw, v2 = (1 - t[c + 1]) * th;
    const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (Math.abs(det) < 1e-9) continue;
    const m11 = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / det;
    const m12 = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / det;
    const m21 = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / det;
    const m22 = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / det;
    if (!Number.isFinite(m11 + m12 + m21 + m22)) continue;
    const dx = x0 - m11 * u0 - m21 * v0, dy = y0 - m12 * u0 - m22 * v0;
    offsetTriangle(quad, x0, y0, x1, y1, x2, y2);
    ctx.save();
    ctx.beginPath(); ctx.moveTo(quad[0], quad[1]); ctx.lineTo(quad[2], quad[3]); ctx.lineTo(quad[4], quad[5]); ctx.closePath();
    ctx.clip();
    ctx.setTransform(m11, m12, m21, m22, dx, dy);
    ctx.drawImage(image, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

export function renderFrameCanvas2D(ctx, frame, textures, view, {createLayer} = {}) {
  let layer = null, maskLayer = null;
  for (const item of frame) {
    if (item.opacity <= 0.001 || !item.indices.length) continue;
    const image = textures[item.texture];
    if (!image) continue;
    if (!item.masks?.length) {
      ctx.globalAlpha = item.opacity;
      drawMesh(ctx, item, image, view);
      ctx.globalAlpha = 1;
      continue;
    }
    // Masked drawable: draw into a layer, keep only pixels covered by the masks.
    if (!createLayer) continue;
    layer ??= createLayer(ctx.canvas.width, ctx.canvas.height);
    maskLayer ??= createLayer(ctx.canvas.width, ctx.canvas.height);
    const g = layer.getContext('2d'), mg = maskLayer.getContext('2d');
    g.clearRect(0, 0, layer.width, layer.height);
    mg.clearRect(0, 0, maskLayer.width, maskLayer.height);
    drawMesh(g, item, image, view);
    for (const mask of item.masks) drawMesh(mg, mask, textures[mask.texture], view);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(maskLayer, 0, 0);
    g.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = item.opacity;
    ctx.drawImage(layer, 0, 0);
    ctx.globalAlpha = 1;
  }
}

// Fits the model canvas into a target of width x height px.
export function fitView(canvasInfo, width, height, {zoom = 1, focusX = 0, focusY = 0} = {}) {
  const unitsW = canvasInfo.CanvasWidth / canvasInfo.PixelsPerUnit;
  const unitsH = canvasInfo.CanvasHeight / canvasInfo.PixelsPerUnit;
  const scale = Math.min(width / unitsW, height / unitsH) * zoom;
  return {scale, originX: width / 2 - focusX * scale, originY: height / 2 + focusY * scale};
}
