#!/usr/bin/env node
/*
 * verify-viewer-assets.cjs —— prismarine-viewer 高保真方块补丁产物「止血回归网」
 *
 * 理念：不判对错、只防退化。把"当前产物特征"冻结为基线快照(入库)，
 *       此后产物任何改动都报警并显示前后 diff。改对了就人工 --update 刷新基线。
 *
 * 用法：
 *   node verification/verify-viewer-assets.cjs            校验(无基线时自动初始化)
 *   node verification/verify-viewer-assets.cjs --update   刷新基线(人工确认改动正确后)
 *   node verification/verify-viewer-assets.cjs --assets-dir <dir>   指向替代产物目录(隔离自检用)
 *   node verification/verify-viewer-assets.cjs --help
 *
 * 退出码：0 通过(含首次初始化) / 1 存在差异 / 2 运行错误
 *
 * 指纹设计（依据 code-explorer 对 blocksStates/1.20.1.json 结构核实）：
 *   blocksStates JSON：
 *     - 整文件 SHA-256（文件级哨兵，任何字节变化都报警）
 *     - 逐方块(顶层键)渲染指纹：variants/multipart 结构、属性串、x/y/z 旋转、
 *       model.elements[].from/to/rotation、faces[side].texture.{u,v,su,sv}/
 *       cullface/tintindex/rotation、model.ao、textures.particle(4 uv)
 *     - 刻意排除的死字段：face.texture.bu/bv(渲染端不读且补丁未同步缩放)、
 *       textures 中 particle 之外的命名残骸、对象键序(指纹前按 key 排序规范化)
 *   textures PNG：SHA-256 + 宽高(2048x2048 图集)。不做像素级定位——
 *       图集重排会整体漂移无定位价值，纹理语义变化应由入库的 texture-src 源 PNG 走 git 历史。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_ASSETS_DIR = path.join(ROOT, 'viewer-assets')
const BASELINE_PATH = path.join(__dirname, 'viewer-assets-baseline.json')
const BASELINE_FORMAT_VERSION = 1

// 受检产物清单(相对 assets 根)
const ASSETS = [
  { rel: 'blocksStates/1.20.1.json', kind: 'blocksStates' },
  { rel: 'textures/1.20.1.png', kind: 'png' },
]

const FACE_UV_KEYS = ['u', 'v', 'su', 'sv']

// ---------------------------------------------------------------- 基础工具

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 读取 PNG 宽高：PNG 头 8 字节签名 + IHDR(宽高为大端 u32, 偏移 16..24) */
function pngSize(buf) {
  if (buf.length < 24) throw new Error('PNG 文件过短，无法读取尺寸')
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  }
}

/** 递归按 key 排序(数组保序)，得到与键序无关的稳定 JSON 串 */
function canonical(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical))
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const k of Object.keys(value).sort()) sorted[k] = canonical(value[k])
    return JSON.stringify(sorted)
  }
  return JSON.stringify(value)
}

function pickUv(tex) {
  // tex 可能是已展开的 {u,v,su,sv,...} 或其它形态，只保留渲染实际读取的 4 个 uv
  if (tex !== null && typeof tex === 'object') {
    const out = {}
    for (const k of FACE_UV_KEYS) {
      if (tex[k] !== undefined) out[k] = tex[k]
    }
    return Object.keys(out).length > 0 ? out : tex
  }
  return tex
}

// ---------------------------------------------------------------- 渲染指纹提取

/** 由"方块状态值"提取渲染相关指纹(排除渲染端不读的字段) */
function extractBlockFingerprint(stateObj) {
  if (stateObj === null || typeof stateObj !== 'object') return stateObj
  if (stateObj.variants !== undefined) {
    const variants = {}
    for (const k of Object.keys(stateObj.variants)) {
      variants[k] = normVariant(stateObj.variants[k])
    }
    return { variants }
  }
  if (stateObj.multipart !== undefined) {
    return {
      multipart: stateObj.multipart.map((part) => {
        const p = {}
        if (part !== null && typeof part === 'object') {
          if (part.when !== undefined) p.when = part.when
          p.apply = normApply(part.apply)
        } else {
          p.apply = part
        }
        return p
      }),
    }
  }
  // 未知形态兜底：原样保留(不做字段裁剪)，至少保证不静默漏检
  return stateObj
}

function normVariant(v) {
  if (Array.isArray(v)) return v.map(normVariant)
  if (v !== null && typeof v === 'object') {
    const o = {}
    for (const k of ['x', 'y', 'z', 'uvlock']) if (v[k] !== undefined) o[k] = v[k]
    if (v.model !== undefined) o.model = extractModel(v.model)
    return o
  }
  return v
}

function normApply(a) {
  if (Array.isArray(a)) return a.map(extractModel)
  return extractModel(a)
}

function extractModel(m) {
  if (m === null || typeof m !== 'object') return m
  const o = {}
  if (m.textures !== undefined && m.textures !== null && typeof m.textures === 'object') {
    const pt = m.textures.particle
    o.textures = pt !== undefined ? { particle: pickUv(pt) } : {}
  }
  if (m.ao !== undefined) o.ao = m.ao
  if (m.elements !== undefined) {
    if (Array.isArray(m.elements)) o.elements = m.elements.map(extractElement)
    else o.elements = extractElement(m.elements)
  }
  return o
}

function extractElement(el) {
  if (el === null || typeof el !== 'object') return el
  const o = {}
  if (el.from !== undefined) o.from = el.from
  if (el.to !== undefined) o.to = el.to
  if (el.rotation !== undefined && el.rotation !== null && typeof el.rotation === 'object') {
    const r = {}
    for (const k of ['origin', 'axis', 'angle']) if (el.rotation[k] !== undefined) r[k] = el.rotation[k]
    o.rotation = r
  }
  if (el.faces !== undefined && el.faces !== null && typeof el.faces === 'object') {
    const f = {}
    for (const side of Object.keys(el.faces)) {
      const fc = el.faces[side]
      if (fc === null || typeof fc !== 'object') { f[side] = fc; continue }
      const e = {}
      if (fc.texture !== undefined) e.texture = pickUv(fc.texture)
      for (const k of ['cullface', 'tintindex', 'rotation']) if (fc[k] !== undefined) e[k] = fc[k]
      f[side] = e
    }
    o.faces = f
  }
  return o
}

/** 解析产物目录里的单个受检文件，得到文件指纹 */
function computeFileFingerprint(assetsDir, asset) {
  const file = path.join(assetsDir, asset.rel)
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`受检产物不存在: ${file}`)
    }
    throw err
  }
  const base = { sha256: sha256(buf), size: buf.length }
  if (asset.kind === 'png') {
    Object.assign(base, pngSize(buf))
    return base
  }
  if (asset.kind === 'blocksStates') {
    let parsed
    try {
      parsed = JSON.parse(buf.toString('utf8'))
    } catch (err) {
      throw new Error(`blocksStates JSON 解析失败: ${file} — ${err.message}`)
    }
    const blocks = {}
    for (const name of Object.keys(parsed)) {
      const render = extractBlockFingerprint(parsed[name])
      blocks[name] = { digest: sha256(canonical(render)), render }
    }
    return { ...base, blockCount: Object.keys(parsed).length, blocks }
  }
  throw new Error(`未知受检类型: ${asset.kind}`)
}

function buildBaseline(assetsDir) {
  const files = {}
  for (const asset of ASSETS) files[asset.rel] = computeFileFingerprint(assetsDir, asset)
  return { formatVersion: BASELINE_FORMAT_VERSION, files }
}

// ---------------------------------------------------------------- 差异对比与展示

/** 深递归 diff 两个指纹树，产出 [{path, old, new}] */
function diffTrees(a, b, out = [], prefix = '') {
  const aIsArr = Array.isArray(a)
  const bIsArr = Array.isArray(b)
  if (aIsArr || bIsArr) {
    if (!aIsArr || !bIsArr) {
      out.push({ path: prefix, old: a, new: b })
      return out
    }
    const len = Math.max(a.length, b.length)
    for (let i = 0; i < len; i++) {
      const av = i < a.length ? a[i] : '<缺失>'
      const bv = i < b.length ? b[i] : '<缺失>'
      diffTrees(av, bv, out, `${prefix}[${i}]`)
    }
    return out
  }
  if (a !== null && typeof a === 'object' && b !== null && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of Array.from(keys).sort()) {
      const subA = Object.prototype.hasOwnProperty.call(a, k) ? a[k] : '<缺失>'
      const subB = Object.prototype.hasOwnProperty.call(b, k) ? b[k] : '<缺失>'
      diffTrees(subA, subB, out, prefix ? `${prefix}.${k}` : k)
    }
    return out
  }
  if (a !== b) out.push({ path: prefix, old: a, new: b })
  return out
}

function fmtValue(v) {
  const s = JSON.stringify(v)
  return s && s.length > 160 ? `${s.slice(0, 157)}...` : s
}

function compareFingerprints(base, curr, labels) {
  const problems = []
  for (const asset of ASSETS) {
    const rel = asset.rel
    const label = labels.get(rel)
    if (!base.files[rel] || !curr.files[rel]) {
      problems.push(`[CHANGED] ${label}: 指纹结构异常(基线缺失当前侧?)`)
      continue
    }
    const bf = base.files[rel]
    const cf = curr.files[rel]
    if (bf.sha256 === cf.sha256) {
      console.log(`[OK]     ${label}: 未变化 (${bf.size} bytes)`)
      continue
    }
    // ---- 文件级变化：定位到方块级 ----
    console.log(`[CHANGED] ${label}: 文件内容已变化 (${bf.size} → ${cf.size} bytes, sha256: ${cf.sha256.slice(0, 12)}...)`)
    if (asset.kind === 'png') {
      problems.push({ label, file: rel, kind: 'png' })
      continue
    }
    const bm = bf.blocks
    const cm = cf.blocks
    const changedNames = []
    const allNames = new Set([...Object.keys(bm), ...Object.keys(cm)])
    for (const name of allNames) {
      const bd = bm[name] && bm[name].digest
      const cd = cm[name] && cm[name].digest
      if (bd !== cd) changedNames.push(name)
    }
    if (changedNames.length === 0) {
      // sha 变了但渲染指纹(方块级)全同 → 变化只发生在排除的死字段/键序
      console.log(`  [WARN]  渲染指纹未变：差异仅在忽略字段(如 bu/bv、textures 命名残骸、键序)或元数据层`)
      problems.push({ label, file: rel, kind: 'nonRenderOnly' })
      continue
    }
    console.log(`  变更方块 (${changedNames.length}): ${changedNames.join(', ')}`)
    for (const name of changedNames.sort()) {
      const oldRender = bm[name] ? bm[name].render : '<新增方块>'
      const newRender = cm[name] ? cm[name].render : '<方块被移除>'
      const diffs = diffTrees(oldRender, newRender)
      console.log(`  — ${name}`)
      for (const d of diffs) {
        const loc = d.path ? `  · ${name}.${d.path}` : `  · ${name}`
        console.log(`      ${loc}`)
        console.log(`        old: ${fmtValue(d.old)}`)
        console.log(`        new: ${fmtValue(d.new)}`)
      }
    }
    problems.push({ label, file: rel, kind: 'blocksStates', count: changedNames.length })
  }
  return problems
}

// ---------------------------------------------------------------- CLI

function usage() {
  console.log(`用法:
  node verification/verify-viewer-assets.cjs            校验当前产物(无基线时自动初始化并退出 0)
  node verification/verify-viewer-assets.cjs --update   以当前产物刷新基线
  node verification/verify-viewer-assets.cjs --assets-dir <dir>  指定替代产物目录(隔离自检)
  node verification/verify-viewer-assets.cjs --help     本帮助

退出码: 0 通过 / 1 存在差异 / 2 运行错误
基线文件: verification/viewer-assets-baseline.json (随 git 入库)`)
}

function parseArgs(argv) {
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

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[ERROR] ${err.message}`)
    usage()
    process.exit(2)
  }
  if (args.help) {
    usage()
    process.exit(0)
  }

  const labels = new Map(ASSETS.map((a) => [a.rel, `${path.join(args.assetsDir, a.rel)}`]))

  if (!fs.existsSync(args.assetsDir)) {
    console.error(`[ERROR] 产物目录不存在: ${args.assetsDir}`)
    process.exit(2)
  }

  let baselineExists = false
  try {
    fs.accessSync(BASELINE_PATH)
    baselineExists = true
  } catch { baselineExists = false }

  // -- 计算当前指纹(可能因受检产物缺失/损坏抛错)
  let current
  try {
    current = buildBaseline(args.assetsDir)
  } catch (err) {
    console.error(`[ERROR] ${err.message}`)
    process.exit(2)
  }

  if (!baselineExists || args.update) {
    try {
      // 紧凑存储：基线文件面向 git 追踪与机器解析，缩进会让 12MB 级内容膨胀数倍并加大每次 --update 的 diff
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(current) + '\n')
    } catch (err) {
      console.error(`[ERROR] 写基线失败: ${BASELINE_PATH} — ${err.message}`)
      process.exit(2)
    }
    console.log(`[INIT] ${args.update ? '已按当前产物刷新基线' : '未发现基线，已将当前产物冻结为初始基线'}`)
    console.log(`       基线文件: ${BASELINE_PATH}`)
    console.log(`       方块数: ${current.files['blocksStates/1.20.1.json'].blockCount} | blocksStates sha256: ${current.files['blocksStates/1.20.1.json'].sha256.slice(0, 12)}... | png: ${current.files['textures/1.20.1.png'].width}x${current.files['textures/1.20.1.png'].height}`)
    console.log(`       建议再次运行(不带 --update)确认校验通过`)
    process.exit(0)
  }

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

  const problems = compareFingerprints(base, current, labels)
  if (problems.length === 0) {
    console.log('[OK]     所有受检产物与止血基线一致')
    process.exit(0)
  }
  console.log(`\n[FAIL]   ${problems.length} 处差异。若改动正确，请人工确认后运行: node verification/verify-viewer-assets.cjs --update`)
  process.exit(1)
}

main()
