#!/usr/bin/env node
/*
 * verify-render.js —— 自研渲染核心「数值断言回归网」
 *
 * 理念：渲染核心(../src/viewer-core/)是纯 JS 且被本脚本直接 import —— 断言与实现同源。
 *      分两层验证：
 *       1) 结构性不变量（MC 语义推导，不依赖外部权威数值）：
 *            · 变体命中键：facing/rotation 显式属性必须命中对应 key（防空 key 抢先）
 *            · 朝向刚性：非对称模型 4 向变体几何应两两相差整 90° 绕 Y 旋转
 *            · 几何边界：顶点模型像素落在 0..16 方块盒内（无出界/缩放漂移）
 *            · UV：全部落在图集 [0,1] 且每面 4 顶点 UV 不退化
 *            · tint：草/叶/常绿样本颜色符合白名单决策；水罐等"内容物"样本必须灰阶（无 grass 污染）
 *            · 无 tint 方块输出颜色灰阶（r≈g≈b）
 *       2) 快照冻结：合成场景各块几何(positions/uvs/colors/indices)冻结为基线，防非语义漂移。
 *
 * 用法：
 *   node verification/verify-render.js            校验（无基线时自动冻结并退出 0）
 *   node verification/verify-render.js --update   刷新基线（人工确认改动正确后）
 *   node verification/verify-render.js --assets-dir <dir>  指定替代 viewer-assets 目录
 *   node verification/verify-render.js --help
 *
 * 退出码：0 通过(含首次冻结) / 1 存在差异 / 2 运行错误
 * 基线文件：verification/render-baseline.json（随 git 入库）
 */
'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildBlockGeometry, selectVariants,
  matmul3, buildRotationMatrix, TINT_PALETTE, DEFAULT_BIOME
} from '../src/viewer-core/index.js'
import {
  offsetFor, pixelAt, singleBlockFixture,
  ROTATION_GROUPS, TINT_SAMPLES, SNAPSHOT_LAYOUT, makeSnapshotWorld
} from './render-fixtures.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DEFAULT_ASSETS_DIR = path.join(ROOT, 'viewer-assets')
const BASELINE_PATH = path.join(HERE, 'render-baseline.json')
const BASELINE_FORMAT_VERSION = 1

const TOL = 1e-6            // 浮点容差（旋转矩阵误差 ~1e-17，断言微调容差 1e-6）
const PIX_TOL = 1e-3        // 模型像素还原容差

// ---------------------------------------------------------------- 基础工具

/** 四舍五入到 1e-6（快照存储用，消除平台无关的极小浮点噪声） */
function round6 (x) { return Math.round(x * 1e6) / 1e6 }

/** 三维向量差范数 */
function dist3 (a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) }

/** 检查集合：注册一组 (id,label,fn)->[detail] 校验 */
function makeSuite () {
  const checks = []
  const run = (id, label, fn) => {
    const details = fn() // 返回错误明细数组；空 = 通过
    const ok = details.length === 0
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
    for (const d of details) console.log(`        · ${d}`)
    checks.push({ id, ok, n: details.length })
  }
  const failCount = () => checks.filter((c) => !c.ok).length
  return { run, failCount }
}

// ---------------------------------------------------------------- 构建工具

/** 渲染单个 fixture 块并返回 attr（null 视为致命构建错误） */
function buildFixture (fx, { doAO = true, biome = DEFAULT_BIOME } = {}) {
  const { world, block, anchor } = fx
  const attr = buildBlockGeometry(block, anchor.x, anchor.y, anchor.z, BLOCKS_STATES, world, { doAO, biome })
  if (!attr || attr.positions.length === 0) return null
  return attr
}

/** 把 attr 顶点还原为模型像素 [[px,py,pz],…] */
function pixVerts (attr, fx) {
  const off = offsetFor(fx.anchor)
  const out = []
  for (let i = 0; i < attr.positions.length; i += 3) {
    out.push(pixelAt([attr.positions[i], attr.positions[i + 1], attr.positions[i + 2]], fx.anchor, off))
  }
  return out
}

/** 绕模型像素中心 (8,8,8) 的 Y 轴旋转 */
function rotYAroundCenter (pix, deg) {
  const m = buildRotationMatrix('y', deg)
  const v = matmul3(m, [pix[0] - 8, pix[1] - 8, pix[2] - 8])
  return [v[0] + 8, v[1] + 8, v[2] + 8]
}

/** 颜色三元组数组 [[r,g,b],…] */
function colorsOf (attr) {
  const out = []
  for (let i = 0; i < attr.colors.length; i += 3) out.push([attr.colors[i], attr.colors[i + 1], attr.colors[i + 2]])
  return out
}

/** 是否存在颜色与目标色 ≤TOL 距离 */
function hasColor (attr, target) {
  return colorsOf(attr).some((c) => dist3(c, target) <= TOL)
}

/** 全部颜色灰阶（r≈g≈b） */
function allGrayscale (attr) {
  return colorsOf(attr).every((c) => Math.abs(c[0] - c[1]) <= TOL && Math.abs(c[1] - c[2]) <= TOL)
}

// ---------------------------------------------------------------- 结构性不变量

function suiteInvariants (suite) {
  // I1 —— 变体命中键：显式属性必须精确命中（空 key 抢先修复的回归防线）
  suite.run('I1.match-key', 'I1 变体命中键：facing/rotation 显式命中（空 key 不抢先）', () => {
    const problems = []
    const cases = []
    for (const g of ROTATION_GROUPS) {
      const key = g.propKey || 'facing'
      for (const dir of g.dirs) {
        const props = { [key]: dir }
        const r = selectVariants({ name: g.name, props }, BLOCKS_STATES)
        const expected = `${key}=${dir}`
        cases.push({ name: `${g.name} ${key}=${dir}`, r, expected })
      }
    }
    // 附加：产物两约定方向性样例（chest north 不落到 '' / 直接命中）
    for (const c of cases) {
      if (c.r.matchedKey !== c.expected || c.r.matchedBy !== 'exact') {
        problems.push(`${c.name}: 命中 key=${JSON.stringify(c.r.matchedKey)} by=${c.r.matchedBy}，期望 '${c.expected}'/exact`)
      }
    }
    return problems
  })

  // I2 —— 朝向刚性：相邻方向几何应差整 90° 绕 Y（顶点一一对应，孤立无 AO/cull 干扰）
  suite.run('I2.rotation-rigid', 'I2 朝向刚性：四向变体几何两两差整 90° 绕 Y 旋转', () => {
    const problems = []
    for (const g of ROTATION_GROUPS) {
      const key = g.propKey || 'facing'
      const geos = new Map()
      for (const dir of g.dirs) {
        const props = { [key]: dir }
        const fx = singleBlockFixture(g.name, props)
        const attr = buildFixture(fx)
        if (!attr) { problems.push(`${g.id} ${dir}: 构建失败/无几何`); continue }
        geos.set(dir, { fx, pix: pixVerts(attr, fx), n: attr.positions.length / 3 })
      }
      if (problems.length) continue
      const dirs = g.dirs
      for (let i = 0; i < dirs.length - 1; i++) {
        const a = dirs[i]
        const b = dirs[i + 1]
        const A = geos.get(a)
        const B = geos.get(b)
        if (A.n !== B.n) { problems.push(`${g.id} ${a}→${b}: 顶点数不一致 ${A.n} vs ${B.n}`); continue }
        // 语义无关的方向符号验证：预测角 θ=±90 必有一个逐顶点命中
        let best = Infinity
        for (const deg of [90, -90]) {
          let err = 0
          for (let k = 0; k < A.pix.length; k++) {
            const rp = rotYAroundCenter(A.pix[k], deg)
            err += dist3(rp, B.pix[k])
          }
          best = Math.min(best, err / A.pix.length)
        }
        if (best > TOL * 4) {
          problems.push(`${g.id} ${a}→${b}: 平均逐顶点误差 ${best.toExponential(2)}（应 ~0，两变体须相差整 90°）`)
        }
        // 两方向几何必须不同（防空 key 竞态导致四个朝向全渲染同模型）
        let same = 0
        for (let k = 0; k < A.pix.length; k++) same += dist3(A.pix[k], B.pix[k])
        if (same === 0) problems.push(`${g.id} ${a} 与 ${b} 几何完全相同（方向未生效）`)
      }
    }
    return problems
  })

  // I3 —— 几何边界：顶点模型像素须落在 0..16 方块盒内（无整体缩放/平移漂移）
  suite.run('I3.pixel-bounds', 'I3 几何边界：顶点模型像素 ∈ [0,16] 方块盒', () => {
    const problems = []
    const samples = [
      ['stone', {}], ['oak_planks', {}], ['chest', { facing: 'north' }],
      ['oak_wall_sign', { facing: 'north' }], ['grass_block', {}], ['oak_leaves', {}], ['water_cauldron', {}]
    ]
    for (const [name, props] of samples) {
      const fx = singleBlockFixture(name, props)
      const attr = buildFixture(fx)
      if (!attr) { problems.push(`${name}: 构建失败/无几何`); continue }
      const pv = pixVerts(attr, fx)
      let worst = 0
      for (const p of pv) for (const c of p) worst = Math.max(worst, Math.abs(c) > 16 ? Math.max(p[0], p[1], p[2]) - 16 : 0)
      const bad = pv.filter((p) => p.some((c) => c < -PIX_TOL || c > 16 + PIX_TOL))
      if (bad.length) {
        problems.push(`${name}: ${bad.length}/${pv.length} 顶点出界，例 [${bad[0].map((v) => v.toFixed(4)).join(', ')}]`)
      }
    }
    return problems
  })

  // I4 —— UV：全部落在图集 [0,1] 内、每面 4 顶点 UV 非退化
  suite.run('I4.uv', 'I4 UV：uv ∈ [0,1] 且每面 4 顶点 UV 非退化', () => {
    const problems = []
    const samples = ['stone', 'chest', 'oak_wall_sign', 'grass_block', 'oak_leaves', 'water_cauldron', 'oak_planks']
    for (const name of samples) {
      const fx = name === 'chest' ? singleBlockFixture(name, { facing: 'north' })
        : name === 'oak_wall_sign' ? singleBlockFixture(name, { facing: 'north' }) : singleBlockFixture(name)
      const attr = buildFixture(fx)
      if (!attr) { problems.push(`${name}: 构建失败/无几何`); continue }
      const n = attr.uvs.length / 2
      if (n === 0) { problems.push(`${name}: 无 UV`); continue }
      let oob = 0
      let degenerateFaces = 0
      for (let i = 0; i < attr.uvs.length; i += 2) {
        const u = attr.uvs[i]
        const v = attr.uvs[i + 1]
        if (!(u >= -TOL && u <= 1 + TOL && v >= -TOL && v <= 1 + TOL)) oob++
      }
      // 每面 4 顶点（liquid 不参与，core 无 liquid），四 uv 须至少两种不同
      for (let f = 0; f < n; f += 4) {
        if (f + 3 >= n) break
        const set = new Set()
        for (let k = 0; k < 4; k++) set.add(`${round6(attr.uvs[(f + k) * 2])},${round6(attr.uvs[(f + k) * 2 + 1])}`)
        if (set.size < 2) degenerateFaces++
      }
      if (oob) problems.push(`${name}: ${oob} 个 UV 越界 [0,1]`)
      if (degenerateFaces) problems.push(`${name}: ${degenerateFaces} 个退化面（四顶点 UV 全同）`)
    }
    return problems
  })

  // I5 —— tint 决策（白名单）：草/叶/常绿染对应色；内容物样本灰阶（回归 #3 草色污染）
  suite.run('I5.tint', 'I5 tint：植物染 grass/foliage/constant，水罐等不得染 grass', () => {
    const problems = []
    const expectColor = {
      grass: TINT_PALETTE.grass[DEFAULT_BIOME],
      foliage: TINT_PALETTE.foliage[DEFAULT_BIOME],
      constant: TINT_PALETTE.constant.birch_leaves
    }
    for (const s of TINT_SAMPLES) {
      const fx = singleBlockFixture(s.name) // props 取真实首个变体，tint 与 props 无关
      const attr = buildFixture(fx)
      if (!attr) { problems.push(`${s.name}: 构建失败/无几何`); continue }
      if (s.expect === 'grayscale') {
        if (!allGrayscale(attr)) problems.push(`${s.name}: ${s.label}，存在非灰阶颜色（可能被 grass/foliage 污染）`)
      } else {
        const target = expectColor[s.expect]
        if (!hasColor(attr, target)) {
          problems.push(`${s.name}: ${s.label}，未找到期望色 ${target.map((v) => v.toFixed(3)).join(',')}`)
        }
      }
    }
    return problems
  })

  // I6 —— 无 tint 方块整体灰阶（草色污染回归补充：水罐/普通方块都须灰阶）
  suite.run('I6.grayscale', 'I6 灰阶：无 tint/非植物方块颜色 r≈g≈b', () => {
    const problems = []
    for (const name of ['stone', 'oak_planks', 'chest', 'oak_wall_sign', 'water_cauldron', 'pink_petals']) {
      const props = name === 'chest' || name === 'oak_wall_sign' ? { facing: 'north' } : {}
      const fx = singleBlockFixture(name, props)
      const attr = buildFixture(fx)
      if (!attr) { problems.push(`${name}: 构建失败/无几何`); continue }
      if (!allGrayscale(attr)) {
        const sample = colorsOf(attr).find((c) => Math.abs(c[0] - c[1]) > TOL || Math.abs(c[1] - c[2]) > TOL)
        problems.push(`${name}: 存在非灰阶颜色 [${sample.map((v) => v.toFixed(4)).join(',')}]`)
      }
    }
    return problems
  })
}

// ---------------------------------------------------------------- 快照冻结

function buildSnapshot () {
  const cases = {}
  const world = makeSnapshotWorld()
  for (const { pos, make } of SNAPSHOT_LAYOUT) {
    const block = make()
    const fx = { world, block, anchor: pos }
    const attr = buildFixture(fx, { doAO: true })
    const key = `${block.name}@${pos.x},${pos.y},${pos.z}`
    if (!attr) {
      cases[key] = { error: '构建失败/无几何' }
      continue
    }
    const flat = { f: 3, positions: [], uvs: [], colors: [], indices: attr.indices }
    for (const x of attr.positions) flat.positions.push(round6(x))
    for (const x of attr.uvs) flat.uvs.push(round6(x))
    for (const x of attr.colors) flat.colors.push(round6(x))
    cases[key] = flat
  }
  return { cases }
}

/** 比较两快照：返回差异描述数组 */
function compareSnapshot (baseCases, currCases) {
  const problems = []
  const baseKeys = new Set(Object.keys(baseCases))
  const currKeys = new Set(Object.keys(currCases))
  for (const k of baseKeys) if (!currKeys.has(k)) problems.push(`快照缺 case: ${k}`)
  for (const k of currKeys) {
    if (!baseKeys.has(k)) { problems.push(`快照新增 case: ${k}`); continue }
    const b = baseCases[k]
    const c = currCases[k]
    if (b.error || c.error) {
      problems.push(`${k}: 基线${b.error ? '有错' : '正常'} vs 当前${c.error ? '有错' : '正常'}`)
      continue
    }
    if (c.positions.length !== b.positions.length) { problems.push(`${k}: 顶点数 ${b.positions.length} → ${c.positions.length}`); continue }
    for (const f of ['positions', 'uvs', 'colors', 'indices']) {
      const bb = b[f]
      const cc = c[f]
      if (bb.length !== cc.length) { problems.push(`${k}.${f}: 长度 ${bb.length} → ${cc.length}`); break }
      for (let i = 0; i < bb.length; i++) {
        if (bb[i] !== cc[i]) {
          const iv = Math.floor(i / (f === 'indices' ? 1 : 3))
          problems.push(`${k}.${f}[${i}]: 基线 ${bb[i]} → 当前 ${cc[i]}（顶点 #${iv}）`)
          break
        }
      }
    }
  }
  return problems
}

// ---------------------------------------------------------------- CLI

function usage () {
  console.log(`用法:
  node verification/verify-render.js            校验（无基线时自动冻结并退出 0）
  node verification/verify-render.js --update   以当前输出刷新基线
  node verification/verify-render.js --assets-dir <dir>  指定替代 viewer-assets 目录(隔离自检)
  node verification/verify-render.js --help     本帮助

退出码: 0 通过 / 1 不变量或快照差异 / 2 运行错误
基线文件: verification/render-baseline.json (随 git 入库)`)
}

function parseArgs (argv) {
  const args = { assetsDir: DEFAULT_ASSETS_DIR, update: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--update') args.update = true
    else if (a === '--assets-dir') {
      if (i + 1 >= argv.length) throw new Error('--assets-dir 缺少目录参数')
      args.assetsDir = path.resolve(ROOT, argv[++i])
    } else if (a === '--help' || a === '-h') args.help = true
    else if (a.startsWith('-')) throw new Error(`未知参数: ${a}`)
  }
  return args
}

// ---- 全局产物（被各 suite 引用）
let BLOCKS_STATES

function main () {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[ERROR] ${err.message}`)
    usage()
    process.exit(2)
  }
  if (args.help) { usage(); process.exit(0) }

  const bsFile = path.join(args.assetsDir, 'blocksStates', '1.20.1.json')
  if (!fs.existsSync(bsFile)) {
    console.error(`[ERROR] blocksStates 不存在: ${bsFile}`)
    process.exit(2)
  }
  try {
    BLOCKS_STATES = JSON.parse(fs.readFileSync(bsFile, 'utf8'))
  } catch (err) {
    console.error(`[ERROR] blocksStates 解析失败: ${err.message}`)
    process.exit(2)
  }

  // ---- 结构性不变量（恒跑）
  const suite = makeSuite()
  suiteInvariants(suite)
  const invFail = suite.failCount()
  const invText = invFail === 0 ? '全部结构性不变量通过' : `${invFail} 项结构性不变量失败`
  console.log(`\n[INV] ${invText}\n`)

  // ---- 快照
  let current
  try {
    current = buildSnapshot()
  } catch (err) {
    console.error(`[ERROR] 快照构建失败: ${err.message}`)
    process.exit(2)
  }

  const writeBaseline = () => {
    const out = { formatVersion: BASELINE_FORMAT_VERSION, createdAt: new Date().toISOString(), cases: current.cases }
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(out) + '\n')
    const n = Object.keys(current.cases).length
    const errs = Object.values(current.cases).filter((c) => c.error).length
    console.log(`[SNAP] 基线已${args.update ? '刷新' : '冻结'}: ${BASELINE_PATH} (${n} cases${errs ? `, ${errs} 个构建失败` : ''})`)
  }

  if (args.update) {
    try { writeBaseline() } catch (err) { console.error(`[ERROR] 写基线失败: ${err.message}`); process.exit(2) }
    process.exit(invFail ? 1 : 0)
  }

  let baselineExists = false
  try { fs.accessSync(BASELINE_PATH); baselineExists = true } catch { baselineExists = false }

  if (!baselineExists) {
    if (invFail > 0) {
      console.log('[FAIL] 不变量失败，且无基线可冻结；请先修复渲染核心')
      process.exit(1)
    }
    try { writeBaseline() } catch (err) { console.error(`[ERROR] 写基线失败: ${err.message}`); process.exit(2) }
    console.log('[OK]   建议再次运行（不带 --update）确认与基线一致')
    process.exit(0)
  }

  // ---- 基线对比
  let base
  try {
    base = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
  } catch (err) {
    console.error(`[ERROR] 基线文件读取/解析失败: ${BASELINE_PATH} — ${err.message}`)
    process.exit(2)
  }
  if (base.formatVersion !== BASELINE_FORMAT_VERSION) {
    console.error(`[ERROR] 基线格式版本不匹配(基线 ${base.formatVersion} vs 脚本 ${BASELINE_FORMAT_VERSION})，请用 --update 重建`)
    process.exit(2)
  }
  const snapProblems = compareSnapshot(base.cases, current.cases)
  if (snapProblems.length) {
    console.log('[CHANGED] 渲染快照与基线存在差异:')
    for (const p of snapProblems.slice(0, 20)) console.log(`          · ${p}`)
    if (snapProblems.length > 20) console.log(`          … 共 ${snapProblems.length} 处`)
    console.log('\n[FAIL]   若改动正确，请人工确认后运行: node verification/verify-render.js --update')
    process.exit(1)
  }
  console.log(`[OK]   渲染快照与基线一致（${Object.keys(base.cases).length} cases）`)
  process.exit(invFail ? 1 : 0)
}

main()
