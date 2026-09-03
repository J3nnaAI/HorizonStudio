/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import type { ShaderDef } from '../core/types';

export const HORIZON_FIELD_SHADER_ID = 'shd_horizon_field';

export function createHorizonFieldShader(): ShaderDef {
  return {
    id: HORIZON_FIELD_SHADER_ID,
    name: 'Horizon Field',
    domain: 'field',
    backends: ['webgpu', 'webgl'],
    parameters: [
      { path: 'energy', type: 'number', default: 0.6, value: 0.6, min: 0, max: 20, animatable: true },
      { path: 'color', type: 'color', default: '#ff6a1a', value: '#ff6a1a', animatable: true },
      { path: 'falloff', type: 'number', default: 2.5, value: 2.5, min: 0, max: 100 },
      { path: 'width', type: 'number', default: 0.02, value: 0.02, min: 0, max: 10 },
      { path: 'scatter', type: 'number', default: 0.3, value: 0.3, min: 0, max: 10 },
      { path: 'height', type: 'number', default: 2.4, value: 2.4, min: 0, max: 100 },
      { path: 'flarePosition', type: 'number', default: 0.45, value: 0.45, min: 0, max: 1 },
      { path: 'flareTightness', type: 'number', default: 155, value: 155, min: 1, max: 1000 },
      { path: 'haloStrength', type: 'number', default: 1, value: 1, min: 0, max: 10 },
      { path: 'haloFalloff', type: 'number', default: 34, value: 34, min: 0, max: 200 },
    ],
  };
}


/** Thin emissive horizon line on a backdrop plane — restrained bloom, left flare. */
export function createHorizonFieldMesh(
  position: [number, number, number],
  energy: number,
  color: string,
  width: number,
  scatter = 0.04,
  height = 2.4,
  flarePosition = 0.45,
  flareTightness = 155,
  haloStrength = 1,
  haloFalloff = 34,
): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(48, height, 1, 1);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uEnergy: { value: energy },
      uColor: { value: new THREE.Color(color) },
      uWidth: { value: width },
      uScatter: { value: scatter },
      uLineY: { value: 0.5 },
      uFlareX: { value: flarePosition },
      uFlareTightness: { value: flareTightness },
      uHaloStrength: { value: haloStrength },
      uHaloFalloff: { value: haloFalloff },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uEnergy;
      uniform vec3 uColor;
      uniform float uWidth;
      uniform float uScatter;
      uniform float uLineY;
      uniform float uFlareX;
      uniform float uFlareTightness;
      uniform float uHaloStrength;
      uniform float uHaloFalloff;
      varying vec2 vUv;

      void main() {
        float lineDist = abs(vUv.y - uLineY);
        float core = exp(-lineDist * lineDist / (uWidth * uWidth + 0.00001));
        float halo =
          exp(-lineDist * uHaloFalloff) * uScatter * 0.28 * uHaloStrength;

        float xFade = smoothstep(0.02, 0.12, vUv.x) * smoothstep(0.98, 0.82, vUv.x);

        float flareDist = length(vec2(vUv.x - uFlareX, vUv.y - uLineY));
        float flare = exp(-flareDist * flareDist * uFlareTightness) * 1.25;

        float intensity = (core * 0.42 + halo + flare) * uEnergy * xFade;
        vec3 col = uColor * intensity * 1.6;
        float alpha = clamp(intensity * 1.2, 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.name = 'HorizonField';
  return mesh;
}

export function updateHorizonField(
  mesh: THREE.Mesh,
  position: [number, number, number],
  energy: number,
  color: string,
  width: number,
  scatter = 0.04,
  flarePosition = 0.45,
  flareTightness = 155,
  haloStrength = 1,
  haloFalloff = 34,
) {
  mesh.position.set(...position);
  const mat = mesh.material as THREE.ShaderMaterial;
  mat.uniforms.uEnergy.value = energy;
  mat.uniforms.uColor.value.set(color);
  mat.uniforms.uWidth.value = width;
  mat.uniforms.uScatter.value = scatter;
  mat.uniforms.uFlareX.value = flarePosition;
  mat.uniforms.uFlareTightness.value = flareTightness;
  mat.uniforms.uHaloStrength.value = haloStrength;
  mat.uniforms.uHaloFalloff.value = haloFalloff;
}

export function getHorizonFieldState(
  node: { properties: Record<string, unknown> },
  resolve: (path: string) => unknown = (path) => node.properties[path],
) {
  const pos = (resolve('transform.position') as [number, number, number]) ?? [0, 0.92, -11.5];
  return {
    position: pos,
    energy: (resolve('energy') as number) ?? 0.88,
    color: (resolve('color') as string) ?? '#ff5612',
    falloff: (resolve('falloff') as number) ?? 1.8,
    width: (resolve('width') as number) ?? 0.004,
    scatter: (resolve('scatter') as number) ?? 0.04,
    height: (resolve('height') as number) ?? 2.4,
    flarePosition: (resolve('flarePosition') as number) ?? 0.45,
    flareTightness: (resolve('flareTightness') as number) ?? 155,
    haloStrength: (resolve('haloStrength') as number) ?? 1,
    haloFalloff: (resolve('haloFalloff') as number) ?? 34,
  };
}
