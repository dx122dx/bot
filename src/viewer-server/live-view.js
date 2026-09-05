// live-view.js —— 实时 3D 查看器（自研管线）启停入口，供 commands.ts 的 !liveview 调用
//
// 与 !view（prismarine-viewer 整链路）并行：本管线只做「区块数据 + 静态资源」服务，
// 网格在浏览器 Worker 用 src/viewer-core/ 纯 JS 渲染核心构建。
//
// 约定（沿用 view.ts）：
//   - 端口默认 3001（与 prismarine-viewer 的 3000 错开）；enable 时可传端口
//   - 端口被占先查一次，若占用的恰是最近停用释放的端口则等 1 秒复查
//   - 启动前 ensurePatchedAssets() 保证 viewer-assets/blocksStates|textures 存在
'use strict'

import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ts } from '../logger.js'
import viewerPatch from '../viewer-patch.cjs'
import { ChunkStream } from './chunk-stream.js'
import { LiveServer } from './server.js'

const require = createRequire(import.meta.url)

const DEFAULT_PORT = 3001
const BIOME = 'plains'
const VIEW_DISTANCE = 6
let recentClosedPort = null

let live = null // { bot, stream, server, onMove, port }

function checkPortAvailable (port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
    tester.once('error', () => resolve(false))
    tester.listen(port, '0.0.0.0', () => {
      tester.close(() => resolve(true))
    })
  })
}

export async function enableLiveView (bot, port = DEFAULT_PORT) {
  if (live) {
    console.log(`${ts()}ℹ️ 实时查看器已在运行: http://localhost:${live.port}`)
    return
  }
  if (!bot || !bot.entity || !bot.world) {
    console.log(`${ts()}⚠️ 机器人未进入服务器`)
    return
  }
  try {
    await viewerPatch.ensurePatchedAssets()
  } catch (err) {
    console.log(`${ts()}⚠️ 高保真补丁生成失败，实时查看器可能缺模型/纹理: ${err.message}`)
  }
  let available = await checkPortAvailable(port)
  if (!available && recentClosedPort === port) {
    await new Promise((r) => setTimeout(r, 1000))
    available = await checkPortAvailable(port)
  }
  if (!available) {
    console.log(`${ts()}⚠️ 端口 ${port} 已被占用，无法启动实时查看器`)
    console.log(`${ts()}ℹ️ 请使用 !liveview enable <端口> 指定其他端口，例如: !liveview enable ${port + 1}`)
    return
  }

  const stream = new ChunkStream({ world: bot.world })
  stream.attach()
  const server = new LiveServer({
    stream,
    cwd: process.cwd(),
    assetDir: path.join(process.cwd(), 'viewer-assets'),
    version: bot.version || '1.20.1',
    biome: BIOME,
    viewDistance: VIEW_DISTANCE,
    infoExtra: { channel: 'liveview' },
    getCenter: () => {
      const p = bot.entity.position
      return { x: p.x, y: p.y, z: p.z }
    }
  })

  const broadcastCenter = () => {
    const p = bot.entity.position
    stream.setCenter({ x: p.x, y: p.y, z: p.z })
  }
  const onMove = () => broadcastCenter()
  stream.on('column', (e) => server.broadcast('column', e))
  stream.on('block', (e) => server.broadcast('block', e))
  stream.on('center', (e) => server.broadcast('center', e))

  try {
    const usedPort = await server.listen(port)
    bot.on('move', onMove)
    broadcastCenter() // 连接后立即给出 bot 当前位置
    live = { bot, stream, server, onMove, port: usedPort }
    const pos = bot.entity.position
    console.log(`${ts()}🌐 实时查看器已启动！浏览器打开 http://localhost:${usedPort}/viewer-live.html 查看`)
    console.log(`${ts()}📍 当前坐标: x=${pos.x.toFixed(1)} y=${pos.y.toFixed(1)} z=${pos.z.toFixed(1)}（默认端口 ${DEFAULT_PORT}）`)
    console.log(`${ts()}ℹ️ 停止: !liveview disable`)
  } catch (err) {
    stream.detach()
    console.error(`${ts()}❌ 实时查看器启动失败: ${err.message}`)
  }
}

export async function disableLiveView () {
  if (!live) {
    console.log(`${ts()}⚠️ 实时查看器未在运行`)
    return
  }
  const { bot, stream, server, onMove, port } = live
  live = null
  bot.removeListener('move', onMove)
  stream.detach()
  try {
    await server.close()
    recentClosedPort = port
    console.log(`${ts()}🛑 实时查看器已关闭（端口 ${port} 已释放）`)
  } catch (err) {
    console.error(`${ts()}❌ 实时查看器关闭失败: ${err.message}`)
  }
}
