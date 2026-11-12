// index.js —— 渲染核心公共 API（纯数据进、纯数组出；零 three/WebGL 依赖，Node 与浏览器共用）
'use strict'

export { ATLAS_SIZE, AIR_BLOCK_NAMES, LIQUID_NAMES, elemFaces } from './constants.js'
export { vecadd3, vecsub3, matmul3, matmulmat3, buildRotationMatrix } from './math.js'
export { resolveTint, GRASS_TINT_NAMES, FOLIAGE_TINT_NAMES } from './tints.js'
export { parseProperties, matchProperties, selectVariants, pickVariantProps } from './variants.js'
export { renderElement, buildBlockGeometry, buildSectionGeometry } from './geometry.js'
export { appendLiquidGeometry, liquidTexture } from './liquids.js'
