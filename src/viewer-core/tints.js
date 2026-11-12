// tints.js —— 面 tint 决策（分类规则），颜色值由服务端按版本解析后注入
//
// 为什么要外部注入：生物群系色随游戏版本变化，且 1.19+ 的版本数据不再直接给出默认色，
// 必须由 Node 侧结合版本 tints / colormap 推导（见 src/viewer-server/tint-palette.js）。
// 本文件只保留「哪些方块参与哪种着色」的语义分类，不持有任何色值。
'use strict'

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

function requirePalette (palette) {
  if (!palette || !palette.grass || !palette.foliage) {
    throw new Error('方块 tint 需要服务端调色板（GET /api/tints），不得静默使用白色')
  }
  return palette
}

/**
 * 由方块 + 面 tintindex 决策着色值（无 tint 时返回 null，调用方保持白色 [1,1,1]）。
 * 规则：tintindex===0 才参与；redstone_wire 按 power 档红石色；constant 名单（birch/spruce/
 * lily_pad 等，随版本数据下发）优先；leaves 系与 FOLIAGE_TINT_NAMES 用 foliage 色；
 * GRASS_TINT_NAMES 用 grass 色；其余方块不染色（保持纹理本色）。
 * tintindex 非 0（如 pink_petals 的 1）同样不染色，与 prismarine models.js 行为一致。
 *
 * @param {import('./constants.js').BlockDescriptor} block
 * @param {number|undefined} tintindex
 * @param {{grass:number[],foliage:number[],redstone:number[][],constant:Object<string,number[]>}} palette
 * @returns {number[]|null}
 */
export function resolveTint (block, tintindex, palette) {
  if (tintindex === undefined || tintindex !== 0) return null
  const name = block.name
  if (name === 'redstone_wire') {
    const table = requirePalette(palette).redstone
    return table[block.props.power | 0] || table[0]
  }
  const constant = palette && palette.constant && palette.constant[name]
  if (constant) return constant // birch_leaves / spruce_leaves / lily_pad 等
  if (name.includes('leaves') || FOLIAGE_TINT_NAMES.has(name)) {
    return requirePalette(palette).foliage
  }
  if (GRASS_TINT_NAMES.has(name)) {
    return requirePalette(palette).grass
  }
  return null // 不再兜底 grass：水罐/雪罐等保持纹理本色
}
