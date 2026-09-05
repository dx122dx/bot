// constants.js —— 渲染核心常量（迁移自 minecraft-viewer.html，与 prismarine-viewer models.js 一致）
'use strict'

/** 图集尺寸。blocksStates 中预计算的 u/v/su/sv 已基于 2048 图集（文档常量，UV 无需再换算） */
export const ATLAS_SIZE = 2048

/** 空气类方块精确名单（替代 models.js 的 name.includes('air') —— 后者误伤 oak_stairs 等） */
export const AIR_BLOCK_NAMES = new Set(['air', 'cave_air', 'void_air'])

/** 六面几何表：dir=外法线、mask1/mask2=AO 侧棱方向、corners=4 顶点 [px,py,pz,ux,uv] 布局 */
export const elemFaces = {
  up: { dir: [0, 1, 0], mask1: [1, 1, 0], mask2: [0, 1, 1], corners: [[0, 1, 1, 0, 1], [1, 1, 1, 1, 1], [0, 1, 0, 0, 0], [1, 1, 0, 1, 0]] },
  down: { dir: [0, -1, 0], mask1: [1, 1, 0], mask2: [0, 1, 1], corners: [[1, 0, 1, 0, 1], [0, 0, 1, 1, 1], [1, 0, 0, 0, 0], [0, 0, 0, 1, 0]] },
  east: { dir: [1, 0, 0], mask1: [1, 1, 0], mask2: [1, 0, 1], corners: [[1, 1, 1, 0, 0], [1, 0, 1, 0, 1], [1, 1, 0, 1, 0], [1, 0, 0, 1, 1]] },
  west: { dir: [-1, 0, 0], mask1: [1, 1, 0], mask2: [1, 0, 1], corners: [[0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [0, 1, 1, 1, 0], [0, 0, 1, 1, 1]] },
  north: { dir: [0, 0, -1], mask1: [1, 0, 1], mask2: [0, 1, 1], corners: [[1, 0, 0, 0, 1], [0, 0, 0, 1, 1], [1, 1, 0, 0, 0], [0, 1, 0, 1, 0]] },
  south: { dir: [0, 0, 1], mask1: [1, 0, 1], mask2: [0, 1, 1], corners: [[0, 0, 1, 0, 1], [1, 0, 1, 1, 1], [0, 1, 1, 0, 0], [1, 1, 1, 1, 0]] }
}

/**
 * @typedef {Object} BlockDescriptor  渲染核心统一使用的方块描述（与 prismarine Block 解耦）
 * @property {string} name            方块名（短名，如 'chest'/'stone'）
 * @property {Object<string,string>} props  方块属性（如 { facing:'north' }），由调用方从 state 解析
 * @property {boolean} [isCube]       是否完整立方体（cullface/AO 邻居判定用）
 * @property {boolean} [transparent]  是否透明
 * @property {number} [y]             世界 Y（仅用于 y<0 剔除检查）
 */
