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
  positionWorld,
  normalWorld,
  cameraPosition,
  uniform,
  pow,
  max,
  dot,
  normalize,
  exp,
  mix,
  sin,
  smoothstep,
} from 'three/tsl';

export interface FloorNodeParams {
  baseColor: string;
  roughness: number;
  reflectivity: number;
  grain: number;
  horizonPos: [number, number, number];
  horizonEnergy: number;
  horizonColor: string;
}

/** TSL/node material approximating the obsidian floor shader. */
export function createFloorNodeMaterial(params: FloorNodeParams): MeshBasicNodeMaterial {
  const uBaseColor = uniform(new THREE.Color(params.baseColor));
  const uRoughness = uniform(params.roughness);
  const uReflectivity = uniform(params.reflectivity);
  const uGrain = uniform(params.grain);
  const uHorizonPos = uniform(new THREE.Vector3(...params.horizonPos));
  const uHorizonEnergy = uniform(params.horizonEnergy);
  const uHorizonColor = uniform(new THREE.Color(params.horizonColor));

  const material = new MeshBasicNodeMaterial();
  material.colorNode = Fn(() => {
    const worldPos = positionWorld;
    const N = normalize(normalWorld);
    const V = normalize(cameraPosition.sub(worldPos));
    const NdotV = max(dot(N, V), float(0.001));
    const fresnel = pow(float(1).sub(NdotV), 4);

    const coarse = sin(worldPos.x.mul(3.5)).mul(sin(worldPos.z.mul(3.5))).mul(0.5).add(0.5);
    const fine = sin(worldPos.x.mul(38)).mul(sin(worldPos.z.mul(38))).mul(0.5).add(0.5);
    const grain = mix(coarse, fine, float(0.42)).mul(uGrain);
    let base = uBaseColor.mul(float(0.72).add(grain.mul(0.75)));

    const stripDirection = normalize(vec3(-0.35, 0.88, 0.22));
    const stripHalf = normalize(V.add(stripDirection));
    const stripSpec = pow(max(dot(N, stripHalf), float(0)), float(44));
    base = base.add(vec3(0.055, 0.06, 0.068).mul(stripSpec));

    const horizonBand = exp(worldPos.z.sub(uHorizonPos.z).abs().mul(0.18).negate());
    base = base.add(
      uHorizonColor.mul(horizonBand).mul(fresnel).mul(uReflectivity).mul(uHorizonEnergy).mul(0.055),
    );

    const contact = smoothstep(float(0), float(4.5), worldPos.xz.sub(vec3(-0.5, 0, -1)).length());
    base = base.mul(float(0.76).add(contact.mul(0.24)));

    const fog = exp(worldPos.sub(cameraPosition).length().mul(0.026).negate());
    base = base.mul(float(0.72).add(fog.mul(0.28)));

    return vec4(base, float(1));
  })();

  material.userData.floorUniforms = {
    uBaseColor,
    uRoughness,
    uReflectivity,
    uGrain,
    uHorizonPos,
    uHorizonEnergy,
    uHorizonColor,
  };

  return material;
}
