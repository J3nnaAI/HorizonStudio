/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ShaderDef } from '../core/types';
import { createId } from '../core/ids';

export const FLOOR_SHADER_ID = 'shd_floor';

const FLOOR_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FLOOR_FRAGMENT = /* glsl */ `
uniform vec3 uBaseColor;
uniform float uRoughness;
uniform float uReflectivity;
uniform float uGrain;
uniform vec3 uHorizonPos;
uniform float uHorizonEnergy;
uniform vec3 uHorizonColor;
uniform float uHorizonFalloff;
uniform vec3 uCameraPos;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos - vWorldPos);
  float NdotV = max(dot(N, V), 0.001);
  float fresnel = pow(1.0 - NdotV, 4.0);

  float coarse = noise(vWorldPos.xz * 3.5);
  float fine = noise(vWorldPos.xz * 38.0);
  float grain = mix(coarse, fine, 0.42) * uGrain;
  vec3 base = uBaseColor * (0.72 + grain * 0.75);

  // Dark grazing sheen reveals the floor without washing it orange.
  vec3 stripDirection = normalize(vec3(-0.35, 0.88, 0.22));
  vec3 stripHalf = normalize(V + stripDirection);
  float stripSpec = pow(max(dot(N, stripHalf), 0.0), 44.0);
  base += vec3(0.055, 0.06, 0.068) * stripSpec;

  // Restrained warm reflection from the distant line.
  float horizonBand = exp(-abs(vWorldPos.z - uHorizonPos.z) * 0.18);
  base += uHorizonColor * horizonBand * fresnel * uReflectivity * uHorizonEnergy * 0.055;

  // Contact darkening near origin
  float contact = smoothstep(0.0, 4.5, length(vWorldPos.xz - vec2(-0.5, -1.0)));
  base *= 0.76 + 0.24 * contact;

  // Specular glint
  vec3 H = normalize(V + vec3(0.2, 1.0, -0.3));
  float spec = pow(max(dot(N, H), 0.0), 48.0 / (uRoughness + 0.1)) * 0.08;
  base += vec3(spec);

  float fog = exp(-length(vWorldPos - uCameraPos) * 0.026);
  base *= 0.72 + 0.28 * fog;

  gl_FragColor = vec4(base, 1.0);
}
`;

export const FLOOR_VERTEX_SHADER = FLOOR_VERTEX;
export const FLOOR_FRAGMENT_SHADER = FLOOR_FRAGMENT;

export function createFloorShader(): ShaderDef {
  return {
    id: FLOOR_SHADER_ID,
    name: 'Obsidian Floor',
    domain: 'surface',
    backends: ['webgpu', 'webgl'],
    parameters: [
      { path: 'baseColor', type: 'color', default: '#080808', value: '#080808', animatable: true },
      { path: 'roughness', type: 'number', default: 0.85, value: 0.85, min: 0, max: 1 },
      { path: 'reflectivity', type: 'number', default: 0.6, value: 0.6, min: 0, max: 1 },
      { path: 'grain', type: 'number', default: 0.4, value: 0.4, min: 0, max: 1 },
      { path: 'planarReflection', type: 'boolean', default: true, value: true },
      { path: 'reflectionStrength', type: 'number', default: 0.25, value: 0.25, min: 0, max: 1 },
      { path: 'reflectionDiffusion', type: 'number', default: 0.4, value: 0.4, min: 0, max: 1 },
      { path: 'reflectionResolution', type: 'integer', default: 768, value: 768, min: 64, max: 4096 },
      { path: 'lightResponse', type: 'number', default: 1, value: 1, min: 0, max: 2 },
      { path: 'textureScale', type: 'number', default: 2, value: 2, min: 0.1, max: 20 },
      { path: 'contactDarkening', type: 'number', default: 0.24, value: 0.24, min: 0, max: 1 },
      { path: 'bloom', type: 'boolean', default: false, value: false },
    ],
    textureSlots: [
      { slot: 'baseColorMap', role: 'baseColor', colorSpace: 'sRGB', uvChannel: 0 },
      { slot: 'normalMap', role: 'normal', colorSpace: 'data', uvChannel: 0 },
      { slot: 'roughnessMap', role: 'roughness', colorSpace: 'data', channel: 'g', uvChannel: 0 },
    ],
    source: FLOOR_FRAGMENT,
  };
}

export function createFloorMaterial(name = 'Obsidian Floor') {
  return {
    id: createId('material'),
    name,
    shaderId: FLOOR_SHADER_ID,
    parameters: {
      baseColor: '#111316',
      roughness: 0.72,
      reflectivity: 0.28,
      grain: 0.11,
      planarReflection: true,
      reflectionStrength: 0.12,
      reflectionDiffusion: 0.78,
      lightResponse: 2,
      textureScale: 2,
      bloom: false,
    },
  };
}

export function buildFloorUniforms(
  params: Record<string, unknown>,
  horizon: { position: [number, number, number]; energy: number; color: string; falloff: number },
  cameraPos: [number, number, number],
) {
  const color = (params.baseColor as string) ?? '#060606';
  const hex = color.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const hHex = horizon.color.replace('#', '');
  return {
    uBaseColor: { value: [r, g, b] },
    uRoughness: { value: (params.roughness as number) ?? 0.88 },
    uReflectivity: { value: (params.reflectivity as number) ?? 0.72 },
    uGrain: { value: (params.grain as number) ?? 0.45 },
    uHorizonPos: { value: horizon.position },
    uHorizonEnergy: { value: horizon.energy },
    uHorizonColor: {
      value: [
        parseInt(hHex.slice(0, 2), 16) / 255,
        parseInt(hHex.slice(2, 4), 16) / 255,
        parseInt(hHex.slice(4, 6), 16) / 255,
      ],
    },
    uHorizonFalloff: { value: horizon.falloff },
    uCameraPos: { value: cameraPos },
  };
}
