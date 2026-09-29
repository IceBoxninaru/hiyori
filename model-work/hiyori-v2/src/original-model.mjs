// Environment-neutral wrapper around the ORIGINAL Hiyori moc3 running in Cubism
// Core. It exposes parameters and per-drawable mesh data. Views into Core
// memory are re-read after every access because WASM memory may grow.

export class OriginalModel {
  constructor(core, mocBuffer) {
    this.core = core;
    this.moc = core.Moc.fromArrayBuffer(mocBuffer);
    if (!this.moc) throw new Error('Invalid moc3');
    this.model = core.Model.fromMoc(this.moc);
    const p = this.model.parameters;
    this.parameterIds = [...p.ids];
    this.parameterMin = Float32Array.from(p.minimumValues);
    this.parameterMax = Float32Array.from(p.maximumValues);
    this.parameterDefault = Float32Array.from(p.defaultValues);
    this.parameterIndex = new Map(this.parameterIds.map((id, i) => [id, i]));
    this.partIds = [...this.model.parts.ids];
    const d = this.model.drawables;
    this.drawables = [];
    for (let i = 0; i < d.count; i++) {
      this.drawables.push({
        index: i,
        id: d.ids[i],
        part: d.parentPartIndices[i] >= 0 ? this.partIds[d.parentPartIndices[i]] : null,
        texture: d.textureIndices[i],
        uvs: Float32Array.from(d.vertexUvs[i]),
        indices: Uint16Array.from(d.indices[i]),
        masks: [...d.masks[i]],
        positions: new Float32Array(d.vertexPositions[i].length),
        order: 0,
        opacity: 1,
      });
    }
    this.drawableIndex = new Map(this.drawables.map(item => [item.id, item.index]));
    this.canvas = this.model.canvasinfo;
    this.reset();
  }

  has(id) { return this.parameterIndex.has(id); }
  get(id) {
    const i = this.parameterIndex.get(id);
    if (i === undefined) throw new Error(`Unknown parameter ${id}`);
    return this.model.parameters.values[i];
  }
  set(id, value) {
    const i = this.parameterIndex.get(id);
    if (i === undefined) throw new Error(`Unknown parameter ${id}`);
    if (!Number.isFinite(value)) throw new Error(`Non-finite value for ${id}`);
    this.model.parameters.values[i] = Math.min(this.parameterMax[i], Math.max(this.parameterMin[i], value));
  }
  reset() {
    const values = this.model.parameters.values;
    for (let i = 0; i < this.parameterIds.length; i++) values[i] = this.parameterDefault[i];
    const parts = this.model.parts.opacities;
    for (let i = 0; i < parts.length; i++) parts[i] = 1;
  }

  // Runs Core and copies the deformed state into the cached drawable records.
  update() {
    this.model.update();
    const d = this.model.drawables;
    const positions = d.vertexPositions, orders = d.renderOrders, opacities = d.opacities;
    for (const item of this.drawables) {
      item.positions.set(positions[item.index]);
      item.order = orders[item.index];
      item.opacity = opacities[item.index];
    }
    return this.drawables;
  }

  release() {
    this.model?.release();
    this.moc?._release?.();
    this.model = null;
  }
}
