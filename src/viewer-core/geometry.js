// geometry.js —— 面渲染与几何构建（迁移自 minecraft-viewer.html renderElement/buildGeometryForBlock，逐行对照 prismarine-viewer models.js）
'use strict'

import { elemFaces, AIR_BLOCK_NAMES } from './constants.js'
import { vecadd3, vecsub3, matmul3, matmulmat3, buildRotationMatrix } from './math.js'
import { selectVariants } from './variants.js'
import { resolveTint, DEFAULT_BIOME } from './tints.js'

/** @typedef {{positions:number[],normals:number[],colors:number[],uvs:number[],indices:number[]}} GeometryAttr */

/**
 * 渲染单个 element 的全部面，追加写入 attr（AO / cullface / UV rotation / tint 全在此）。
 *
 * @param {object} world      邻居查询接口，只需 getBlock(x,y,z) → BlockDescriptor|null
 * @param {{x:number,y:number,z:number}} cursor   当前方块整型坐标（内部按 &15-8 做 16³ 内居中）
 * @param {object} element    方块 model 的单个 element（from/to/faces[/rotation]）
 * @param {boolean} doAO      是否计算环境光遮蔽
 * @param {GeometryAttr} attr 输出累计器
 * @param {Array|null} globalMatrix  变体级旋转矩阵（含 null=无）
 * @param {Array|null} globalShift   变体级平移（绕 [8,8,8] 中心）
 * @param {import('./constants.js').BlockDescriptor} block
 * @param {string} [biome]    着色 biome（默认 plains）
 */
export function renderElement (world, cursor, element, doAO, attr, globalMatrix, globalShift, block, biome = DEFAULT_BIOME) {
  const cullIfIdentical = block.name.indexOf('glass') >= 0

  for (const face in element.faces) {
    const eFace = element.faces[face]
    const { corners, mask1, mask2 } = elemFaces[face]
    const dir = matmul3(globalMatrix, elemFaces[face].dir)

    if (eFace.cullface) {
      const neighbor = world.getBlock(cursor.x + dir[0], cursor.y + dir[1], cursor.z + dir[2])
      if (!neighbor) continue
      if (cullIfIdentical && neighbor.name === block.name) continue
      if (!neighbor.transparent && neighbor.isCube) continue
      if (neighbor.y < 0) continue
    }

    const minx = element.from[0]; const miny = element.from[1]; const minz = element.from[2]
    const maxx = element.to[0]; const maxy = element.to[1]; const maxz = element.to[2]

    const u = eFace.texture.u
    const v = eFace.texture.v
    const su = eFace.texture.su
    const sv = eFace.texture.sv

    const ndx = Math.floor(attr.positions.length / 3)

    const resolved = resolveTint(block, eFace.tintindex, { biome })
    const tint = resolved || [1, 1, 1]

    // UV rotation
    const r = eFace.rotation || 0
    const uvcs = Math.cos(r * Math.PI / 180)
    const uvsn = -Math.sin(r * Math.PI / 180)

    let localMatrix = null
    let localShift = null
    if (element.rotation) {
      localMatrix = buildRotationMatrix(element.rotation.axis, element.rotation.angle)
      localShift = vecsub3(element.rotation.origin, matmul3(localMatrix, element.rotation.origin))
    }

    const aos = []
    for (const pos of corners) {
      let vertex = [
        (pos[0] ? maxx : minx),
        (pos[1] ? maxy : miny),
        (pos[2] ? maxz : minz)
      ]
      vertex = vecadd3(matmul3(localMatrix, vertex), localShift)
      vertex = vecadd3(matmul3(globalMatrix, vertex), globalShift)
      vertex = vertex.map(val => val / 16)

      attr.positions.push(
        vertex[0] + (cursor.x & 15) - 8,
        vertex[1] + (cursor.y & 15) - 8,
        vertex[2] + (cursor.z & 15) - 8
      )
      attr.normals.push(...dir)

      const baseu = (pos[3] - 0.5) * uvcs - (pos[4] - 0.5) * uvsn + 0.5
      const basev = (pos[3] - 0.5) * uvsn + (pos[4] - 0.5) * uvcs + 0.5
      attr.uvs.push(baseu * su + u, basev * sv + v)

      let light = 1
      if (doAO) {
        const dx = pos[0] * 2 - 1
        const dy = pos[1] * 2 - 1
        const dz = pos[2] * 2 - 1
        const cornerDir = matmul3(globalMatrix, [dx, dy, dz])
        const side1Dir = matmul3(globalMatrix, [dx * mask1[0], dy * mask1[1], dz * mask1[2]])
        const side2Dir = matmul3(globalMatrix, [dx * mask2[0], dy * mask2[1], dz * mask2[2]])
        const side1 = world.getBlock(cursor.x + side1Dir[0], cursor.y + side1Dir[1], cursor.z + side1Dir[2])
        const side2 = world.getBlock(cursor.x + side2Dir[0], cursor.y + side2Dir[1], cursor.z + side2Dir[2])
        const corner = world.getBlock(cursor.x + cornerDir[0], cursor.y + cornerDir[1], cursor.z + cornerDir[2])

        const side1Block = (side1 && side1.isCube) ? 1 : 0
        const side2Block = (side2 && side2.isCube) ? 1 : 0
        const cornerBlock = (corner && corner.isCube) ? 1 : 0

        // TODO: correctly interpolate ao light based on pos (evaluate once for each corner of the block)
        const ao = (side1Block && side2Block) ? 0 : (3 - (side1Block + side2Block + cornerBlock))
        light = (ao + 1) / 4
        aos.push(ao)
      }

      attr.colors.push(tint[0] * light, tint[1] * light, tint[2] * light)
    }

    if (doAO && aos[0] + aos[3] >= aos[1] + aos[2]) {
      attr.indices.push(ndx, ndx + 3, ndx + 2, ndx, ndx + 1, ndx + 3)
    } else {
      attr.indices.push(ndx, ndx + 1, ndx + 2, ndx + 2, ndx + 1, ndx + 3)
    }
  }
}

/**
 * 构建单个方块的几何（voxel 坐标 x/y/z 为世界坐标；位置按 cursor & 15 内聚到 16³）。
 * 与 minecraft-viewer.html buildGeometryForBlock 行为一致：
 *   - water/lava 跳过（液体由 viewer 特殊处理，本核心首版不含）；
 *   - 空气类（AIR_BLOCK_NAMES）返回 null；
 *   - 无可用模型 / 无几何产出返回 null。
 * 注：block 须由调用方构造好 descriptor（props/isCube/transparent），本函数不依赖外部名单表。
 *
 * @param {import('./constants.js').BlockDescriptor} block
 * @param {number} x 世界 X（应 ≥0 且为整数；voxel 定位按 & 15）
 * @param {number} y
 * @param {number} z
 * @param {object} blocksStates
 * @param {object} world   getBlock(x,y,z)→BlockDescriptor|null（调用方负责取整以消除浮点误差）
 * @param {{doAO?:boolean,biome?:string}} [opts]
 * @returns {GeometryAttr|null}
 */
export function buildBlockGeometry (block, x, y, z, blocksStates, world, { doAO = true, biome = DEFAULT_BIOME } = {}) {
  const name = block.name
  if (name === 'water' || name === 'lava') return null // 液体：本核心首版跳过（与演示页一致）
  if (AIR_BLOCK_NAMES.has(name)) return null

  const { variants } = selectVariants(block, blocksStates)
  if (!variants || variants.length === 0) return null

  const attr = { positions: [], normals: [], colors: [], uvs: [], indices: [] }
  let built = false
  for (const v of variants) {
    if (!v || !v.model) continue
    let globalMatrix = null
    let globalShift = null
    for (const axis of ['x', 'y', 'z']) {
      if (axis in v) {
        if (!globalMatrix) globalMatrix = buildRotationMatrix(axis, -v[axis])
        else globalMatrix = matmulmat3(globalMatrix, buildRotationMatrix(axis, -v[axis]))
      }
    }
    if (globalMatrix) {
      globalShift = [8, 8, 8]
      globalShift = vecsub3(globalShift, matmul3(globalMatrix, globalShift))
    }
    for (const element of v.model.elements) {
      renderElement(world, { x, y, z }, element, v.model.ao && doAO, attr, globalMatrix, globalShift, block, biome)
      built = true
    }
  }
  if (!built || attr.positions.length === 0) return null
  return attr
}

/**
 * 构建一个 16³ section 的聚合几何。
 * 遍历每格调用 world.getBlock(x,y,z)；返回 null 或缺失的格子跳过。
 * NOTE(性能)：16³ 遍历逐格查询——浏览器侧由 mesh-worker 持有镜像（Uint16 stateId 快查）提供 world；
 * Node 断言侧用小 world 对象即可。空 section 返回 null。
 *
 * @param {{x:number,y:number,z:number}} origin  section 最小角世界坐标（16 的倍数）
 * @param {object} world  getBlock(x,y,z)→BlockDescriptor|null
 * @param {object} blocksStates
 * @param {{doAO?:boolean,biome?:string}} [opts]
 * @returns {GeometryAttr|null}
 */
export function buildSectionGeometry (origin, world, blocksStates, { doAO = true, biome = DEFAULT_BIOME } = {}) {
  // indices 保持全量（供 verts/tris 统计与既有消费方）；opaqueIndices/alphaIndices 按方块
  // 是否半透明（block.transparent）把三角分装——页面据此拆"不透明 mesh / alpha 混合 mesh"，
  // 避免单 mesh 内透明与不透明面混排：不透明面与玻璃面同一渲染队列时不做片元级排序，
  // 玻璃先画会以 depth 遮挡其后绘制的实心面（透过玻璃"消失/透视"）。
  const attr = { positions: [], normals: [], colors: [], uvs: [], indices: [], opaqueIndices: [], alphaIndices: [] }
  let any = false
  for (let by = 0; by < 16; by++) {
    for (let bz = 0; bz < 16; bz++) {
      for (let bx = 0; bx < 16; bx++) {
        const x = origin.x + bx
        const y = origin.y + by
        const z = origin.z + bz
        if (y < 0) continue
        const block = world.getBlock(x, y, z)
        if (!block) continue
        const built = buildBlockGeometry(block, x, y, z, blocksStates, world, { doAO, biome })
        if (built) {
          // 索引偏移 = 本块首顶点在累计缓冲里的位置（appendGeometry 只平移索引）
          const base = attr.positions.length / 3
          const partition = block.transparent ? attr.alphaIndices : attr.opaqueIndices
          for (let i = 0; i < built.indices.length; i++) partition.push(built.indices[i] + base)
          appendGeometry(attr, built)
          any = true
        }
      }
    }
  }
  return any ? attr : null
}

/** 把子几何（相对索引）并入聚合 attr（indices 加偏移） */
function appendGeometry (target, source) {
  const base = target.positions.length / 3
  target.positions.push(...source.positions)
  target.normals.push(...source.normals)
  target.colors.push(...source.colors)
  target.uvs.push(...source.uvs)
  for (let i = 0; i < source.indices.length; i++) target.indices.push(source.indices[i] + base)
}
