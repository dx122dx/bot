// variants.js —— 方块状态 → 模型变体选择（迁移自 minecraft-viewer.html，保留其 AIR 精确匹配修复）
'use strict'

import { AIR_BLOCK_NAMES } from './constants.js'

/** 'a=b,c=d' 属性串 → 对象；已是对象则透传 */
export function parseProperties (properties) {
  if (typeof properties === 'object') return properties
  const json = {}
  for (const prop of properties.split(',')) {
    const [key, value] = prop.split('=')
    json[key] = value
  }
  return json
}

/** 判定 block 是否满足 variants key / multipart when 条件 */
export function matchProperties (block, properties) {
  if (!properties) return true
  properties = parseProperties(properties)
  const blockProps = block.props
  if (properties.OR) return properties.OR.some((or) => matchProperties(block, or))
  for (const prop in blockProps) {
    if (typeof properties[prop] === 'string' && !properties[prop].split('|').some((value) => value === blockProps[prop] + '')) return false
  }
  return true
}

/**
 * 从 blocksStates 为 block 选出命中的模型变体。
 * 语义与 minecraft-viewer.html getModelVariants 一致（含 AIR 精确匹配修复）：
 * variants 分支取"首个 matchProperties 命中"（空 key '' 无条件命中——若它在对象键序最前会抢先，此为已知根因，下一步修复）；
 * multipart 分支聚合所有命中 part。
 *
 * @param {import('./constants.js').BlockDescriptor} block
 * @param {object} blocksStates  blocksStates/1.20.1.json 解析结果
 * @returns {{variants:Array, matchedKey:string|null, matchedBy:'exact'|'default'|'multipart'|null}}
 *   variants: 命中模型（可含 {model,x?,y?,z?}）；matchedKey: 命中的 variants 属性串（multipart 为 null）；
 *   matchedBy: exact=命中非空 key / default=命中空 key / multipart
 */
export function selectVariants (block, blocksStates) {
  if (AIR_BLOCK_NAMES.has(block.name)) return { variants: [], matchedKey: null, matchedBy: null }
  const state = blocksStates[block.name] ?? blocksStates.missing_texture
  if (!state) return { variants: [], matchedKey: null, matchedBy: null }
  if (state.variants) {
    // 精确优先（根因修复）：先扫显式属性 key（facing=…/rotation=…），再回退空 key ''。
    // 空 key（parseProperties('')==={}）对任意 props 都 matchProperties 为 true——
    // 若它在对象键序最前会无条件抢先命中，导致朝向/状态变体永远不可达。
    for (const [properties, variant] of Object.entries(state.variants)) {
      if (properties === '') continue // 显式匹配轮跳过缺省键
      if (!matchProperties(block, properties)) continue
      const list = variant instanceof Array ? [variant[0]] : [variant]
      return { variants: list, matchedKey: properties, matchedBy: 'exact' }
    }
    const fallback = state.variants['']
    if (fallback !== undefined) {
      const list = fallback instanceof Array ? [fallback[0]] : [fallback]
      return { variants: list, matchedKey: '', matchedBy: 'default' }
    }
  }
  if (state.multipart) {
    const parts = state.multipart.filter((multipart) => matchProperties(block, multipart.when))
    const variants = []
    for (const part of parts) {
      if (part.apply instanceof Array) variants.push(...part.apply)
      else variants.push(part.apply)
    }
    return { variants, matchedKey: null, matchedBy: 'multipart' }
  }
  return { variants: [], matchedKey: null, matchedBy: null }
}

/**
 * 从 blocksStates 为方块选取一组"演示默认属性"（取 variants 首个非空 key 的 a=b 组合）。
 * 供演示/测试 fixture 构造 block.props 使用；真实世界数据请从 prismarine block state 解析 props。
 */
export function pickVariantProps (blockName, blocksStates) {
  const state = blocksStates[blockName] || blocksStates.missing_texture
  const props = {}
  if (state && state.variants) {
    const keys = Object.keys(state.variants)
    const first = keys.find(k => k !== '') || keys[0] || ''
    if (first) {
      for (const kv of first.split(',')) {
        const [k, v] = kv.split('=')
        if (k && v !== undefined) props[k] = v
      }
    }
  }
  return props
}
