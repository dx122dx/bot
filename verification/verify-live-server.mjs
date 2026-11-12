#!/usr/bin/env node
/*
 * verify-live-server.mjs —— 实时链路无头冒烟（e2e 收缩为可复跑回归）
 *
 * 覆盖链路（真实 prismarine-registry 数据，无 bot/浏览器依赖）：
 *   prismarine-registry(1.20.1) → LiveServer / chunk-stream 自研二进制
 *     → HTTP(/api/info · /api/blocksStateMeta · /api/tints · /chunk gzip · /api/blocksStates)
 *     → MirrorWorld 解码(stateId→name/props/isCube/transparent)
 *     → viewer-core buildSectionGeometry（渲染核心与浏览器同源，含液体分区）
 *
 * 跑法： node verification/verify-live-server.mjs
 * 退出码：0 通过 / 1 任一断言失败 / 2 运行错误
 */
'use strict'

import { EventEmitter } from 'node:events'
import path from 'node:path'
import { ChunkStream } from '../src/viewer-server/chunk-stream.js'
import { LiveServer } from '../src/viewer-server/server.js'
import { createStateDecoder, MirrorWorld } from '../src/viewer-core/world-mirror.js'
import { buildSectionGeometry } from '../src/viewer-core/index.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

// ---------------------------------------------------------------- 合成世界
const DATA_COL = { cx: 1, cz: 1 } // si=8 全 stone + 单格 chest(facing=north)
const CHEST = { lx: 3, ly: 3, lz: 5 }
function dataChunk (stoneId, chestId) {
  const sections = []
  for (let i = 0; i < 24; i++) sections.push({ isEmpty: () => true, data: { get: () => 0 } })
  sections[8] = {
    isEmpty: () => false,
    data: {
      get (i) {
        const ly = i >> 8; const lz = (i >> 4) & 15; const lx = i & 15
        return (lx === CHEST.lx && ly === CHEST.ly && lz === CHEST.lz) ? chestId : stoneId
      }
    }
  }
  return { minY: -64, numSections: 24, sections }
}
function emptyChunk () {
  const sections = []
  for (let i = 0; i < 24; i++) sections.push({ isEmpty: () => true, data: { get: () => 0 } })
  return { minY: -64, numSections: 24, sections }
}

class FakeWorld extends EventEmitter {
  constructor () {
    super()
    this.center = { x: 19.5, y: 67, z: 21.5 }
    this._data = null // 数据列（si=8 全 stone + 单 chest），stateId 依赖 meta 后填充
    this._empty = emptyChunk()
  }
  getLoadedColumn (cx, cz) {
    if (cx === DATA_COL.cx && cz === DATA_COL.cz) return this._data
    if (cx === 0 && cz === 0) return this._empty
    return null
  }
}

async function main () {
  let stoneId, chestId, glassId, meta
  const world = new FakeWorld()

  const stream = new ChunkStream({ world })
  const server = new LiveServer({
    stream,
    cwd: process.cwd(),
    assetDir: path.join(process.cwd(), 'viewer-assets'),
    version: '1.20.1',
    biome: 'plains',
    viewDistance: 6,
    getCenter: () => world.center
  })
  const port = await server.listen(0)
  const base = `http://127.0.0.1:${port}`

  try {
    // 1) info（含 center 快照）
    const info = await (await fetch(`${base}/api/info`)).json()
    check('info 端点', info.version === '1.20.1' && info.biome === 'plains' && info.viewDistance === 6, `version=${info.version} center=${JSON.stringify(info.center)}`)

    // 2) meta：per-block t/c 语义
    meta = await (await fetch(`${base}/api/blocksStateMeta`)).json()
    check('meta 端点', meta.blocks && meta.blocks.length >= 900, `blocks=${meta.blocks && meta.blocks.length} maxStateId=${meta.maxStateId}`)
    const rec = (n) => meta.blocks.find((b) => b.n === n)
    const stone = rec('stone'); const chest = rec('chest'); const glass = rec('glass')
    check('meta 语义字段', stone && stone.c === true && stone.t === false, `stone c=${stone && stone.c} t=${stone && stone.t}`)
    check('meta 语义字段(chest/glass)', chest && chest.c === false && glass && glass.t === true, `chest c=${chest && chest.c} glass t=${glass && glass.t}`)
    stoneId = stone.mn; chestId = chest.mn; glassId = glass.mn

    // 3) 数据列 /chunk → 镜像解码
    world._data = dataChunk(stoneId, chestId)
    const colBuf = await (await fetch(`${base}/chunk?cx=${DATA_COL.cx}&cz=${DATA_COL.cz}`)).arrayBuffer()
    const decoder = createStateDecoder(meta)
    const mirror = new MirrorWorld(decoder)
    const applied = mirror.applyColumnBuffer(DATA_COL.cx, DATA_COL.cz, colBuf)
    check('chunk 二进制(数据列)', applied && colBuf.byteLength >= 6, `bytes=${colBuf.byteLength}`)
    check('镜像载入 section 数', mirror.stats().sections === 1, `sections=${mirror.stats().sections}`)

    const chestX = DATA_COL.cx * 16 + CHEST.lx
    const chestY = -64 + 8 * 16 + CHEST.ly
    const chestZ = DATA_COL.cz * 16 + CHEST.lz
    const c = mirror.getBlock(chestX, chestY, chestZ)
    check('stateId→方块(chest)', c && c.name === 'chest', `name=${c && c.name}`)
    check('stateId→props(facing=north)', c && c.props.facing === 'north', `facing=${c && c.props.facing}`)
    const s = mirror.getBlock(chestX + 1, chestY, chestZ)
    check('stateId→方块(stone/cube)', s && s.name === 'stone' && s.isCube === true, `name=${s && s.name} cube=${s && s.isCube}`)
    const a = mirror.getBlock(chestX, chestY + 13, chestZ) // y=80 属未建 section（全空）
    check('未建 section 视作 air', a && a.name === 'air' && a.transparent === true, `name=${a && a.name}`)
    check('查询未加载列返回 null', mirror.getBlock(-5 * 16, 64, 0) === null)

    // 4) 单格更新（block 事件路径）
    const upY = chestY + 1
    const res = mirror.applyBlock(chestX, upY, chestZ, glassId)
    const g = mirror.getBlock(chestX, upY, chestZ)
    check('applyBlock 单格更新', res && res.si === 8 && g && g.name === 'glass' && g.isCube === true, `name=${g && g.name}`)

    // 5) 全空列 / 缺列
    const emptyBuf = await (await fetch(`${base}/chunk?cx=0&cz=0`)).arrayBuffer()
    check('chunk 全空列(6B 头)', emptyBuf.byteLength === 6, `bytes=${emptyBuf.byteLength}`)
    check('chunk 缺列(0B)', (await (await fetch(`${base}/chunk?cx=-3&cz=3`)).arrayBuffer()).byteLength === 0)

    // 5.1) WorldSync 形态回归：mineflayer 的 bot.world = prismarine-world .sync 代理，
    //      只暴露同步 getColumn（无 getLoadedColumn），且 getColumn 即 async.getLoadedColumn。
    //      曾因调用不存在的 getLoadedColumn 导致整列静默 0 字节（实机全黑根因）。
    const holder = { data: world._data, empty: world._empty }
    const syncLike = new EventEmitter() // 不继承 FakeWorld（其上无 getLoadedColumn 方法）
    syncLike.getColumn = (cx, cz) => {
      if (cx === DATA_COL.cx && cz === DATA_COL.cz) return holder.data
      if (cx === 0 && cz === 0) return holder.empty
      return null
    }
    const syncStream = new ChunkStream({ world: syncLike })
    const syncBuf = syncStream.serializeColumn(DATA_COL.cx, DATA_COL.cz)
    check('WorldSync 形态(world.getColumn) 数据列', syncBuf && syncBuf.byteLength >= 6, `bytes=${syncBuf && syncBuf.byteLength}`)
    check('WorldSync 形态缺列 → null', syncStream.serializeColumn(-3, 3) === null)

    // 6) 着色器模块可被静态路由访问（viewer-live.html 直接 import 该路径）
    const matRes = await fetch(`${base}/src/viewer-web/materials.js`)
    check('着色器模块静态可达', matRes.ok && (await matRes.text()).includes('ShaderMaterial'), `status=${matRes.status}`)

    // 6.1) blocksStates 静态数据可达（浏览器 Worker 用）
    const statesRes = await fetch(`${base}/api/blocksStates`)
    const statesJson = await statesRes.json()
    const stVariants = statesJson.stone && statesJson.stone.variants
    check('blocksStates 端点', statesRes.ok && stVariants && typeof stVariants === 'object' && Object.keys(stVariants).length >= 1, `stone variants keys=${stVariants ? Object.keys(stVariants).length : 0}`)

    // 6.2) /api/tints：调色板按版本数据解析；草地必须真的是绿色（回归「草地近白/无色」）
    const tints = await (await fetch(`${base}/api/tints`)).json()
    const [gr, gg, gb] = tints.grass || []
    check('tints 端点(grass 绿色)', tints.version === '1.20.1' && tints.biome === 'plains' && gg > gr && gr > gb && gg > 0.6,
      `grass=${(tints.grass || []).map((v) => v.toFixed(3)).join(',')}`)
    check('tints 端点(redstone/constant)', Array.isArray(tints.redstone) && tints.redstone.length === 16 && tints.constant && tints.constant.birch_leaves,
      `redstone=${tints.redstone && tints.redstone.length} constant=${tints.constant ? Object.keys(tints.constant).length : 0}`)
    check('tints 端点(water)', Array.isArray(tints.water) && tints.water.length === 3,
      `water=${(tints.water || []).map((v) => v.toFixed(3)).join(',')}`)

    // 7) 渲染核心从镜像建几何（与浏览器 Worker 同源调用）：stone 基底 + chest 部件，顶点必须成对
    const sectionOrigin = { x: DATA_COL.cx * 16, y: 64, z: DATA_COL.cz * 16 }
    const geo = buildSectionGeometry(sectionOrigin, mirror, statesJson, { doAO: true, palette: tints })
    const verts = geo.positions.length / 3
    const tris = geo.indices.length / 3
    check('渲染核心从镜像产几何', verts > 1500 && verts === tris * 2, `verts=${verts} tris=${tris}`)

    // 7.1) 液体：把 section 顶层一格替换成水源（上方为空 section），应只产出一个朝上的水面
    const waterId = rec('water').mn
    const wx = DATA_COL.cx * 16 + 6
    const wy = -64 + 8 * 16 + 15
    const wz = DATA_COL.cz * 16 + 6
    mirror.applyBlock(wx, wy, wz, waterId)
    const geoWet = buildSectionGeometry(sectionOrigin, mirror, statesJson, { doAO: true, palette: tints })
    check('液体几何进入 waterIndices', !!geoWet && geoWet.waterIndices.length === 6,
      `waterIdx=${geoWet && geoWet.waterIndices.length}（1 个顶面 = 6 索引）`)
    check('液体不污染不透明分区', !!geoWet && geoWet.opaqueIndices.length > 0 && geoWet.lavaIndices.length === 0,
      `opaqueIdx=${geoWet && geoWet.opaqueIndices.length} lavaIdx=${geoWet && geoWet.lavaIndices.length}`)
  } finally {
    await server.close()
  }

  console.log(failures === 0 ? '\nALL LIVE-SERVER SMOKE PASSED' : `\n${failures} 项断言失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`[ERROR] ${err.stack || err}`)
  process.exit(2)
})
