// mesh-worker.js —— 浏览器 Web Worker：持有世界镜像并在 Worker 内构建几何（transferable 回传）
//
// 线程职责分离（与 prismarine-viewer 的 worker 节奏一致）：
//   - 镜像（world-mirror.js）与 stateId 解码只存在 Worker：主线程不碰 JSON/状态数据。
//   - 每 50ms 批量处理 dirty section（≤4 个/批，参考 prismarine-viewer 的 50ms 节拍），
//     几何数组转 TypedArray 后以 transferable 交给主线程直接建 BufferGeometry。
//
// 主 ⇄ Worker 协议：
//   主 → Worker
//     {type:'init', viewDistance}          —— 触发 Worker 自取 /api/blocksStateMeta + /api/blocksStates
//     {type:'center', x,y,z}               —— bot 中心（重算矩形：新列 need-column / 过期列 remove-column）
//     {type:'column', cx,cz}               —— 服务端 SSE column 通知（可能代表列刚就绪，可重试空列）
//     {type:'chunk', cx,cz, buffer:<AB>}   —— /chunk 响应（transfer）
//     {type:'chunk-empty', cx,cz}          —— /chunk 空体（服务端列未就绪 → 记录，等 column 通知重试）
//     {type:'block', x,y,z,stateId}        —— SSE block 通知
//     {type:'rebuild', ao}                 —— AO/重建（全量重算现有几何）
//     {type:'query', id, x,y,z}            —— 悬停块名查询
//   Worker → 主
//     {type:'ready'}
//     {type:'need-column', cx,cz}          —— 主线程 fetch /chunk 后回传 chunk/chunk-empty
//     {type:'remove-column', cx,cz}        —— 主线程卸载对应 Mesh 与几何
//     {type:'geometry', key, origin, positions,normals,colors,uvs,opaqueIdx,alphaIdx}  (全部 transfer)
//        opaqueIdx/alphaIdx：渲染核心把三角按"方块是否半透明"分装成两组，页面据此拆两个 mesh
//     {type:'gone', key}                   —— 该 section 现无几何（清空/全空），主线程移除 Mesh
//     {type:'blockinfo', id, name, x,y,z}  —— 悬停查询应答
//     {type:'stats', dirty, columns, sections}
'use strict'

import { createStateDecoder, MirrorWorld } from './world-mirror.js'
import { buildSectionGeometry } from './index.js'

let decoder = null
let mirror = null
let blocksStates = null

let center = { x: 0, y: 64, z: 0 }
let viewDistance = 6
let doAO = true
const biome = 'plains'

const requested = new Map() // key "cx,cz" → true（已请求 /chunk，等待响应）
const emptyCols = new Set() // key → 服务端列未就绪（空响应），等 column 通知/定时重试
const dirty = new Map() // key "cx,cz/si" → {cx,cz,si,origin}
const geoKeys = new Map() // key → true（当前已交主线程的几何）

const keyC = (cx, cz) => `${cx},${cz}`
const keyS = (cx, cz, si) => `${cx},${cz}/${si}`

function post (type, data = {}, transfer) {
  self.postMessage(Object.assign({ type }, data), transfer || [])
}

// ---------------- 工具 ----------------

function parseChunkCenter () {
  return { x: Math.floor(center.x / 16), z: Math.floor(center.z / 16) }
}

function inRect (cx, cz, cch, margin = 0) {
  const r = viewDistance + margin
  return Math.abs(cx - cch.x) <= r && Math.abs(cz - cch.z) <= r
}

/**
 * 由内向外列出矩形内全部目标列（近处优先）。
 * NOTE(2026-09-05 bugfix)：旧实现按"双环配对"枚举，(x∈(−rad,rad), z=±rad) 的
 * 上/下边中段列不会被推入 → 视距 6 时仅枚举 107/169 列、漏 62 列，漏列呈菱状空洞
 * 且永不加载（handleCenter 只会请求本函数返回的列）。改为全矩形逐列枚举 + 距离排序。
 */
function desiredColumns () {
  const c = parseChunkCenter()
  const r = viewDistance
  const list = []
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      list.push([c.x + dx, c.z + dz])
    }
  }
  // 由内向外（Manhattan 距离），近处列先请求，加载更平滑
  list.sort((a, b) => {
    const da = Math.abs(a[0] - c.x) + Math.abs(a[1] - c.z)
    const db = Math.abs(b[0] - c.x) + Math.abs(b[1] - c.z)
    return da - db
  })
  return list
}

/** 处理 center：请求缺失列，卸载超出矩形(含 margin)的列 */
function handleCenter () {
  for (const [cx, cz] of desiredColumns()) {
    if (mirror.hasColumn(cx, cz) || requested.has(keyC(cx, cz))) continue
    requested.set(keyC(cx, cz), true)
    post('need-column', { cx, cz })
  }
  // 清理过期
  for (const key of [...mirror.columns.keys()]) {
    const [cx, cz] = key.split(',').map(Number)
    if (inRect(cx, cz, parseChunkCenter(), 1)) continue
    const removed = mirror.removeColumn(cx, cz)
    if (!removed) continue
    requested.delete(key)
    emptyCols.delete(key)
    for (const si of removed.siKeys) dirty.delete(keyS(cx, cz, si))
    for (const gk of [...geoKeys.keys()]) if (gk.startsWith(key + '/')) geoKeys.delete(gk)
    post('remove-column', { cx, cz })
  }
}

function markSectionDirty (cx, cz, si) {
  const col = mirror.getColumn(cx, cz)
  if (!col) return
  const key = keyS(cx, cz, si)
  dirty.set(key, { cx, cz, si, origin: { x: cx * 16, y: col.minY + si * 16, z: cz * 16 } })
}

/** 整列 dirty：新旧 section 并集（覆盖"列更新后某些 section 变空"的情形） */
function markColumnDirty (cx, cz, extraSi = []) {
  const col = mirror.getColumn(cx, cz)
  if (!col) return
  const sis = new Set([...extraSi, ...col.sections.keys()])
  for (const si of sis) markSectionDirty(cx, cz, si)
  // 若该列之前有几何、但列数据全空（无 section），也把旧几何 key 标 dirty 以便触发 gone
  for (const gk of geoKeys.keys()) {
    if (gk.startsWith(keyC(cx, cz) + '/')) {
      const si = Number(gk.split('/')[1])
      if (!col.sections.has(si)) markSectionDirty(cx, cz, si)
    }
  }
}

// ---------------- 建几何 ----------------

function flushDirty () {
  if (!mirror || !blocksStates || dirty.size === 0) return
  const keys = [...dirty.keys()]
  const batch = Math.min(4, keys.length)
  for (let n = 0; n < batch; n++) {
    const key = keys[n]
    const item = dirty.get(key)
    dirty.delete(key)
    if (!item) continue
    let attr = null
    try {
      attr = buildSectionGeometry(item.origin, mirror, blocksStates, { doAO, biome })
    } catch (err) {
      console.error(`[mesh-worker] section ${key} 几何失败:`, err)
      post('geometry-error', { key, message: (err && err.message) || String(err) })
    }
    if (attr && attr.positions.length) {
      const positions = new Float32Array(attr.positions)
      const normals = new Float32Array(attr.normals)
      const colors = new Float32Array(attr.colors)
      const uvs = new Float32Array(attr.uvs)
      // 渲染核心已按方块是否半透明把三角分装；页面据此拆"不透明/alpha 混合"两个 mesh。
      // 空数组也随消息传递（纯不透明 section 的 alphaIdx 为空），页面据此只建需要的部分。
      const opaqueIdx = new Uint32Array(attr.opaqueIndices || [])
      const alphaIdx = new Uint32Array(attr.alphaIndices || [])
      geoKeys.set(key, true)
      post('geometry', { key, origin: item.origin, positions, normals, colors, uvs, opaqueIdx, alphaIdx },
        [positions.buffer, normals.buffer, colors.buffer, uvs.buffer, opaqueIdx.buffer, alphaIdx.buffer])
    } else if (geoKeys.has(key)) {
      geoKeys.delete(key)
      post('gone', { key })
    }
  }
  postStats()
}

function postStats () {
  const s = mirror ? mirror.stats() : { columns: 0, sections: 0 }
  post('stats', { dirty: dirty.size, columns: s.columns, sections: s.sections })
}

// ---------------- 消息分发 ----------------

self.onmessage = ({ data }) => {
  if (!data || !data.type) return
  const t = data.type
  if (t === 'init') {
    viewDistance = data.viewDistance || 6
    initWorker()
  } else if (t === 'center') {
    center = { x: data.x, y: data.y, z: data.z }
    if (mirror) handleCenter()
  } else if (t === 'column') {
    // 服务端可能广播列就绪：若曾收到空体（列未就绪）且仍在视口内，重试拉取
    const key = keyC(data.cx, data.cz)
    if (emptyCols.has(key) && inRect(data.cx, data.cz, parseChunkCenter()) && !requested.has(key)) {
      emptyCols.delete(key)
      requested.set(key, true)
      post('need-column', { cx: data.cx, cz: data.cz })
    }
  } else if (t === 'chunk') {
    const key = keyC(data.cx, data.cz)
    requested.delete(key)
    emptyCols.delete(key)
    const old = mirror.getColumn(data.cx, data.cz)
    const oldSi = old ? [...old.sections.keys()] : []
    const ok = mirror.applyColumnBuffer(data.cx, data.cz, data.buffer)
    if (ok) markColumnDirty(data.cx, data.cz, oldSi)
    else emptyCols.add(key) // 空体：列尚未就绪
  } else if (t === 'chunk-empty') {
    const key = keyC(data.cx, data.cz)
    requested.delete(key)
    emptyCols.add(key)
  } else if (t === 'chunk-failed') {
    // 主线程对 /chunk 的有限次重试已耗尽：清 requested 并记入 emptyCols，
    // 交给 4s 定时兜底重试自愈——否则该列卡在 requested 里永不再次请求。
    const key = keyC(data.cx, data.cz)
    requested.delete(key)
    emptyCols.add(key)
  } else if (t === 'block') {
    const res = mirror && mirror.applyBlock(data.x, data.y, data.z, data.stateId)
    if (res) markSectionDirty(res.cx, res.cz, res.si)
  } else if (t === 'rebuild') {
    doAO = data.ao !== false
    if (!mirror) return
    // 全量重算：把已有几何全部标 dirty
    for (const gk of geoKeys.keys()) {
      const [cx, cz, si] = gk.split('/')
      markSectionDirty(Number(cx), Number(cz), Number(si))
    }
    flushDirty()
  } else if (t === 'query') {
    const res = mirror ? mirror.queryBlock(data.x, data.y, data.z) : null
    if (res) post('blockinfo', { id: data.id, name: res.name, x: res.x, y: res.y, z: res.z })
    else post('blockinfo', { id: data.id, name: null, x: data.x, y: data.y, z: data.z })
  }
}

async function initWorker () {
  try {
    const [metaRes, statesRes] = await Promise.all([
      fetch('/api/blocksStateMeta').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() }),
      fetch('/api/blocksStates').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
    ])
    decoder = createStateDecoder(metaRes)
    mirror = new MirrorWorld(decoder)
    blocksStates = statesRes
    post('ready')
    if (center.x !== 0 || center.z !== 0) handleCenter()
  } catch (err) {
    post('error', { message: `worker 数据加载失败: ${err.message}` })
  }
}

// 每 50ms 处理一批 dirty section（近实时的同时给主线程让出帧时间）
setInterval(flushDirty, 50)
// 空列兜底重试：错过 SSE column 通知时也能自愈（4s）
setInterval(() => {
  if (!mirror || emptyCols.size === 0) return
  const c = parseChunkCenter()
  for (const key of [...emptyCols]) {
    const [cx, cz] = key.split(',').map(Number)
    if (Math.abs(cx - c.x) <= viewDistance && Math.abs(cz - c.z) <= viewDistance && !requested.has(key)) {
      emptyCols.delete(key)
      requested.set(key, true)
      post('need-column', { cx, cz })
    }
  }
}, 4000)
