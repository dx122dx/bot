// tint-palette.js —— 按版本解析生物群系着色（调色板），供 /api/tints 下发给浏览器
//
// 为什么在服务端解析：浏览器侧渲染核心必须保持「纯 JS、零三方依赖」，而颜色来源是
// minecraft-data 的版本数据与 vanilla 颜色查找图，只有在 Node 侧才能读取。
//
// 取数顺序（全程不写死任何颜色值）：
//   1) minecraft-data(version).tints 中该 biome 的显式分组色（1.17 用 ARGB 负整数，
//      `>>> 0` 后取低 24 位）；color === 0 表示版本数据未给出该 biome 的颜色。
//   2) 显式值缺失时，用该版本 colormap/<category>.png 按 vanilla 规则查表：
//        x = floor((1 - temperature) * 255)
//        y = floor((1 - humidity * temperature) * 255)
//      实测 1.20.1 plains（temp 0.8 / humidity 0.4）得到 #91BD59 / #77AB2F，与官方一致。
//   3) humidity 取 biome 的 rainfall；1.19+ 的 minecraft-data 已不再导出该字段，
//      此时按 dataVersion 降序找最近一个仍导出 rainfall 的版本（生物群系湿度跨版本稳定）。
// 任一步无法解析都抛错并带上版本/biome/来源，不做静默白色兜底。
'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import pngjs from 'pngjs'

const { PNG } = pngjs
const require = createRequire(import.meta.url)
const mcData = require('minecraft-data')

const VIEWER_DIR = path.dirname(require.resolve('prismarine-viewer'))
const TEXTURE_ROOT = path.join(VIEWER_DIR, 'public', 'textures')
/** 只有这两类是「双线性温湿度色图」，water/redstone/constant 在 tints 里直接给出 */
const COLORMAP_CATEGORIES = ['grass', 'foliage']
const REDSTONE_LEVELS = 16

const paletteCache = new Map()
const colormapCache = new Map()

/** 0xRRGGBB / 0xAARRGGBB → [r,g,b]（0..1） */
function toRgb01 (color) {
  const rgb = (color >>> 0) & 0xffffff
  return [((rgb >> 16) & 0xff) / 255, ((rgb >> 8) & 0xff) / 255, (rgb & 0xff) / 255]
}

function dataOf (version) {
  try {
    return mcData(version)
  } catch (err) {
    throw new Error(`minecraft-data 无法加载版本 ${version}: ${err.message}`)
  }
}

function dataVersionOf (version) {
  const rec = dataOf(version).version
  const dv = rec && rec.dataVersion
  if (!Number.isInteger(dv)) throw new Error(`minecraft-data 缺少 ${version} 的 dataVersion`)
  return dv
}

function biomeRecordOf (version, biome) {
  const rec = dataOf(version).biomesByName[biome]
  if (!rec) throw new Error(`minecraft-data(${version}) 中不存在生物群系 ${biome}`)
  return rec
}

/** tints 中该 biome 的显式分组色；0 = 版本数据未给出 */
function tintsBiomeColor (tints, category, biome) {
  const table = tints[category]
  if (!table || !Array.isArray(table.data)) return 0
  const hit = table.data.find((entry) => Array.isArray(entry.keys) && entry.keys.includes(biome))
  return hit ? hit.color >>> 0 : 0
}

/** tints 的全局 default（旧版本数据才有；用于 water 等无 colormap 的类别） */
function tintsDefaultColor (tints, category) {
  const table = tints[category]
  return table && typeof table.default === 'number' ? table.default >>> 0 : 0
}

/**
 * 选择 colormap 使用的版本目录：精确版本优先，否则取 dataVersion ≤ 目标的最近版本。
 * vanilla 的这两张色图跨版本基本不变，但不同版本目录仍按数据版本排序，避免硬编码。
 */
function resolveColormapVersion (version) {
  const dirs = fs.readdirSync(TEXTURE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => COLORMAP_CATEGORIES.every((cat) => fs.existsSync(path.join(TEXTURE_ROOT, name, 'colormap', `${cat}.png`))))
  if (dirs.length === 0) throw new Error(`prismarine-viewer 未提供 colormap 素材: ${TEXTURE_ROOT}`)
  if (dirs.includes(version)) return version
  const target = dataVersionOf(version)
  const ranked = dirs
    .map((name) => {
      try { return { name, dv: dataVersionOf(name) } } catch { return { name, dv: -1 } }
    })
    .filter((entry) => entry.dv >= 0 && entry.dv <= target)
    .sort((a, b) => b.dv - a.dv)
  if (ranked.length === 0) throw new Error(`找不到适用于 ${version} 的 colormap 素材（${TEXTURE_ROOT}）`)
  return ranked[0].name
}

function loadColormap (colormapVersion, category) {
  const key = `${colormapVersion}/${category}`
  const cached = colormapCache.get(key)
  if (cached) return cached
  const file = path.join(TEXTURE_ROOT, colormapVersion, 'colormap', `${category}.png`)
  const png = PNG.sync.read(fs.readFileSync(file))
  if (!png || png.width !== 256 || png.height !== 256) {
    throw new Error(`colormap 尺寸异常（期望 256×256）: ${file}`)
  }
  colormapCache.set(key, png)
  return png
}

/** vanilla 温湿度查表（GrassColor/FoliageColor 同式） */
function sampleColormap (png, temperature, humidity) {
  const clamp255 = (v) => Math.min(255, Math.max(0, v))
  const x = clamp255(Math.floor((1 - temperature) * 255))
  const y = clamp255(Math.floor((1 - humidity * temperature) * 255))
  const i = (y * png.width + x) * 4
  return (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]
}

/** biome 湿度（vanilla downfall）；目标版本缺失时按 dataVersion 降序回溯 */
function resolveHumidity (version, biome) {
  const direct = biomeRecordOf(version, biome)
  if (typeof direct.rainfall === 'number') return { value: direct.rainfall, from: version }

  const target = dataVersionOf(version)
  // 旧版本条目没有 releaseType 字段，改用版本号形态区分正式版（1.16.2）与快照（23w03a）；
  // 优先正式版，取不到再退到快照（两者都只是「读取历史数据」，不含任何写死颜色）。
  const older = mcData.versions.pc
    .filter((v) => Number.isInteger(v.dataVersion) && v.dataVersion < target)
    .sort((a, b) => b.dataVersion - a.dataVersion)
  const isRelease = (name) => /^\d+\.\d+(\.\d+)?$/.test(name)
  const candidates = [...older.filter((v) => isRelease(v.minecraftVersion)), ...older.filter((v) => !isRelease(v.minecraftVersion))]
  for (const v of candidates) {
    let rec
    try { rec = mcData(v.minecraftVersion).biomesByName[biome] } catch { continue }
    if (rec && typeof rec.rainfall === 'number') return { value: rec.rainfall, from: v.minecraftVersion }
  }
  throw new Error(`无法为 ${version}/${biome} 解析湿度：目标版本与历史版本数据均无 rainfall`)
}

/** grass/foliage：tints 显式色优先，缺失时走该版本 colormap */
function resolveBiomeTint (version, biome, category) {
  const tints = dataOf(version).tints
  const explicit = tintsBiomeColor(tints, category, biome)
  if (explicit) return { color: explicit, source: `tints(${version})` }

  const rec = biomeRecordOf(version, biome)
  const temperature = rec.temperature
  if (typeof temperature !== 'number') {
    throw new Error(`minecraft-data(${version}) 的 ${biome} 缺少 temperature，无法查 colormap`)
  }
  const humidity = resolveHumidity(version, biome)
  const colormapVersion = resolveColormapVersion(version)
  const color = sampleColormap(loadColormap(colormapVersion, category), temperature, humidity.value)
  return {
    color,
    source: `colormap(${colormapVersion}, temp=${temperature}, humidity=${humidity.value}@${humidity.from})`
  }
}

function buildRedstone (version, tints) {
  const data = tints.redstone && tints.redstone.data
  if (!Array.isArray(data) || data.length !== REDSTONE_LEVELS) {
    throw new Error(`minecraft-data(${version}).tints.redstone 档位数异常（期望 ${REDSTONE_LEVELS}）`)
  }
  return data
    .slice()
    .sort((a, b) => a.keys[0] - b.keys[0])
    .map((entry) => toRgb01(entry.color))
}

function buildConstant (version, tints) {
  const data = tints.constant && tints.constant.data
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`minecraft-data(${version}).tints.constant 缺失`)
  }
  const map = {}
  for (const entry of data) for (const name of entry.keys) map[name] = toRgb01(entry.color)
  return map
}

/**
 * 解析指定版本 + 生物群系的调色板（结果缓存，服务端每个实例只算一次）。
 * @param {{version:string, biome:string}} opts
 * @returns {{palette:{version:string,biome:string,grass:number[],foliage:number[],water:number[],redstone:number[][],constant:Object<string,number[]>}, sources:Object<string,string>}}
 */
export function buildTintPalette ({ version, biome }) {
  const key = `${version}|${biome}`
  const cached = paletteCache.get(key)
  if (cached) return cached

  const tints = dataOf(version).tints
  if (!tints) throw new Error(`minecraft-data(${version}) 未导出 tints`)

  const grass = resolveBiomeTint(version, biome, 'grass')
  const foliage = resolveBiomeTint(version, biome, 'foliage')

  const waterColor = tintsBiomeColor(tints, 'water', biome) || tintsDefaultColor(tints, 'water')
  if (!waterColor) throw new Error(`minecraft-data(${version}).tints 未给出 ${biome} 的水色，也没有 default`)

  const result = {
    palette: {
      version,
      biome,
      grass: toRgb01(grass.color),
      foliage: toRgb01(foliage.color),
      water: toRgb01(waterColor),
      redstone: buildRedstone(version, tints),
      constant: buildConstant(version, tints)
    },
    sources: {
      grass: grass.source,
      foliage: foliage.source,
      water: `tints(${version})`,
      redstone: `tints(${version})`,
      constant: `tints(${version})`
    }
  }
  paletteCache.set(key, result)
  return result
}
