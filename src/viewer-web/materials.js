// materials.js —— liveview 统一着色器材质（唯一使用 three 的渲染层）
//
// 为什么要自定义 ShaderMaterial：
//   1) three 的内置材质把「顶点色」当线性值直接与会解码为线性的纹理相乘，而原版是在
//      gamma 空间做 tint×AO×纹理的乘法。这里把顶点色从 sRGB 转到线性后相乘，等价于原版
//      观感（草/叶颜色不再被冲淡）。
//   2) 液体需要在图集格子内做 UV 循环滚动，内置材质无法在不采样到相邻格子的前提下做到。
//
// 四类材质通道（与 mesh-worker 下发的四组索引一一对应）：
//   opaque —— 不透明方块
//   alpha  —— 半透明/镂空方块（玻璃、植物；alphaTest 丢弃镂空像素）
//   water  —— 水面：混合 + 格子内滚动
//   lava   —— 岩浆：不透明 + 更慢的滚动
'use strict'

import * as THREE from 'three'

/** 顶点色是 sRGB 乘数（tint×AO），转到线性空间再与已解压的纹理相乘 */
const VERTEX_SHADER = /* glsl */`
varying vec2 vUv;
varying vec3 vColor;

void main () {
  vUv = uv;
  vColor = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`

const FRAGMENT_SHADER = /* glsl */`
uniform sampler2D uMap;
uniform float uOpacity;
uniform float uAlphaTest;
uniform float uTime;
uniform vec4 uTile;    // 液体在图集中的格子 [u, v, su, sv]
uniform vec2 uScroll;  // 每秒滚动的格子比例

varying vec2 vUv;
varying vec3 vColor;

void main () {
  vec2 uv = vUv;

#ifdef LIQUID
  // 只在自身图集格子内循环，避免滚动时采样到相邻格子的像素
  vec2 local = ( uv - uTile.xy ) / uTile.zw;
  local = fract( local + uScroll * uTime );
  uv = uTile.xy + local * uTile.zw;
#endif

  vec4 texel = texture2D( uMap, uv );

#ifdef ALPHA_TEST
  if ( texel.a < uAlphaTest ) discard;
#endif

  // MC 在 gamma 空间做 tint/AO 与纹理乘算；纹理已被 GPU 解到线性，这里把顶点色也对齐
  vec3 tint = pow( vColor, vec3( 2.2 ) );
  gl_FragColor = vec4( texel.rgb * tint, texel.a * uOpacity );
  gl_FragColor = linearToOutputTexel( gl_FragColor );
}
`

// 每秒滚动的格子比例（水快、岩浆慢）。四个分量都能整除 1200，页面按 1200s 取模，
// 保证长时间运行时 uTime 不会因 float 精度下降而抖动，回绕也没有视觉跳变。
const SCROLL = {
  water: [0.08, 0.12],
  lava: [0.03, 0.045]
}

const ALPHA_TEST_THRESHOLD = 0.35

/**
 * 创建一块 section 用的材质。材质按 mesh 独立创建（淡入需要独立的 uOpacity），
 * 但 time uniform 由调用方共享同一个对象，动画时只更新一次。
 *
 * @param {{map:THREE.Texture, kind:'opaque'|'alpha'|'water'|'lava', tile?:number[], time:{value:number}}} opts
 * @returns {THREE.ShaderMaterial}
 */
export function createBlockMaterial ({ map, kind, tile, time }) {
  const liquid = kind === 'water' || kind === 'lava'
  if (!map) throw new Error('着色器材质缺少图集纹理')
  if (liquid && !Array.isArray(tile)) {
    // 缺 tile 会让 UV 动画在整张图集上滚动（采到相邻格子），宁可失败也不静默画错
    throw new Error(`液体材质缺少图集格子 tile: ${kind}`)
  }
  const defines = {}
  if (kind === 'alpha') defines.ALPHA_TEST = ''
  if (liquid) defines.LIQUID = ''

  const material = new THREE.ShaderMaterial({
    defines,
    uniforms: {
      uMap: { value: map },
      uOpacity: { value: 1 },
      uAlphaTest: { value: kind === 'alpha' ? ALPHA_TEST_THRESHOLD : 0 },
      uTime: time,
      uTile: { value: new THREE.Vector4(...(tile || [0, 0, 1, 1])) },
      uScroll: { value: new THREE.Vector2(...(liquid ? SCROLL[kind] : [0, 0])) }
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    vertexColors: true,
    transparent: kind === 'alpha' || kind === 'water',
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide
  })
  material.name = `liveview-${kind}`
  return material
}

/** 共享时间 uniform（秒）；页面每帧写入一次 */
export function createTimeUniform () {
  return { value: 0 }
}
