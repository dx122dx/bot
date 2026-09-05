// world-mirror.js —— 浏览器世界镜像：把服务器下发的列二进制解码为可查询的方块世界
//
// 镜像职责（只做一件事：状态数据查询）：
//   - 接收 chunk-stream.js 的自研二进制（"LV" magic）→ 解码为 per-column / per-section 的
//     Uint16 stateId 数组（与 prismarine-chunk 内部布局一致：idx=(y<<8)|(z<<4)|x）。
//   - getBlock(x,y,z) → BlockDescriptor|null：为渲染核心提供 cullface/AO/主块查询，
//     返回字段与 constants.js BlockDescriptor 一致（name/props/isCube/transparent/y）。
//   - stateId → (name,props) 用 /api/blocksStateMeta 解码；isCube/transparent 直接来自
//     meta 里的方块级 t/c 字段（服务端用 minecraft-data blocksByName + blockCollisionShapes
//     计算，等价 prismarine-viewer world.js 的 isCube 判定）。
//   - 列未加载返回 null（渲染核心会保留该面）；列已加载但某 section 全 air（header 省略）
//     视为全 0（air 描述）。空 header（count=0）表示服务器确认"列已载入但全空"。
//
// 本文件零浏览器 API 依赖，Node 断言亦可 import（用于链路回归）。
'use strict'

const SECTION_VOLUME = 4096
const WORLD_HEIGHT = 384 // 1.20.1 主世界
const AIR_DESC = Object.freeze({ name: 'air', props: {}, isCube: false, transparent: true, y: null })

function computeStateLength (stateDecls) {
  let n = 1
  for (const s of stateDecls) n *= s[2]
  return n
}

/**
 * 由 /api/blocksStateMeta 的 JSON 构造 stateId → 描述缓存解码器。
 * 属性数值编码与 prismarine-block 一致：data=stateId−mn，自末个声明属性开始逐位取模
 * （data % num_values），因此解码反向同样从末属性开始。
 */
export function createStateDecoder (meta) {
  const blocks = meta.blocks.slice().sort((a, b) => a.mn - b.mn)
  const nState = (meta.maxStateId || 0) + 1
  const blockOfState = new Array(nState).fill(-1)
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const len = computeStateLength(b.s)
    if (b.mn + len - 1 < nState) {
      blockOfState.fill(i, b.mn, b.mn + len)
    }
  }
  const nameRecord = new Map() // name → {t,c}
  for (const b of blocks) nameRecord.set(b.n, b)

  /** 描述缓存：按 stateId 缓存 name/props/isCube/transparent；y 由调用方现场补（同步单线程安全） */
  const descCache = new Map()

  function decodeProps (b, data) {
    const props = {}
    let d = data
    const s = b.s
    for (let i = s.length - 1; i >= 0; i--) {
      const decl = s[i]
      const num = decl[2]
      const v = d % num
      d = (d - v) / num
      let value
      if (decl[1] === 'bool') value = v === 0 ? 'true' : 'false'
      else value = decl[3] ? decl[3][v] : String(v)
      props[decl[0]] = value
    }
    return props
  }

  function decode (stateId) {
    let cached = descCache.get(stateId)
    if (cached) return cached
    const i = blockOfState[stateId]
    let desc
    if (i >= 0) {
      const b = blocks[i]
      desc = {
        name: b.n,
        props: decodeProps(b, stateId - b.mn),
        isCube: b.c === true,
        transparent: b.t === true,
        y: null
      }
    } else {
      desc = { name: 'unknown', props: {}, isCube: false, transparent: true, y: null }
    }
    descCache.set(stateId, desc)
    return desc
  }

  function isAirState (stateId) {
    const i = blockOfState[stateId]
    if (i < 0) return false
    return blocks[i].n === 'air'
  }

  return { meta, blocks, blockOfState, nameRecord, decode, isAirState }
}

/** 一个 16×16×16 section 的镜像：Uint16Array(SECTION_VOLUME)，索引=(y<<8)|(z<<4)|x */
export class MirrorSection {
  constructor (si, minY) {
    this.si = si
    this.minY = minY // 该 section 的全局最小 Y = 列 minY + si*16
    this.data = new Uint16Array(SECTION_VOLUME)
  }
}

export class MirrorColumn {
  constructor (cx, cz, minY) {
    this.cx = cx
    this.cz = cz
    this.minY = minY
    this.sections = new Map() // si → MirrorSection
    this.loaded = false
  }

  /** 本地 section 下标 = (y−minY)/16，供调用方取 si */
  siAt (y) {
    const si = (y - this.minY) / 16
    return Number.isInteger(si) ? si : Math.floor(si)
  }
}

/**
 * 世界镜像。
 * 注：镜像区只含"已从服务器拉到的列"；对越界/未拉取邻居返回 null，
 * 使渲染核心在 chunk 边缘保留外露面（与 prismarine-viewer 行为一致）。
 */
export class MirrorWorld {
  constructor (decoder) {
    this.decoder = decoder
    this.columns = new Map() // key `${cx},${cz}` → MirrorColumn
  }

  key (cx, cz) { return `${cx},${cz}` }

  hasColumn (cx, cz) { return this.columns.has(this.key(cx, cz)) }

  getColumn (cx, cz) { return this.columns.get(this.key(cx, cz)) || null }

  removeColumn (cx, cz) {
    const col = this.columns.get(this.key(cx, cz))
    if (!col) return null
    const siKeys = [...col.sections.keys()]
    this.columns.delete(this.key(cx, cz))
    return { cx, cz, siKeys }
  }

  /**
   * 解码整列二进制（chunk-stream.js 格式）。
   * @param {number} cx
   * @param {number} cz
   * @param {Uint8Array|ArrayBuffer} buf  整列字节（>=6 即已加载；<6 视为"未加载"，返回 false）
   * @returns {boolean} 是否成功载入该列（含空列）
   */
  applyColumnBuffer (cx, cz, buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    if (!b || b.length < 6) return false
    if (b[0] !== 0x4c || b[1] !== 0x56) return false
    const minY = (b[3] | (b[4] << 8)) << 16 >> 16 // int16LE
    const count = b[5]
    let col = this.getColumn(cx, cz)
    if (!col) {
      col = new MirrorColumn(cx, cz, minY)
      this.columns.set(this.key(cx, cz), col)
    } else {
      col.minY = minY
      col.sections.clear()
    }
    col.loaded = true
    let off = 6
    for (let k = 0; k < count && off + 1 + SECTION_VOLUME * 2 <= b.length; k++) {
      const si = b[off++]
      const section = new MirrorSection(si, minY + si * 16)
      // 偏移可能非 2 对齐（6 + k*(1+8192) 奇数），不能直接用 Uint16Array 子视图；逐字节组装
      const end = off + SECTION_VOLUME * 2
      let i = 0
      for (let p = off; p < end; p += 2) {
        section.data[i++] = b[p] | (b[p + 1] << 8)
      }
      col.sections.set(si, section)
      off = end
    }
    return true
  }

  /** 单格更新（SSE block 事件）。列/section 尚未载入则跳过（整列到达时全量覆盖）。 */
  applyBlock (x, y, z, stateId) {
    const cx = Math.floor(x / 16)
    const cz = Math.floor(z / 16)
    const col = this.getColumn(cx, cz)
    if (!col || !col.loaded) return null
    const si = col.siAt(y)
    if (si < 0 || si >= WORLD_HEIGHT / 16) return null
    let section = col.sections.get(si)
    if (!section) {
      if (stateId === 0) return null // 空 section 视为全 0，无必要新建
      section = new MirrorSection(si, col.minY + si * 16)
      col.sections.set(si, section)
    }
    const lx = x - cx * 16
    const lz = z - cz * 16
    const ly = y - (col.minY + si * 16)
    section.data[(ly << 8) | (lz << 4) | lx] = stateId
    return { cx, cz, si }
  }

  /**
   * 取方块描述（渲染核心专用；列内全空也返回 air 描述而非 null）。
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {object|null}
   */
  getBlock (x, y, z) {
    const col = this.getColumn(Math.floor(x / 16), Math.floor(z / 16))
    if (!col || !col.loaded) return null
    const si = col.siAt(y)
    if (si < 0 || si >= WORLD_HEIGHT / 16) return null
    const section = col.sections.get(si)
    if (!section) return AIR_DESC
    const lx = x - col.cx * 16
    const lz = z - col.cz * 16
    const ly = y - (col.minY + si * 16)
    const stateId = section.data[(ly << 8) | (lz << 4) | lx]
    if (stateId === 0) return AIR_DESC
    const desc = this.decoder.decode(stateId)
    desc.y = y
    return desc
  }

  /** 悬停/坐标查询：返回可显示的 {name,x,y,z}（供 tooltip；air 返回 null） */
  queryBlock (x, y, z) {
    const col = this.getColumn(Math.floor(x / 16), Math.floor(z / 16))
    if (!col || !col.loaded) return null
    const si = col.siAt(y)
    if (si < 0 || si >= WORLD_HEIGHT / 16) return null
    const section = col.sections.get(si)
    if (!section) return null
    const lx = x - col.cx * 16
    const lz = z - col.cz * 16
    const ly = y - (col.minY + si * 16)
    const stateId = section.data[(ly << 8) | (lz << 4) | lx]
    if (stateId === 0) return null
    const desc = this.decoder.decode(stateId)
    return { name: desc.name, x, y, z }
  }

  /** 返回已加载列内所有 (cx,cz) 键（供重建/统计） */
  loadedColumnKeys () {
    return [...this.columns.keys()]
  }

  /** 统计：已加载列数 / 已建 section 数 / 总非空格数（估算，供 HUD 数字缓动） */
  stats () {
    let sections = 0
    let cells = 0
    for (const col of this.columns.values()) {
      for (const s of col.sections.values()) {
        sections++
        for (let i = 0; i < SECTION_VOLUME; i++) if (s.data[i] !== 0) cells++
      }
    }
    return { columns: this.columns.size, sections, cells }
  }
}
