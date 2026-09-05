'use strict'
// prismarine-viewer 高保真方块补丁模块
// 1) 为 blocksStates 中"空模型"方块（箱子/告示牌/床/横幅/潜影盒/头颅等 tile entity 方块）
//    注入高保真几何模型（数据格式与 viewer/lib/models.js 完全兼容）
// 2) 纹理图集合并：原 512x512 图集原样放 2048x2048 左上角，原 UV ÷4 重映射；新纹理贴右侧/下方
// 3) 替换 express 静态路由，浏览器优先加载 viewer-assets 补丁数据（未命中自动回退 public）
// 兼容 node 直跑与 pkg 打包（补丁数据写入 process.cwd()/viewer-assets）

const path = require('path')
const fs = require('fs')
const express = require('express')
const { PNG } = require('pngjs')

// ---------- 常量 ----------
const VIEWER_DIR = path.dirname(require.resolve('prismarine-viewer'))
const PUBLIC_DIR = path.join(VIEWER_DIR, 'public')
const VERSION = '1.20.1'
const ORIG_ATLAS_SIZE = 512
const NEW_ATLAS_SIZE = 2048
const UV_FACTOR = NEW_ATLAS_SIZE / ORIG_ATLAS_SIZE // 4
const VIEWER_ASSETS_DIR = path.join(process.cwd(), 'viewer-assets')
const TEXTURE_SRC_DIR = path.join(VIEWER_ASSETS_DIR, 'texture-src')
const BLOCKS_PATCH_FILE = path.join(VIEWER_ASSETS_DIR, 'blocksStates', `${VERSION}.json`)
const TEXTURE_PATCH_FILE = path.join(VIEWER_ASSETS_DIR, 'textures', `${VERSION}.png`)

// ---------- 小工具 ----------
function ts () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function log (msg) { console.log(`[${ts()}] ${msg}`) }

// ---------- UV 工具 ----------
function pxUV (x, y, w, h) {
  return { u: x / NEW_ATLAS_SIZE, v: y / NEW_ATLAS_SIZE, su: w / NEW_ATLAS_SIZE, sv: h / NEW_ATLAS_SIZE }
}

class UVAllocator {
  constructor () {
    this.x = ORIG_ATLAS_SIZE
    this.y = 0
    this.rowH = 0
    this.map = new Map()    // name -> {x,y,w,h} 像素位置（供图集贴入）
    this.uvs = new Map()    // name -> {u,v,su,sv} 归一化坐标（供模型引用）
  }

  alloc (name, w, h) {
    if (this.x + w > NEW_ATLAS_SIZE) {
      this.x = ORIG_ATLAS_SIZE
      this.y += this.rowH
      this.rowH = 0
    }
    const pos = { x: this.x, y: this.y, w, h }
    this.map.set(name, pos)
    this.x += w
    this.rowH = Math.max(this.rowH, h)
    return pos
  }

  // 同一纹理多次引用返回同一 uv（uvs 缓存，二次调用不再重新分配）
  uv (name, w, h) {
    if (this.uvs.has(name)) return this.uvs.get(name)
    const p = this.alloc(name, w, h)
    const uv = pxUV(p.x, p.y, p.w, p.h)
    this.uvs.set(name, uv)
    return uv
  }
}

// ---------- 原图集 UV 重映射（全部 ÷4） ----------
function rescaleUVs (states) {
  const scale = (t) => {
    if (!t) return
    if (t.u !== undefined) { t.u /= UV_FACTOR; t.su /= UV_FACTOR }
    if (t.v !== undefined) { t.v /= UV_FACTOR; t.sv /= UV_FACTOR }
  }
  const collect = (v) => {
    const list = Array.isArray(v) ? v : [v]
    for (const item of list) {
      const m = item && item.model
      if (m && m.textures) {
        for (const t of Object.values(m.textures)) scale(t)
      }
      if (m && m.elements) {
        for (const e of m.elements) {
          if (e.faces) {
            for (const f of Object.values(e.faces)) scale(f.texture)
          }
        }
      }
    }
  }
  for (const name of Object.keys(states)) {
    const s = states[name]
    if (s.variants) { for (const v of Object.values(s.variants)) collect(v) }
    if (s.multipart) {
      for (const p of s.multipart) {
        collect(Array.isArray(p.apply) ? p.apply : [p.apply])
      }
    }
  }
}

// 取原 blocksStates 某方块任一面纹理 UV（须在 rescale 之后调用）
function origTextureUV (states, blockName) {
  const s = states[blockName]
  if (!s) return null
  const pick = (v) => {
    // v 可能是 variant 包装 { x?, y?, z?, model }，也可能是 multipart apply 元素 { model } 或裸 model
    const m = v && (v.model || v)
    if (!m || !m.textures) return null
    const t = m.textures.particle || m.textures.north || m.textures.up ||
      Object.values(m.textures).find((x) => x && x.u !== undefined)
    return t && t.u !== undefined ? { u: t.u, v: t.v, su: t.su, sv: t.sv } : null
  }
  if (s.variants) {
    for (const v of Object.values(s.variants)) {
      const r = pick(Array.isArray(v) ? v[0] : v)
      if (r) return r
    }
  }
  if (s.multipart) {
    for (const p of s.multipart) {
      const list = Array.isArray(p.apply) ? p.apply : [p.apply]
      for (const a of list) {
        const r = pick(a)
        if (r) return r
      }
    }
  }
  return null
}

// ---------- 模型构建 helpers ----------
// 元素：from/to 为 0-16 单位坐标，每面引用一个完整纹理格 {u,v,su,sv}
function el (from, to, tex, rot) {
  const faces = {}
  for (const f of ['north', 'east', 'south', 'west', 'up', 'down']) {
    faces[f] = { texture: tex }
  }
  const e = { from, to, faces }
  if (rot) e.rotation = rot
  return e
}

// 实体模型 cuboid：off=[x,y,z] 起点，size=[sx,sy,sz] 尺寸，uvOff=[u,v] 纹理内偏移（像素，默认 0,0）。
// 模型单位 1 单位=1 纹理像素；6 面按 1.20.1 ModelPart$Cuboid 的 UV 布局各自采样子区
// （避免整块纹理重复贴到每面）：u 行: west(sizeZ) north(sizeX) east(sizeZ) south(sizeX)；
// v 区: [p,q]=down/up, [q,r]=侧四面。
function elCuboid (tex, off, size, rot, uvOff) {
  const [cx, cy, cz] = off
  const [sx, sy, sz] = size
  const [u0, v0] = uvOff || [0, 0]
  const texW = tex.su * NEW_ATLAS_SIZE
  const texH = tex.sv * NEW_ATLAS_SIZE
  const k = sz
  const l = k + sx
  const m = l + sx
  const n = l + sz
  const o = n + sx
  const q = sz
  const r = q + sy
  const faceUV = (u1, v1, u2, v2) => ({
    u: tex.u + ((u1 + u0) / texW) * tex.su,
    v: tex.v + ((v1 + v0) / texH) * tex.sv,
    su: ((u2 - u1) / texW) * tex.su,
    sv: ((v2 - v1) / texH) * tex.sv
  })
  const faces = {
    west: { texture: faceUV(0, q, k, r) },
    north: { texture: faceUV(k, q, l, r) },
    east: { texture: faceUV(l, q, n, r) },
    south: { texture: faceUV(n, q, o, r) },
    down: { texture: faceUV(k, 0, l, q) },
    up: { texture: faceUV(l, 0, m, q) }
  }
  const e = { from: [cx, cy, cz], to: [cx + sx, cy + sy, cz + sz], faces }
  if (rot) e.rotation = rot
  return e
}

function makeModel (particle, elements, ao = true) {
  return { textures: { particle }, ao, elements }
}

// 生成 facing 变体（base 模型正面朝北/-z，参照 anvil 旋转约定：north=0/east=270/south=180/west=90）
// 注意：variant 必须是 { x?, y?, z?, model } 包装结构（getModelVariants 消费 variant.model）
function facingVariants (model) {
  return {
    'facing=north': { model },
    'facing=east': { y: 90, model },
    'facing=south': { y: 180, model },
    'facing=west': { y: 270, model }
  }
}

// 箱子专属 facing 变体（与 facingVariants 相反：south=0）
// 依据 1.20.1 ChestBlockEntityRenderer：blockEntity.facing 为 SOUTH 时旋转 0（model 自身 +z 为前/锁扣侧），
// NORTH→y180、EAST→y270、WEST→y90（与 prismarine-viewer 原版 anvil/chest 数据约定一致）。
// 不能复用 facingVariants：墙贴类（wall_sign/wall_banner/wall_head 等）默认贴北墙需 north=0。
function facingVariantsChest (model) {
  return {
    'facing=north': { y: 180, model },
    'facing=east': { y: 270, model },
    'facing=south': { model },
    'facing=west': { y: 90, model }
  }
}

// rotation 0-15 → y = rotation * 22.5
// 注意：不能带空 key '' —— 渲染端对空 properties 无条件最先命中，会导致 16 向旋转变体永不可达
function rotationVariants (model) {
  const v = {}
  for (let r = 0; r < 16; r++) {
    v[`rotation=${r}`] = r === 0 ? { model } : { y: r * 22.5, model }
  }
  return v
}

// ---------- 方块分类常量 ----------
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped']
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const HEADS = ['skeleton_skull', 'wither_skeleton_skull', 'player_head', 'zombie_head', 'creeper_head', 'dragon_head', 'piglin_head']
const HEADS_WALL = ['skeleton_wall_skull', 'wither_skeleton_wall_skull', 'player_wall_head', 'zombie_wall_head', 'creeper_wall_head', 'dragon_wall_head', 'piglin_wall_head']

// ---------- 纹理规格表（texName -> [w, h] 像素） ----------
const TEXTURE_SPECS = {
  chest_normal: [64, 64],
  chest_trapped: [64, 64],
  chest_ender: [64, 64],
  conduit: [16, 16],
  moving_piston: [16, 16],
  light_15: [16, 16],
  structure_void: [16, 16],
  barrier: [16, 16],
  end_portal: [16, 16],
  end_gateway: [16, 16],
  decorated_pot_side: [16, 16],
  pitcher_crop: [16, 16]
}
for (const w of WOODS) {
  TEXTURE_SPECS[`${w}_sign`] = [64, 32]
  TEXTURE_SPECS[`${w}_hanging`] = [64, 64]
  TEXTURE_SPECS[`${w}_log`] = [16, 16]
  TEXTURE_SPECS[`${w}_planks`] = [16, 16]
}
for (const c of COLORS) {
  TEXTURE_SPECS[`bed_${c}`] = [64, 64]
  TEXTURE_SPECS[`bed_${c}_frame`] = [64, 64]
  TEXTURE_SPECS[`banner_${c}`] = [64, 64]
  TEXTURE_SPECS[`shulker_${c}`] = [64, 64]
}
for (const h of HEADS) {
  TEXTURE_SPECS[h] = [16, 16]
}

// ---------- 方块模型生成器 ----------
// 每个生成器接收 tex(name) -> {u,v,su,sv}（缺失时回退），返回 { variants: {...} }

// 箱子/陷阱箱/末影箱：箱体 + 盖 + 把手，facing 4 方向（texName 指定各自纹理）
// 几何参考 1.20.1 ChestModel：bottom uv(0,19) cuboid(1,0,1,14,10,14)；lid uv(0,0) cuboid(1,0,0,14,5,14) pivot(0,9,1)；lock uv(0,0) cuboid(7,-2,14,2,4,1) pivot(0,9,1)
// lid pivot y9 换算绝对 [1,9,1]（z 与箱体对齐 1~15）；lock 相对 pivot (-7,-2,-1) 换算绝对 [7,7,15]（z 15~16 凸出）
// 旋转用 facingVariantsChest（lock 在模型自身 +z 侧，facing=north 时锁扣朝北需 y180，south=0 与 1.20.1 ChestBlockEntityRenderer 一致）
function buildChest (tex, texName = 'chest_normal') {
  const t = tex(texName)
  const model = makeModel(t, [
    elCuboid(t, [1, 0, 1], [14, 10, 14], null, [0, 19]),  // 箱体（uv 区 v19 起）
    elCuboid(t, [1, 9, 1], [14, 5, 14], null, [0, 0]),    // 盖（setPos(0,9,1)，lid 区 uv(0,0)）
    elCuboid(t, [7, 7, 15], [2, 4, 1], null, [0, 0])      // 把手（南侧 +z，setPos(0,9,1)，lock 区 uv(0,0)）
  ])
  return { variants: facingVariantsChest(model) }
}

// 站立告示牌：立柱 + 板，rotation 16 方向
// 几何参考 1.20.1 SignModel：板 cuboid(-12,-14,-1,24,12,2) 换算为 [-4,2,7]~[20,14,9]（宽 24 超出方块为原版行为）；
// 立柱 cuboid(-1,-2,-1,2,14,2) 换算为 [7,0,7]~[9,14,9]，与板 z 7~9 对齐
function buildSign (tex, wood) {
  const t = tex(`${wood}_sign`)
  const post = tex(`${wood}_log`)
  const model = makeModel(t, [
    elCuboid(post, [7, 0, 7], [2, 14, 2]),        // 立柱（log 整格，y 0-14）
    elCuboid(t, [-4, 2, 7], [24, 12, 2])          // 告示板（原版尺寸，x -4-20 / y 2-14 / z 7-9 居中）
  ])
  return { variants: rotationVariants(model) }
}

// 墙壁告示牌：贴墙薄板，facing 4 方向（base 朝北贴 -z 墙内侧）
function buildWallSign (tex, wood) {
  const t = tex(`${wood}_sign`)
  const model = makeModel(t, [
    elCuboid(t, [0, 3.5, 15], [16, 9, 1])         // 贴北墙外侧薄板（z 15-16，y 3.5-12.5 板心居中于 8）
  ])
  return { variants: facingVariants(model) }
}

// 吊挂告示牌：吊杆 + 横板，rotation 16 方向
function buildHangingSign (tex, wood) {
  const t = tex(`${wood}_hanging`)
  const model = makeModel(t, [
    elCuboid(t, [6, 10, 6], [4, 6, 4]),           // 吊杆
    elCuboid(t, [1, 0, 1], [14, 10, 14])          // 横板
  ])
  return { variants: rotationVariants(model) }
}

// 墙挂告示牌：贴墙横板，facing 4 方向
function buildWallHangingSign (tex, wood) {
  const t = tex(`${wood}_hanging`)
  const model = makeModel(t, [
    elCuboid(t, [0, 3, 15], [16, 10, 1])          // 贴北墙外侧横板（z 15-16，y 3-13 板心居中于 8）
  ])
  return { variants: facingVariants(model) }
}

// 床：床架 + 床垫 + 床头，facing 4 x part 2（base 头部朝北/-z）
function buildBed (tex, color) {
  const bed = tex(`bed_${color}`)
  const frame = tex(`bed_${color}_frame`)
  const mattress = makeModel(bed, [
    elCuboid(bed, [0, 3, 0], [16, 6, 16]),        // 床垫
    elCuboid(frame, [0, 0, 0], [16, 3, 16])       // 床架
  ])
  const head = makeModel(bed, [
    elCuboid(bed, [0, 3, 0], [16, 6, 16]),
    elCuboid(frame, [0, 0, 0], [16, 3, 16]),
    elCuboid(bed, [0, 3, 0], [16, 7, 2])          // 床头（北端）
  ])
  const v = {}
  for (const facing of ['north', 'east', 'south', 'west']) {
    const rot = { north: 0, east: 90, south: 180, west: 270 }[facing]
    v[`facing=${facing},part=head`] = rot === 0 ? { model: head } : { y: rot, model: head }
    v[`facing=${facing},part=foot`] = rot === 0 ? { model: mattress } : { y: rot, model: mattress }
  }
  return { variants: v }
}

// 旗帜：立柱 + 布面 + 横杆，rotation 16 方向
// 几何参考 1.20.1 BannerModel：flag uv(0,0) cuboid(-10,-2,0,20,40,1)；pole uv(44,0) cuboid(-1,-30,-1,2,42,2)；bar uv(0,42) cuboid(-10,-32,-1,20,2,2)
function buildBanner (tex, color) {
  const t = tex(`banner_${color}`)
  const model = makeModel(t, [
    elCuboid(t, [7, 0, 7], [2, 16, 2], null, [44, 0]),  // 立柱（pole 区）
    elCuboid(t, [6.5, 0, 0.5], [3, 16, 15]),            // 布面（flag 区）
    elCuboid(t, [6, 14, 6], [4, 2, 4], null, [0, 42])   // 横杆（bar 区）
  ])
  return { variants: rotationVariants(model) }
}

// 墙旗：贴墙布面，facing 4 方向
function buildWallBanner (tex, color) {
  const t = tex(`banner_${color}`)
  const model = makeModel(t, [
    elCuboid(t, [6.5, 0, 15], [3, 16, 1])         // 贴北墙外侧（z 15-16）
  ])
  return { variants: facingVariants(model) }
}

// 潜影盒：底盒 + 盖（几何参考 1.20.1 ShulkerEntityModel；关闭状态为完整盒，无凸起元素）
// UV 参考 1.20.1 ShulkerEntityModel：base uv(0,28) cuboid(-8,-8,-8,16,8,16) pivot(0,24,0)；lid uv(0,0) cuboid(-8,-16,-8,16,12,16) pivot(0,24,0)
// 渲染时模型整体平移使 base 贴底：base 绝对 y0~8（8 高）；lid 高 12 顶部对齐方块 y16 → 绝对 y4~16（覆盖 base 上部，同原版盖包盒体）
// 注：head uv(0,52) 为打开状态凸出的头部，关闭时不可见，故不注入
function buildShulker (tex, color) {
  const t = tex(`shulker_${color}`)
  return { variants: { '': { model: makeModel(t, [
    elCuboid(t, [0, 0, 0], [16, 8, 16], null, [0, 28]),   // 底盒（base 区）
    elCuboid(t, [0, 4, 0], [16, 12, 16], null, [0, 0])    // 盖（lid 区 uv(0,0)，高 12）
  ]) } } }
}

// 头颅/骷髅：8x8 立方体，standing rotation 16 / wall facing 4
function buildHead (tex, name) {
  const t = tex(name)
  const model = makeModel(t, [el([4, 0, 4], [12, 8, 12], t)])
  return { variants: rotationVariants(model) }
}

function buildWallHead (tex, name) {
  const t = tex(name)
  const model = makeModel(t, [el([4, 0, 12], [12, 8, 16], t)])  // 贴北墙
  return { variants: facingVariants(model) }
}

// 简单盒：conduit / moving_piston / light / structure_void / barrier 等（texName 指定各自纹理）
function buildBox (tex, texName = 'conduit') {
  const t = tex(texName)
  return { variants: { '': { model: makeModel(t, [el([0, 0, 0], [16, 16, 16], t)]) } } }
}

function buildSmallBox (tex, from, to, texName = 'conduit') {
  const t = tex(texName)
  return { variants: { '': { model: makeModel(t, [el(from, to, t)]) } } }
}

// 切石机：底座 + 刀片。原模型刀片带 tintindex:0 会被 viewer 的 grass 着色染绿，
// 故重写：纹理直接复用原模型在原图集上的 UV（texture-src 无 stonecutter 纹理，注入后图集保留左上，UV 仍有效）
function buildStonecutter (origModel) {
  const t = origModel.textures // { particle, bottom, top, side, saw } 均为已 rescale 的 {u,v,su,sv}
  const base = {
    from: [0, 0, 0],
    to: [16, 9, 16],
    faces: {
      up: { texture: t.top },
      down: { texture: t.bottom },
      north: { texture: t.side },
      south: { texture: t.side },
      east: { texture: t.side },
      west: { texture: t.side }
    }
  }
  const blade = {
    from: [1, 9, 8],
    to: [15, 16, 8],
    faces: { north: { texture: t.saw }, south: { texture: t.saw } } // 仅两面、无 tintindex
  }
  return { variants: facingVariants(makeModel(t.particle, [base, blade])) }
}

// ---------- 主流程：为全部空模型方块注入模型 ----------
// sourceTextures: Map<texName, PNG>（texture-src 中已加载的纹理）
function buildPatchedStates (states, allocator, sourceTextures) {
  rescaleUVs(states) // 全部原 UV ÷4（必须在取原纹理前）
  const fallbackOf = (blockName) =>
    origTextureUV(states, blockName) || origTextureUV(states, 'missing_texture') || { u: 0, v: 0, su: 0.015625, sv: 0.015625 }

  const builders = {}
  builders.chest = (r) => buildChest(r, 'chest_normal')
  builders.trapped_chest = (r) => buildChest(r, 'chest_trapped')
  builders.ender_chest = (r) => buildChest(r, 'chest_ender')
  for (const w of WOODS) {
    builders[`${w}_sign`] = (r) => buildSign(r, w)
    builders[`${w}_wall_sign`] = (r) => buildWallSign(r, w)
    builders[`${w}_hanging_sign`] = (r) => buildHangingSign(r, w)
    builders[`${w}_wall_hanging_sign`] = (r) => buildWallHangingSign(r, w)
  }
  for (const c of COLORS) {
    builders[`${c}_bed`] = (r) => buildBed(r, c)
    builders[`${c}_banner`] = (r) => buildBanner(r, c)
    builders[`${c}_wall_banner`] = (r) => buildWallBanner(r, c)
    builders[`${c}_shulker_box`] = (r) => buildShulker(r, c)
  }
  builders.shulker_box = (r) => buildShulker(r, 'purple') // 无色基础名默认紫色（原版 ShulkerBoxBlock 普通 shulker_box 为 DyeColor.PURPLE）
  for (const h of HEADS) builders[h] = (r) => buildHead(r, h)
  for (const h of HEADS_WALL) builders[h] = (r) => buildWallHead(r, h)
  builders.conduit = (r) => buildBox(r, 'conduit')
  builders.moving_piston = (r) => buildBox(r, 'moving_piston')
  builders.light = (r) => buildSmallBox(r, [6, 6, 6], [10, 10, 10], 'light_15')
  builders.structure_void = (r) => buildBox(r, 'structure_void')
  builders.barrier = (r) => buildBox(r, 'barrier')
  builders.end_portal = (r) => buildSmallBox(r, [0, 0, 0], [16, 1, 16], 'end_portal')
  builders.end_gateway = (r) => buildSmallBox(r, [0, 0, 0], [16, 2, 16], 'end_gateway')
  builders.decorated_pot = (r) => buildSmallBox(r, [1, 0, 1], [15, 14, 15], 'decorated_pot_side')
  builders.pitcher_crop = (r) => buildSmallBox(r, [1, 0, 1], [15, 8, 15], 'pitcher_crop')

  let injected = 0
  const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air'])
  for (const name of Object.keys(states)) {
    if (AIR_BLOCKS.has(name) || name === 'water' || name === 'lava') continue // worker 特判/不渲染
    const s = states[name]
    // stonecutter 强制重写：原模型刀片带 tintindex:0 会被 viewer 的 grass 着色染绿（无需 builders 注册）
    if (name === 'stonecutter') {
      const orig = (s.variants && Object.values(s.variants)[0]) || {}
      states[name] = buildStonecutter(orig.model || orig)
      injected++
      continue
    }
    const builder = builders[name]
    if (!builder) continue
    // 该方块现有模型是否全空
    const hasModel = (v) => {
      const list = Array.isArray(v) ? v : [v]
      return list.some((x) => x && x.model && x.model.elements && x.model.elements.length > 0)
    }
    const alreadyOk = (s.variants && Object.values(s.variants).some(hasModel)) ||
      (s.multipart && s.multipart.some((p) => hasModel(p.apply)))
    if (alreadyOk) continue

    const fb = fallbackOf(name)
    const resolver = (n2) => {
      const spec = TEXTURE_SPECS[n2]
      if (!spec) return fb
      if (allocator.uvs.has(n2)) return allocator.uvs.get(n2)
      if (sourceTextures.has(n2)) {
        const uv = allocator.uv(n2, spec[0], spec[1])
        return uv
      }
      return fb // 无源纹理 → 回退该方块粒子纹理（保证可见）
    }
    states[name] = { variants: builder(resolver).variants }
    injected++
  }
  return injected
}

// ---------- 纹理图集合并 ----------
// 原 512 图集原样放 2048 左上；新纹理按 allocator 布局贴入；返回写入的 PNG
function mergeTextureAtlas (sourceTextures, allocator) {
  const orig = PNG.sync.read(fs.readFileSync(path.join(PUBLIC_DIR, 'textures', `${VERSION}.png`)))
  const canvas = new PNG({ width: NEW_ATLAS_SIZE, height: NEW_ATLAS_SIZE })
  // 原内容复制到左上
  for (let y = 0; y < ORIG_ATLAS_SIZE; y++) {
    for (let x = 0; x < ORIG_ATLAS_SIZE; x++) {
      const si = (orig.width * y + x) * 4
      const di = (canvas.width * y + x) * 4
      canvas.data[di] = orig.data[si]
      canvas.data[di + 1] = orig.data[si + 1]
      canvas.data[di + 2] = orig.data[si + 2]
      canvas.data[di + 3] = orig.data[si + 3]
    }
  }
  // 新纹理贴入
  for (const [name, pos] of allocator.map) {
    const src = sourceTextures.get(name)
    if (!src) continue
    for (let y = 0; y < pos.h && y < src.height; y++) {
      for (let x = 0; x < pos.w && x < src.width; x++) {
        const si = (src.width * y + x) * 4
        const di = (canvas.width * (pos.y + y) + (pos.x + x)) * 4
        canvas.data[di] = src.data[si]
        canvas.data[di + 1] = src.data[si + 1]
        canvas.data[di + 2] = src.data[si + 2]
        canvas.data[di + 3] = src.data[si + 3]
      }
    }
  }
  return canvas
}

// 加载 texture-src 目录下的纹理（<name>.png）
function loadSourceTextures (srcDir) {
  const map = new Map()
  if (!fs.existsSync(srcDir)) return map
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.png')) continue
    const name = f.slice(0, -4)
    try {
      const png = PNG.sync.read(fs.readFileSync(path.join(srcDir, f)))
      map.set(name, png)
    } catch (err) {
      log(`⚠️ 纹理加载失败 ${f}: ${err.message}`)
    }
  }
  return map
}

// 头颅方块原版无方块纹理（几何与贴图由客户端代码动态生成），
// 缺失时程序生成绿色格纹回退（参考掉落物紫色方块的缺省样式）
function ensureHeadTextures (sourceTextures) {
  for (const h of HEADS) {
    if (sourceTextures.has(h)) continue
    const png = new PNG({ width: 16, height: 16 })
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = (16 * y + x) * 4
        const dark = (((x >> 2) + (y >> 2)) & 1) === 0
        png.data[i] = 0
        png.data[i + 1] = dark ? 60 : 120
        png.data[i + 2] = 0
        png.data[i + 3] = 255
      }
    }
    sourceTextures.set(h, png)
  }
}

// ---------- GUI 数据缓冲（单 bot 场景，模块级） ----------
// 业务侧（src/interact.ts）通过 setGuiData({ title, items }) 写入；
// 前端 index.html 注入的内联脚本轮询 GET /api/gui-data 渲染到右上角悬浮窗。
let guiBuffer = null
function setGuiData (data) {
  guiBuffer = { at: Date.now(), ...data }
}

// 注入到 public/index.html </body> 前的内联轮询脚本（相对路径 api/gui-data，兼容 prefix 子路径）
const GUI_POLL_SCRIPT = `<script>
(function () {
  var div = null
  function ensureOverlay () {
    if (div && document.getElementById('gui-data-overlay')) return div
    div = document.createElement('div')
    div.id = 'gui-data-overlay'
    div.style.cssText = 'position:fixed;top:10px;right:10px;z-index:9999;max-width:420px;max-height:70vh;overflow:auto;background:rgba(0,0,0,0.8);color:#e8e8e8;font:12px/1.6 monospace;padding:10px 12px;border:1px solid rgba(255,255,255,0.25);border-radius:6px;white-space:pre-wrap;word-break:break-all;display:none;'
    document.body.appendChild(div)
    return div
  }
  function render (data) {
    var el = ensureOverlay()
    if (!data || !data.title) { el.style.display = 'none'; return }
    var lines = ['[GUI] ' + data.title, '']
    if (data.items && data.items.length) lines = lines.concat(data.items)
    else lines.push('(空)')
    el.textContent = lines.join('\\n')
    el.style.display = 'block'
  }
  function poll () {
    fetch('api/gui-data').then(function (r) { return r.json() }).then(render).catch(function () {})
  }
  setInterval(poll, 1000)
  poll()
})()
</script>`

// ---------- 路由注入（唯一需要替换的第三方接口） ----------
function patchSetupRoutes () {
  const common = require('prismarine-viewer/lib/common')
  if (common.setupRoutes && common.setupRoutes.__viewerPatched) return
  if (typeof common.setupRoutes !== 'function') {
    log('⚠️ prismarine-viewer/lib/common.setupRoutes 非函数，跳过路由注入')
    return
  }
  const orig = common.setupRoutes
  common.setupRoutes = function (app, prefix = '') {
    // GET /：返回注入内联轮询脚本的 index.html（须在 express.static 之前注册，否则静态命中原页）
    app.get(prefix + '/', (req, res) => {
      let html
      try {
        html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
      } catch (err) {
        res.status(500).send('viewer index.html 读取失败: ' + err.message)
        return
      }
      res.type('html').send(html.replace('</body>', GUI_POLL_SCRIPT + '</body>'))
    })
    // GET /api/gui-data：返回 GUI 缓冲 JSON（业务侧 setGuiData 写入）
    app.get(prefix + '/api/gui-data', (req, res) => {
      res.json(guiBuffer)
    })
    // express.static 未命中自动 next，回退到原 public 目录
    app.use(prefix + '/', express.static(VIEWER_ASSETS_DIR))
    orig(app, prefix)
  }
  common.setupRoutes.__viewerPatched = true
}

// ---------- 主入口（幂等，带缓存） ----------
async function ensurePatchedAssets (version = VERSION, opts = {}) {
  const force = !!opts.force
  const srcDir = opts.textureSrcDir || TEXTURE_SRC_DIR
  let generated = false

  const needBlocks = force || !fs.existsSync(BLOCKS_PATCH_FILE)
  const needTexture = force || !fs.existsSync(TEXTURE_PATCH_FILE)
  if (!needBlocks && !needTexture) {
    patchSetupRoutes()
    return false
  }

  const allocator = new UVAllocator()
  const sourceTextures = loadSourceTextures(srcDir)
  ensureHeadTextures(sourceTextures)
  log(`已加载纹理源 ${sourceTextures.size} 个（目录: ${srcDir}）`)

  // 1. blocksStates 补丁
  if (needBlocks) {
    // 注意：不能 require（有模块缓存且 buildPatchedStates 会原地修改），每次全新读取原始数据
    const states = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'blocksStates', `${version}.json`), 'utf8'))
    const t0 = Date.now()
    const injected = buildPatchedStates(states, allocator, sourceTextures)
    fs.mkdirSync(path.dirname(BLOCKS_PATCH_FILE), { recursive: true })
    fs.writeFileSync(BLOCKS_PATCH_FILE, JSON.stringify(states))
    log(`✅ blocksStates 补丁已生成: 注入 ${injected} 个方块模型 (${Date.now() - t0}ms) -> ${BLOCKS_PATCH_FILE}`)
    generated = true
  }

  // 2. 纹理图集
  if (needTexture) {
    const canvas = mergeTextureAtlas(sourceTextures, allocator)
    fs.mkdirSync(path.dirname(TEXTURE_PATCH_FILE), { recursive: true })
    fs.writeFileSync(TEXTURE_PATCH_FILE, PNG.sync.write(canvas))
    log(`✅ 纹理图集已生成: ${NEW_ATLAS_SIZE}x${NEW_ATLAS_SIZE} -> ${TEXTURE_PATCH_FILE}`)
    generated = true
  }

  patchSetupRoutes()
  return generated
}

module.exports = {
  ensurePatchedAssets,
  patchSetupRoutes,
  setGuiData,
  VIEWER_ASSETS_DIR,
  BLOCKS_PATCH_FILE,
  TEXTURE_PATCH_FILE,
  TEXTURE_SRC_DIR
}
