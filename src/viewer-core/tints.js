// tints.js —— 生物群系着色决策（迁移自 minecraft-viewer.html 硬编码 TINTS；biome 维度首期固定 plains）
'use strict'

export const DEFAULT_BIOME = 'plains'

/**
 * 色板（与 minecraft-viewer.html TINTS 同值）。
 * grass/foliage 按 biome 索引（当前仅 plains）；redstone 按 power 0..15 档；constant 按方块名。
 * 结构上允许未来补充其他 biome 值。
 */
export const TINT_PALETTE = {
  grass: { plains: [0.847, 0.847, 0.741] },
  foliage: { plains: [0.588, 0.773, 0.184] },
  water: [0.4, 0.588, 0.824],
  redstone: [
    [0.188, 0.188, 0.188], [0.278, 0.278, 0.278], [0.302, 0.302, 0.302],
    [0.325, 0.325, 0.325], [0.35, 0.35, 0.35], [0.376, 0.376, 0.376],
    [0.403, 0.403, 0.403], [0.427, 0.427, 0.427], [0.452, 0.452, 0.452],
    [0.478, 0.478, 0.478], [0.502, 0.502, 0.502], [0.527, 0.527, 0.527],
    [0.553, 0.553, 0.553], [0.577, 0.577, 0.577], [0.604, 0.604, 0.604],
    [0.631, 0.631, 0.631]
  ],
  constant: {
    birch_leaves: [0.329, 0.745, 0.325],
    spruce_leaves: [0.251, 0.49, 0.176],
    lily_pad: [0.082, 0.447, 0.208]
  }
}

// —— tintindex===0 时实际参与生物群系染色的植物白名单（根因修复 #3：删除"默认 grass"兜底）——
// 判定依据：tintindex 只是"该面参与 block tint"的标记，具体颜色由方块语义决定。
// 原 prismarine models.js 把所有 tintindex0 的非特殊方块一律染 grass[biome]，
// 导致内容物纹理本色的方块（water_cauldron 水蓝 / powder_snow_cauldron 雪白 /
// lava_cauldron 熔岩橙 等，vanilla 从不 biome tint）被染成草绿。这里改为白名单：
// 只有语义上确实随生物群系变色的植物才取 grass/foliage；其余保持纹理本色（返回 null）。
export const GRASS_TINT_NAMES = new Set([
  'grass_block', // 草皮 overlay（顶/侧）
  'grass', 'tall_grass', 'fern', 'large_fern', 'potted_fern',
  'sugar_cane'
])

export const FOLIAGE_TINT_NAMES = new Set([
  'vine',
  'melon_stem', 'pumpkin_stem', 'attached_melon_stem', 'attached_pumpkin_stem',
  'bamboo', 'bamboo_sapling',
  'mangrove_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'cherry_leaves'
])

/**
 * 由方块 + 面 tintindex 决策着色值（无 tint 时返回 null，调用方保持白色 [1,1,1]）。
 * 规则：tintindex===0 才参与；redstone_wire 按 power 档红石色；birch/spruce/lily_pad
 * 用 constant（与 prismarine models.js 一致）；leaves 系与 FOLIAGE_TINT_NAMES 用 foliage 色；
 * GRASS_TINT_NAMES 用 grass 色；其余方块不染色（保持纹理本色）。
 * tintindex 非 0（如 pink_petals 的 1）同样不染色，与 prismarine models.js 行为一致。
 *
 * @param {import('./constants.js').BlockDescriptor} block
 * @param {number|undefined} tintindex
 * @param {{biome?:string,palette?:object}} [opts]
 * @returns {number[]|null}
 */
export function resolveTint (block, tintindex, { biome = DEFAULT_BIOME, palette = TINT_PALETTE } = {}) {
  if (tintindex === undefined || tintindex !== 0) return null
  const name = block.name
  if (name === 'redstone_wire') {
    return palette.redstone[block.props.power | 0] || palette.redstone[0]
  }
  const constant = palette.constant[name]
  if (constant) return constant // birch_leaves / spruce_leaves / lily_pad
  if (name.includes('leaves') || FOLIAGE_TINT_NAMES.has(name)) {
    return palette.foliage[biome] || palette.foliage[DEFAULT_BIOME]
  }
  if (GRASS_TINT_NAMES.has(name)) {
    return palette.grass[biome] || palette.grass[DEFAULT_BIOME]
  }
  return null // 不再兜底 grass：水罐/雪罐等保持纹理本色
}
