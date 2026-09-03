/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  vec4,
  uv,
  uniform,
  exp,
  smoothstep,
  length,
} from 'three/tsl';

export interface HorizonFieldUniforms {
  energy: number;
  color: string;
  width: number;
  scatter: number;
  flarePosition: number;
  flareTightness: number;
  haloStrength: number;
  haloFalloff: number;
}

/** TSL/node material for the horizon field backdrop plane. */
export function createHorizonFieldNodeMaterial(params: HorizonFieldUniforms): MeshBasicNodeMaterial {
  const uEnergy = uniform(params.energy);
  const uColor = uniform(new THREE.Color(params.color));
  const uWidth = uniform(params.width);
  const uScatter = uniform(params.scatter);
  const uFlareX = uniform(params.flarePosition);
  const uFlareTightness = uniform(params.flareTightness);
  const uHaloStrength = uniform(params.haloStrength);
  const uHaloFalloff = uniform(params.haloFalloff);

  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;

  material.colorNode = Fn(() => {
    const vUv = uv();
    const lineDist = vUv.y.sub(float(0.5)).abs();
    const core = exp(lineDist.mul(lineDist).div(uWidth.mul(uWidth).add(0.00001)).negate());
    const halo = exp(lineDist.mul(uHaloFalloff).negate()).mul(uScatter).mul(0.28).mul(uHaloStrength);
    const xFade = smoothstep(0.02, 0.12, vUv.x).mul(smoothstep(0.98, 0.82, vUv.x));
    const flareDist = length(vec3(vUv.x.sub(uFlareX), vUv.y.sub(0.5), float(0)));
    const flare = exp(flareDist.mul(flareDist).mul(uFlareTightness).negate()).mul(1.25);
    const intensity = core.mul(0.42).add(halo).add(flare).mul(uEnergy).mul(xFade);
    const col = uColor.mul(intensity).mul(1.6);
    const alpha = intensity.mul(1.2).clamp(0, 1);
    return vec4(col, alpha);
  })();

  material.userData.horizonUniforms = {
    uEnergy,
    uColor,
    uWidth,
    uScatter,
    uFlareX,
    uFlareTightness,
    uHaloStrength,
    uHaloFalloff,
  };

  return material;
}

export function updateHorizonFieldNodeMaterial(
  material: MeshBasicNodeMaterial,
  params: HorizonFieldUniforms,
): void {
  const uniforms = material.userData.horizonUniforms as Record<
    string,
    { value: THREE.Color | number }
  >;
  if (!uniforms) return;
  uniforms.uEnergy.value = params.energy;
  (uniforms.uColor.value as THREE.Color).set(params.color);
  uniforms.uWidth.value = params.width;
  uniforms.uScatter.value = params.scatter;
  uniforms.uFlareX.value = params.flarePosition;
  uniforms.uFlareTightness.value = params.flareTightness;
  uniforms.uHaloStrength.value = params.haloStrength;
  uniforms.uHaloFalloff.value = params.haloFalloff;
}
