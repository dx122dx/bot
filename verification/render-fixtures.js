// render-fixtures.js —— verify-render.js 的合成世界夹具
//
// 设计原则：
//   - world 只提供 getBlock(x,y,z) → BlockDescriptor；未填充格返回 air 描述（与真实
//     prismarine world 一致：每格都有块，air 是透明块），保证 cullface/AO 判定路径真实。
//   - 单方块断言统一放在 ANCHOR 格，周围无任何实体块 → AO 全亮(light=1)、cullface 全保留，
//     颜色 = tint×1 精确可断言；也避免块间干扰。
//   - props 一律显式给出（不依赖 blocksStates 注入）：tint/几何不变量与 props 无关；
//     selectVariants 对空 props 会命中首个非空 key 或回退 default，保证各类 variants 形态可测。
//   - 快照布局为多块合成场景（间隔 ≥3 避免 AO 串扰），逐块独立构建后合并成 cases。
'use strict'

/** 单方块断言统一锚点（y=1 保证下邻居 y=0 ≥0 不被剔除；x/z=0 时 &15=0 便于换算） */
export const ANCHOR = { x: 0, y: 1, z: 0 }

/** 由格子坐标推导渲染核心的位置偏移 (x&15)-8 */
export function offsetFor (p) { return { x: (p.x & 15) - 8, y: (p.y & 15) - 8, z: (p.z & 15) - 8 } }

/** 由 attr 局部坐标还原模型像素坐标（须用同 anchor 渲染，且块无出界/仅 90° 旋转时才有效） */
export function pixelAt (posArr, anchor, off) {
  const o = off || offsetFor(anchor)
  return [(posArr[0] - o.x) * 16, (posArr[1] - o.y) * 16, (posArr[2] - o.z) * 16]
}

export function makeBlock (name, props = {}, extra = {}) {
  return Object.assign({ name, props, isCube: false, transparent: false, y: null }, extra)
}

/** 合成 world：entries = [[pos, block], …]；未填充格返回 air */
export function makeWorld (entries) {
  const map = new Map()
  for (const [pos, block] of entries) map.set(`${pos.x},${pos.y},${pos.z}`, block)
  return {
    getBlock (x, y, z) {
      const hit = map.get(`${x},${y},${z}`)
      if (hit) return hit
      return { name: 'air', props: {}, isCube: false, transparent: true, y }
    }
  }
}

/** 单方块孤立 world + block（props 显式传，缺省 {}；extra 可附加 isCube/transparent 等） */
export function singleBlockFixture (name, props = {}, extra) {
  const block = makeBlock(name, props, extra)
  return { world: makeWorld([[ANCHOR, block]]), block, anchor: ANCHOR }
}

// ---------------------------------------------------------------- 断言样本集

/** 朝向旋转组：方块 4 向/16 向变体在 facing 变化时应整体绕 Y 旋转 90°（非对称模型） */
export const ROTATION_GROUPS = [
  {
    id: 'chest',
    name: 'chest',
    dirs: ['north', 'east', 'south', 'west'],
    // 期望产物 facing → 渲染应用角度（负角规则），仅用于报告
    expectedY: { north: 180, east: 270, south: 0, west: 90 }
  },
  {
    id: 'oak_wall_sign',
    name: 'oak_wall_sign',
    dirs: ['north', 'east', 'south', 'west'],
    expectedY: { north: 0, east: 90, south: 180, west: 270 }
  },
  {
    id: 'oak_sign_rot',
    name: 'oak_sign',
    dirs: ['0', '4', '8', '12'], // rotation 0/4/8/12 → y 0/90/180/270
    propKey: 'rotation',
    expectedY: { 0: 0, 4: 90, 8: 180, 12: 270 }
  }
]

/** tint 决策样本：{name, expectKind} expectKind ∈ grass|foliage|constant|grayscale|grayscale-any */
export const TINT_SAMPLES = [
  { name: 'grass_block', expect: 'grass', label: '草方块顶部应染 grass 色' },
  { name: 'oak_leaves', expect: 'foliage', label: '橡树叶应染 foliage 色' },
  { name: 'birch_leaves', expect: 'constant', label: '白桦叶用 constant 色(非常规 foliage)' },
  { name: 'bamboo', expect: 'foliage', label: '竹子应染 foliage 色(非 grass)' },
  { name: 'water_cauldron', expect: 'grayscale', label: '水罐不得被 grass 污染(回归 #3)' },
  { name: 'pink_petals', expect: 'grayscale', label: '粉瓣花 tintindex=1 不染色(与上游一致)' },
  { name: 'stone', expect: 'grayscale', label: '石头无 tint 保持灰阶' },
  { name: 'oak_planks', expect: 'grayscale', label: '橡木板无 tint 保持灰阶' }
]

// ---------------------------------------------------------------- 快照布局
// 覆盖类别：cube 无 tint / 朝向模型(4向) / 墙贴 / 植物 tint / 内容物 tint(回归) / multipart
// 各块 x 间隔 ≥3 避免 AO 与 cullface 串扰；位于同 section（y≥4 底层无影响）。
export const SNAPSHOT_LAYOUT = [
  { pos: { x: 1, y: 4, z: 1 }, make: () => makeBlock('stone', {}, { isCube: true }) },
  { pos: { x: 5, y: 4, z: 1 }, make: () => makeBlock('chest', { facing: 'north' }) },
  { pos: { x: 9, y: 4, z: 1 }, make: () => makeBlock('oak_planks', {}, { isCube: true }) },
  { pos: { x: 13, y: 4, z: 1 }, make: () => makeBlock('oak_wall_sign', { facing: 'south' }) },
  { pos: { x: 1, y: 8, z: 4 }, make: () => makeBlock('grass_block', {}, { isCube: true }) },
  { pos: { x: 5, y: 8, z: 4 }, make: () => makeBlock('oak_leaves', {}, { isCube: true, transparent: true }) },
  { pos: { x: 9, y: 8, z: 4 }, make: () => makeBlock('water_cauldron', {}, { isCube: true }) },
  { pos: { x: 13, y: 8, z: 4 }, make: () => makeBlock('bamboo', {}) },
  { pos: { x: 1, y: 12, z: 7 }, make: () => makeBlock('oak_sign', { rotation: '8' }) },
  { pos: { x: 5, y: 12, z: 7 }, make: () => makeBlock('redstone_wire', { power: '15', east: 'none', north: 'none', south: 'none', west: 'none' }) },
  { pos: { x: 9, y: 12, z: 7 }, make: () => makeBlock('birch_leaves', {}, { isCube: true, transparent: true }) },
  { pos: { x: 13, y: 12, z: 7 }, make: () => makeBlock('pink_petals', {}, { transparent: true }) }
]

/** 生成快照场景 world（entries 带各自的 pos） */
export function makeSnapshotWorld () {
  return makeWorld(SNAPSHOT_LAYOUT.map(({ pos, make }) => [pos, make()]))
}
