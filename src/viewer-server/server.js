// server.js —— 实时查看 HTTP 服务（Node 内置 http，零新增依赖）
//
// 路由：
//   GET /chunk?cx=&cz=     列二进制（chunk-stream.js 的自研格式）
//   GET /events            SSE：column/block/center/info 通知
//   GET /api/blocksStates   viewer-assets/blocksStates/1.20.1.json（方块几何/模型）
//   GET /api/blocksStateMeta  stateId→(方块名,属性) 解码元数据（启动时一次性构建）
//   GET /api/info           服务信息（版本/生物群系/核心状态）
//   其余路径               cwd 静态文件（viewer-live.html、src/…、viewer-assets/…）
'use strict'

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

function sendJson (res, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

export class LiveServer {
  /**
   * @param {{
   *   stream: import('./chunk-stream.js').ChunkStream,
   *   cwd: string,                // 静态文件根（项目根，cwd）
   *   assetDir: string,           // viewer-assets 目录
   *   version: string,            // '1.20.1'
   *   biome: string,              // 固定生物群系名（plains）
   *   viewDistance: number,
   *   infoExtra?: object,
   *   streamGetter?: () => import('./chunk-stream.js').ChunkStream
   * }} opts
   */
  constructor (opts) {
    this.stream = opts.stream
    this.cwd = opts.cwd
    this.assetDir = opts.assetDir
    this.version = opts.version
    this.biome = opts.biome
    this.viewDistance = opts.viewDistance
    this.infoExtra = opts.infoExtra || {}
    /** 提供 bot 当前坐标的回调（可选，用于 /api/info 的 center 快照，页首屏不必等 SSE） */
    this.getCenter = typeof opts.getCenter === 'function' ? opts.getCenter : null

    this.sses = new Set()
    this.blocksStatesFile = path.join(this.assetDir, 'blocksStates', `${this.version}.json`)
    this.textureFile = path.join(this.assetDir, 'textures', `${this.version}.png`)
    this.stateMetaCache = null
    this._metaError = null
    this._keepAlive = null
  }

  listen (port, host = '0.0.0.0') {
    const server = http.createServer((req, res) => this._handle(req, res))
    this.http = server
    return new Promise((resolve, reject) => {
      const onError = (err) => { server.off('listening', onListening); reject(err) }
      const onListening = () => { server.off('error', onError); resolve(server.address().port) }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  _handle (req, res) {
    const url = new URL(req.url, 'http://localhost')
    const pathname = decodeURIComponent(url.pathname)
    const method = req.method || 'GET'

    // CORS 无跨域需求（同源页面），不额外放开
    if (pathname === '/events' || pathname === '/chunk') {
      // SSE 端点单独处理（GET）
    } else if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' })
      res.end('Method Not Allowed')
      return
    }

    try {
      if (pathname === '/events') return this._handleSse(req, res)
      if (pathname === '/chunk') return this._handleChunk(req, res, url)
      if (pathname === '/api/blocksStates') return this._handleBlocksStates(res)
      if (pathname === '/api/blocksStateMeta') return this._handleStateMeta(res)
      if (pathname === '/api/info') return this._handleInfo(res)
      return this._handleStatic(pathname, res)
    } catch (err) {
      if (res.headersSent) { res.destroy(); return }
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`Internal Error: ${err.message}`)
    }
  }

  // ---------------- 事件推送（SSE） ----------------
  _handleSse (req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write(': connected\n\n')
    this.sses.add(res)
    const send = (event, data) => {
      try {
        res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
      } catch { /* 已断开 */ }
    }
    send('hello', { version: this.version })
    req.on('close', () => this.sses.delete(res))
    if (!this._keepAlive) {
      this._keepAlive = setInterval(() => {
        for (const s of this.sses) { try { s.write(': ping\n\n') } catch {} }
      }, 25000)
      this._keepAlive.unref?.()
    }
  }

  broadcast (event, data) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    for (const s of this.sses) {
      try { s.write(`event: ${event}\ndata: ${payload}\n\n`) } catch { /* ignore */ }
    }
  }

  _handleChunk (req, res, url) {
    const cx = parseInt(url.searchParams.get('cx'), 10)
    const cz = parseInt(url.searchParams.get('cz'), 10)
    if (!Number.isInteger(cx) || !Number.isInteger(cz)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('bad cx/cz')
      return
    }
    const buf = this.stream.serializeColumn(cx, cz)
    const compressed = zlib.gzipSync(buf || Buffer.alloc(0))
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'gzip',
      'Content-Length': compressed.length,
      'Cache-Control': 'no-store'
    })
    res.end(compressed)
  }

  _handleBlocksStates (res) {
    if (!fs.existsSync(this.blocksStatesFile)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('blocksStates not generated yet; run !liveview enable (calls ensurePatchedAssets)')
      return
    }
    const stat = fs.statSync(this.blocksStatesFile)
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': stat.size,
      'Cache-Control': 'max-age=86400'
    })
    fs.createReadStream(this.blocksStatesFile).pipe(res)
  }

  // stateId → {方块名, 属性} 解码元数据（构建一次）
  _buildStateMeta () {
    if (this.stateMetaCache) return this.stateMetaCache
    if (this._metaError) throw this._metaError
    let registry
    try {
      registry = require('prismarine-registry')(this.version)
    } catch (err) {
      this._metaError = new Error(`prismarine-registry 加载失败: ${err.message}`)
      throw this._metaError
    }
    const blocks = []
    const byState = registry.blocksByStateId || {}
    const entries = registry.blocksArray || Object.values(registry.blocks || {})
    const byName = registry.blocksByName || {}
    const cs = registry.blockCollisionShapes
    const isFullCubeShape = (shape) => !!shape && shape.length === 1 && shape[0][0] === 0 && shape[0][1] === 0 && shape[0][2] === 0 && shape[0][3] === 1 && shape[0][4] === 1 && shape[0][5] === 1
    for (const b of entries) {
      const min = b.minStateId
      const named = byName[b.name] || b
      const transparent = named.transparent === true || named.transparent === 'true'
      // cube = 方块级碰撞形状恰为完整 1×1×1（与 prismarine-viewer world.js 同式）
      let cube = false
      if (cs && cs.blocks) {
        const sid = cs.blocks[b.name]
        if (sid !== undefined && cs.shapes) {
          cube = isFullCubeShape(cs.shapes[Array.isArray(sid) ? sid[0] : sid])
        }
      }
      const stateDecls = []
      if (Array.isArray(b.states)) {
        for (const p of b.states) {
          stateDecls.push(p.type === 'bool'
            ? [p.name, 'bool', 2, null]
            : [p.name, p.type || 'enum', p.num_values, p.values || null])
        }
      }
      blocks.push({ n: b.name, mn: min, t: transparent, c: cube, s: stateDecls })
    }
    // 用 byState 里的最大 stateId 决定客户端表长，避免逐块找 max
    let maxId = 0
    const keys = Object.keys(byState)
    for (const k of keys) {
      const id = parseInt(k, 10)
      if (Number.isInteger(id) && id > maxId) maxId = id
    }
    this.stateMetaCache = { version: this.version, biome: this.biome, maxStateId: maxId, blocks }
    return this.stateMetaCache
  }

  _handleStateMeta (res) {
    try {
      const meta = this._buildStateMeta()
      sendJson(res, meta)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`stateMeta error: ${err.message}`)
    }
  }

  _handleInfo (res) {
    const center = this.getCenter ? this.getCenter() : null
    sendJson(res, {
      version: this.version,
      biome: this.biome,
      viewDistance: this.viewDistance,
      assetFile: `${this.version}.json`,
      textureFile: `${this.version}.png`,
      ...this.infoExtra,
      ...(center ? { center } : {})
    })
  }

  _handleStatic (pathname, res) {
    if (pathname === '/') pathname = '/viewer-live.html'
    const rel = pathname.replace(/^\/+/, '')
    const full = path.resolve(this.cwd, rel)
    if (!full.startsWith(this.cwd + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return
    }
    fs.stat(full, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
        return
      }
      const ext = path.extname(full).toLowerCase()
      const mime = MIME[ext] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' })
      fs.createReadStream(full).pipe(res)
    })
  }

  async close () {
    if (this._keepAlive) { clearInterval(this._keepAlive); this._keepAlive = null }
    this.sses.clear()
    if (!this.http) return
    // 先销毁 keep-alive/SSE 长连接，否则 http.close 会一直等待其自然断开
    if (typeof this.http.closeAllConnections === 'function') this.http.closeAllConnections()
    await new Promise((resolve) => this.http.close(() => resolve()))
  }
}
