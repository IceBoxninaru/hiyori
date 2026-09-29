// Composes one frame: the ORIGINAL Core drawables (without the hidden original
// arm drawings) plus the rig's arm/hand items, sorted back to front.

export function composeFrame(coreDrawables, rigItems, {hiddenParts = ['PartArmA', 'PartArmB']} = {}) {
  const hidden = new Set(hiddenParts);
  const frame = [];
  for (const d of coreDrawables) {
    if (hidden.has(d.part) || d.id === 'HitArea') continue;
    frame.push({id: d.id, texture: d.texture, uvs: d.uvs, indices: d.indices, positions: d.positions, opacity: d.opacity, order: d.order,
      masks: d.masks.map(i => coreDrawables[i])});
  }
  for (const item of rigItems) frame.push({...item, masks: []});
  // Stable sort; ties keep insertion order (Core first).
  return frame.map((item, i) => [item, i]).sort((a, b) => a[0].order - b[0].order || a[1] - b[1]).map(([item]) => item);
}
