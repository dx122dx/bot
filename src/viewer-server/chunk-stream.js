// chunk-stream.js —— 实时区块数据流（Node 侧）：订阅 bot.world 事件 → 自研二进制序列化
//
// 设计要点：
//   - 直接监听 prismarine-world（bot.world）的事件（chunkColumnLoad 传列角点、
//     blockUpdate 传 Block 对），避免 mineflayer bot 事件转发带来的语义不确定性。
//   - 传输格式是"展开成逐格协议 stateId"的自研二进制，而非 prismarine-chunk 的
//     palette 压缩序列：客户端不需要 prismarine 家族（零浏览器依赖）即可还原世界镜像；
//     stateId→(方块名,属性) 由 /api/blocksStateMeta（镜像 prismarine-block 编码顺序）还原。
//   - 每格 stateId 用 16 位（1.20.1 最大 stateId=24134 < 65535）；blockIndex 采用
//     prismarine-chunk 的 y-major 布局 index=(y<<8)|(z<<4)|x，与 PaletteChunkSection
//     内部下标一致，可直接读 section.data.get(index) 免逐格对象分配。
//
// 二进制格式（整列一次）：
//   magic "LV" u8[2] | version u8 | minY int16 | 非空 section 数 u8
//   之后每非空 section：si u8 | 4096 × u16LE(stateId)
//
// 事件（extends EventEmitter，live-view.js/server.js 消费）：
//   'column'   { cx, cz }                  —— 该列已载入/更新，客户端应 fetch /chunk
//   'block'    { x, y, z, stateId }        —— 单格更新（客户端只重排对应 section）
//   'center'   { x, y, z }                 —— bot 中心移动（客户端据此重算视口）
'use strict'

import { EventEmitter } from 'node:events'

const SECTION_VOLUME = 4096
export const CHUNK_MAGIC = Buffer.from('LV', 'utf8')

export class ChunkStream extends EventEmitter {
  /**
   * @param {{world: object}} deps  deps.world 为 prismarine-world 实例（bot.world）
   */
  constructor ({ world }) {
    super()
    this.world = world
    this.attached = false
    this._onColumn = null
    this._onBlock = null
  }

  attach () {
    if (this.attached) return
    this.attached = true
    this._onColumn = (corner) => {
      this.emit('column', { cx: Math.floor(corner.x / 16), cz: Math.floor(corner.z / 16) })
    }
    this._onBlock = (oldBlock, newBlock) => {
      const block = newBlock || oldBlock
      if (!block || !block.position) return
      const stateId = Number.isInteger(block.stateId) ? block.stateId : 0
      this.emit('block', { x: block.position.x, y: block.position.y, z: block.position.z, stateId })
    }
    this.world.on('chunkColumnLoad', this._onColumn)
    this.world.on('blockUpdate', this._onBlock)
  }

  detach () {
    if (!this.attached) return
    this.attached = false
    if (this._onColumn) this.world.removeListener('chunkColumnLoad', this._onColumn)
    if (this._onBlock) this.world.removeListener('blockUpdate', this._onBlock)
    this._onColumn = null
    this._onBlock = null
  }

  setCenter (pos) {
    this.emit('center', { x: pos.x, y: pos.y, z: pos.z })
  }

  /**
   * 取已加载列（同步；未加载返回 null）
   * 注意：mineflayer 的 bot.world 是 prismarine-world 的 WorldSync 同步代理
   * （mineflayer blocks.js: bot.world = new World(...).sync），它没有
   * getLoadedColumn()，而是 getColumn() 同步转发 async.getLoadedColumn()。
   * 原生 World（异步）没有同步 getColumn，且本函数仅在已加载列上使用，
   * 故统一按"无 getLoadedColumn → 调 getColumn"处理。
   */
  getLoadedChunk (cx, cz) {
    let chunk = null
    if (typeof this.world.getLoadedColumn === 'function') {
      chunk = this.world.getLoadedColumn(cx, cz)
    } else if (typeof this.world.getColumn === 'function') {
      chunk = this.world.getColumn(cx, cz)
    }
    // 异步 World.getColumn 会返回 Promise——本管线不等待加载，视同未就绪
    if (!chunk || typeof chunk.then === 'function' || !chunk.sections) return null
    return chunk
  }

  /**
   * 序列化整列：只含非空 section（全 air 的 section 不计）。
   * 列未加载返回 null。
   * @returns {Buffer|null}
   */
  serializeColumn (cx, cz) {
    const chunk = this.getLoadedChunk(cx, cz)
    if (!chunk || !chunk.sections) return null

    const minY = Number.isInteger(chunk.minY) ? chunk.minY : -64
    const sections = chunk.sections
    const counts = []
    let total = 0
    for (let si = 0; si < sections.length; si++) {
      const section = sections[si]
      if (section && typeof section.isEmpty === 'function' && !section.isEmpty() && section.data) {
        counts.push(si)
        total++
      }
    }
    if (total > 255) {
      // 理论不可能（worldHeight 384 = 24 sections），防御性截断即可
      counts.length = 255
      total = 255
    }

    const buf = Buffer.alloc(2 + 1 + 2 + 1 + total * (1 + SECTION_VOLUME * 2)) // magic2+ver1+minY2+count1
    let off = 0
    CHUNK_MAGIC.copy(buf, off)
    off += 2
    buf.writeUInt8(1, off++)
    buf.writeInt16LE(minY, off)
    off += 2
    buf.writeUInt8(total, off++)
    for (let i = 0; i < total; i++) {
      const si = counts[i]
      const data = sections[si].data
      buf.writeUInt8(si, off++)
      // blockIndex=(y<<8)|(z<<4)|x，与 section 内部下标一致
      for (let idx = 0; idx < SECTION_VOLUME; idx++) {
        buf.writeUInt16LE(data.get(idx), off)
        off += 2
      }
    }
    return buf
  }

  /** 该列是否已由 chunkColumnLoad 广播过（供 server 初始化镜像用） */
  listLoadedColumnKeys () {
    return Object.keys(this.world.columns || {})
  }
}
