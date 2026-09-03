/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ShaderDef } from '../core/types';
import { createId } from '../core/ids';

export const GRAPHITE_SHADER_ID = 'shd_graphite';
export const HORIZON_FIELD_SHADER_ID = 'shd_horizon_field';

const GRAPHITE_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vViewDir = normalize(cameraPosition - worldPos.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const GRAPHITE_FRAGMENT = /* glsl */ `
uniform vec3 uBaseTone;
uniform float uRoughness;
uniform float uMetallic;
uniform float uEdgeEnergy;
uniform float uHorizonInfluence;
uniform float uWarmReflection;
uniform float uMicroTexture;
uniform float uDistanceFade;
uniform vec3 uHorizonPos;
uniform float uHorizonEnergy;
uniform float uHorizonFalloff;
uniform vec3 uHorizonColor;
uniform vec3 uCameraPos;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vViewDir;

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
  vec3 V = normalize(vViewDir);
  float NdotV = max(dot(N, V), 0.0);

  float topFace = smoothstep(0.45, 0.9, N.y);
  float fresnel = pow(1.0 - NdotV, 3.5);
  float micro = noise(vWorldPos.xy * 70.0 + vWorldPos.yz * 23.0);

  // Nearly black gunmetal body.
  vec3 base = uBaseTone * mix(0.72, 1.12, micro * uMicroTexture);

  // A long, soft white strip light above and camera-left creates the reference edge.
  vec3 whiteLight = normalize(vec3(-0.55, 0.78, 0.28));
  vec3 whiteHalf = normalize(whiteLight + V);
  float whiteDiffuse = max(dot(N, whiteLight), 0.0);
  float whiteSpec = pow(max(dot(N, whiteHalf), 0.0), mix(28.0, 150.0, 1.0 - uRoughness));
  base += vec3(0.13, 0.14, 0.16) * whiteDiffuse * (0.35 + topFace);
  base += vec3(0.78, 0.8, 0.84) * whiteSpec * uMetallic * 0.52;

  // The orange horizon is distant directional light, strongest on rear/top bevels.
  vec3 horizonLight = normalize(uHorizonPos - vWorldPos);
  vec3 horizonHalf = normalize(horizonLight + V);
  float warmDiffuse = max(dot(N, horizonLight), 0.0);
  float warmSpec = pow(max(dot(N, horizonHalf), 0.0), 72.0);
  base += uHorizonColor * warmDiffuse * uHorizonEnergy * uHorizonInfluence * 0.18;
  base += uHorizonColor * warmSpec * uHorizonEnergy * 0.62;

  // Thin neutral rim keeps black silhouettes readable without turning them gray.
  base += vec3(0.34, 0.36, 0.4) * fresnel * uEdgeEnergy * 0.42;
  base += uHorizonColor * fresnel * warmDiffuse * uWarmReflection * 0.2;

  float distanceToCamera = length(vWorldPos - uCameraPos);
  float depthFade = 1.0 - clamp(distanceToCamera * 0.012 * uDistanceFade, 0.0, 0.42);
  base *= depthFade;

  gl_FragColor = vec4(base, 1.0);
}
`;

export const GRAPHITE_VERTEX_SHADER = GRAPHITE_VERTEX;
export const GRAPHITE_FRAGMENT_SHADER = GRAPHITE_FRAGMENT;

export function createGraphiteShader(): ShaderDef {
  return {
    id: GRAPHITE_SHADER_ID,
    name: 'Graphite',
    domain: 'surface',
    backends: ['webgpu', 'webgl'],
    parameters: [
      { path: 'baseTone', type: 'color', default: '#1a1a1a', value: '#1a1a1a', animatable: true },
      { path: 'roughness', type: 'number', default: 0.65, value: 0.65, min: 0, max: 1 },
      { path: 'metallic', type: 'number', default: 0.85, value: 0.85, min: 0, max: 1 },
      { path: 'edgeEnergy', type: 'number', default: 0.35, value: 0.35, min: 0, max: 1, animatable: true },
      { path: 'horizonInfluence', type: 'number', default: 0.5, value: 0.5, min: 0, max: 1 },
      { path: 'warmReflection', type: 'number', default: 0.15, value: 0.15, min: 0, max: 1 },
      { path: 'microTexture', type: 'number', default: 0.3, value: 0.3, min: 0, max: 1 },
      { path: 'distanceFade', type: 'number', default: 0.2, value: 0.2, min: 0, max: 1 },
      { path: 'envMapIntensity', type: 'number', default: 1.05, value: 1.05, min: 0, max: 5 },
      { path: 'clearcoat', type: 'number', default: 0.16, value: 0.16, min: 0, max: 1 },
      { path: 'clearcoatRoughness', type: 'number', default: 0.16, value: 0.16, min: 0, max: 1 },
      { path: 'anisotropy', type: 'number', default: 0.34, value: 0.34, min: 0, max: 1 },
      { path: 'anisotropyRotation', type: 'number', default: 1.5708, value: 1.5708, min: -3.1416, max: 3.1416 },
      { path: 'bumpScale', type: 'number', default: 0.012, value: 0.012, min: 0, max: 0.2 },
      { path: 'bloom', type: 'boolean', default: false, value: false },
    ],
    textureSlots: [
      { slot: 'baseColorMap', role: 'baseColor', colorSpace: 'sRGB', uvChannel: 0 },
      { slot: 'roughnessMap', role: 'roughness', colorSpace: 'data', channel: 'g', uvChannel: 0 },
      { slot: 'metallicMap', role: 'metallic', colorSpace: 'data', channel: 'b', uvChannel: 0 },
      { slot: 'normalMap', role: 'normal', colorSpace: 'data', uvChannel: 0 },
      { slot: 'bumpMap', role: 'bump', colorSpace: 'data', channel: 'r', uvChannel: 0 },
    ],
    source: GRAPHITE_FRAGMENT,
  };
}

export function createGraphiteMaterial(name = 'Graphite') {
  return {
    id: createId('material'),
    name,
    shaderId: GRAPHITE_SHADER_ID,
    parameters: {
      baseTone: '#101114',
      roughness: 0.28,
      metallic: 0.9,
      edgeEnergy: 0.72,
      horizonInfluence: 0.62,
      warmReflection: 0.18,
      microTexture: 0.24,
      distanceFade: 0.22,
    },
  };
}

export function buildGraphiteUniforms(
  params: Record<string, unknown>,
  horizon: { position: [number, number, number]; energy: number; falloff: number; color: string },
  cameraPos: [number, number, number] = [0, 1, 8],
) {
  const color = (params.baseTone as string) ?? '#141414';
  const hex = color.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const hHex = horizon.color.replace('#', '');
  const hr = parseInt(hHex.slice(0, 2), 16) / 255;
  const hg = parseInt(hHex.slice(2, 4), 16) / 255;
  const hb = parseInt(hHex.slice(4, 6), 16) / 255;
  return {
    uBaseTone: { value: [r, g, b] },
    uRoughness: { value: (params.roughness as number) ?? 0.7 },
    uMetallic: { value: (params.metallic as number) ?? 0.9 },
    uEdgeEnergy: { value: (params.edgeEnergy as number) ?? 0.35 },
    uHorizonInfluence: { value: (params.horizonInfluence as number) ?? 0.5 },
    uWarmReflection: { value: (params.warmReflection as number) ?? 0.15 },
    uMicroTexture: { value: (params.microTexture as number) ?? 0.3 },
    uDistanceFade: { value: (params.distanceFade as number) ?? 0.2 },
    uHorizonPos: { value: horizon.position },
    uHorizonEnergy: { value: horizon.energy },
    uHorizonFalloff: { value: horizon.falloff },
    uHorizonColor: { value: [hr, hg, hb] },
    uCameraPos: { value: cameraPos },
  };
}
