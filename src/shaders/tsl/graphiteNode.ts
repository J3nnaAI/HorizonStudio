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
  mix,
  sin,
} from 'three/tsl';

export interface GraphiteNodeParams {
  baseTone: string;
  roughness: number;
  metallic: number;
  edgeEnergy: number;
  horizonInfluence: number;
  warmReflection: number;
  microTexture: number;
  distanceFade: number;
  horizonPos: [number, number, number];
  horizonEnergy: number;
  horizonColor: string;
}

/** TSL/node material approximating the authored graphite shader. */
export function createGraphiteNodeMaterial(params: GraphiteNodeParams): MeshBasicNodeMaterial {
  const uBaseTone = uniform(new THREE.Color(params.baseTone));
  const uRoughness = uniform(params.roughness);
  const uMetallic = uniform(params.metallic);
  const uEdgeEnergy = uniform(params.edgeEnergy);
  const uHorizonInfluence = uniform(params.horizonInfluence);
  const uWarmReflection = uniform(params.warmReflection);
  const uMicroTexture = uniform(params.microTexture);
  const uDistanceFade = uniform(params.distanceFade);
  const uHorizonPos = uniform(new THREE.Vector3(...params.horizonPos));
  const uHorizonEnergy = uniform(params.horizonEnergy);
  const uHorizonColor = uniform(new THREE.Color(params.horizonColor));

  const material = new MeshBasicNodeMaterial();
  material.colorNode = Fn(() => {
    const worldPos = positionWorld;
    const N = normalize(normalWorld);
    const V = normalize(cameraPosition.sub(worldPos));
    const NdotV = max(dot(N, V), float(0));
    const fresnel = pow(float(1).sub(NdotV), 3.5);

    const micro = sin(worldPos.x.mul(70)).mul(sin(worldPos.y.mul(23))).mul(0.5).add(0.5);
    let base = uBaseTone.mul(mix(float(0.72), float(1.12), micro.mul(uMicroTexture)));

    const whiteLight = normalize(vec3(-0.55, 0.78, 0.28));
    const whiteHalf = normalize(whiteLight.add(V));
    const whiteDiffuse = max(dot(N, whiteLight), float(0));
    const whiteSpec = pow(max(dot(N, whiteHalf), float(0)), mix(float(28), float(150), float(1).sub(uRoughness)));
    base = base.add(vec3(0.13, 0.14, 0.16).mul(whiteDiffuse).mul(float(0.35)));
    base = base.add(vec3(0.78, 0.8, 0.84).mul(whiteSpec).mul(uMetallic).mul(0.52));

    const horizonLight = normalize(uHorizonPos.sub(worldPos));
    const horizonHalf = normalize(horizonLight.add(V));
    const warmDiffuse = max(dot(N, horizonLight), float(0));
    const warmSpec = pow(max(dot(N, horizonHalf), float(0)), float(72));
    base = base.add(uHorizonColor.mul(warmDiffuse).mul(uHorizonEnergy).mul(uHorizonInfluence).mul(0.18));
    base = base.add(uHorizonColor.mul(warmSpec).mul(uHorizonEnergy).mul(0.62));
    base = base.add(vec3(0.34, 0.36, 0.4).mul(fresnel).mul(uEdgeEnergy).mul(0.42));
    base = base.add(uHorizonColor.mul(fresnel).mul(warmDiffuse).mul(uWarmReflection).mul(0.2));

    const distanceToCamera = worldPos.sub(cameraPosition).length();
    const depthFade = float(1).sub(distanceToCamera.mul(0.012).mul(uDistanceFade).clamp(0, 0.42));
    base = base.mul(depthFade);

    return vec4(base, float(1));
  })();

  material.userData.graphiteUniforms = {
    uBaseTone,
    uRoughness,
    uMetallic,
    uEdgeEnergy,
    uHorizonInfluence,
    uWarmReflection,
    uMicroTexture,
    uDistanceFade,
    uHorizonPos,
    uHorizonEnergy,
    uHorizonColor,
  };

  return material;
}
