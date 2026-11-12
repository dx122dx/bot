// liquids.js —— 液体（水/岩浆）几何：液面高度、角点平滑、面剔除、侧面 UV 压缩
//
// 逐行对照 prismarine-viewer viewer/lib/models.js 的 getLiquidRenderHeight / renderLiquid。
// 与上游的两处显式偏差（本项目方块描述符没有 material 字段）：
//   1) 上游对 neighbor.material === 'plant' 跳过液体面；本项目描述符无该字段，不做植物判断。
//   2) 上游用 `neighbor.isCube && !isUp` 剔除侧面，会把玻璃等透明方块后面的液面一起剔掉；
//      这里按 vanilla 语义只剔除不透明方块（`isCube && !transparent`），透明方块不剔除。
// 其余（高度公式、3×3 角点取最大值、UV 按高度压缩、水面假光照）与上游一致。
'use strict'

import { elemFaces } from './constants.js'
import { selectVariants } from './variants.js'

/**
 * 液体渲染高度（0..1）。上游对非液体邻居返回 1/9；本实现对非液体返回 0，
 * 因为角点取的是 3×3 邻域最大值且自身必在其中（自身高度 ≥ 1/9），结果等价。
 *
 * @returns {number}
 */
function liquidRenderHeight (world, x, y, z, name) {
  const block = world.getBlock(x, y, z)
  if (!block || block.name !== name) return 0
  const raw = Number(block.props && block.props.level)
  const level = Number.isInteger(raw) && raw >= 0 ? raw : 0
  if (level === 0) {
    const above = world.getBlock(x, y + 1, z)
    if (above && above.name === name) return 1
    return 8 / 9
  }
  return ((level >= 8 ? 8 : 7 - level) + 1) / 9
}

/** 3×3 邻域液面最大值 → 四角高度（角点索引 = z*2+x） */
function cornerHeights (world, x, y, z, name) {
  const h = []
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      h.push(liquidRenderHeight(world, x + dx, y, z + dz, name))
    }
  }
  return [
    Math.max(h[0], h[1], h[3], h[4]),
    Math.max(h[1], h[2], h[4], h[5]),
    Math.max(h[3], h[4], h[6], h[7]),
    Math.max(h[4], h[5], h[7], h[8])
  ]
}

/** blocksStates → (液体名 → 图集格子)；每个 section 会为每格液体调用一次，必须缓存 */
const tileCache = new WeakMap()

/**
 * 取液体纹理在图集中的格子（blocksStates 的 textures.particle）。
 * blocksStates 由 ensurePatchedAssets 生成，液体模型没有 elements，只保留 particle 的 UV。
 */
export function liquidTexture (block, blocksStates) {
  let perStates = tileCache.get(blocksStates)
  if (!perStates) {
    perStates = new Map()
    tileCache.set(blocksStates, perStates)
  }
  const cached = perStates.get(block.name)
  if (cached) return cached

  const { variants } = selectVariants(block, blocksStates)
  const model = variants && variants[0] && variants[0].model
  const texture = model && model.textures && model.textures.particle
  if (!texture || typeof texture.u !== 'number' || typeof texture.su !== 'number') {
    throw new Error(`blocksStates 缺少 ${block.name} 的 particle 纹理 UV，无法构建液体几何`)
  }
  perStates.set(block.name, texture)
  return texture
}

/** 水面/岩浆的假光照系数（与上游 renderLiquid 同值）：让液面有基本的朝向区分度 */
function faceLight (dir) {
  if (dir[0] !== 0) return 0.6
  if (dir[2] !== 0) return 0.8
  return 1
}

/**
 * 把单个液体方块的可见面追加进 attr（positions/normals/colors/uvs/indices）。
 * 调用方负责判断该方块是否为液体、以及之后按 attr.liquid 分组索引。
 *
 * @param {{attr:object, world:object, blocksStates:object, palette:object}} ctx
 *   attr 为输出累计器，world 需提供 getBlock(x,y,z)，palette 为服务端调色板
 * @param {number} x 世界坐标（整数）
 * @param {number} y
 * @param {number} z
 * @param {import('./constants.js').BlockDescriptor} block
 */
export function appendLiquidGeometry (ctx, x, y, z, block) {
  const { attr, world, blocksStates, palette } = ctx
  const name = block.name
  const texture = liquidTexture(block, blocksStates)
  const heights = cornerHeights(world, x, y, z, name)

  let tint = [1, 1, 1]
  if (name === 'water') {
    if (!palette || !palette.water) {
      throw new Error('水面着色需要服务端调色板（/api/tints 的 water），不得静默使用白色')
    }
    tint = palette.water
  }

  const u = texture.u
  const v = texture.v
  const su = texture.su
  const sv = texture.sv

  for (const face in elemFaces) {
    const { dir, corners } = elemFaces[face]
    const isUp = dir[1] === 1
    const neighbor = world.getBlock(x + dir[0], y + dir[1], z + dir[2])
    if (!neighbor) continue // 未加载列：与方块几何一致，剔除该面
    if (neighbor.name === name) continue // 同种液体互剔
    if (!isUp && neighbor.isCube && !neighbor.transparent) continue // 不透明立方体挡住侧面
    if (neighbor.props && neighbor.props.waterlogged === 'true') continue

    const light = faceLight(dir)
    const ndx = Math.floor(attr.positions.length / 3)

    for (const pos of corners) {
      const height = heights[pos[2] * 2 + pos[0]]
      attr.positions.push(
        (pos[0] ? 1 : 0) + (x & 15) - 8,
        (pos[1] ? height : 0) + (y & 15) - 8,
        (pos[2] ? 1 : 0) + (z & 15) - 8
      )
      attr.normals.push(...dir)
      // 侧面把纹理按液面高度压缩（上游同式）；顶/底面用满格纹理
      attr.uvs.push(
        pos[3] * su + u,
        pos[4] * sv * (pos[1] ? 1 : height) + v
      )
      attr.colors.push(tint[0] * light, tint[1] * light, tint[2] * light)
    }

    attr.indices.push(ndx, ndx + 1, ndx + 2, ndx + 2, ndx + 1, ndx + 3)
  }
}
